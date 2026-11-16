import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebAudioPlayer } from "./player.js";

interface FakeSource {
  buffer: { duration: number } | null;
  startedAt: number | null;
  stopped: boolean;
  onended: (() => void) | null;
  connect(): void;
  disconnect(): void;
  start(at?: number): void;
  stop(): void;
}

/** Just enough of an AudioContext to see when buffers are scheduled. The test plays the audio clock by hand. */
function fakeContext(initialState: AudioContextState = "suspended", resume?: () => Promise<void>) {
  const sources: FakeSource[] = [];
  const gains: Array<{ gain: { value: number } }> = [];
  const context = {
    currentTime: 0,
    state: initialState,
    sampleRate: 48000,
    destination: {},
    createGain: () => {
      const node = { connect() {}, gain: { value: 1 } };
      gains.push(node);
      return node;
    },
    createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
    createBufferSource(): FakeSource {
      const source: FakeSource = {
        buffer: null,
        startedAt: null,
        stopped: false,
        onended: null,
        connect() {},
        disconnect() {},
        start(at = 0) {
          source.startedAt = at;
        },
        stop() {
          source.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
    async resume() {
      await resume?.();
      context.state = "running";
    },
    async close() {
      context.state = "closed";
    },
  };
  return { context, sources, gains, asAudioContext: () => context as unknown as AudioContext };
}

const signal = () => new AbortController().signal;
const pcm = (seconds: number, rate = 24000) => new Float32Array(Math.round(seconds * rate));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("web audio player: scheduling", () => {
  it("starts an idle player a little after now, and queues the next buffer exactly where the first ends", async () => {
    const fake = fakeContext("running");
    const player = createWebAudioPlayer({ createContext: fake.asAudioContext, leadSeconds: 0.03 });
    void player.play(pcm(0.5), 24000, signal());
    void player.play(pcm(0.25), 24000, signal());
    void player.play(pcm(0.1), 24000, signal());
    await Promise.resolve();

    const [first, second, third] = fake.sources;
    expect(first!.startedAt).toBeCloseTo(0.03, 9);
    expect(second!.startedAt).toBeCloseTo(0.53, 9); // 0.03 + 0.5: no gap.
    expect(third!.startedAt).toBeCloseTo(0.78, 9);
  });

  it("does not schedule into the past when the audio clock has moved on", async () => {
    const fake = fakeContext("running");
    const player = createWebAudioPlayer({ createContext: fake.asAudioContext, leadSeconds: 0 });
    const first = player.play(pcm(0.1), 24000, signal());
    fake.sources[0]!.onended?.();
    await first;

    fake.context.currentTime = 5; // Idle for a while.
    void player.play(pcm(0.1), 24000, signal());
    expect(fake.sources[1]!.startedAt).toBe(5);
  });

  it("resolves a play() when its buffer ends, and reports started, chunk-finished and drained", async () => {
    const fake = fakeContext("running");
    const player = createWebAudioPlayer({ createContext: fake.asAudioContext, leadSeconds: 0 });
    const events: string[] = [];
    const finished: Array<{ startTime: number; endTime: number }> = [];
    player.on("started", () => events.push("started"));
    player.on("chunk-finished", (timing) => (events.push("chunk-finished"), finished.push(timing)));
    player.on("drained", () => events.push("drained"));

    const a = player.play(pcm(0.5), 24000, signal());
    const b = player.play(pcm(0.5), 24000, signal());
    expect(events).toEqual(["started"]); // Once, not per buffer.

    fake.sources[0]!.onended?.();
    await a;
    expect(events).toEqual(["started", "chunk-finished"]);

    fake.sources[1]!.onended?.();
    await b;
    expect(events).toEqual(["started", "chunk-finished", "chunk-finished", "drained"]);
    expect(finished[0]!.endTime).toBeCloseTo(finished[1]!.startTime, 9);
  });

  it("an aborted buffer is silenced, rejects with an AbortError and says nothing about finishing", async () => {
    const fake = fakeContext("running");
    const player = createWebAudioPlayer({ createContext: fake.asAudioContext });
    const events: string[] = [];
    player.on("chunk-finished", () => events.push("chunk-finished"));
    player.on("drained", () => events.push("drained"));

    const controller = new AbortController();
    const playing = player.play(pcm(1), 24000, controller.signal).then(() => "done", (e: Error) => e.name);
    controller.abort();
    expect(await playing).toBe("AbortError");
    expect(fake.sources[0]!.stopped).toBe(true);
    expect(events).toEqual(["drained"]);
  });

  it("stopping all of them leaves the player ready to start fresh", async () => {
    const fake = fakeContext("running");
    const player = createWebAudioPlayer({ createContext: fake.asAudioContext, leadSeconds: 0 });
    const controller = new AbortController();
    const plays = [1, 1, 1].map(() => player.play(pcm(1), 24000, controller.signal).catch((e: Error) => e.name));
    controller.abort();
    expect(await Promise.all(plays)).toEqual(["AbortError", "AbortError", "AbortError"]);

    void player.play(pcm(0.1), 24000, signal());
    expect(fake.sources[3]!.startedAt).toBe(0); // Not queued behind the three that were cancelled.
  });

  it("volume sets the master gain only: everything is still scheduled, so tests can run it silently", async () => {
    const quiet = fakeContext("running");
    const player = createWebAudioPlayer({ createContext: quiet.asAudioContext, volume: 0, leadSeconds: 0 });
    void player.play(pcm(0.5), 24000, signal());
    expect(quiet.gains[0]!.gain.value).toBe(0);
    expect(quiet.sources).toHaveLength(1);
    expect(quiet.sources[0]!.startedAt).toBe(0);

    const loud = fakeContext("running");
    void createWebAudioPlayer({ createContext: loud.asAudioContext }).play(pcm(0.1), 24000, signal());
    expect(loud.gains[0]!.gain.value).toBe(1);

    const clamped = fakeContext("running");
    void createWebAudioPlayer({ createContext: clamped.asAudioContext, volume: 7 }).play(pcm(0.1), 24000, signal());
    expect(clamped.gains[0]!.gain.value).toBe(1);
  });

  it("rejects at once for a signal that is already aborted", async () => {
    const fake = fakeContext("running");
    const player = createWebAudioPlayer({ createContext: fake.asAudioContext });
    const controller = new AbortController();
    controller.abort();
    await expect(player.play(pcm(1), 24000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.sources).toHaveLength(0);
  });
});

describe("web audio player: unlocking", () => {
  it("unlock() resumes a suspended context", async () => {
    const fake = fakeContext("suspended");
    const player = createWebAudioPlayer({ createContext: fake.asAudioContext, silentSwitch: "off" });
    expect(player.contextState).toBeNull();
    await player.unlock();
    expect(player.contextState).toBe("running");
  });

  it("play() before any gesture gives up with a clear error instead of hanging", async () => {
    vi.useFakeTimers();
    const fake = fakeContext("suspended", () => new Promise(() => {})); // resume() never answers: no gesture yet.
    const player = createWebAudioPlayer({ createContext: fake.asAudioContext });
    const playing = player.play(pcm(0.1), 24000, signal()).catch((e: Error & { code?: string }) => e);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await playing).toMatchObject({ name: "AudioPlaybackError", code: "blocked" });
  });

  it("uses navigator.audioSession where it exists", async () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession, userAgent: "", platform: "", maxTouchPoints: 0 });
    const player = createWebAudioPlayer({ createContext: fakeContext().asAudioContext });
    await player.unlock();
    expect(audioSession.type).toBe("playback");
    expect(player.silentSwitchUsed).toBe("audio-session");
  });

  it("falls back to a silent <audio> element on iOS without audioSession, started inside the gesture", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 });
    const played: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        loop = false;
        constructor(readonly src: string) {}
        setAttribute() {}
        play() {
          played.push(this.src.slice(0, 15));
          return Promise.resolve();
        }
        pause() {}
      },
    );
    const player = createWebAudioPlayer({ createContext: fakeContext().asAudioContext });
    const unlocking = player.unlock();
    expect(played).toEqual(["data:audio/wav;"]); // Already started before the first await resolved.
    await unlocking;
    expect(player.silentSwitchUsed).toBe("audio-element");
  });

  it("does nothing about the silent switch off iOS, or when told not to", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux", maxTouchPoints: 0 });
    const player = createWebAudioPlayer({ createContext: fakeContext().asAudioContext });
    await player.unlock();
    expect(player.silentSwitchUsed).toBeNull();

    const off = createWebAudioPlayer({ createContext: fakeContext().asAudioContext, silentSwitch: "off" });
    await off.unlock();
    expect(off.silentSwitchUsed).toBeNull();
  });

  it("dispose() stops what is playing and closes the context", async () => {
    const fake = fakeContext("running");
    const player = createWebAudioPlayer({ createContext: fake.asAudioContext });
    void player.play(pcm(1), 24000, signal());
    await player.dispose();
    expect(fake.sources[0]!.stopped).toBe(true);
    expect(fake.context.state).toBe("closed");
  });
});
