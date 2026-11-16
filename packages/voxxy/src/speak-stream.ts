import { abortError, type SpeakOptions } from "./provider.js";
import { SentenceSplitter, type SplitterOptions } from "./sentences.js";

/** Options for `voxxy.speakStream()`: the sentence-splitting ones plus limits on how far text may run ahead of the voice. */
export interface SpeakStreamOptions extends SplitterOptions {
  /**
   * How many sentences may be handed to the provider at once: the one playing plus those queued behind it.
   * Default 2. This bounds the audio held in memory, since a PCM provider synthesises every sentence it was given.
   */
  maxInFlight?: number;
  /**
   * How many finished sentences may wait here for their turn before `push()` makes the caller wait. Default 8.
   * Text is cheap, so this is about keeping a fast text source from running far ahead of the voice.
   */
  maxPending?: number;
  /** Tidies a sentence before it is spoken. Default: removes Markdown marks. Return "" to skip the sentence. */
  normalize?: (sentence: string) => string;
  /** Cancels the stream, like `cancel()`. */
  signal?: AbortSignal;
}

/**
 * A reply being spoken while it is still being written, returned by `voxxy.speakStream()`. Feed it with `push()`,
 * finish with `end()`, or stop with `cancel()`.
 */
export interface SpeakStream {
  /**
   * Adds text as it arrives, in any size of piece. The returned promise resolves at once while there is room, and
   * waits while many sentences are already waiting: `await` it in a loop over a token stream to let the speech set the pace.
   */
  push(delta: string): Promise<void>;
  /** No more text. Resolves when everything pushed has finished playing; rejects if the stream was cancelled or the provider failed. */
  end(): Promise<void>;
  /** Drops what is waiting, stops the sound, and makes `end()` reject with an AbortError. */
  cancel(): void;
}

/** What a stream needs from a speaker: `voxxy.speak` and `voxxy.stopSpeaking`, or any provider's `speak` and `stop`. */
export interface Speaker {
  speak(text: string, options?: SpeakOptions): Promise<void>;
  stop(): void;
}

/** Strips what a speech engine would read aloud as noise: emphasis marks, code ticks, heading and list markers, link targets. */
export function stripMarkdown(sentence: string): string {
  return sentence
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]+(?=\S)/g, "$1")
    .replace(/(?<=\S)[*_]+(?=[\s).,;:!?]|$)/g, "")
    .replace(/^\s*(#{1,6}|>|[-*•]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * Speaks a reply while it is still being written. Text deltas go in; whole sentences go out to the provider's
 * `speak()` one by one, in order, so the first sentence sounds while the rest is still arriving. It relies on `speak()`
 * calls queueing, so it works for any provider: a PCM model prepares the next sentence while the current one plays, a
 * platform engine queues natively. At most `maxInFlight` sentences are with the provider at once.
 */
export function createSpeakStream(speaker: Speaker, options: SpeakStreamOptions = {}): SpeakStream {
  const maxInFlight = Math.max(1, options.maxInFlight ?? 2);
  const maxPending = Math.max(1, options.maxPending ?? 8);
  const normalize = options.normalize ?? stripMarkdown;
  const splitter = new SentenceSplitter(options);
  const abort = new AbortController();

  const pending: string[] = [];
  let inFlight = 0;
  let ended = false;
  let failure: unknown;
  let cancelled = false;
  let roomWaiters: Array<() => void> = [];
  let settle: { resolve(): void; reject(error: unknown): void } | null = null;
  const finished = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  finished.catch(() => {}); // Reported through end(); this keeps an unread stream from raising an unhandled rejection.

  const wakeWriters = () => {
    const waiting = roomWaiters;
    roomWaiters = [];
    for (const wake of waiting) wake();
  };

  function check(): void {
    if (failure !== undefined) {
      settle?.reject(failure);
      return;
    }
    if (ended && pending.length === 0 && inFlight === 0) settle?.resolve();
  }

  function pump(): void {
    while (!cancelled && failure === undefined && inFlight < maxInFlight && pending.length > 0) {
      const sentence = pending.shift()!;
      inFlight++;
      speaker.speak(sentence, { signal: abort.signal }).then(
        () => {
          inFlight--;
          pump();
        },
        (error) => {
          inFlight--;
          if (!cancelled && !isAbort(error) && failure === undefined) failure = error;
          pump();
        },
      );
    }
    if (pending.length < maxPending) wakeWriters();
    check();
  }

  function enqueue(sentences: string[]): void {
    for (const raw of sentences) {
      const sentence = normalize(raw);
      if (/[\p{L}\p{N}]/u.test(sentence)) pending.push(sentence); // Nothing to say in "—" or "***".
    }
    pump();
  }

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    pending.length = 0;
    abort.abort(abortError("Speech stream cancelled"));
    speaker.stop();
    wakeWriters();
    settle?.reject(abortError("Speech stream cancelled"));
  }
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();

  return {
    async push(delta) {
      if (cancelled) throw abortError("Speech stream cancelled");
      if (failure !== undefined) throw failure;
      if (ended) throw new Error("The speech stream has ended");
      enqueue(splitter.push(delta));
      while (pending.length >= maxPending && !cancelled && failure === undefined) {
        await new Promise<void>((resolve) => roomWaiters.push(resolve));
      }
    },
    end() {
      if (!ended && !cancelled) {
        ended = true;
        enqueue(splitter.flush());
      }
      return finished;
    },
    cancel,
  };
}
