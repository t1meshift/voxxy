import type { InstallAcquisition, ModelFile, ModelFileReader } from "./models/types.js";
import type { Kind } from "./types.js";

/** Where the work happens. `worker`: our own models in a Web Worker. `platform`: the browser's engine. `custom`: the host's. */
export type Engine = "worker" | "platform" | "custom";

/**
 * Whether audio or text leaves the device. Fixed per provider instance: where one
 * engine can run both ways, the module offers two instances.
 */
export type Locality = "local" | "cloud" | "unknown";

/** What the facade hands to a provider's `load()`: a progress callback and a way to cancel. */
export interface ProviderLoadContext {
  /** Progress of getting the engine ready in memory (not the download, which `voxxy.models` reports). */
  onProgress?: (loaded: number, total: number | null) => void;
  /** Aborted when the host cancels the load. */
  signal?: AbortSignal;
}

/** What every provider says about itself. Read-only data, safe to put in state. */
export interface ProviderInfo<K extends Kind = Kind> {
  readonly kind: K;
  readonly id: string;
  readonly engine: Engine;
  readonly locality: Locality;
  /** For the consent text. Falls back to the sum of `files`; null or absent when unknown. */
  readonly downloadSize?: number | null;
}

/**
 * Common to both kinds. A provider owns whatever it needs to produce text or
 * sound (microphone, playback, worker); the core never reaches inside.
 * The host creates it, passes it to `voxxy.select()`, and one provider belongs to
 * one Voxxy instance: sharing it between two is not supported.
 */
export interface Provider<K extends Kind = Kind> extends ProviderInfo<K> {
  /**
   * What must be on the device before this provider can run. At most one of:
   * `files` (we download, verify and cache them) or `install` (the platform does it).
   * Neither: no consent step, `load()` runs at once.
   */
  readonly files?: readonly ModelFile[];
  readonly install?: InstallAcquisition;
  /** Gets the engine ready (starts the worker, loads the model). Called after any acquisition is done. */
  load(context?: ProviderLoadContext & { models?: ModelFileReader }): Promise<void>;
  /** Releases everything. For a worker-backed provider this ends the worker, which is what returns WASM memory. */
  unload(): Promise<void>;
  /**
   * Gets what only a user gesture can get: audio output on iOS and Chrome, for example. The facade's
   * `voxxy.unlock()` calls it, so the host calls that once from a tap handler. Optional: absent where there is nothing to unlock.
   */
  unlock?(): Promise<void>;
}

/**
 * One push-to-talk recording, returned by `voxxy.listen()`. Call `stop()` when the button is released, or
 * `cancel()` to drop it.
 */
export interface SttSession {
  /** Ends the recording and resolves with the final text. */
  stop(): Promise<string>;
  /** Drops the recording and any transcription in progress. `stop()` then rejects with an AbortError. */
  cancel(): void;
}

/** Options for `listen()`. */
export interface ListenOptions {
  /** Abort to drop the recording, like `cancel()` on the session. */
  signal?: AbortSignal;
}

/** Push-to-talk speech recognition. No streaming partial results in the interface. */
export interface SttProvider extends Provider<"stt"> {
  listen(options?: ListenOptions): SttSession;
}

/** Options for `speak()`. */
export interface SpeakOptions {
  /** Abort to cancel this utterance: it stops if it is playing, or is dropped from the queue. The returned promise rejects with an AbortError. */
  signal?: AbortSignal;
}

/** Speech synthesis that plays the sound itself. */
export interface TtsProvider extends Provider<"tts"> {
  /**
   * Resolves when this utterance has finished playing. Calls queue: a `speak` made
   * while another is playing starts after it, in order.
   */
  speak(text: string, options?: SpeakOptions): Promise<void>;
  /** Clears the queue and stops the sound. Pending `speak` promises reject with an AbortError. */
  stop(): void;
}

export const abortError = (message = "Aborted"): DOMException => new DOMException(message, "AbortError");
