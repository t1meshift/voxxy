import { claimMicrophone, mapMediaError, MicrophoneError } from "../audio/errors.js";
import type { InstallAcquisition } from "../models/types.js";
import { abortError, type SttProvider } from "../provider.js";

interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionOptions {
  langs: string[];
  processLocally: true;
}

type Availability = "available" | "downloadable" | "downloading" | "unavailable";

interface RecognitionConstructor {
  new (): Recognition;
  available?(options: RecognitionOptions): Promise<Availability>;
  install?(options: RecognitionOptions): Promise<boolean>;
}

function recognitionConstructor(): RecognitionConstructor | undefined {
  const browser = globalThis as typeof globalThis & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return [browser.SpeechRecognition, browser.webkitSpeechRecognition].find((Recognition) =>
    typeof Recognition === "function" && (["start", "stop", "abort", "addEventListener"] as const).every((method) =>
      typeof Recognition.prototype[method] === "function"));
}

/**
 * What this browser's own speech recognition can do. `cloud`: recognition exists, and the browser may send the
 * audio to a service. `local`: it can also run on the device, with a language pack the browser installs.
 * Safe to call anywhere; both are false where there is no recognition.
 */
export function detectPlatformStt(): { cloud: boolean; local: boolean } {
  const Recognition = recognitionConstructor();
  return {
    cloud: typeof Recognition === "function",
    local: typeof Recognition === "function" && typeof Recognition.available === "function" &&
      typeof Recognition.install === "function" && "processLocally" in Recognition.prototype,
  };
}

/** Options for `platformStt()`. All of them are optional. */
export interface PlatformSttOptions {
  /** Language to recognise, as a BCP 47 tag. Default `"en-US"`. */
  lang?: string;
  /**
   * `"local"` (default): recognise on the device with the browser's language pack, which the user must agree to
   * install first. `"cloud"`: the browser's ordinary recognition, which may send the audio to a service, with no download.
   */
  locality?: "local" | "cloud";
  /** Called when the browser starts capturing audio. */
  onAudioStart?: () => void;
  /** Called once when a session settles, including on errors and cancellation. */
  onEnd?: () => void;
}

/**
 * Speech recognition by the browser's own engine, as a push-to-talk `SttProvider`. Its `locality` says whether audio
 * stays on the device, so show a notice when it is `"cloud"`. With `locality: "local"` the language pack is an
 * install the user agrees to through `voxxy.models`, like a model download.
 */
export function platformStt({ lang = "en-US", locality = "local", onAudioStart, onEnd }: PlatformSttOptions = {}): SttProvider {
  const id = `platform-stt-${locality}:${lang}`;
  const local = locality === "local";
  const options: RecognitionOptions = { langs: [lang], processLocally: true };
  let loaded = false;
  let cancelSession: (() => void) | undefined;

  const install: InstallAcquisition | undefined = local ? {
    async check() {
      if (!detectPlatformStt().local) return { status: "unavailable", reason: "On-device browser recognition is unavailable" };
      const status = await recognitionConstructor()!.available!(options);
      if (status === "available") return { status: "ready" };
      if (status === "downloadable" || status === "downloading") return { status: "installable" };
      return { status: "unavailable", reason: `No browser recognition language pack for ${lang}` };
    },
    async install(signal) {
      signal.throwIfAborted();
      const Recognition = recognitionConstructor();
      if (!Recognition?.install) throw new Error("Browser language pack installation is unavailable");
      try {
        if (!await Recognition.install(options)) throw new Error(`Could not install browser recognition for ${lang}`);
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          throw new Error("The browser blocked the language pack install. Retry from the install button.", { cause: error });
        }
        throw error;
      }
      signal.throwIfAborted();
    },
  } : undefined;

  return {
    kind: "stt",
    id,
    engine: "platform",
    locality,
    install,
    async load({ signal } = {}) {
      signal?.throwIfAborted();
      if (!detectPlatformStt()[locality]) throw new Error(`Browser recognition (${locality}) is unavailable`);
      loaded = true;
    },
    async unload() {
      loaded = false;
      cancelSession?.();
    },
    listen({ signal } = {}) {
      const Recognition = recognitionConstructor();
      if (!loaded || !Recognition) throw new Error("Browser recognition is not loaded");
      signal?.throwIfAborted();
      const recognition = new Recognition();
      recognition.lang = lang;
      recognition.continuous = true;
      if (local && !("processLocally" in recognition)) throw new Error("On-device browser recognition is unavailable");
      if ("processLocally" in recognition) recognition.processLocally = local;

      const release = claimMicrophone(id);
      const events = new AbortController();
      const results = new Map<number, string>();
      let resolve!: (text: string) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<string>((done, failed) => { resolve = done; reject = failed; });
      void promise.catch(() => {}); // Surface errors through stop(), including errors before release.
      let finished = false;
      let cancelled: DOMException | undefined;
      let stopping: ReturnType<typeof setTimeout> | undefined;

      function finish(error?: unknown): void {
        if (finished) return;
        finished = true;
        clearTimeout(stopping);
        events.abort();
        signal?.removeEventListener("abort", onAbort);
        cancelSession = undefined;
        release();
        if (error !== undefined) reject(error);
        else resolve([...results].sort(([a], [b]) => a - b).map(([, text]) => text.trim()).join(" ").trim());
        onEnd?.();
      }

      function cancel(error: unknown): void {
        if (finished) return;
        try {
          // Detach callbacks so a synchronous end event cannot resolve a cancelled session.
          events.abort();
          recognition.abort();
        } catch {
          // Some engines already aborted when the page was suspended.
        } finally {
          finish(error);
        }
      }

      const onAbort = () => cancel(signal?.reason ?? abortError());
      const cancelListening = () => {
        cancelled ??= abortError("Listening cancelled");
        cancel(cancelled);
      };
      cancelSession = cancelListening;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (onAudioStart) recognition.addEventListener("audiostart", onAudioStart, { once: true, signal: events.signal });
      recognition.addEventListener("result", (event) => {
        const { resultIndex, results: incoming } = event as Event & {
          resultIndex: number;
          results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }>;
        };
        for (let i = resultIndex; i < incoming.length; i++) {
          const result = incoming[i];
          if (result?.isFinal && result[0]) results.set(i, result[0].transcript);
        }
      }, { signal: events.signal });
      recognition.addEventListener("end", () => finish(), { signal: events.signal });
      recognition.addEventListener("error", (event) => {
        const { error } = event as Event & { error: string };
        if (error === "no-speech") finish();
        else if (error === "aborted") finish(abortError());
        else if (error === "not-allowed" || error === "service-not-allowed") {
          finish(new MicrophoneError("permission-denied", `Browser recognition: ${error}`));
        } else finish(new Error(`Browser recognition: ${error}`));
      }, { signal: events.signal });
      try {
        recognition.start();
      } catch (error) {
        finish(mapMediaError(error));
      }

      return {
        stop() {
          if (cancelled) return Promise.reject(cancelled);
          if (!finished && stopping === undefined) {
            stopping = setTimeout(() => cancel(new Error("Browser recognition did not finish")), 15_000);
            try {
              recognition.stop();
            } catch (error) {
              cancel(error);
            }
          }
          return promise;
        },
        cancel: cancelListening,
      };
    },
  };
}
