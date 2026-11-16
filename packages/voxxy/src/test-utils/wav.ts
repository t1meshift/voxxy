import { resample } from "../audio/resample.js";

/** Decodes a 16-bit PCM WAV (any channel count and rate) to mono 16 kHz Float32, for tests and fixtures. */
export function wavToMono16k(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let channels = 1;
  let rate = 16000;
  let bits = 16;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt ") {
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (tag(at) === "data") {
      if (bits !== 16) throw new Error(`Only 16-bit WAV is supported, got ${bits}`);
      const frames = Math.floor(Math.min(size, bytes.length - at - 8) / (2 * channels));
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += view.getInt16(at + 8 + (i * channels + c) * 2, true);
        mono[i] = sum / channels / 32768;
      }
      return rate === 16000 ? mono : resample(mono, rate, 16000);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Mono 16-bit PCM WAV bytes from Float32 samples at `rate`. */
export function monoToWav(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true));
  return out;
}
