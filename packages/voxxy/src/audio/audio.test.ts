import { describe, expect, it } from "vitest";
import { MicrophoneError, claimMicrophone, mapMediaError, microphoneOwner } from "./errors.js";
import { Resampler, resample } from "./resample.js";

const sine = (hz: number, rate: number, seconds: number, amplitude = 0.5): Float32Array =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));

const rms = (samples: Float32Array, from = 0, to = samples.length): number => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (to - from));
};

/** Largest difference from the ideal sine, away from the edges where the filter has little context. */
function maxError(output: Float32Array, hz: number, rate: number, amplitude = 0.5): number {
  const margin = Math.floor(rate * 0.02);
  let worst = 0;
  for (let i = margin; i < output.length - margin; i++) {
    worst = Math.max(worst, Math.abs(output[i]! - amplitude * Math.sin((2 * Math.PI * hz * i) / rate)));
  }
  return worst;
}

describe("Resampler", () => {
  it.each([
    ["48 kHz (typical iPhone)", 48000],
    ["44.1 kHz (typical iPhone, non-integer ratio)", 44100],
    ["32 kHz", 32000],
  ])("keeps a 440 Hz tone intact from %s down to 16 kHz", (_name, inRate) => {
    const output = resample(sine(440, inRate, 1), inRate, 16000);
    expect(Math.abs(output.length - 16000)).toBeLessThanOrEqual(2);
    expect(maxError(output, 440, 16000)).toBeLessThan(0.01);
  });

  it("removes what 16 kHz cannot carry instead of folding it into the speech band", () => {
    // 12 kHz is above the 8 kHz Nyquist of the output. Naive decimation would turn it into a 4 kHz tone.
    const input = sine(12000, 48000, 1, 0.7);
    const output = resample(input, 48000, 16000);
    expect(rms(input)).toBeGreaterThan(0.45);
    expect(rms(output, 500, output.length - 500)).toBeLessThan(0.01);
  });

  it("gives the same result however the input is chunked", () => {
    const input = sine(300, 44100, 0.5);
    const whole = resample(input, 44100, 16000);

    const resampler = new Resampler(44100, 16000);
    const parts: Float32Array[] = [];
    for (let at = 0; at < input.length; ) {
      const size = 1 + ((at * 7919) % 4000); // Uneven chunk sizes, including tiny ones.
      parts.push(resampler.push(input.subarray(at, at + size)));
      at += size;
    }
    parts.push(resampler.flush());
    const chunked = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) (chunked.set(part, offset), (offset += part.length));

    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(chunked[i]).toBeCloseTo(whole[i]!, 5);
  });

  it("passes audio through unchanged when the rates match", () => {
    const input = sine(200, 16000, 0.1);
    expect([...resample(input, 16000, 16000)]).toEqual([...input]);
  });

  it("keeps the level of a constant signal, edges included", () => {
    const output = resample(new Float32Array(4800).fill(0.25), 48000, 16000);
    expect(output.length).toBeGreaterThan(1500);
    for (const sample of output) expect(sample).toBeCloseTo(0.25, 3);
  });

  it("handles input shorter than the filter and empty input", () => {
    expect(resample(new Float32Array(0), 48000, 16000)).toHaveLength(0);
    const tiny = resample(new Float32Array(10).fill(1), 48000, 16000);
    expect(tiny.length).toBeGreaterThanOrEqual(3);
    expect(tiny.every((sample) => Number.isFinite(sample))).toBe(true);
  });

  it("can also upsample", () => {
    const output = resample(sine(440, 16000, 1), 16000, 48000);
    expect(Math.abs(output.length - 48000)).toBeLessThanOrEqual(3);
    expect(maxError(output, 440, 48000)).toBeLessThan(0.01);
  });
});

describe("microphone errors and ownership", () => {
  it.each([
    ["NotAllowedError", "permission-denied"],
    ["SecurityError", "permission-denied"],
    ["NotFoundError", "no-device"],
    ["OverconstrainedError", "no-device"],
    ["NotReadableError", "in-use"],
    ["TypeError", "unsupported"],
    ["SomethingElse", "failed"],
  ])("maps %s to %s", (name, code) => {
    const error = mapMediaError(Object.assign(new Error("x"), { name }));
    expect(error).toBeInstanceOf(MicrophoneError);
    expect(error.code).toBe(code);
  });

  it("only one owner at a time, and releasing frees it", () => {
    const release = claimMicrophone("recorder");
    expect(microphoneOwner()).toBe("recorder");
    expect(() => claimMicrophone("platform-stt")).toThrow(expect.objectContaining({ code: "busy" }));
    release();
    release(); // Releasing twice must not free someone else's claim.
    expect(microphoneOwner()).toBeNull();

    const next = claimMicrophone("platform-stt");
    release();
    expect(microphoneOwner()).toBe("platform-stt");
    next();
  });
});
