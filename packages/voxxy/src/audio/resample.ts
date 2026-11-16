/** Models take mono 16 kHz audio. */
export const STT_SAMPLE_RATE = 16000;

const OVERSAMPLE = 256; // Kernel table entries per input sample; values in between are interpolated.

/**
 * Streaming sample-rate converter: a windowed-sinc low-pass (Blackman window) at the lower of the two
 * Nyquist frequencies, so downsampling 44.1 or 48 kHz to 16 kHz does not fold high frequencies back
 * into the speech band the way picking every n-th sample or plain interpolation does.
 *
 * Feed chunks of any size to `push()`, then call `flush()` once at the end. Output does not depend on
 * how the input was chunked. Edges are handled by normalising with the weights actually available.
 */
export class Resampler {
  private readonly step: number; // Input samples per output sample.
  private readonly halfWidth: number; // Kernel reach in input samples, each side.
  private readonly kernel: Float32Array;
  private buffer: Float32Array = new Float32Array(0);
  private pos = 0; // Where the next output sample sits, in `buffer` coordinates.

  constructor(
    readonly inRate: number,
    readonly outRate: number = STT_SAMPLE_RATE,
    zeroCrossings = 16,
  ) {
    if (inRate <= 0 || outRate <= 0) throw new RangeError("Sample rates must be positive");
    this.step = inRate / outRate;
    const cutoff = Math.min(1, outRate / inRate); // Fraction of the input's Nyquist frequency.
    this.halfWidth = Math.ceil(zeroCrossings / cutoff);
    this.kernel = new Float32Array(this.halfWidth * OVERSAMPLE + 2);
    for (let i = 0; i < this.kernel.length; i++) {
      const x = i / OVERSAMPLE;
      const u = x / this.halfWidth;
      const window = u >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      const arg = Math.PI * cutoff * x;
      this.kernel[i] = cutoff * (x === 0 ? 1 : Math.sin(arg) / arg) * window;
    }
  }

  push(chunk: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return chunk.slice();
    const joined = new Float32Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    return this.drain(false);
  }

  /** Emits the samples still waiting for input that will never come. Call once, after the last `push()`. */
  flush(): Float32Array {
    if (this.inRate === this.outRate) return new Float32Array(0);
    return this.drain(true);
  }

  private weight(distance: number): number {
    const at = Math.abs(distance) * OVERSAMPLE;
    const i = Math.floor(at);
    const fraction = at - i;
    return this.kernel[i]! * (1 - fraction) + this.kernel[i + 1]! * fraction;
  }

  private drain(final: boolean): Float32Array {
    const { buffer, halfWidth, step } = this;
    const limit = final ? buffer.length : buffer.length - halfWidth;
    const out = new Float32Array(Math.max(0, Math.ceil((limit - this.pos) / step)));
    let count = 0;
    while (this.pos < limit) {
      const from = Math.max(0, Math.ceil(this.pos - halfWidth));
      const to = Math.min(buffer.length - 1, Math.floor(this.pos + halfWidth));
      let sum = 0;
      let weights = 0;
      for (let i = from; i <= to; i++) {
        const w = this.weight(i - this.pos);
        sum += w * buffer[i]!;
        weights += w;
      }
      out[count++] = weights > 1e-9 ? sum / weights : 0;
      this.pos += step;
    }
    // Drop what no later output can reach, keeping the kernel's history.
    const keepFrom = Math.floor(this.pos - halfWidth) - 1;
    if (keepFrom > 0) {
      this.buffer = buffer.slice(Math.min(keepFrom, buffer.length));
      this.pos -= keepFrom;
    }
    return out.subarray(0, count);
  }
}

/** Resamples a whole buffer at once. */
export function resample(input: Float32Array, inRate: number, outRate: number = STT_SAMPLE_RATE): Float32Array {
  const resampler = new Resampler(inRate, outRate);
  const body = resampler.push(input);
  const tail = resampler.flush();
  const joined = new Float32Array(body.length + tail.length);
  joined.set(body);
  joined.set(tail, body.length);
  return joined;
}
