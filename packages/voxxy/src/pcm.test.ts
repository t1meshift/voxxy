import { describe, expect, it } from "vitest";
import { pcmListener, pcmSpeaker, type Player, type Recorder } from "./pcm.js";
import { speechWeight, type SplitterOptions } from "./sentences.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/**
 * Speaker whose synthesis and playback the test steps by hand. Text length = sample count, so it shows in the log.
 * The fake player queues like a real one: `issued` is what was handed to it, `played` what has begun playing.
 */
function speakerHarness(maxAhead?: number, splitter?: SplitterOptions) {
  const synthesized: string[] = [];
  const synthSignals: AbortSignal[] = [];
  const issued: number[] = [];
  const played: number[] = [];
  const playGates: Array<ReturnType<typeof deferred<void>>> = [];
  let tail: Promise<void> = Promise.resolve();
  const player: Player = {
    play(pcm, _rate, signal) {
      issued.push(pcm.length);
      const previous = tail;
      const run = (async () => {
        const cancelled = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        await Promise.race([previous, cancelled]); // Wait for its turn, unless stopped first.
        signal.throwIfAborted();
        played.push(pcm.length);
        const gate = deferred<void>();
        playGates.push(gate);
        signal.addEventListener("abort", () => gate.reject(signal.reason), { once: true });
        await gate.promise;
      })();
      tail = run.catch(() => {});
      return run;
    },
  };
  const speaker = pcmSpeaker({
    player,
    maxAhead,
    splitter,
    async synthesize(text, signal) {
      synthesized.push(text);
      synthSignals.push(signal);
      signal.throwIfAborted();
      return { pcm: new Float32Array(text.length), sampleRate: 1000 };
    },
  });
  return { speaker, synthesized, synthSignals, issued, played, finishCurrent: () => playGates[played.length - 1]!.resolve() };
}

describe("pcmSpeaker", () => {
  it("plays queued texts in order, each promise resolving when its own utterance ends", async () => {
    const h = speakerHarness();
    const done: string[] = [];
    const a = h.speaker.speak("a").then(() => done.push("a"));
    const b = h.speaker.speak("bb").then(() => done.push("b"));
    const c = h.speaker.speak("ccc").then(() => done.push("c"));
    await tick();
    expect(h.played).toEqual([1]);
    expect(done).toEqual([]);

    h.finishCurrent();
    await tick();
    expect(done).toEqual(["a"]);
    expect(h.played).toEqual([1, 2]);

    h.finishCurrent();
    await tick();
    h.finishCurrent();
    await Promise.all([a, b, c]);
    expect(done).toEqual(["a", "b", "c"]);
    expect(h.played).toEqual([1, 2, 3]);
  });

  it("hands the next buffer to the player while the current one is still playing, so it can follow without a gap", async () => {
    const h = speakerHarness();
    void h.speaker.speak("a");
    void h.speaker.speak("bb");
    await tick();
    expect(h.played).toEqual([1]); // Only "a" is sounding...
    expect(h.issued).toEqual([1, 2]); // ...but "bb" is already with the player, queued behind it.
  });

  it("synthesises the next text while the current one plays, but only `maxAhead` of them", async () => {
    const h = speakerHarness();
    void h.speaker.speak("a");
    void h.speaker.speak("b");
    void h.speaker.speak("c");
    await tick();
    expect(h.synthesized).toEqual(["a", "b"]); // c waits: one is playing, one is prepared.

    h.finishCurrent();
    await tick();
    expect(h.synthesized).toEqual(["a", "b", "c"]);
  });

  it("prepares further ahead when allowed", async () => {
    const h = speakerHarness(3);
    for (const text of ["a", "b", "c", "d", "e"]) void h.speaker.speak(text);
    await tick();
    expect(h.synthesized).toEqual(["a", "b", "c", "d"]);
  });

  it("stop() ends the sound, clears the queue and rejects pending calls with an AbortError", async () => {
    const h = speakerHarness();
    const results = ["a", "b", "c"].map((text) => h.speaker.speak(text).then(() => "done", (e: Error) => e.name));
    await tick();
    h.speaker.stop();
    expect(await Promise.all(results)).toEqual(["AbortError", "AbortError", "AbortError"]);
    expect(h.synthSignals.every((signal) => signal.aborted)).toBe(true);
    expect(h.played).toEqual([1]); // The others never played.
  });

  it("works again after stop()", async () => {
    const h = speakerHarness();
    const stopped = h.speaker.speak("a").catch(() => "stopped");
    await tick();
    h.speaker.stop();
    expect(await stopped).toBe("stopped");

    const again = h.speaker.speak("bb");
    await tick();
    h.finishCurrent();
    await expect(again).resolves.toBeUndefined();
  });

  it("a call's own signal drops just that utterance", async () => {
    const h = speakerHarness();
    const controller = new AbortController();
    const a = h.speaker.speak("a");
    const b = h.speaker.speak("bb", { signal: controller.signal }).then(() => "done", (e: Error) => e.name);
    const c = h.speaker.speak("ccc");
    await tick();
    controller.abort();
    h.finishCurrent();
    await tick();
    h.finishCurrent();
    await Promise.all([a, c]);
    expect(await b).toBe("AbortError");
    expect(h.played).toEqual([1, 3]);
  });

  it("rejects at once when the call's signal is already aborted", async () => {
    const h = speakerHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.speaker.speak("a", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.synthesized).toEqual([]);
  });

  describe("long text", () => {
    const THREE = "First sentence goes here. Second sentence goes here. Third sentence goes here.";
    const [s1, s2, s3] = ["First sentence goes here.", "Second sentence goes here.", "Third sentence goes here."];

    it("is cut into sentences that are synthesised one after another, so sound starts with the first", async () => {
      const h = speakerHarness();
      let resolved = false;
      const spoken = h.speaker.speak(THREE).then(() => (resolved = true));
      await tick();
      expect(h.synthesized).toEqual([s1, s2]); // The third waits for room: the memory held is bounded.
      expect(h.played).toEqual([s1!.length]);

      h.finishCurrent();
      await tick();
      expect(h.synthesized).toEqual([s1, s2, s3]);
      h.finishCurrent();
      await tick();
      expect(resolved).toBe(false);
      h.finishCurrent();
      await spoken;
      expect(h.played).toEqual([s1!.length, s2!.length, s3!.length]);
    });

    it("hands the player a long text's next sentence while the current one plays", async () => {
      const h = speakerHarness();
      void h.speaker.speak(THREE);
      await tick();
      expect(h.issued).toEqual([s1!.length, s2!.length]);
      expect(h.played).toEqual([s1!.length]);
    });

    it("rejects the whole call if one sentence cannot be synthesised, and calls off the ones after it", async () => {
      const signals = new Map<string, AbortSignal>();
      const speaker = pcmSpeaker({
        player: { async play() {} },
        maxAhead: 1,
        async synthesize(text, signal) {
          signals.set(text, signal);
          if (text === s2) throw new Error("model crashed");
          return { pcm: new Float32Array(text.length), sampleRate: 1000 };
        },
      });
      await expect(speaker.speak(THREE)).rejects.toThrow("model crashed");
      await tick();
      // The third may already have been started when the second failed; if so it was told to stop.
      expect(signals.get(s3)?.aborted ?? true).toBe(true);
    });

    it("stop() rejects a long call and clears every sentence of it", async () => {
      const h = speakerHarness();
      const spoken = h.speaker.speak(THREE).then(() => "done", (e: Error) => e.name);
      await tick();
      h.speaker.stop();
      expect(await spoken).toBe("AbortError");
      await tick();
      expect(h.synthesized).toEqual([s1, s2]);
    });

    it("a call's signal drops all of its sentences, and only its own", async () => {
      const h = speakerHarness();
      const controller = new AbortController();
      const first = h.speaker.speak("Another reply that is long enough. And one more of it.", { signal: controller.signal }).then(() => "done", (e: Error) => e.name);
      const other = h.speaker.speak("kept");
      await tick();
      controller.abort();
      h.finishCurrent();
      await tick();
      h.finishCurrent();
      expect(await first).toBe("AbortError");
      await other;
    });

    it("empty or blank text resolves at once and synthesises nothing", async () => {
      const h = speakerHarness();
      await h.speaker.speak("");
      await h.speaker.speak("  \n ");
      expect(h.synthesized).toEqual([]);
    });

    it("the cutting can be tuned", async () => {
      const h = speakerHarness();
      void h.speaker.speak("One. Two. Three. Four.");
      const tuned = speakerHarness(undefined, { minChars: 0 });
      void tuned.speaker.speak("One. Two. Three. Four.");
      await tick();
      expect(h.synthesized).toEqual(["One. Two. Three. Four."]); // Very short sentences are joined by default, a short last one too.
      expect(tuned.synthesized).toEqual(["One.", "Two."]);
    });

    it("does not leave a one-word last sentence as a chunk of its own", async () => {
      const h = speakerHarness();
      void h.speaker.speak("Hey. I. Am. Here.");
      await tick();
      expect(h.synthesized).toEqual(["Hey. I. Am. Here."]);
    });
  });

  describe("chunk size follows the speed of the device", () => {
    const TEXT = Array.from({ length: 40 }, () => "Another short sentence ends here.").join(" ");
    const BIG = { firstMinChars: 30, minChars: 300, maxChars: 420 };
    const SPEECH_CHARS_PER_SECOND = 15;

    /**
     * Speaks TEXT on a device that makes speech `rtf` times faster than it takes to say it. "Playing" a chunk ends
     * when the next one is ready, as if it lasted just that long. Returns the chunk weights and the listener's silence, by the same model.
     */
    async function run(rtf: number, withSynthMs = true, text = TEXT) {
      const weights: number[] = [];
      const audio: number[] = [];
      const gates: Array<() => void> = [];
      let clock = 0;
      const speaker = pcmSpeaker({
        splitter: BIG,
        now: () => clock,
        async synthesize(text) {
          const weight = speechWeight(text);
          const seconds = weight / SPEECH_CHARS_PER_SECOND;
          weights.push(weight);
          audio.push(seconds);
          clock += (seconds * 1000) / rtf; // The device is busy for this long.
          return { pcm: new Float32Array(Math.round(seconds * 1000)), sampleRate: 1000, ...(withSynthMs ? { synthMs: (seconds * 1000) / rtf } : {}) };
        },
        player: {
          play: (_pcm, _rate, signal) =>
            new Promise<void>((resolve, reject) => {
              gates.push(resolve);
              if (gates.length > 1) gates[gates.length - 2]!(); // The one before has played by the time this one is ready.
              signal.addEventListener("abort", () => reject(signal.reason));
            }),
        },
      });
      let finished = false;
      const spoken = speaker.speak(text).then(() => (finished = true));
      while (!finished) {
        await tick();
        gates.at(-1)?.();
      }
      await spoken;

      // Silence heard, on the cost model: synthesis is one at a time, two chunks are held, playing is continuous when it can be.
      const synth = audio.map((seconds) => seconds / rtf);
      let synthEnd = 0;
      const playEnd: number[] = [];
      let silence = 0;
      weights.forEach((_, i) => {
        synthEnd = Math.max(synthEnd, i >= 2 ? playEnd[i - 2]! - audio[i - 1]! : 0) + synth[i]!;
        const start = Math.max(synthEnd, i ? playEnd[i - 1]! : 0);
        if (i) silence += start - playEnd[i - 1]!;
        playEnd[i] = start + audio[i]!;
      });
      return { weights, silence };
    }

    it("on a fast device the second chunk is as big as it may be", async () => {
      const { weights } = await run(100);
      expect(weights[0]).toBeLessThan(80); // A short first chunk, so sound starts early.
      expect(weights[1]).toBeGreaterThanOrEqual(300);
    });

    it("on a slow device the chunks grow step by step, each within what the one before can cover", async () => {
      const rtf = 3;
      const { weights, silence } = await run(rtf);
      weights.slice(1).forEach((weight, i) => expect(weight, `chunk ${i + 1}`).toBeLessThanOrEqual(weights[i]! * rtf * 0.8 + 1e-9));
      expect(weights[1]).toBeGreaterThan(weights[0]!); // It does grow...
      expect(weights[1]).toBeLessThan(300); // ...but not straight to the full size.
      expect(silence).toBeLessThan(0.05);
    });

    it("cuts one long sentence to fit when the chunk before it is too short to cover its synthesis", async () => {
      const rtf = 4;
      const longSentence = `Okay, here goes. Then ${"word ".repeat(70).trim()}.`; // A short first chunk, then 350 characters in one sentence.
      const { weights, silence } = await run(rtf, true, longSentence);
      expect(weights[0]).toBeLessThan(20);
      expect(weights[1]).toBeLessThanOrEqual(weights[0]! * rtf * 0.8 + 1e-9); // All the short chunk can cover.
      weights.slice(1).forEach((weight, i) => expect(weight, `chunk ${i + 1}`).toBeLessThanOrEqual(Math.max(40, weights[i]! * rtf * 0.8) + 1e-9));
      expect(Math.max(...weights)).toBeGreaterThan(100); // It still grows to bigger chunks.
      expect(silence).toBeLessThan(0.05);
    });

    it("keeps big chunks on a device that is slower than speech: a hole is coming anyway, and fewer chunks waste less", async () => {
      const { weights } = await run(0.5);
      expect(weights[1]).toBeGreaterThanOrEqual(300);
    });

    it("uses its own clock when the provider does not say how long a synthesis took", async () => {
      expect((await run(3, false)).weights).toEqual((await run(3, true)).weights);
    });

    it("never makes a chunk smaller than one sentence, even when the device is slower than speech", async () => {
      const { weights } = await run(0.5);
      expect(Math.min(...weights.slice(0, -1))).toBeGreaterThanOrEqual(33);
    });
  });

  it("a failing synthesis rejects that call and the queue moves on", async () => {
    const played: number[] = [];
    const speaker = pcmSpeaker({
      player: { async play(pcm) { played.push(pcm.length); } },
      async synthesize(text) {
        if (text === "bad") throw new Error("model crashed");
        return { pcm: new Float32Array(text.length), sampleRate: 1000 };
      },
    });
    const results = await Promise.allSettled([speaker.speak("a"), speaker.speak("bad"), speaker.speak("cc")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(played).toEqual([1, 2]);
  });
});

function recorderHarness() {
  const log: string[] = [];
  const recorder: Recorder = {
    async start(signal) {
      signal?.throwIfAborted();
      log.push("start");
      return {
        async stop() {
          log.push("stop");
          return new Float32Array(48);
        },
        cancel() {
          log.push("cancel");
        },
      };
    },
  };
  return { recorder, log };
}

describe("pcmListener", () => {
  it("records, then transcribes what stop() captured", async () => {
    const { recorder, log } = recorderHarness();
    const listen = pcmListener({ recorder, transcribe: async (pcm) => `${pcm.length} samples` });
    const session = listen();
    expect(await session.stop()).toBe("48 samples");
    expect(log).toEqual(["start", "stop"]);
  });

  it("cancel() drops the recording and stop() then rejects with an AbortError", async () => {
    const { recorder, log } = recorderHarness();
    let transcribed = false;
    const listen = pcmListener({ recorder, transcribe: async () => ((transcribed = true), "x") });
    const session = listen();
    await tick();
    session.cancel();
    await expect(session.stop()).rejects.toMatchObject({ name: "AbortError" });
    expect(log).toEqual(["start", "cancel"]);
    expect(transcribed).toBe(false);
  });

  it("aborts the transcription when cancelled while it runs", async () => {
    const { recorder } = recorderHarness();
    const gate = deferred<string>();
    let seen: AbortSignal | undefined;
    const listen = pcmListener({
      recorder,
      transcribe: (_pcm, signal) => ((seen = signal), gate.promise),
    });
    const session = listen();
    const text = session.stop().catch((e: Error) => e.name);
    await tick();
    session.cancel();
    expect(seen?.aborted).toBe(true);
    gate.reject(seen?.reason);
    expect(await text).toBe("AbortError");
  });

  it("follows the caller's signal", async () => {
    const { recorder } = recorderHarness();
    const controller = new AbortController();
    const listen = pcmListener({ recorder, transcribe: async () => "x" });
    const session = listen({ signal: controller.signal });
    await tick();
    controller.abort();
    await expect(session.stop()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a recorder that fails to start surfaces on stop()", async () => {
    const recorder: Recorder = { start: async () => Promise.reject(new Error("microphone denied")) };
    const listen = pcmListener({ recorder, transcribe: async () => "x" });
    await expect(listen().stop()).rejects.toThrow("microphone denied");
  });
});
