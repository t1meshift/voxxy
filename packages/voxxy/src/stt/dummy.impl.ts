import type { AdapterLoadContext, SttAdapter } from "../types.js";
import { sleep } from "../util.js";

const SIZE = 1_000_000;

/** Fake STT for exercising the protocol: "loads" in steps, then reports the audio length. */
export function createAdapter(): SttAdapter {
  return {
    id: "dummy",
    async load({ onProgress, signal }: AdapterLoadContext = {}) {
      for (let step = 1; step <= 5; step++) {
        await sleep(100, signal);
        onProgress?.((SIZE / 5) * step, SIZE);
      }
    },
    async transcribe(pcm16k, signal) {
      await sleep(150, signal);
      return `dummy transcript: ${pcm16k.length} samples, ${(pcm16k.length / 16000).toFixed(2)} s`;
    },
    async dispose() {},
  };
}
