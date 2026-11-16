import type { ModelFileReader } from "./models/types.js";

/** The two things voxxy does: `"stt"` is speech to text, `"tts"` is text to speech. */
export type Kind = "stt" | "tts";

/** Passed to an adapter's `load()`. Everything here is optional so adapters stay easy to test. */
export interface AdapterLoadContext {
  /** `total` is null when unknown. */
  onProgress?: (loaded: number, total: number | null) => void;
  /** Aborted when the host cancels the load. Adapters should stop what they are doing. */
  signal?: AbortSignal;
  /** Where the adapter should fetch its WASM runtime files from, if the host overrides it. */
  wasmBaseUrl?: string;
  /** What the provider factory passed as `adapterOptions` (structured-cloneable): for example the URLs its files were declared under. */
  options?: unknown;
  /** Reads the files the host downloaded, by the `url` the provider declared. Absent where there is no Cache API. */
  models?: ModelFileReader;
}

/**
 * Speech-to-text engine inside a worker: mono 16 kHz PCM in, text out.
 * The PCM layer under a worker-backed `SttProvider`; hosts normally use the provider.
 */
export interface SttAdapter {
  readonly id: string;
  load(context?: AdapterLoadContext): Promise<void>;
  transcribe(pcm16k: Float32Array, signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

/** What a `TtsAdapter` returns: the synthesised sound. */
export interface SpeechResult {
  /** Mono samples in the range -1 to 1. */
  pcm: Float32Array;
  /** Samples per second of `pcm`. It differs per model. */
  sampleRate: number;
}

/**
 * Text-to-speech engine inside a worker: text in, PCM plus its sample rate out.
 * Phonemisation is the adapter's own business.
 */
export interface TtsAdapter {
  readonly id: string;
  load(context?: AdapterLoadContext): Promise<void>;
  synthesize(text: string, signal?: AbortSignal): Promise<SpeechResult>;
  dispose(): Promise<void>;
}
