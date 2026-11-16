import type { Player, Recorder } from "./pcm.js";
import { abortError } from "./provider.js";
import { sleep } from "./util.js";

/**
 * Stand-ins for the real recorder and player, for tests and the stand.
 * No microphone, no sound.
 */

export { wavToMono16k } from "./test-utils/wav.js";

/**
 * A recorder that "hears" a prepared clip instead of a microphone: `stop()` returns the clip (mono 16 kHz).
 * Lets the stand and tests run the whole `listen()` path, speech recogniser included, on known speech.
 */
export function clipRecorder(clip: Float32Array | (() => Promise<Float32Array>)): Recorder {
  return {
    async start(signal) {
      signal?.throwIfAborted();
      const pcm = typeof clip === "function" ? clip() : Promise.resolve(clip);
      return { stop: () => pcm, cancel() {} };
    },
  };
}

/** "Records" 16 samples per millisecond held, at least 100 ms worth, so a transcript reflects how long the button was down. */
export function fakeRecorder(): Recorder {
  return {
    async start(signal) {
      signal?.throwIfAborted();
      const startedAt = Date.now();
      return {
        async stop() {
          return new Float32Array(Math.max(1600, (Date.now() - startedAt) * 16));
        },
        cancel() {},
      };
    },
  };
}

/** Options for `fakePlayer()`. */
export interface FakePlayerOptions {
  /** How much faster than real time it "plays". Default 10, so tests do not wait for whole sentences. */
  speed?: number;
  /** Called when a buffer starts playing. */
  onPlay?: (info: { samples: number; sampleRate: number }) => void;
}

/** Queues like the real player: a buffer handed over while another plays waits for its turn. */
export function fakePlayer({ speed = 10, onPlay }: FakePlayerOptions = {}): Player {
  let tail: Promise<void> = Promise.resolve();
  return {
    play(pcm, sampleRate, signal) {
      const previous = tail;
      const run = (async () => {
        const cancelled = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? abortError()), { once: true }));
        if (signal.aborted) throw signal.reason ?? abortError();
        await Promise.race([previous, cancelled]);
        signal.throwIfAborted();
        onPlay?.({ samples: pcm.length, sampleRate });
        await sleep((pcm.length / sampleRate / speed) * 1000, signal);
      })();
      tail = run.catch(() => {});
      return run;
    },
    async unlock() {},
  };
}
