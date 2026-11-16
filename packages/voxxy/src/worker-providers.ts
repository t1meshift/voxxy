import { pcmListener, pcmSpeaker, type ChunkInfo, type Player, type Recorder } from "./pcm.js";
import type { ModelFile } from "./models/types.js";
import type { SttProvider, TtsProvider } from "./provider.js";
import type { SplitterOptions } from "./sentences.js";
import { createWorkerHost } from "./worker-host.js";

interface WorkerProviderOptions {
  id: string;
  /**
   * Creates this provider's worker. Lives in each adapter's entry point, because bundlers only
   * emit the worker script for the literal form `new Worker(new URL("./x.worker.js", import.meta.url), { type: "module" })`.
   * `workerUrl` is the host's override, when it serves the script itself.
   */
  spawn(workerUrl?: string | URL): Worker;
  workerUrl?: string | URL;
  /** Where the adapter fetches its WASM runtime files from, when they are not already in storage. */
  wasmBaseUrl?: string;
  /** Handed to the adapter's `load()` as `context.options`. Must be structured-cloneable. */
  adapterOptions?: unknown;
  /** Weights to download before `load()`. The manager checks, downloads and verifies them. */
  files?: readonly ModelFile[];
  downloadSize?: number;
}

/** Options for `workerStt`: the shared ones plus the recorder that captures the microphone. */
export interface WorkerSttOptions extends WorkerProviderOptions {
  /** Captures mono 16 kHz audio. `createMicRecorder` is the real one. */
  recorder: Recorder;
}

/** Options for `workerTts`: the shared ones plus the player that plays the sound. */
export interface WorkerTtsOptions extends WorkerProviderOptions {
  /** Plays PCM. `createWebAudioPlayer` is the real one. */
  player: Player;
  /** How many texts may be synthesised ahead of the one playing. Default 1. */
  maxAhead?: number;
  /** How `speak()` cuts long text into sentences before synthesising them one by one. */
  splitter?: SplitterOptions;
  /** Called for every chunk once it is synthesised: its text, size, how long it took and how long it plays. For logs and the stand. */
  onChunk?: (info: ChunkInfo) => void;
}

/**
 * A speech-to-text provider backed by an adapter in its own worker. The worker starts
 * on `load()` and ends on `unload()`.
 */
export function workerStt(options: WorkerSttOptions): SttProvider {
  const host = createWorkerHost(() => options.spawn(options.workerUrl));
  const listen = pcmListener({
    recorder: options.recorder,
    async transcribe(pcm, signal) {
      const result = await host.request((id) => ({ type: "transcribe", id, pcm }), { signal, transfer: [pcm.buffer] });
      if (result.kind !== "transcript") throw new Error(`Unexpected worker result "${result.kind}"`);
      return result.text;
    },
  });
  return {
    kind: "stt",
    id: options.id,
    engine: "worker",
    locality: "local",
    files: options.files,
    downloadSize: options.downloadSize,
    async load({ signal, onProgress } = {}) {
      host.start();
      try {
        await host.request((id) => ({ type: "load", id, wasmBaseUrl: options.wasmBaseUrl, options: options.adapterOptions }), { signal, onProgress });
      } catch (error) {
        host.terminate(); // A half-loaded worker is of no use and holds memory.
        throw error;
      }
    },
    async unload() {
      host.terminate();
    },
    listen,
  };
}

/**
 * A text-to-speech provider backed by an adapter in its own worker. Queued `speak()` calls
 * are synthesised ahead while the current one plays.
 */
export function workerTts(options: WorkerTtsOptions): TtsProvider {
  const host = createWorkerHost(() => options.spawn(options.workerUrl));
  const speaker = pcmSpeaker({
    player: options.player,
    maxAhead: options.maxAhead,
    splitter: options.splitter,
    onChunk: options.onChunk,
    async synthesize(text, signal) {
      const result = await host.request((id) => ({ type: "synthesize", id, text }), { signal });
      if (result.kind !== "speech") throw new Error(`Unexpected worker result "${result.kind}"`);
      return { pcm: result.pcm, sampleRate: result.sampleRate };
    },
  });
  return {
    kind: "tts",
    id: options.id,
    engine: "worker",
    locality: "local",
    files: options.files,
    downloadSize: options.downloadSize,
    async load({ signal, onProgress } = {}) {
      host.start();
      try {
        await host.request((id) => ({ type: "load", id, wasmBaseUrl: options.wasmBaseUrl, options: options.adapterOptions }), { signal, onProgress });
      } catch (error) {
        host.terminate();
        throw error;
      }
    },
    async unload() {
      speaker.stop();
      host.terminate();
    },
    unlock: () => options.player.unlock?.() ?? Promise.resolve(),
    speak: speaker.speak,
    stop: speaker.stop,
  };
}
