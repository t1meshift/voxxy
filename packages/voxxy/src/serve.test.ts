import { describe, expect, it } from "vitest";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import { serveStt, serveTts, type WorkerScope } from "./serve.js";
import type { SttAdapter, TtsAdapter } from "./types.js";

/** A worker scope you can drive by hand: `send` plays the main thread, `outbox` collects replies. */
function fakeScope() {
  let listener: (event: MessageEvent<WorkerRequest>) => void = () => {};
  const outbox: WorkerResponse[] = [];
  const waiters: Array<() => void> = [];
  const scope: WorkerScope = {
    postMessage(message) {
      outbox.push(message);
      for (const wake of waiters.splice(0)) wake();
    },
    addEventListener(_type, handler) {
      listener = handler;
    },
  };
  return {
    scope,
    outbox,
    send: (request: WorkerRequest) => listener({ data: request } as MessageEvent<WorkerRequest>),
    /** Resolves with the reply that settles request `id` (a result or an error). */
    async settled(id: number) {
      for (;;) {
        const reply = outbox.find((m) => m.id === id && m.type !== "progress");
        if (reply) return reply;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

const echoStt = (): SttAdapter => ({
  id: "echo",
  async load({ onProgress } = {}) {
    onProgress?.(1, 2);
    onProgress?.(2, 2);
  },
  async transcribe(pcm) {
    return `${pcm.length} samples`;
  },
  async dispose() {},
});

describe("serveStt", () => {
  it("loads with progress, then answers a transcribe request", async () => {
    const worker = fakeScope();
    serveStt(echoStt, worker.scope);

    worker.send({ type: "load", id: 1 });
    expect(await worker.settled(1)).toEqual({ type: "result", id: 1, result: { kind: "loaded" } });
    expect(worker.outbox.flatMap((m) => (m.type === "progress" ? [m.loaded] : []))).toEqual([1, 2]);

    worker.send({ type: "transcribe", id: 2, pcm: new Float32Array(160) });
    expect(await worker.settled(2)).toEqual({ type: "result", id: 2, result: { kind: "transcript", text: "160 samples" } });
  });

  it("refuses work before load, and reports a failing load", async () => {
    const worker = fakeScope();
    serveStt(
      () => ({ ...echoStt(), load: async () => Promise.reject(new Error("weights missing")) }),
      worker.scope,
    );

    worker.send({ type: "transcribe", id: 1, pcm: new Float32Array(1) });
    expect(await worker.settled(1)).toMatchObject({ type: "error", error: { message: "The STT adapter is not loaded" } });

    worker.send({ type: "load", id: 2 });
    expect(await worker.settled(2)).toMatchObject({ type: "error", error: { message: "weights missing" } });
  });

  it("drops a queued job that is cancelled before it starts", async () => {
    const worker = fakeScope();
    serveStt(echoStt, worker.scope);

    worker.send({ type: "load", id: 1 });
    worker.send({ type: "transcribe", id: 2, pcm: new Float32Array(1) });
    worker.send({ type: "cancel", id: 3, target: 2 });

    expect(await worker.settled(2)).toMatchObject({ type: "error", error: { name: "AbortError" } });
    expect(await worker.settled(1)).toMatchObject({ type: "result" });
  });

  it("aborts the signal of a running job when it is cancelled", async () => {
    const worker = fakeScope();
    let sawAbort = false;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    serveStt(
      () => ({
        ...echoStt(),
        transcribe: (_pcm, signal) =>
          new Promise((_resolve, reject) => {
            started();
            signal?.addEventListener("abort", () => {
              sawAbort = true;
              reject(signal.reason);
            });
          }),
      }),
      worker.scope,
    );
    worker.send({ type: "load", id: 1 });
    await worker.settled(1);
    worker.send({ type: "transcribe", id: 2, pcm: new Float32Array(1) });
    await running; // The job is really executing, not just queued.
    worker.send({ type: "cancel", id: 3, target: 2 });
    expect(await worker.settled(2)).toMatchObject({ type: "error", error: { name: "AbortError" } });
    expect(sawAbort).toBe(true);
  });

  it("does not synthesise: a TTS request to an STT worker is an error", async () => {
    const worker = fakeScope();
    serveStt(echoStt, worker.scope);
    worker.send({ type: "synthesize", id: 1, text: "hi" });
    expect(await worker.settled(1)).toMatchObject({ type: "error" });
  });
});

describe("serveTts", () => {
  it("returns PCM with its sample rate", async () => {
    const worker = fakeScope();
    const adapter: TtsAdapter = {
      id: "tone",
      async load() {},
      async synthesize(text) {
        return { pcm: new Float32Array(text.length), sampleRate: 24000 };
      },
      async dispose() {},
    };
    serveTts(() => adapter, worker.scope);

    worker.send({ type: "load", id: 1 });
    await worker.settled(1);
    worker.send({ type: "synthesize", id: 2, text: "hello" });
    const reply = await worker.settled(2);
    expect(reply).toMatchObject({ type: "result", result: { kind: "speech", sampleRate: 24000 } });
    expect(reply.type === "result" && reply.result.kind === "speech" && reply.result.pcm.length).toBe(5);
  });
});
