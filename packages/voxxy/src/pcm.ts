import { abortError, type ListenOptions, type SpeakOptions, type SttSession } from "./provider.js";
import { SentenceSplitter, cutIndex, speechWeight, type SplitterOptions } from "./sentences.js";

/** Mono 16 kHz samples, which is what PCM speech-to-text adapters take. */
export interface RecordingHandle {
  /** Stops recording and returns what was captured, mono 16 kHz. */
  stop(): Promise<Float32Array>;
  /** Stops recording and discards it. */
  cancel(): void;
}

/** Captures push-to-talk audio. `createMicRecorder` is the real one; `voxxy/testing` has a fake. */
export interface Recorder {
  /** Starts capturing. Rejects with an AbortError if `signal` aborts first. */
  start(signal?: AbortSignal): Promise<RecordingHandle>;
}

/**
 * Plays PCM. `createWebAudioPlayer` is the real one; `voxxy/testing` has a fake.
 *
 * `play()` may be called while earlier buffers are still playing. The player then plays them in
 * call order, each starting exactly when the previous one ends (gapless). `pcmSpeaker` relies on this:
 * it hands over the next buffer as soon as it is synthesised.
 */
export interface Player {
  /**
   * Resolves when this buffer has finished playing. Rejects with an AbortError when `signal` aborts,
   * after silencing it (or without ever starting it, if its turn had not come).
   */
  play(pcm: Float32Array, sampleRate: number, signal: AbortSignal): Promise<void>;
  /**
   * Gets playback permitted. Call from a user gesture (a tap handler): iOS and Chrome start audio only
   * after one. Safe to call repeatedly.
   */
  unlock?(): Promise<void>;
}

/** Turns a recorder plus a PCM transcriber into `listen()`. */
export function pcmListener(deps: {
  recorder: Recorder;
  transcribe(pcm16k: Float32Array, signal: AbortSignal): Promise<string>;
}): (options?: ListenOptions) => SttSession {
  return (options = {}) => {
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort(options.signal?.reason ?? abortError());
    if (options.signal?.aborted) onCallerAbort();
    else options.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const started = deps.recorder.start(abort.signal);
    // A rejected start surfaces through stop(); this keeps it from also being an unhandled rejection.
    started.catch(() => {});
    // However the session is aborted (cancel(), or the caller's signal), the microphone must be let go.
    abort.signal.addEventListener("abort", () => void started.then((recording) => recording.cancel(), () => {}), { once: true });
    let stopping: Promise<string> | null = null;

    return {
      stop() {
        stopping ??= (async () => {
          try {
            const recording = await started;
            abort.signal.throwIfAborted();
            const pcm = await recording.stop();
            abort.signal.throwIfAborted();
            return await deps.transcribe(pcm, abort.signal);
          } finally {
            options.signal?.removeEventListener("abort", onCallerAbort);
          }
        })();
        return stopping;
      },
      cancel() {
        abort.abort(abortError("Listening cancelled"));
      },
    };
  };
}

export interface SynthesizedSpeech {
  pcm: Float32Array;
  sampleRate: number;
  /** How long the synthesis took, in ms, when the provider knows. Otherwise the speaker times the call itself. */
  synthMs?: number;
}

/** What `pcmSpeaker` reports about each chunk once it has been synthesised. */
export interface ChunkInfo {
  /** Which chunk of its `speak()` call this is, from 0. */
  index: number;
  text: string;
  /** Its length in speech weight (see `speechWeight`). */
  weight: number;
  /** How long the synthesis took. */
  synthMs: number;
  /** How long the speech is. */
  audioSeconds: number;
  /** How many times faster than speech the device was on the chunks so far, or undefined before the first. */
  speedFactor: number | undefined;
  /** The most the next chunk may weigh given that speed, or undefined if nothing limits it. */
  nextCap: number | undefined;
}

/** One call to `speak()`: its text as sentences, handed out as chunks while the pipeline has room. */
interface Job {
  units: string[];
  /** Index of the first sentence not yet in a chunk. */
  next: number;
  /** Chunks made so far. */
  made: number;
  /** Chunks made and not yet played. */
  active: number;
  failed: boolean;
  /** Aborts every synthesis and every playback of this call. */
  abort: AbortController;
  resolve(): void;
  reject(error: unknown): void;
}

interface Chunk {
  job: Job;
  /** Its place among the chunks of its call. */
  index: number;
  text: string;
  weight: number;
  ready: SynthesizedSpeech | null;
  /** True once the buffer has been handed to the player. */
  issued: boolean;
  settled: boolean;
}

/**
 * How much of the previous chunk's playing time the next chunk's synthesis may use. Below 1 leaves a margin, because
 * speed varies from one chunk to the next.
 */
const HEADROOM = 0.8;
/** How quickly old measurements of the synthesis speed fade. */
const FORGET = 0.6;
/** A sentence is not cut into pieces smaller than this (speech weight), however short the chunk before it was. */
const MIN_CHUNK = 40;

/**
 * Turns a PCM synthesiser plus a player into `speak()` / `stop()`.
 *
 * - **Chunks.** A text is cut into sentences, and sentences are packed into chunks (`splitter`: at least `minChars`,
 *   at most `maxChars`; the first chunk has its own limits so that sound starts early). One chunk is one synthesis.
 * - **Pipeline.** Calls queue in order. One chunk is synthesised at a time, and at most `1 + maxAhead` are held
 *   (playing or waiting), which bounds the audio in memory. A finished chunk goes to the player at once, so the player can
 *   start it exactly when the one before ends.
 * - **No holes.** A big chunk takes long to synthesise, and if the one before it is short, the listener hears silence while
 *   it is made. So the size of each chunk is capped by how much synthesis time the previous chunk's playing time can
 *   cover, at the speed measured on the chunks so far: on a fast device chunks may jump straight to their full size, on a slow
 *   one they grow step by step. A sentence is never split to fit, and the limit never makes a chunk smaller than one sentence.
 */
export function pcmSpeaker(deps: {
  synthesize(text: string, signal: AbortSignal): Promise<SynthesizedSpeech>;
  player: Player;
  maxAhead?: number;
  /** How `speak()` cuts text into chunks. Default: sentences of at most 220 characters, tiny ones joined. */
  splitter?: SplitterOptions;
  /** A clock in ms, for timing the synthesis. Default `performance.now()`. */
  now?: () => number;
  /** Called when a chunk has been synthesised, for logs and for looking at how the text was cut. */
  onChunk?: (info: ChunkInfo) => void;
}): { speak(text: string, options?: SpeakOptions): Promise<void>; stop(): void } {
  const capacity = 1 + Math.max(1, deps.maxAhead ?? 1);
  const now = deps.now ?? (() => performance.now());
  const minChars = deps.splitter?.minChars ?? 10;
  const firstMinChars = deps.splitter?.firstMinChars ?? minChars;
  const maxChars = deps.splitter?.maxChars ?? 220;
  const firstMaxChars = Math.min(maxChars, deps.splitter?.firstMaxChars ?? 120);

  const jobs: Job[] = [];
  /** Chunks that have been started and have not finished playing, in order. */
  const queue: Chunk[] = [];

  // How fast synthesis has been, as seconds of speech made per second of work (measured on recent chunks).
  let audioSeconds = 0;
  let workSeconds = 0;
  const speedFactor = () => (workSeconds > 0 ? audioSeconds / workSeconds : undefined);

  function finishJob(job: Job): void {
    const at = jobs.indexOf(job);
    if (at >= 0) jobs.splice(at, 1);
  }

  function failJob(job: Job, error: unknown): void {
    if (job.failed) return;
    job.failed = true;
    job.next = job.units.length; // The rest of the text is not going to be spoken.
    finishJob(job);
    job.abort.abort(error); // Stops its syntheses and its playback.
    for (const chunk of [...queue]) {
      if (chunk.job !== job) continue;
      chunk.settled = true;
      queue.splice(queue.indexOf(chunk), 1);
    }
    job.active = 0;
    job.reject(error);
    pump();
  }

  function settle(chunk: Chunk, error?: unknown): void {
    if (chunk.settled) return;
    chunk.settled = true;
    queue.splice(queue.indexOf(chunk), 1);
    const job = chunk.job;
    job.active--;
    if (error !== undefined) {
      failJob(job, error);
      return;
    }
    if (job.next >= job.units.length && job.active === 0 && !job.failed) {
      finishJob(job);
      job.resolve();
    }
    pump();
  }

  /** The next chunk of `job`: sentences are added while the chunk is below its minimum, within its limits and the growth cap. */
  function takeChunk(job: Job): { text: string; weight: number } {
    const fresh = job.made === 0 && queue.length === 0; // Nothing playing: sound is waiting for this chunk.
    const needed = fresh ? firstMinChars : minChars;
    const limit = fresh ? firstMaxChars : maxChars;

    let text = job.units[job.next++]!;
    let weight = speechWeight(text);

    // The previous chunk plays for about `previous.weight` / (characters per second of speech); this one must be
    // synthesised in less than that. In weight terms: at most `previous.weight * speed * HEADROOM`. Only meaningful when
    // the device is faster than speech: on a slower one a hole is coming whatever the size, and bigger chunks waste less.
    const previous = queue.at(-1);
    const speed = speedFactor();
    const cap = previous && speed && speed * HEADROOM > 1 ? Math.max(MIN_CHUNK, previous.weight * speed * HEADROOM) : Infinity;

    // A sentence too long for the cap is cut at a pause or a space, and the rest waits for the next chunk.
    const cut = weight > cap ? cutIndex(text, cap, MIN_CHUNK) : null;
    if (cut !== null && cut < text.length) {
      job.units.splice(job.next, 0, text.slice(cut).trim());
      text = text.slice(0, cut).trim();
      weight = speechWeight(text);
    }

    while (job.next < job.units.length && weight < needed) {
      const unit = job.units[job.next]!;
      const unitWeight = speechWeight(unit);
      if (weight + 1 + unitWeight > Math.min(limit, cap)) break;
      text += ` ${unit}`;
      weight += 1 + unitWeight;
      job.next++;
    }
    // A last sentence too short to stand alone ("Hey. I. Am. | Here.") joins this chunk rather than becoming a chunk of
    // its own, separated from the rest by a gap of its own.
    if (job.next === job.units.length - 1) {
      const unit = job.units[job.next]!;
      const unitWeight = speechWeight(unit);
      if (unitWeight < needed && weight + 1 + unitWeight <= Math.min(limit * 1.25, cap)) {
        text += ` ${unit}`;
        weight += 1 + unitWeight;
        job.next++;
      }
    }
    return { text, weight };
  }

  function startChunk(job: Job): void {
    const { text, weight } = takeChunk(job);
    const chunk: Chunk = { job, index: job.made, text, weight, ready: null, issued: false, settled: false };
    queue.push(chunk);
    job.made++;
    job.active++;
    const startedAt = now();
    deps.synthesize(text, job.abort.signal).then(
      (speech) => {
        if (chunk.settled) return;
        chunk.ready = speech;
        const seconds = speech.pcm.length / speech.sampleRate;
        const synthMs = speech.synthMs ?? now() - startedAt;
        audioSeconds = audioSeconds * FORGET + seconds;
        workSeconds = workSeconds * FORGET + synthMs / 1000;
        const speed = speedFactor();
        deps.onChunk?.({
          index: chunk.index,
          text,
          weight,
          synthMs,
          audioSeconds: seconds,
          speedFactor: speed,
          nextCap: speed && speed * HEADROOM > 1 ? Math.max(MIN_CHUNK, weight * speed * HEADROOM) : undefined,
        });
        pump();
      },
      (error) => settle(chunk, error),
    );
  }

  function pump(): void {
    // Start the next chunk when nothing is being synthesised and there is room. One at a time: the next size is
    // decided from how fast the last one was made.
    while (queue.length < capacity && !queue.some((chunk) => !chunk.ready && !chunk.settled)) {
      const job = jobs.find((candidate) => !candidate.failed && candidate.next < candidate.units.length);
      if (!job) break;
      startChunk(job);
    }
    // Hand finished chunks to the player in order, as soon as each is ready.
    for (const chunk of queue) {
      if (chunk.issued) continue;
      if (!chunk.ready) break;
      chunk.issued = true;
      deps.player.play(chunk.ready.pcm, chunk.ready.sampleRate, chunk.job.abort.signal).then(
        () => settle(chunk),
        (error) => settle(chunk, error),
      );
    }
  }

  return {
    /**
     * Text of any length. It is cut into sentences and chunks that are synthesised one after another, so sound starts after
     * the first chunk has been made, not the last, and only the pipeline's worth of audio is ever held. Resolves when
     * the last chunk has finished playing; any failure or abort rejects it and drops the rest.
     */
    speak(text, options = {}) {
      if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? abortError());
      // Sentences only; packing them into chunks happens later, when it is known how fast the device is.
      const splitter = new SentenceSplitter({ ...deps.splitter, minChars: 0, firstMinChars: 0 });
      const units = [...splitter.push(text), ...splitter.flush()];
      if (units.length === 0) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const onCallerAbort = () => failJob(job, options.signal?.reason ?? abortError());
        const job: Job = {
          units,
          next: 0,
          made: 0,
          active: 0,
          failed: false,
          abort: new AbortController(),
          resolve: () => (options.signal?.removeEventListener("abort", onCallerAbort), resolve()),
          reject: (error) => (options.signal?.removeEventListener("abort", onCallerAbort), reject(error)),
        };
        options.signal?.addEventListener("abort", onCallerAbort, { once: true });
        jobs.push(job);
        pump();
      });
    },
    stop() {
      for (const job of [...jobs]) failJob(job, abortError("Speech stopped"));
    },
  };
}
