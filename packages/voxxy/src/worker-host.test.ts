import { describe, expect, it } from "vitest";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import { createWorkerHost } from "./worker-host.js";

/** A stand-in for `Worker` that records what it was sent and lets the test answer. */
function fakeWorker() {
  const listeners: Record<string, Array<(event: any) => void>> = {};
  const sent: WorkerRequest[] = [];
  const worker = {
    terminated: false,
    addEventListener: (type: string, listener: (event: any) => void) => (listeners[type] ??= []).push(listener),
    postMessage: (message: WorkerRequest) => void sent.push(message),
    terminate() {
      worker.terminated = true;
    },
  };
  return {
    worker: worker as unknown as Worker & { terminated: boolean },
    sent,
    reply: (message: WorkerResponse) => listeners.message?.forEach((listener) => listener({ data: message })),
    fail: (message: string) => listeners.error?.forEach((listener) => listener({ message })),
  };
}

describe("worker host", () => {
  it("starts lazily and ends the worker on terminate()", () => {
    let spawned = 0;
    const fake = fakeWorker();
    const host = createWorkerHost(() => (spawned++, fake.worker));
    expect(spawned).toBe(0);
    expect(host.running).toBe(false);

    host.start();
    host.start();
    expect(spawned).toBe(1);
    expect(host.running).toBe(true);

    host.terminate();
    expect(fake.worker.terminated).toBe(true);
    expect(host.running).toBe(false);
  });

  it("starts a fresh worker after terminate()", () => {
    let spawned = 0;
    const host = createWorkerHost(() => (spawned++, fakeWorker().worker));
    host.start();
    host.terminate();
    host.start();
    expect(spawned).toBe(2);
  });

  it("terminate() rejects what is in flight with an AbortError", async () => {
    const fake = fakeWorker();
    const host = createWorkerHost(() => fake.worker);
    host.start();
    const pending = host.request((id) => ({ type: "load", id }));
    host.terminate();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a request when no worker is running", async () => {
    const host = createWorkerHost(() => fakeWorker().worker);
    await expect(host.request((id) => ({ type: "load", id }))).rejects.toThrow("not running");
  });

  it("matches replies to requests by id and forwards progress", async () => {
    const fake = fakeWorker();
    const host = createWorkerHost(() => fake.worker);
    host.start();
    const progress: Array<[number, number | null]> = [];
    const first = host.request((id) => ({ type: "load", id }), { onProgress: (l, t) => progress.push([l, t]) });
    const second = host.request((id) => ({ type: "synthesize", id, text: "x" }));
    const [a, b] = fake.sent.map((m) => m.id);

    fake.reply({ type: "progress", id: a!, loaded: 1, total: null });
    fake.reply({ type: "result", id: b!, result: { kind: "speech", pcm: new Float32Array(2), sampleRate: 8000 } });
    fake.reply({ type: "result", id: a!, result: { kind: "loaded" } });

    expect(await first).toEqual({ kind: "loaded" });
    expect(await second).toMatchObject({ kind: "speech", sampleRate: 8000 });
    expect(progress).toEqual([[1, null]]);
  });

  it("aborting a request rejects it at once and tells the worker to drop the job", async () => {
    const fake = fakeWorker();
    const host = createWorkerHost(() => fake.worker);
    host.start();
    const controller = new AbortController();
    const pending = host.request((id) => ({ type: "load", id }), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.sent.at(-1)).toMatchObject({ type: "cancel", target: fake.sent[0]!.id });
  });

  it("a worker that fails to start rejects everything and can be started again", async () => {
    const failing = fakeWorker();
    const host = createWorkerHost(() => failing.worker);
    host.start();
    const pending = host.request((id) => ({ type: "load", id }));
    failing.fail("script not found");
    await expect(pending).rejects.toThrow("script not found");
    expect(host.running).toBe(false);
    host.start();
    expect(host.running).toBe(true);
  });
});
