import { abortError } from "./provider.js";
import type { WorkerRequest, WorkerResponse, WorkerResult } from "./protocol.js";
import { deserializeError } from "./protocol.js";

export interface RequestOptions {
  /** Abort to cancel. The promise rejects with an AbortError right away; the worker drops the job. */
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number | null) => void;
  transfer?: Transferable[];
}

/**
 * Owns one worker for one provider: starts it lazily, talks to it, and ends it with
 * `terminate()`. Ending the worker, not unloading a model inside it, is what returns
 * WASM memory: linear memory never shrinks while the worker lives.
 */
export interface WorkerHost {
  readonly running: boolean;
  /** Spawns the worker if it is not running. */
  start(): void;
  /** Sends a request. Rejects if the worker is not running. */
  request(build: (id: number) => WorkerRequest, options?: RequestOptions): Promise<WorkerResult>;
  /** Ends the worker and rejects everything in flight with an AbortError. Safe to call when not running. */
  terminate(): void;
}

interface Pending {
  resolve(result: WorkerResult): void;
  reject(error: unknown): void;
  onProgress?: RequestOptions["onProgress"];
}

export function createWorkerHost(spawn: () => Worker): WorkerHost {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function failAll(error: unknown): void {
    const jobs = [...pending.values()];
    pending.clear();
    for (const job of jobs) job.reject(error);
  }

  return {
    get running() {
      return worker !== null;
    },
    start() {
      if (worker) return;
      const created = spawn();
      created.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        const job = pending.get(message.id);
        if (!job) return;
        if (message.type === "progress") {
          job.onProgress?.(message.loaded, message.total);
          return;
        }
        pending.delete(message.id);
        if (message.type === "result") job.resolve(message.result);
        else job.reject(deserializeError(message.error));
      });
      created.addEventListener("error", (event) => {
        const error = new Error(event.message || "Worker failed to start");
        if (worker === created) worker = null;
        created.terminate();
        failAll(error);
      });
      worker = created;
    },
    request(build, { signal, onProgress, transfer } = {}) {
      const target = worker;
      if (!target) return Promise.reject(new Error("The worker is not running; load the provider first"));
      if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
      const id = nextId++;
      return new Promise<WorkerResult>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const onAbort = () => {
          if (!pending.delete(id)) return;
          target.postMessage({ type: "cancel", id: nextId++, target: id } satisfies WorkerRequest);
          reject(signal?.reason ?? abortError());
        };
        pending.set(id, {
          resolve: (result) => (cleanup(), resolve(result)),
          reject: (error) => (cleanup(), reject(error)),
          onProgress,
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        target.postMessage(build(id), transfer ?? []);
      });
    },
    terminate() {
      const ending = worker;
      worker = null;
      ending?.terminate();
      failAll(abortError("The worker was ended"));
    },
  };
}
