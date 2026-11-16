import { createModelManager } from "./models/manager.js";
import { createLocalStorageConsentStore } from "./models/consent.js";
import { ModelNotReadyError, type ModelManager, type ModelManagerOptions } from "./models/types.js";
import type {
  Engine,
  ListenOptions,
  Locality,
  ProviderInfo,
  SpeakOptions,
  SttProvider,
  SttSession,
  TtsProvider,
} from "./provider.js";
import { abortError } from "./provider.js";
import { createSpeakStream, type SpeakStream, type SpeakStreamOptions } from "./speak-stream.js";
import type { Kind } from "./types.js";

/**
 * When the selected model is unavailable (the user declined the download, or loading failed), may voxxy use the
 * browser's own speech engine instead? `"any"`: yes, even one that sends audio or text to a browser service.
 * `"local-only"`: only an engine that works on the device. `"off"`: never.
 */
export type PlatformFallbackPolicy = "any" | "local-only" | "off";

/** Options for `createVoxxy`. All of them are optional. */
export interface VoxxyOptions {
  /** Where consent and weights are kept, and how files are fetched. The defaults suit a browser page. */
  models?: ModelManagerOptions;
  /** Browser engine policy per kind. Both default to `any`, which can send speech or text to a browser service. */
  platformFallback?: Partial<Record<Kind, PlatformFallbackPolicy>> & { lang?: string };
}

/** Where a provider is in getting ready: `idle` (not asked yet), `loading`, `ready` to use, or `error` (see `KindState.error`). */
export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** The engine that `listen()` / `speak()` currently go to. The host can always read it, to show a notice if audio may leave the device. */
export interface ActiveProvider {
  id: string;
  engine: Engine;
  locality: Locality;
  /** Why this one is in use when it is a fallback; null when it is simply what the host selected. */
  reason: string | null;
}

/** Everything the host can show about one kind, speech recognition (`stt`) or synthesis (`tts`). */
export interface KindState {
  /** What the host picked. Selecting downloads nothing. */
  selected: ProviderInfo | null;
  /** Set while the provider is loaded and in use; null otherwise. */
  active: ActiveProvider | null;
  /** Whether the provider is ready to use. */
  status: LoadStatus;
  /** Progress of getting the engine ready in memory (the download is on `voxxy.models`). `total` is null when unknown. */
  progress: { loaded: number; total: number | null } | null;
  /** The message of the last load failure, or null. */
  error: string | null;
  /** Why the fallback was unavailable, when neither engine could load. */
  fallbackError: string | null;
}

/** What `voxxy.getState()` returns and `subscribe()` listeners receive: one `KindState` for recognition and one for synthesis. */
export interface VoxxyState {
  /** Speech to text. */
  stt: KindState;
  /** Text to speech. */
  tts: KindState;
}

/** Options shared by calls that can be cancelled. */
export interface CallOptions {
  /** Abort to cancel. */
  signal?: AbortSignal;
}

/** Options for `voxxy.load()`. */
export interface LoadOptions extends CallOptions {
  /** Ask for the allowed browser fallback directly and expose this reason in state. */
  fallbackReason?: string;
}

/** Options for `voxxy.select()`. */
export interface SelectOptions {
  /** Recorded in `active.reason`. Used when a fallback policy picks the provider. */
  reason?: string;
}

/**
 * The host's handle. It owns the providers it was given: it loads and unloads them.
 * A provider instance belongs to one Voxxy; sharing it between two is not supported.
 */
export interface Voxxy {
  /**
   * Consent, download and storage state, per kind. Drive your consent popup and
   * background-download indicator from this; `load()` uses it too.
   */
  models: ModelManager;
  /** On-device browser recognition language pack. Separate from the selected model's consent and download. */
  platformModels: Pick<ModelManager, "getState" | "subscribe" | "optIn" | "optOut">;
  getState(): VoxxyState;
  /** Calls `listener` after every state change. Returns an unsubscribe function. */
  subscribe(listener: (state: VoxxyState) => void): () => void;
  /**
   * Picks the provider for its kind. Cancels a load in progress and unloads the previous
   * provider of that kind. Downloads and loads nothing.
   */
  select(provider: SttProvider | TtsProvider, options?: SelectOptions): void;
  /** Gets the selected provider ready: asks the model manager first (consent, download), then loads it. */
  load(kind: Kind, options?: LoadOptions): Promise<void>;
  /** Cancels a load in progress and unloads the provider. For a worker-backed one this ends the worker. */
  unload(kind: Kind): Promise<void>;
  /** Starts push-to-talk on the active STT provider. Call `stop()` on the session for the text. */
  listen(options?: ListenOptions): SttSession;
  /** Speaks on the active TTS provider. Calls queue; resolves when this utterance has finished. */
  speak(text: string, options?: SpeakOptions): Promise<void>;
  /**
   * Speaks a reply while it is still being written: push text deltas as they arrive and the first sentence sounds
   * before the rest exists. Sentences go to `speak()` one by one, so it works with every provider. `cancel()` stops
   * the sound too, so start a new reply by cancelling the old one. See `SpeakStream`.
   */
  speakStream(options?: SpeakStreamOptions): SpeakStream;
  /** Stops speaking and clears the queue. */
  stopSpeaking(): void;
  /**
   * Call once from a user gesture (a tap or click handler, synchronously, before any `await`). iOS and
   * Chrome start audio only after one, and iOS mutes WebAudio on the silent switch until the page asks
   * for playback audio. Works on the selected providers whether or not they are loaded yet.
   */
  unlock(): Promise<void>;
  /** Unloads both providers. */
  dispose(): Promise<void>;
}

const emptyKind = (): KindState => ({ selected: null, active: null, status: "idle", progress: null, error: null, fallbackError: null });

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const infoOf = (provider: SttProvider | TtsProvider): ProviderInfo => ({
  kind: provider.kind,
  id: provider.id,
  engine: provider.engine,
  locality: provider.locality,
  downloadSize: provider.downloadSize,
});

/**
 * Creates the handle a page talks to. It starts with no provider: pass one to `select()` (for example
 * `moonshineStt()` or `paradeeTts()`), then call `load()`, `listen()` and `speak()`.
 *
 * Nothing is downloaded or loaded until the host asks, and the library draws no UI: consent, progress and text
 * are the host's to show, from `getState()` and `subscribe()`.
 */
export function createVoxxy(options: VoxxyOptions = {}): Voxxy {
  let state: VoxxyState = { stt: emptyKind(), tts: emptyKind() };
  const listeners = new Set<(state: VoxxyState) => void>();
  const consent = options.models?.consent ?? createLocalStorageConsentStore();
  const models = createModelManager({ ...options.models, consent });
  const platformModels = createModelManager({ consent, autoDownload: false });
  const { stt: sttPolicy = "any", tts: ttsPolicy = "any", lang = "en-US" } = options.platformFallback ?? {};
  const sttRegistration = sttPolicy === "off" ? Promise.resolve(undefined) : import("./stt/platform.js").then(async (module) => {
    const local = module.platformStt({ lang });
    await platformModels.register(local);
    return { local, ...module };
  });
  void sttRegistration.catch(() => {});

  const providers: { stt?: SttProvider; tts?: TtsProvider } = {};
  const activeProviders: { stt?: SttProvider; tts?: TtsProvider } = {};
  const reasons: Record<Kind, string | null> = { stt: null, tts: null };
  /** The load in flight per kind, so `select` and `unload` can cancel it. */
  const loads: Partial<Record<Kind, AbortController>> = {};
  /** Pending `models.register()` per kind, so `load` never runs against a half-registered selection. */
  const registrations: Record<Kind, Promise<void>> = { stt: Promise.resolve(), tts: Promise.resolve() };

  function patch(kind: Kind, change: Partial<KindState>): void {
    state = { ...state, [kind]: { ...state[kind], ...change } };
    for (const listener of listeners) listener(state);
  }

  const providerOf = (kind: Kind): SttProvider | TtsProvider | undefined => providers[kind];

  function cancelLoad(kind: Kind): void {
    loads[kind]?.abort(abortError("Load cancelled"));
    delete loads[kind];
  }

  async function loadFallback(kind: Kind, signal: AbortSignal): Promise<SttProvider | TtsProvider> {
    if (kind === "tts") {
      const { detectPlatformTts, platformTts, platformVoices, voiceLocality } = await import("./tts/platform.js");
      signal.throwIfAborted();
      if (!detectPlatformTts()) throw new Error("Browser speech synthesis is unavailable");
      const voices = await platformVoices(lang, signal);
      const local = voices.find((voice) => voiceLocality(voice) === "local");
      const voice = local ?? (ttsPolicy === "any" ? voices[0] : undefined);
      if (!voice) throw new Error(`No ${ttsPolicy === "local-only" ? "local " : ""}browser voice for ${lang}`);
      const fallback = platformTts({ lang, voice: voice.voiceURI, locality: voiceLocality(voice) });
      await fallback.load({ signal });
      return fallback;
    }

    const stt = await sttRegistration;
    if (!stt) throw new Error("Browser recognition fallback is off");
    try {
      await platformModels.ensure("stt", { signal });
      await stt.local.load({ signal });
      return stt.local;
    } catch (error) {
      signal.throwIfAborted();
      if (sttPolicy === "local-only" || !stt.detectPlatformStt().cloud) {
        if (error instanceof ModelNotReadyError) throw new Error(`Browser recognition needs a language pack for ${lang}`);
        throw error;
      }
    }
    const fallback = stt.platformStt({ lang, locality: "cloud" });
    await fallback.load({ signal });
    return fallback;
  }

  async function load(kind: Kind, call: LoadOptions = {}): Promise<void> {
    const provider = providerOf(kind);
    const policy = kind === "stt" ? sttPolicy : ttsPolicy;
    cancelLoad(kind);
    const abort = new AbortController();
    loads[kind] = abort;
    const onCallerAbort = () => abort.abort(call.signal?.reason ?? abortError());
    if (call.signal?.aborted) onCallerAbort();
    else call.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const previous = activeProviders[kind];
    delete activeProviders[kind];
    patch(kind, { status: "loading", active: null, progress: null, error: null, fallbackError: null });
    let fallbackError: string | null = null;
    try {
      if (previous && previous !== provider) await previous.unload();
      let active: SttProvider | TtsProvider;
      let reason = reasons[kind];
      let started = false;
      try {
        abort.signal.throwIfAborted();
        if (call.fallbackReason) throw new Error(call.fallbackReason);
        if (!provider) throw new Error(`No ${kind.toUpperCase()} provider selected`);
        await registrations[kind];
        await models.ensure(kind, { signal: abort.signal });
        abort.signal.throwIfAborted();
        started = true;
        await provider.load({
          signal: abort.signal,
          onProgress: (loaded, total) => {
            if (loads[kind] === abort) patch(kind, { progress: { loaded, total } });
          },
        });
        active = provider;
      } catch (error) {
        abort.signal.throwIfAborted();
        if (isAbort(error) || policy === "off" || provider?.engine === "platform") throw error;
        reason = errorMessage(error);
        if (started || previous === provider) await provider?.unload().catch(() => {});
        abort.signal.throwIfAborted();
        try {
          active = await loadFallback(kind, abort.signal);
        } catch (fallbackFailure) {
          abort.signal.throwIfAborted();
          fallbackError = errorMessage(fallbackFailure);
          if (!provider || call.fallbackReason) throw fallbackFailure;
          throw error;
        }
      }
      abort.signal.throwIfAborted();
      if (active.kind === "stt") activeProviders.stt = active;
      else activeProviders.tts = active;
      patch(kind, { status: "ready", progress: null, active: { id: active.id, engine: active.engine, locality: active.locality, reason } });
    } catch (error) {
      if (loads[kind] === abort) {
        if (abort.signal.aborted || isAbort(error)) patch(kind, { status: "idle", progress: null });
        else patch(kind, { status: "error", progress: null, error: errorMessage(error), fallbackError });
      }
      throw error;
    } finally {
      call.signal?.removeEventListener("abort", onCallerAbort);
      if (loads[kind] === abort) delete loads[kind];
    }
  }

  async function unload(kind: Kind): Promise<void> {
    cancelLoad(kind);
    const provider = providerOf(kind);
    const active = activeProviders[kind];
    delete activeProviders[kind];
    patch(kind, { ...emptyKind(), selected: state[kind].selected });
    await Promise.all([provider?.unload(), active !== provider ? active?.unload() : undefined]);
  }

  const api: Voxxy = {
    models,
    platformModels: {
      getState: platformModels.getState,
      subscribe: platformModels.subscribe,
      async optIn(kind) {
        await sttRegistration;
        await platformModels.optIn(kind);
      },
      async optOut(kind) {
        await sttRegistration;
        await platformModels.optOut(kind);
      },
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    select(provider, selectOptions = {}) {
      const kind = provider.kind;
      const previous = providerOf(kind);
      if (previous === provider) return;
      cancelLoad(kind);
      const active = activeProviders[kind];
      delete activeProviders[kind];
      if (provider.kind === "stt") providers.stt = provider;
      else providers.tts = provider;
      reasons[kind] = selectOptions.reason ?? null;
      patch(kind, { ...emptyKind(), selected: infoOf(provider) });
      registrations[kind] = models.register(provider).catch(() => {});
      // Free the old provider now; for a worker-backed one that ends its worker.
      void previous?.unload().catch(() => {});
      if (active && active !== previous) void active.unload().catch(() => {});
    },
    load,
    unload,
    listen(listenOptions) {
      const provider = activeProviders.stt;
      if (!provider || state.stt.status !== "ready") throw new Error("No STT provider is loaded");
      return provider.listen(listenOptions);
    },
    speak(text, speakOptions) {
      const provider = activeProviders.tts;
      if (!provider || state.tts.status !== "ready") return Promise.reject(new Error("No TTS provider is loaded"));
      return provider.speak(text, speakOptions);
    },
    speakStream(streamOptions) {
      return createSpeakStream({ speak: (text, speakOptions) => api.speak(text, speakOptions), stop: () => api.stopSpeaking() }, streamOptions);
    },
    stopSpeaking() {
      activeProviders.tts?.stop();
    },
    async unlock() {
      // Both calls start synchronously, so each provider's gesture-bound work runs inside the handler.
      await Promise.all([providers.stt?.unlock?.(), providers.tts?.unlock?.()]);
    },
    async dispose() {
      await Promise.all([unload("stt"), unload("tts")]);
    },
  };
  return api;
}
