import { abortError, type Locality, type TtsProvider } from "../provider.js";
import { SentenceSplitter } from "../sentences.js";

/** Whether this browser has speech synthesis (`speechSynthesis`). Safe to call anywhere. */
export function detectPlatformTts(): boolean {
  return typeof globalThis.SpeechSynthesisUtterance === "function" &&
    typeof globalThis.speechSynthesis?.getVoices === "function" &&
    typeof globalThis.speechSynthesis?.speak === "function" &&
    typeof globalThis.speechSynthesis?.cancel === "function" &&
    typeof globalThis.speechSynthesis?.addEventListener === "function";
}

/** Whether a browser voice runs on the device (`"local"`), on a service (`"cloud"`), or the browser does not say (`"unknown"`). */
export const voiceLocality = (voice: SpeechSynthesisVoice): Locality =>
  voice.localService === true ? "local" : voice.localService === false ? "cloud" : "unknown";

/** Options for `platformTts()`. All of them are optional. */
export interface PlatformTtsOptions {
  /** Language to speak, as a BCP 47 tag. Default `"en-US"`. */
  lang?: string;
  /** The name or URI shown by the browser. */
  voice?: string;
  /** Which kind of voice to use: `"local"` (default) runs on the device, `"cloud"` may send the text to a service. */
  locality?: Locality;
}

/** Reads voices without speaking. Browsers may populate the list asynchronously. */
export async function platformVoices(lang: string, signal?: AbortSignal): Promise<SpeechSynthesisVoice[]> {
  signal?.throwIfAborted();
  if (!detectPlatformTts()) return [];
  const synth = globalThis.speechSynthesis;
  const voices = await new Promise<SpeechSynthesisVoice[]>((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      synth.removeEventListener("voiceschanged", onVoices);
      signal?.removeEventListener("abort", onAbort);
    }
    function onVoices() {
      const available = synth.getVoices();
      if (available.length === 0) return;
      cleanup();
      resolve(available);
    }
    function onAbort() {
      cleanup();
      reject(signal?.reason);
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve(synth.getVoices());
    }, 1_500);
    synth.addEventListener("voiceschanged", onVoices);
    signal?.addEventListener("abort", onAbort, { once: true });
    onVoices();
  });
  const locale = lang.toLowerCase();
  const language = locale.split("-")[0];
  return voices.filter((voice) => voice.lang.toLowerCase().split("-")[0] === language).sort((a, b) => {
    const score = (voice: SpeechSynthesisVoice) => 2 * Number(voice.lang.toLowerCase() === locale) + Number(voice.default);
    return score(b) - score(a);
  });
}

/**
 * Speech synthesis by the browser's own voices, as a `TtsProvider`. It needs no download. Pick `locality` to say
 * whether the text may leave the device, and show a notice when it is `"cloud"`. Reports "unavailable" when no
 * voice of that kind exists for the language; list the choices with `platformVoices()`.
 */
export function platformTts({ lang = "en-US", voice, locality = "local" }: PlatformTtsOptions = {}): TtsProvider {
  const id = `platform-tts-${locality}:${lang}${voice ? `:${voice}` : ""}`;
  const unavailable = `No ${locality} browser voice for ${lang}${voice ? ` (${voice})` : ""}`;
  const findVoice = async (signal?: AbortSignal) => (await platformVoices(lang, signal)).find((candidate) =>
    voiceLocality(candidate) === locality && (!voice || candidate.voiceURI === voice || candidate.name === voice));
  let selected: SpeechSynthesisVoice | undefined;
  let tail = Promise.resolve();
  const pending = new Set<AbortController>();

  function play(text: string, voice: SpeechSynthesisVoice, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const synth = globalThis.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;

      function finish(error?: unknown) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        utterance.onend = null;
        utterance.onerror = null;
        if (error === undefined) resolve();
        else reject(error);
      }
      function cancel(error: unknown) {
        finish(error);
        synth.cancel();
      }
      const onAbort = () => cancel(signal.reason);
      const timer = setTimeout(() => cancel(new Error("Browser speech did not finish")), 60_000);
      utterance.onend = () => finish();
      utterance.onerror = ({ error }) => finish(error === "canceled" || error === "interrupted" ? abortError() : new Error(`Browser speech: ${error}`));
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        synth.speak(utterance);
      } catch (error) {
        finish(error);
      }
    });
  }

  function stop() {
    for (const job of pending) job.abort(abortError("Speech stopped"));
  }

  return {
    kind: "tts",
    id,
    engine: "platform",
    locality,
    install: {
      async check() {
        if (!detectPlatformTts()) return { status: "unavailable", reason: "Browser speech synthesis is unavailable" };
        return await findVoice() ? { status: "ready" } : { status: "unavailable", reason: unavailable };
      },
    },
    async load({ signal } = {}) {
      if (!detectPlatformTts()) throw new Error("Browser speech synthesis is unavailable");
      const candidate = await findVoice(signal);
      signal?.throwIfAborted();
      if (!candidate) throw new Error(unavailable);
      selected = candidate;
    },
    async unload() {
      stop();
      selected = undefined;
    },
    speak(text, { signal } = {}) {
      const voice = selected;
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (!voice) return Promise.reject(new Error("Browser speech synthesis is not loaded"));
      if (!text.trim()) return Promise.resolve();
      const job = new AbortController();
      const onAbort = () => job.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.add(job);
      // Dispatch only one native utterance at a time, so aborting the active job does not drop later calls.
      const spoken = tail.then(async () => {
        job.signal.throwIfAborted();
        const splitter = new SentenceSplitter({ minChars: 0, maxChars: 180 });
        for (const chunk of [...splitter.push(text), ...splitter.flush()]) await play(chunk, voice, job.signal);
      });
      tail = spoken.catch(() => {});
      return new Promise<void>((resolve, reject) => {
        const cancelled = () => reject(job.signal.reason);
        job.signal.addEventListener("abort", cancelled, { once: true });
        void spoken.then(resolve, reject).finally(() => {
          pending.delete(job);
          job.signal.removeEventListener("abort", cancelled);
          signal?.removeEventListener("abort", onAbort);
        });
      });
    },
    stop,
  };
}
