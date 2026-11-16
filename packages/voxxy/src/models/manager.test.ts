import { describe, expect, it } from "vitest";
import type { Kind } from "../types.js";
import { createMemoryConsentStore } from "./consent.js";
import { createModelManager } from "./manager.js";
import {
  ModelNotReadyError,
  ModelUnavailableError,
  type Acquirable,
  type CheckResult,
  type FileCache,
  type InstallAcquisition,
  type ModelManager,
  type ModelPhase,
} from "./types.js";

/** In-memory stand-in for the Cache API, with the same all-or-nothing write. */
function memoryCache() {
  const files = new Map<string, Uint8Array>();
  const cache: FileCache = {
    async stat(url) {
      return files.get(url)?.length ?? null;
    },
    async write(url, body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
      files.set(url, Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));
    },
    async read(url) {
      const bytes = files.get(url);
      return bytes ? new Response(bytes as BodyInit) : null;
    },
    async delete(url) {
      files.delete(url);
    },
  };
  return { cache, files };
}

/** A fetch that serves `bytes` per URL, optionally failing partway on chosen URLs. */
function fakeFetch(served: Record<string, number>, options: { failMidway?: Set<string> } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const size = served[url];
    if (size === undefined) return new Response("nope", { status: 404 });
    const body = new Uint8Array(size).fill(7);
    const half = Math.floor(size / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, half));
        if (options.failMidway?.has(url)) controller.error(new Error("connection lost"));
        else {
          controller.enqueue(body.subarray(half));
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "content-length": String(size) } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const descriptor = (kind: Kind, files: Array<[string, number]>, id = "m"): Acquirable => ({
  kind,
  id,
  downloadSize: files.reduce((sum, [, size]) => sum + size, 0),
  files: files.map(([url, size]) => ({ url, size })),
});

function waitForPhase(manager: ModelManager, kind: Kind, phase: ModelPhase): Promise<void> {
  if (manager.getState()[kind].phase === phase) return Promise.resolve();
  return new Promise((resolve) => {
    const off = manager.subscribe((state) => {
      if (state[kind].phase === phase) {
        off();
        resolve();
      }
    });
  });
}

function setup(served: Record<string, number>, extra: { failMidway?: Set<string>; persist?: () => Promise<boolean | null>; autoDownload?: boolean } = {}) {
  const { cache, files } = memoryCache();
  const consent = createMemoryConsentStore();
  const { fetchFn, calls } = fakeFetch(served, { failMidway: extra.failMidway });
  const make = () =>
    createModelManager({
      cache,
      consent,
      fetch: fetchFn,
      persist: extra.persist ?? (async () => true),
      autoDownload: extra.autoDownload,
      progressIntervalMs: 0,
    });
  return { make, cache, files, consent, calls };
}

const STT = descriptor("stt", [["a.bin", 100], ["b.bin", 50]]);

describe("model manager", () => {
  it("starts not opted in and reports the download size", async () => {
    const { make } = setup({});
    const manager = make();
    await manager.register(STT);
    expect(manager.getState().stt).toMatchObject({ phase: "not-opted-in", downloadSize: 150 });
  });

  it("opt-in stores consent, asks for persistence, downloads in the background and ends ready", async () => {
    const { make, files, consent } = setup({ "a.bin": 100, "b.bin": 50 });
    const manager = make();
    await manager.register(STT);

    await manager.optIn("stt");
    expect(manager.getState().stt.phase).toBe("downloading");
    expect(manager.getState().stt.persisted).toBe(true);
    expect(await consent.get("stt", "m")).toMatchObject({ hasBeenReady: false });

    await waitForPhase(manager, "stt", "ready");
    expect([...files.keys()].sort()).toEqual(["a.bin", "b.bin"]);
    expect(await consent.get("stt", "m")).toMatchObject({ hasBeenReady: true });
    expect(manager.getState().stt.progress).toBeNull();
  });

  it("reports progress across files, counting what it already had", async () => {
    const { make, cache } = setup({ "a.bin": 100, "b.bin": 50 });
    await cache.write("a.bin", new Response(new Uint8Array(100)).body!, 100);
    const manager = make();
    const seen: number[] = [];
    manager.subscribe((state) => state.stt.progress && seen.push(state.stt.progress.loaded));
    await manager.register(STT);
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "ready");
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(150);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it.each([
    ["unavailable", null],
    ["denied", false],
  ])("copes with persistent storage being %s", async (_name, answer) => {
    const { make } = setup({ "a.bin": 100, "b.bin": 50 }, { persist: async () => answer });
    const manager = make();
    await manager.register(STT);
    await manager.optIn("stt");
    expect(manager.getState().stt.persisted).toBe(answer);
    await waitForPhase(manager, "stt", "ready");
  });

  it("does not wait for a persistent-storage prompt that the user never answers", async () => {
    const { make } = setup({ "a.bin": 100, "b.bin": 50 }, { persist: () => new Promise(() => {}) });
    const manager = make();
    await manager.register(STT);
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "ready");
    expect(manager.getState().stt.persisted).toBeNull();
  });

  it("keeps finished files and restarts only the partial one after an interruption", async () => {
    const { make, files, calls } = setup({ "a.bin": 100, "b.bin": 50 }, { failMidway: new Set(["b.bin"]) });
    const manager = make();
    await manager.register(STT);
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "error");

    expect(manager.getState().stt.error).toContain("connection lost");
    expect([...files.keys()]).toEqual(["a.bin"]); // The partial b.bin is not stored.
    expect(calls).toEqual(["a.bin", "b.bin"]);
  });

  it("retry after an error fetches only the missing file", async () => {
    const { cache, files } = memoryCache();
    const consent = createMemoryConsentStore();
    const flaky = fakeFetch({ "a.bin": 100, "b.bin": 50 }, { failMidway: new Set(["b.bin"]) });
    const good = fakeFetch({ "a.bin": 100, "b.bin": 50 });
    let useGood = false;
    const manager = createModelManager({
      cache,
      consent,
      fetch: ((input: RequestInfo | URL) => (useGood ? good.fetchFn : flaky.fetchFn)(input)) as typeof fetch,
      persist: async () => true,
      progressIntervalMs: 0,
    });
    await manager.register(STT);
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "error");
    expect([...files.keys()]).toEqual(["a.bin"]);

    useGood = true;
    await manager.retry("stt");
    await waitForPhase(manager, "stt", "ready");
    expect(good.calls).toEqual(["b.bin"]);
    expect([...files.keys()].sort()).toEqual(["a.bin", "b.bin"]);
  });

  it("rejects a file of the wrong size and stores nothing for it", async () => {
    const { make, files } = setup({ "a.bin": 100, "b.bin": 49 });
    const manager = make();
    await manager.register(STT);
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "error");
    expect(manager.getState().stt.error).toContain("b.bin");
    expect(files.has("b.bin")).toBe(false);
  });

  it("treats an HTTP error as an error", async () => {
    const { make } = setup({ "a.bin": 100 }); // b.bin is a 404
    const manager = make();
    await manager.register(STT);
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "error");
    expect(manager.getState().stt.error).toContain("404");
  });

  it("checks a SHA-256 when one is given", async () => {
    const { make, files } = setup({ "a.bin": 4 });
    const bad = { ...descriptor("stt", [["a.bin", 4]]), files: [{ url: "a.bin", size: 4, sha256: "0".repeat(64) }] };
    const manager = make();
    await manager.register(bad);
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "error");
    expect(manager.getState().stt.error).toContain("Checksum");
    expect(files.has("a.bin")).toBe(false);

    // sha256 of four bytes of 0x07
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(4).fill(7));
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const good = make();
    await good.register({ ...bad, id: "good", files: [{ url: "a.bin", size: 4, sha256 }] });
    await good.optIn("stt");
    await waitForPhase(good, "stt", "ready");
  });

  it("a reload with files present is ready at once, without fetching", async () => {
    const { make, calls } = setup({ "a.bin": 100, "b.bin": 50 });
    const first = make();
    await first.register(STT);
    await first.optIn("stt");
    await waitForPhase(first, "stt", "ready");
    const fetched = calls.length;

    const reloaded = make();
    await reloaded.register(STT);
    expect(reloaded.getState().stt.phase).toBe("ready");
    expect(calls.length).toBe(fetched);
  });

  it("eviction while running: consent is remembered and it re-downloads without asking", async () => {
    const { make, files, calls } = setup({ "a.bin": 100, "b.bin": 50 });
    const manager = make();
    await manager.register(STT);
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "ready");

    files.clear(); // The browser evicts the cache.
    await manager.refresh("stt");
    expect(manager.getState().stt).toMatchObject({ phase: "evicted-redownloading", evicted: true });
    expect(manager.getState().stt.progress).toMatchObject({ loaded: 0, total: 150 });

    await waitForPhase(manager, "stt", "ready");
    expect(manager.getState().stt.evicted).toBe(false);
    expect(files.size).toBe(2);
    expect(calls.length).toBe(4);
  });

  it("eviction between visits: a new manager sees the consent and re-downloads", async () => {
    const { make, files } = setup({ "a.bin": 100, "b.bin": 50 });
    const first = make();
    await first.register(STT);
    await first.optIn("stt");
    await waitForPhase(first, "stt", "ready");
    files.clear();

    const second = make();
    await second.register(STT);
    expect(second.getState().stt.phase).toBe("evicted-redownloading");
    await waitForPhase(second, "stt", "ready");
  });

  it("a download that never finished resumes as a plain download, not as an eviction", async () => {
    const { make, consent } = setup({ "a.bin": 100, "b.bin": 50 });
    await consent.set("stt", "m", { optedInAt: 1, hasBeenReady: false });
    const manager = make();
    await manager.register(STT);
    expect(manager.getState().stt).toMatchObject({ phase: "downloading", evicted: false });
    await waitForPhase(manager, "stt", "ready");
  });

  it("with autoDownload off, stays opted-in-not-downloaded until ensure() is called", async () => {
    const { make, consent, calls } = setup({ "a.bin": 100, "b.bin": 50 }, { autoDownload: false });
    await consent.set("stt", "m", { optedInAt: 1, hasBeenReady: true });
    const manager = make();
    await manager.register(STT);
    expect(manager.getState().stt).toMatchObject({ phase: "opted-in-not-downloaded", evicted: true });
    expect(calls).toEqual([]);

    await manager.ensure("stt");
    expect(manager.getState().stt.phase).toBe("ready");
  });

  it("opt-out stops the download, deletes the files and forgets the consent", async () => {
    const { make, files, consent } = setup({ "a.bin": 100, "b.bin": 50 });
    const manager = make();
    await manager.register(STT);
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "ready");

    await manager.optOut("stt");
    expect(manager.getState().stt.phase).toBe("not-opted-in");
    expect(files.size).toBe(0);
    expect(await consent.get("stt", "m")).toBeNull();
  });

  it("ensure() refuses without consent, and waits for a running download", async () => {
    const { make } = setup({ "a.bin": 100, "b.bin": 50 });
    const manager = make();
    await manager.register(STT);
    await expect(manager.ensure("stt")).rejects.toBeInstanceOf(ModelNotReadyError);

    await manager.optIn("stt");
    await manager.ensure("stt");
    expect(manager.getState().stt.phase).toBe("ready");
  });

  it("ensure() reports a failed download instead of retrying forever", async () => {
    const { make } = setup({ "a.bin": 100, "b.bin": 50 }, { failMidway: new Set(["b.bin"]) });
    const manager = make();
    await manager.register(STT);
    await manager.optIn("stt");
    await expect(manager.ensure("stt")).rejects.toThrow("connection lost");
  });

  it("STT and TTS are independent", async () => {
    const { make } = setup({ "a.bin": 100, "b.bin": 50, "t.bin": 30 });
    const manager = make();
    await manager.register(STT);
    await manager.register(descriptor("tts", [["t.bin", 30]], "voice"));
    await manager.optIn("tts");
    await waitForPhase(manager, "tts", "ready");
    expect(manager.getState().stt.phase).toBe("not-opted-in");
  });

  it("an adapter without files needs no consent", async () => {
    const { make } = setup({});
    const manager = make();
    await manager.register({ kind: "stt", id: "dummy", downloadSize: 0 });
    expect(manager.getState().stt.phase).toBe("ready");
    await manager.ensure("stt");
  });

  it("selecting another adapter cancels the running download of the first", async () => {
    const { make, files } = setup({ "a.bin": 100, "b.bin": 50, "c.bin": 20 });
    const manager = make();
    await manager.register(STT);
    await manager.optIn("stt");
    await manager.register(descriptor("stt", [["c.bin", 20]], "other"));
    expect(manager.getState().stt).toMatchObject({ phase: "not-opted-in", downloadSize: 20 });
    expect(files.has("c.bin")).toBe(false);
  });
});

/** A platform engine whose state the test controls. `install()` flips it to ready unless told to fail. */
function fakeInstall(initial: CheckResult, { installs = true, finishes = true }: { installs?: boolean; finishes?: boolean } = {}) {
  let current = initial;
  const calls = { check: 0, install: 0 };
  const install: InstallAcquisition = {
    async check() {
      calls.check++;
      return current;
    },
    ...(installs
      ? {
          async install(_signal: AbortSignal, onProgress?: (loaded: number, total: number | null) => void) {
            calls.install++;
            onProgress?.(0, null); // Platform installs usually cannot say how far along they are.
            await Promise.resolve();
            if (finishes) current = { status: "ready" };
          },
        }
      : {}),
  };
  return { install, calls, set: (next: CheckResult) => void (current = next) };
}

const pack = (install: InstallAcquisition, id = "pack"): Acquirable => ({ kind: "stt", id, install });

describe("model manager: platform installs", () => {
  it("an engine that is already there needs no consent", async () => {
    const { make } = setup({});
    const manager = make();
    const { install, calls } = fakeInstall({ status: "ready" });
    await manager.register(pack(install));
    expect(manager.getState().stt).toMatchObject({ phase: "ready", downloadSize: null });
    expect(calls.install).toBe(0);
  });

  it("asks first, installs only after opt-in, with progress of unknown total, and never asks for persistent storage", async () => {
    let persistAsked = 0;
    const { make, consent } = setup({}, { persist: async () => (persistAsked++, true) });
    const manager = make();
    const { install, calls } = fakeInstall({ status: "installable" });
    await manager.register(pack(install));
    expect(manager.getState().stt.phase).toBe("not-opted-in");
    expect(calls.install).toBe(0);

    const totals: Array<number | null> = [];
    manager.subscribe((s) => s.stt.progress && totals.push(s.stt.progress.total));
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "ready");
    expect(calls.install).toBe(1);
    expect(totals).toContain(null);
    expect(persistAsked).toBe(0);
    expect(await consent.get("stt", "pack")).toMatchObject({ hasBeenReady: true });
  });

  it("notices that the engine went missing and installs again, without asking", async () => {
    const { make } = setup({});
    const first = make();
    const { install, calls, set } = fakeInstall({ status: "installable" });
    const provider = pack(install);
    await first.register(provider);
    await first.optIn("stt");
    await waitForPhase(first, "stt", "ready");

    set({ status: "installable" }); // The browser dropped the language pack.
    await first.refresh("stt");
    expect(first.getState().stt).toMatchObject({ phase: "evicted-redownloading", evicted: true });
    await waitForPhase(first, "stt", "ready");
    expect(calls.install).toBe(2);
  });

  it("is a final answer when the check says unavailable, and ensure() carries the reason", async () => {
    const { make } = setup({});
    const manager = make();
    const { install, calls } = fakeInstall({ status: "unavailable", reason: "no recognition for es-MX" });
    await manager.register(pack(install));
    expect(manager.getState().stt).toMatchObject({ phase: "unavailable", reason: "no recognition for es-MX" });

    await manager.optIn("stt");
    expect(calls.install).toBe(0);
    await expect(manager.ensure("stt")).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(manager.ensure("stt")).rejects.toThrow("no recognition for es-MX");
  });

  it("a check-only provider has no consent step: installable counts as unavailable", async () => {
    const { make } = setup({});
    const manager = make();
    const { install } = fakeInstall({ status: "installable", reason: "no voice for en-GB" }, { installs: false });
    await manager.register({ kind: "stt", id: "voices", install });
    expect(manager.getState().stt).toMatchObject({ phase: "unavailable", reason: "no voice for en-GB" });
  });

  it("an install that returns but is not ready afterwards is an error", async () => {
    const { make } = setup({});
    const manager = make();
    const { install } = fakeInstall({ status: "installable" }, { finishes: false });
    await manager.register(pack(install));
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "error");
    expect(manager.getState().stt.error).toContain("not ready");
  });

  it("asks check() again inside ensure(), never trusting an earlier answer", async () => {
    const { make } = setup({});
    const manager = make();
    const { install, calls, set } = fakeInstall({ status: "ready" });
    await manager.register(pack(install));
    const before = calls.check;
    await manager.ensure("stt");
    expect(calls.check).toBeGreaterThan(before);

    set({ status: "unavailable", reason: "removed" });
    await expect(manager.ensure("stt")).rejects.toThrow("removed");
  });

  it("opting out forgets the consent but cannot remove what the platform installed", async () => {
    const { make, consent } = setup({});
    const manager = make();
    const { install } = fakeInstall({ status: "installable" });
    await manager.register(pack(install));
    await manager.optIn("stt");
    await waitForPhase(manager, "stt", "ready");

    await manager.optOut("stt");
    expect(await consent.get("stt", "pack")).toBeNull();
    expect(manager.getState().stt.phase).toBe("ready"); // Still installed, so still usable.
  });

  it("a provider has one acquisition: files and install together is refused", async () => {
    const { make } = setup({});
    const manager = make();
    const { install } = fakeInstall({ status: "ready" });
    await expect(manager.register({ ...descriptor("stt", [["a.bin", 1]]), install })).rejects.toThrow("one acquisition");
  });
});
