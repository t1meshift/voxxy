import type { Kind } from "../types.js";
import { createCacheApiFileCache } from "./cache.js";
import { createLocalStorageConsentStore } from "./consent.js";
import {
  ModelNotReadyError,
  ModelUnavailableError,
  type ConsentRecord,
  type InstallAcquisition,
  type ModelFile,
  type ModelManager,
  type ModelManagerOptions,
  type ModelPhase,
  type ModelState,
  type ModelsState,
} from "./types.js";

const emptyState = (): ModelState => ({
  provider: null,
  phase: "not-opted-in",
  downloadSize: null,
  progress: null,
  error: null,
  reason: null,
  evicted: false,
  persisted: null,
});

async function browserPersist(): Promise<boolean | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

async function sha256Hex(response: Response): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Slot {
  /** Bumped on every register/optOut, so work started for an older selection can tell it is stale. */
  generation: number;
  abort: AbortController | null;
  /** Settles when the current download or install attempt ends, successfully or not. */
  running: Promise<void> | null;
}

/**
 * Creates a model manager on its own, for a host that wants consent and downloads without the rest of voxxy.
 * `createVoxxy()` builds one for you and exposes it as `voxxy.models`.
 */
export function createModelManager(options: ModelManagerOptions = {}): ModelManager {
  const consent = options.consent ?? createLocalStorageConsentStore();
  const cache = options.cache ?? createCacheApiFileCache();
  const fetchFile = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const rewriteUrl = options.rewriteUrl ?? ((url: string) => url);
  const autoDownload = options.autoDownload ?? true;
  const persist = options.persist ?? browserPersist;
  const progressIntervalMs = options.progressIntervalMs ?? 100;

  let state: ModelsState = { stt: emptyState(), tts: emptyState() };
  const listeners = new Set<(state: ModelsState) => void>();
  const slots: Record<Kind, Slot> = {
    stt: { generation: 0, abort: null, running: null },
    tts: { generation: 0, abort: null, running: null },
  };

  function patch(kind: Kind, change: Partial<ModelState>): void {
    state = { ...state, [kind]: { ...state[kind], ...change } };
    for (const listener of listeners) listener(state);
  }

  const filesOf = (kind: Kind): readonly ModelFile[] => state[kind].provider?.files ?? [];
  const installOf = (kind: Kind): InstallAcquisition | undefined => state[kind].provider?.install;
  const needsAcquisition = (kind: Kind) => filesOf(kind).length > 0 || installOf(kind) !== undefined;

  async function allPresent(files: readonly ModelFile[]): Promise<boolean> {
    for (const file of files) {
      if ((await cache.stat(file.url)) !== file.size) return false;
    }
    return true;
  }

  async function readRecord(kind: Kind): Promise<ConsentRecord | null> {
    const provider = state[kind].provider;
    return provider ? consent.get(kind, provider.id) : null;
  }

  async function saveRecord(kind: Kind, record: ConsentRecord): Promise<void> {
    const provider = state[kind].provider;
    if (provider) await consent.set(kind, provider.id, record);
  }

  async function downloadFile(file: ModelFile, signal: AbortSignal, onBytes: (count: number) => void): Promise<void> {
    const response = await fetchFile(rewriteUrl(file.url), { signal });
    if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}): ${file.url}`);

    // `Content-Length` is not compared with `file.size` here: a CDN may compress the response (GitHub raw does, with
    // gzip) and then it counts compressed bytes, while a cross-origin page cannot even see `Content-Encoding` to know.
    // The size is checked on the bytes that arrive, below, which is the size that ends up stored.
    let received = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > file.size) throw new Error(`${file.url} is larger than the expected ${file.size} bytes`);
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
      flush() {
        // Throwing here fails the cache write, so a short file is never stored.
        if (received !== file.size) throw new Error(`${file.url} ended after ${received} of ${file.size} bytes`);
      },
    });
    await cache.write(file.url, response.body.pipeThrough(counter), file.size);

    if (file.sha256) {
      const stored = await cache.read(file.url);
      if (!stored || (await sha256Hex(stored)) !== file.sha256) {
        await cache.delete(file.url);
        throw new Error(`Checksum mismatch for ${file.url}`);
      }
    }
  }

  /** Downloads the missing files (`files`), or has the platform install (`install`). Runs in the background. */
  function startAcquisition(kind: Kind, record: ConsentRecord): void {
    const slot = slots[kind];
    if (slot.running) return;
    const files = filesOf(kind);
    const install = installOf(kind);
    const generation = slot.generation;
    const abort = new AbortController();
    slot.abort = abort;

    const total = install ? null : files.reduce((sum, file) => sum + file.size, 0);
    let loaded = 0;
    let lastEmit = 0;
    const fileCount = install ? 1 : files.length;
    const redownload = record.hasBeenReady;
    patch(kind, {
      phase: redownload ? "evicted-redownloading" : "downloading",
      evicted: redownload,
      error: null,
      reason: null,
      progress: { loaded, total, fileIndex: 0, fileCount },
    });

    const downloadFiles = async () => {
      for (const [fileIndex, file] of files.entries()) {
        abort.signal.throwIfAborted();
        if ((await cache.stat(file.url)) === file.size) {
          loaded += file.size; // Finished earlier: keep it.
          continue;
        }
        // A file that is present but the wrong size is junk from an older version.
        await cache.delete(file.url);
        const base = loaded;
        let fileLoaded = 0;
        await downloadFile(file, abort.signal, (count) => {
          fileLoaded += count;
          loaded = base + fileLoaded;
          const now = Date.now();
          if (generation === slot.generation && now - lastEmit >= progressIntervalMs) {
            lastEmit = now;
            patch(kind, { progress: { loaded, total, fileIndex, fileCount } });
          }
        });
        loaded = base + file.size;
        patch(kind, { progress: { loaded, total, fileIndex, fileCount } });
      }
    };

    const runInstall = async (target: InstallAcquisition) => {
      if (!target.install) throw new Error("This provider cannot be installed from here");
      await target.install(abort.signal, (done, size) => {
        if (generation === slot.generation) patch(kind, { progress: { loaded: done, total: size, fileIndex: 0, fileCount: 1 } });
      });
      // An install call that returns is not proof; ask again.
      const after = await target.check();
      if (after.status !== "ready") throw new Error(after.reason ?? "The install finished but the engine is still not ready");
    };

    const run = async () => {
      await (install ? runInstall(install) : downloadFiles());
      abort.signal.throwIfAborted();
      await saveRecord(kind, { ...record, hasBeenReady: true });
    };

    slot.running = run()
      .then(
        () => {
          if (generation !== slot.generation) return;
          patch(kind, { phase: "ready", progress: null, error: null, evicted: false });
        },
        (error) => {
          if (generation !== slot.generation || abort.signal.aborted) return;
          patch(kind, { phase: "error", progress: null, error: errorMessage(error) });
        },
      )
      .finally(() => {
        if (slot.abort === abort) {
          slot.abort = null;
          slot.running = null;
        }
      });
  }

  async function stop(kind: Kind): Promise<void> {
    const slot = slots[kind];
    slot.generation++;
    slot.abort?.abort();
    await slot.running;
    slot.abort = null;
    slot.running = null;
  }

  /** What to do once consent exists but the thing is not there: start now, or wait for `ensure()`. */
  function resume(kind: Kind, record: ConsentRecord): void {
    if (autoDownload) startAcquisition(kind, record);
    else patch(kind, { phase: "opted-in-not-downloaded", progress: null, error: null, reason: null, evicted: record.hasBeenReady });
  }

  async function settleFiles(kind: Kind, generation: number): Promise<void> {
    const files = filesOf(kind);
    const record = await readRecord(kind);
    if (generation !== slots[kind].generation) return;
    if (!record) {
      patch(kind, { phase: "not-opted-in", progress: null, error: null, reason: null, evicted: false });
      return;
    }
    const present = await allPresent(files);
    if (generation !== slots[kind].generation) return;
    if (present) {
      if (!record.hasBeenReady) await saveRecord(kind, { ...record, hasBeenReady: true });
      patch(kind, { phase: "ready", progress: null, error: null, reason: null, evicted: false });
      return;
    }
    resume(kind, record);
  }

  async function settleInstall(kind: Kind, install: InstallAcquisition, generation: number): Promise<void> {
    let result;
    try {
      result = await install.check();
    } catch (error) {
      if (generation !== slots[kind].generation) return;
      patch(kind, { phase: "error", progress: null, error: errorMessage(error), reason: null });
      return;
    }
    if (generation !== slots[kind].generation) return;
    const clear = { progress: null, error: null, evicted: false };

    if (result.status === "unavailable" || (result.status === "installable" && !install.install)) {
      const reason = result.reason ?? "Not available in this browser";
      patch(kind, { ...clear, phase: "unavailable", reason });
      return;
    }
    const record = await readRecord(kind);
    if (generation !== slots[kind].generation) return;
    if (result.status === "ready") {
      // Already present, whoever put it there: nothing to ask the user.
      if (record && !record.hasBeenReady) await saveRecord(kind, { ...record, hasBeenReady: true });
      patch(kind, { ...clear, phase: "ready", reason: null });
      return;
    }
    // Installable. A consent that says it was once ready means it went missing.
    if (!record) patch(kind, { ...clear, phase: "not-opted-in", reason: null });
    else resume(kind, record);
  }

  async function settle(kind: Kind): Promise<void> {
    const generation = slots[kind].generation;
    if (!needsAcquisition(kind)) {
      patch(kind, { phase: "ready", progress: null, error: null, reason: null, evicted: false });
      return;
    }
    const install = installOf(kind);
    await (install ? settleInstall(kind, install, generation) : settleFiles(kind, generation));
  }

  const manager: ModelManager = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async register(provider) {
      if (provider.files?.length && provider.install) {
        throw new Error(`Provider "${provider.id}" declares both files and install; a provider has one acquisition`);
      }
      const kind = provider.kind;
      if (state[kind].provider === provider) return;
      await stop(kind);
      const downloadSize =
        provider.downloadSize ?? (provider.files?.length ? provider.files.reduce((sum, file) => sum + file.size, 0) : null);
      state = { ...state, [kind]: { ...emptyState(), provider, downloadSize, persisted: state[kind].persisted } };
      for (const listener of listeners) listener(state);
      await settle(kind);
    },
    async optIn(kind) {
      const provider = state[kind].provider;
      if (!provider) throw new Error(`No ${kind} provider selected`);
      if (!needsAcquisition(kind)) return;
      if (slots[kind].running) return;
      if (state[kind].phase === "unavailable" || state[kind].phase === "ready") return;
      const existing = await readRecord(kind);
      const record = existing ?? { optedInAt: Date.now(), hasBeenReady: false };
      if (!existing) await saveRecord(kind, record);
      if (!installOf(kind)) {
        // Asked on the user's gesture, which is when browsers are most willing to say yes. Never
        // awaited before the download: Firefox shows a prompt and answers only when the user does.
        // Only for our own cached files; a platform install is stored by the platform.
        void persist().then(
          (granted) => patch(kind, { persisted: granted }),
          () => patch(kind, { persisted: false }),
        );
      }
      startAcquisition(kind, record);
    },
    async optOut(kind) {
      const provider = state[kind].provider;
      if (!provider) return;
      await stop(kind);
      for (const file of filesOf(kind)) await cache.delete(file.url);
      await consent.clear(kind, provider.id);
      // An installed language pack stays on the device; the check tells what is true now.
      if (installOf(kind)) await settle(kind);
      else patch(kind, { phase: needsAcquisition(kind) ? "not-opted-in" : "ready", progress: null, error: null, reason: null, evicted: false });
    },
    async retry(kind) {
      if (state[kind].phase !== "error") return;
      await stop(kind);
      await settle(kind);
    },
    async refresh(kind) {
      if (state[kind].phase === "downloading" || state[kind].phase === "evicted-redownloading") return;
      if (!state[kind].provider) return;
      await settle(kind);
    },
    async ensure(kind, { signal } = {}) {
      if (!state[kind].provider) throw new Error(`No ${kind} provider selected`);
      if (!needsAcquisition(kind)) return;
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        // Ask again once, up front (eviction, or an install that changed); afterwards trust what the attempt reported.
        if (attempt === 0) await manager.refresh(kind);
        let phase: ModelPhase = state[kind].phase;
        if (phase === "not-opted-in") {
          throw new ModelNotReadyError(`The ${kind} model is not downloaded and the user has not opted in`);
        }
        if (phase === "unavailable") throw new ModelUnavailableError(state[kind].reason ?? "Not available");
        if (phase === "opted-in-not-downloaded") {
          const record = await readRecord(kind);
          if (record) startAcquisition(kind, record);
          phase = state[kind].phase;
        }
        if (phase === "ready") return;
        if (phase === "error") throw new Error(state[kind].error ?? "Model download failed");
        // Downloading: wait for this attempt, then look again.
        const running = slots[kind].running;
        if (!running) continue;
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          running.then(() => resolve());
        });
      }
    },
  };

  return manager;
}
