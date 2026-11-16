import { describe, expect, it } from "vitest";
import { createVoxxy } from "./client.js";
import { createMemoryConsentStore } from "./models/consent.js";
import { ModelNotReadyError, type InstallAcquisition } from "./models/types.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import type { Engine, Locality, SttProvider, TtsProvider } from "./provider.js";
import { serveStt, serveTts, type WorkerScope } from "./serve.js";
import { fakePlayer, fakeRecorder } from "./testing.js";
import { createAdapter as dummySttAdapter } from "./stt/dummy.impl.js";
import { createAdapter as dummyTtsAdapter } from "./tts/dummy.impl.js";
import { workerStt, workerTts } from "./worker-providers.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A provider that records what the facade does to it. */
function spyStt(id: string, extra: { engine?: Engine; locality?: Locality; install?: InstallAcquisition; gate?: Promise<void> } = {}) {
  const calls: string[] = [];
  let loadSignal: AbortSignal | undefined;
  const provider: SttProvider = {
    kind: "stt",
    id,
    engine: extra.engine ?? "custom",
    locality: extra.locality ?? "unknown",
    install: extra.install,
    async load({ signal } = {}) {
      calls.push("load");
      loadSignal = signal;
      await extra.gate;
    },
    async unload() {
      calls.push("unload");
    },
    listen: () => ({ stop: async () => `heard by ${id}`, cancel() {} }),
  };
  return { provider, calls, loadSignal: () => loadSignal };
}

function spyTts(id: string) {
  const spoken: string[] = [];
  let stopped = 0;
  const provider: TtsProvider = {
    kind: "tts",
    id,
    engine: "custom",
    locality: "local",
    async load() {},
    async unload() {},
    async speak(text) {
      spoken.push(text);
    },
    stop() {
      stopped++;
    },
  };
  return { provider, spoken, stopped: () => stopped };
}

const newVoxxy = () => createVoxxy({ models: { consent: createMemoryConsentStore(), persist: async () => true } });

describe("facade: state and `active`", () => {
  it("select() stores the choice and loads nothing", () => {
    const voxxy = newVoxxy();
    const { provider, calls } = spyStt("a", { engine: "platform", locality: "cloud" });
    voxxy.select(provider);
    expect(voxxy.getState().stt).toMatchObject({
      selected: { id: "a", engine: "platform", locality: "cloud" },
      active: null,
      status: "idle",
    });
    expect(calls).toEqual([]);
  });

  it("load() goes idle, loading, ready; `active` appears with engine and locality", async () => {
    const voxxy = newVoxxy();
    const { provider } = spyStt("a", { engine: "platform", locality: "cloud" });
    const seen: string[] = [];
    voxxy.subscribe((s) => seen.push(`${s.stt.status}:${s.stt.active?.id ?? "-"}`));
    voxxy.select(provider);
    await voxxy.load("stt");
    expect(seen.at(-3)).toBe("idle:-");
    expect(seen).toContain("loading:-");
    expect(voxxy.getState().stt.active).toEqual({ id: "a", engine: "platform", locality: "cloud", reason: null });
  });

  it("carries the reason a fallback was chosen", async () => {
    const voxxy = newVoxxy();
    const { provider } = spyStt("fallback", { engine: "platform", locality: "cloud" });
    voxxy.select(provider, { reason: "user declined the download" });
    await voxxy.load("stt");
    expect(voxxy.getState().stt.active?.reason).toBe("user declined the download");
  });

  it("selecting another provider unloads the first and clears `active`", async () => {
    const voxxy = newVoxxy();
    const first = spyStt("one");
    const second = spyStt("two");
    voxxy.select(first.provider);
    await voxxy.load("stt");
    voxxy.select(second.provider);
    await tick();
    expect(first.calls).toEqual(["load", "unload"]);
    expect(voxxy.getState().stt).toMatchObject({ active: null, status: "idle", selected: { id: "two" } });
  });

  it("unload() unloads and clears `active`", async () => {
    const voxxy = newVoxxy();
    const { provider, calls } = spyStt("a");
    voxxy.select(provider);
    await voxxy.load("stt");
    await voxxy.unload("stt");
    expect(calls).toEqual(["load", "unload"]);
    expect(voxxy.getState().stt).toMatchObject({ active: null, status: "idle" });
  });

  it("aborting a load stops it and leaves the kind idle", async () => {
    const voxxy = newVoxxy();
    const never = new Promise<void>(() => {});
    const { provider, loadSignal } = spyStt("slow", { gate: never });
    voxxy.select(provider);
    const controller = new AbortController();
    const loading = voxxy.load("stt", { signal: controller.signal }).catch((e: Error) => e.name);
    await tick();
    controller.abort();
    expect(loadSignal()?.aborted).toBe(true);
    // The provider ignores the signal in this test, so release the facade by unloading.
    await voxxy.unload("stt");
    expect(voxxy.getState().stt.status).toBe("idle");
    void loading;
  });

  it("a failing load shows the error and keeps `active` empty", async () => {
    const voxxy = newVoxxy();
    const { provider } = spyStt("broken");
    provider.load = async () => Promise.reject(new Error("no WebAssembly"));
    voxxy.select(provider);
    await expect(voxxy.load("stt")).rejects.toThrow("no WebAssembly");
    expect(voxxy.getState().stt).toMatchObject({ status: "error", error: "no WebAssembly", active: null });
  });

  it("dispose() unloads both kinds", async () => {
    const voxxy = newVoxxy();
    const stt = spyStt("s");
    voxxy.select(stt.provider);
    voxxy.select(spyTts("t").provider);
    await voxxy.load("stt");
    await voxxy.dispose();
    expect(stt.calls).toEqual(["load", "unload"]);
  });
});

describe("facade: listen and speak", () => {
  it("refuse until the provider is loaded, then delegate", async () => {
    const voxxy = newVoxxy();
    const tts = spyTts("t");
    voxxy.select(spyStt("s").provider);
    voxxy.select(tts.provider);
    expect(() => voxxy.listen()).toThrow("No STT provider is loaded");
    await expect(voxxy.speak("hi")).rejects.toThrow("No TTS provider is loaded");

    await Promise.all([voxxy.load("stt"), voxxy.load("tts")]);
    expect(await voxxy.listen().stop()).toBe("heard by s");
    await voxxy.speak("hi");
    voxxy.stopSpeaking();
    expect(tts.spoken).toEqual(["hi"]);
    expect(tts.stopped()).toBe(1);
  });
});

describe("facade: speakStream", () => {
  it("speaks a reply sentence by sentence through the active provider, and stops it on cancel", async () => {
    const voxxy = newVoxxy();
    const tts = spyTts("t");
    voxxy.select(tts.provider);
    await voxxy.load("tts");

    const stream = voxxy.speakStream({ minChars: 0 });
    for (const token of "Hello there, my friend. How are you today? Fine, thanks.".split(/(?<= )/)) await stream.push(token);
    await tick();
    expect(tts.spoken).toEqual(["Hello there, my friend.", "How are you today?"]);
    await stream.end();
    expect(tts.spoken).toEqual(["Hello there, my friend.", "How are you today?", "Fine, thanks."]);

    const second = voxxy.speakStream();
    await second.push("Another reply that is going to be cut short. ");
    second.cancel();
    expect(tts.stopped()).toBe(1);
    await expect(second.end()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses until a TTS provider is loaded, like speak()", async () => {
    const voxxy = newVoxxy();
    const stream = voxxy.speakStream();
    await stream.push("Nothing is loaded yet. ");
    await expect(stream.end()).rejects.toThrow("No TTS provider is loaded");
  });
});

describe("facade: consent", () => {
  it("a provider with no acquisition skips consent and loads at once", async () => {
    const voxxy = newVoxxy();
    voxxy.select(spyStt("cloud-custom").provider);
    await voxxy.load("stt");
    expect(voxxy.models.getState().stt.phase).toBe("ready");
    expect(voxxy.getState().stt.status).toBe("ready");
  });

  it("an install acquisition is gated by consent: refused first, loads after opt-in", async () => {
    const voxxy = newVoxxy();
    let installed = false;
    const install: InstallAcquisition = {
      check: async () => ({ status: installed ? "ready" : "installable" }),
      install: async () => void (installed = true),
    };
    const { provider, calls } = spyStt("on-device", { install });
    voxxy.select(provider);

    await expect(voxxy.load("stt")).rejects.toBeInstanceOf(ModelNotReadyError);
    expect(voxxy.getState().stt.status).toBe("error");
    expect(calls).toEqual([]); // The provider was never asked to load.

    await voxxy.models.optIn("stt");
    await voxxy.load("stt");
    expect(installed).toBe(true);
    expect(calls).toEqual(["load"]);
    expect(voxxy.getState().stt.status).toBe("ready");
  });
});

/**
 * A Worker stand-in wired straight to the real `serveStt` / `serveTts`, so the provider,
 * the worker host, the protocol and the job loop run together in Node.
 */
function loopbackWorker(start: (scope: WorkerScope) => void) {
  const toHost: Array<(event: { data: WorkerResponse }) => void> = [];
  let toServe: (event: { data: WorkerRequest }) => void = () => {};
  const scope = {
    postMessage: (message: WorkerResponse) => void queueMicrotask(() => toHost.forEach((l) => l({ data: message }))),
    addEventListener: (_type: string, listener: typeof toServe) => void (toServe = listener),
  } as unknown as WorkerScope;
  start(scope);
  const worker = {
    terminated: false,
    addEventListener: (type: string, listener: (typeof toHost)[number]) => void (type === "message" && toHost.push(listener)),
    postMessage: (message: WorkerRequest) => void queueMicrotask(() => toServe({ data: message })),
    terminate() {
      worker.terminated = true;
    },
  };
  return worker as unknown as Worker & { terminated: boolean };
}

describe("worker providers", () => {
  it("TTS: load starts a worker, speak queues and plays in order, unload ends the worker", async () => {
    const workers: Array<Worker & { terminated: boolean }> = [];
    const played: number[] = [];
    const provider = workerTts({
      id: "dummy",
      spawn: () => {
        const worker = loopbackWorker((scope) => serveTts(dummyTtsAdapter, scope));
        workers.push(worker);
        return worker;
      },
      player: fakePlayer({ speed: 1000, onPlay: ({ samples }) => played.push(samples) }),
    });
    expect(workers).toHaveLength(0); // Lazy.

    await provider.load();
    expect(workers).toHaveLength(1);
    await Promise.all([provider.speak("hello"), provider.speak("hi")]);
    expect(played).toEqual([6000, 2400]); // 24 kHz, 50 ms per character, in call order.

    await provider.unload();
    expect(workers[0]!.terminated).toBe(true);
    await expect(provider.speak("again")).rejects.toThrow("not running");

    await provider.load(); // A fresh worker, because the old one is gone.
    expect(workers).toHaveLength(2);
    await provider.unload();
  });

  it("TTS: unload() while speaking rejects the pending call with an AbortError", async () => {
    const provider = workerTts({
      id: "dummy",
      spawn: () => loopbackWorker((scope) => serveTts(dummyTtsAdapter, scope)),
      player: fakePlayer({ speed: 0.01 }), // Very slow, so it is still playing.
    });
    await provider.load();
    const speaking = provider.speak("hello").then(() => "done", (e: Error) => e.name);
    await tick();
    await provider.unload();
    expect(await speaking).toBe("AbortError");
  });

  it("STT: listen() records and transcribes through the worker", async () => {
    const provider = workerStt({
      id: "dummy",
      spawn: () => loopbackWorker((scope) => serveStt(dummySttAdapter, scope)),
      recorder: fakeRecorder(),
    });
    await provider.load();
    const text = await provider.listen().stop();
    expect(text).toMatch(/^dummy transcript: \d+ samples/);
    await provider.unload();
  });

  it("a load that fails ends the worker, since a half-loaded one only holds memory", async () => {
    let worker!: Worker & { terminated: boolean };
    const provider = workerStt({
      id: "broken",
      spawn: () =>
        (worker = loopbackWorker((scope) =>
          serveStt(() => ({ ...dummySttAdapter(), load: async () => Promise.reject(new Error("bad weights")) }), scope),
        )),
      recorder: fakeRecorder(),
    });
    await expect(provider.load()).rejects.toThrow("bad weights");
    expect(worker.terminated).toBe(true);
  });

  it("works through the facade, with `active` showing the worker engine", async () => {
    const voxxy = newVoxxy();
    voxxy.select(
      workerTts({
        id: "dummy",
        spawn: () => loopbackWorker((scope) => serveTts(dummyTtsAdapter, scope)),
        player: fakePlayer({ speed: 1000 }),
      }),
    );
    await voxxy.load("tts");
    expect(voxxy.getState().tts.active).toMatchObject({ engine: "worker", locality: "local" });
    await voxxy.speak("ok");
    await voxxy.dispose();
  });
});
