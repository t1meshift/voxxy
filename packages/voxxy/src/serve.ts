import { createCacheApiFileCache, hasCacheApi } from "./models/cache.js";
import type { WorkerRequest, WorkerResponse, WorkerResult } from "./protocol.js";
import { serializeError } from "./protocol.js";
import type { SttAdapter, TtsAdapter } from "./types.js";

/** The slice of a dedicated worker's global scope that `serve*` needs. */
export interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
}

const abortError = () => new DOMException("Aborted", "AbortError");

type Handlers = {
  load(request: Extract<WorkerRequest, { type: "load" }>, signal: AbortSignal, onProgress: (loaded: number, total: number | null) => void): Promise<void>;
  transcribe?(pcm: Float32Array, signal: AbortSignal): Promise<string>;
  synthesize?(text: string, signal: AbortSignal): Promise<{ pcm: Float32Array; sampleRate: number }>;
};

/**
 * The job loop of one worker, which hosts one adapter. Jobs run one at a time in arrival
 * order (WASM inference is single-threaded anyway, and it keeps peak memory predictable).
 * Cancel messages bypass the queue, so a queued job can be dropped before it starts.
 * The worker is ended from outside (`terminate()`), not by a message.
 */
function serveJobs(handlers: Handlers, scope: WorkerScope): void {
  const jobs = new Map<number, AbortController>();
  let queue: Promise<void> = Promise.resolve();

  const post = (message: WorkerResponse, transfer?: Transferable[]) => scope.postMessage(message, transfer);

  async function run(request: Exclude<WorkerRequest, { type: "cancel" }>, signal: AbortSignal): Promise<WorkerResult> {
    signal.throwIfAborted();
    switch (request.type) {
      case "load": {
        await handlers.load(request, signal, (loaded, total) => post({ type: "progress", id: request.id, loaded, total }));
        signal.throwIfAborted();
        return { kind: "loaded" };
      }
      case "transcribe": {
        if (!handlers.transcribe) throw new Error("This worker does not transcribe");
        return { kind: "transcript", text: await handlers.transcribe(request.pcm, signal) };
      }
      case "synthesize": {
        if (!handlers.synthesize) throw new Error("This worker does not synthesise");
        const { pcm, sampleRate } = await handlers.synthesize(request.text, signal);
        signal.throwIfAborted();
        return { kind: "speech", pcm, sampleRate };
      }
    }
  }

  scope.addEventListener("message", (event) => {
    const request = event.data;
    if (request.type === "cancel") {
      jobs.get(request.target)?.abort(abortError());
      return;
    }
    const controller = new AbortController();
    jobs.set(request.id, controller);
    queue = queue
      .then(() => run(request, controller.signal))
      .then(
        (result) => post({ type: "result", id: request.id, result }, result.kind === "speech" ? [result.pcm.buffer] : undefined),
        (error) => post({ type: "error", id: request.id, error: serializeError(error) }),
      )
      .finally(() => jobs.delete(request.id));
  });
}

/** The default entry of a worker script that hosts an STT adapter: `serveStt(() => createAdapter(), self)`. */
export function serveStt(createAdapter: () => SttAdapter, scope: WorkerScope): void {
  let adapter: SttAdapter | undefined;
  // Adapters read the files the host downloaded from the same Cache API. Not present in Node.
  const models = hasCacheApi() ? createCacheApiFileCache() : undefined;
  serveJobs(
    {
      async load(request, signal, onProgress) {
        adapter = createAdapter();
        await adapter.load({ onProgress, signal, wasmBaseUrl: request.wasmBaseUrl, options: request.options, models });
      },
      async transcribe(pcm, signal) {
        if (!adapter) throw new Error("The STT adapter is not loaded");
        return adapter.transcribe(pcm, signal);
      },
    },
    scope,
  );
}

/** The default entry of a worker script that hosts a TTS adapter: `serveTts(() => createAdapter(), self)`. */
export function serveTts(createAdapter: () => TtsAdapter, scope: WorkerScope): void {
  let adapter: TtsAdapter | undefined;
  const models = hasCacheApi() ? createCacheApiFileCache() : undefined;
  serveJobs(
    {
      async load(request, signal, onProgress) {
        adapter = createAdapter();
        await adapter.load({ onProgress, signal, wasmBaseUrl: request.wasmBaseUrl, options: request.options, models });
      },
      async synthesize(text, signal) {
        if (!adapter) throw new Error("The TTS adapter is not loaded");
        return adapter.synthesize(text, signal);
      },
    },
    scope,
  );
}
