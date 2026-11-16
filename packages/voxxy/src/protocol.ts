/**
 * Messages between a provider (main thread) and its own worker. One worker hosts one
 * adapter, so there is no adapter id or kind on the wire. `id` is chosen by the sender and echoed back.
 */
export type WorkerRequest =
  | { type: "load"; id: number; wasmBaseUrl?: string; options?: unknown }
  /** `pcm` is mono 16 kHz; its buffer is transferred. */
  | { type: "transcribe"; id: number; pcm: Float32Array }
  | { type: "synthesize"; id: number; text: string }
  /** Aborts the job whose id is `target`. Gets no reply of its own. */
  | { type: "cancel"; id: number; target: number };

export interface SerializedError {
  name: string;
  message: string;
}

export type WorkerResult =
  | { kind: "loaded" }
  | { kind: "transcript"; text: string }
  | { kind: "speech"; pcm: Float32Array; sampleRate: number };

export type WorkerResponse =
  | { type: "progress"; id: number; loaded: number; total: number | null }
  | { type: "result"; id: number; result: WorkerResult }
  | { type: "error"; id: number; error: SerializedError };

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

export function deserializeError({ name, message }: SerializedError): Error {
  if (name === "AbortError") return new DOMException(message, "AbortError");
  const error = new Error(message);
  error.name = name;
  return error;
}
