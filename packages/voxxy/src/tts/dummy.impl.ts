import type { AdapterLoadContext, TtsAdapter } from "../types.js";
import { sleep } from "../util.js";

const SIZE = 500_000;
const SAMPLE_RATE = 24000;

/** Fake TTS for exercising the protocol: returns a 220 Hz tone, 50 ms per character. */
export function createAdapter(): TtsAdapter {
  return {
    id: "dummy",
    async load({ onProgress, signal }: AdapterLoadContext = {}) {
      for (let step = 1; step <= 5; step++) {
        await sleep(100, signal);
        onProgress?.((SIZE / 5) * step, SIZE);
      }
    },
    async synthesize(text, signal) {
      await sleep(150, signal);
      const seconds = Math.max(0.1, text.length * 0.05);
      const pcm = new Float32Array(Math.round(seconds * SAMPLE_RATE));
      for (let i = 0; i < pcm.length; i++) pcm[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
      return { pcm, sampleRate: SAMPLE_RATE };
    },
    async dispose() {},
  };
}
