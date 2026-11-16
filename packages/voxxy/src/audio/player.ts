import type { Player } from "../pcm.js";
import { abortError } from "../provider.js";

/**
 * How the player gets sound out on an iPhone whose hardware silent switch is on, where WebAudio is otherwise
 * muted. Pick one with the `silentSwitch` option of `createWebAudioPlayer`.
 */
export type SilentSwitchMode =
  /** `navigator.audioSession` where it exists, else the silent `<audio>` trick on iOS, else nothing. */
  | "auto"
  /** Set `navigator.audioSession.type = "playback"` (Safari 16.4+): WebAudio then ignores the hardware silent switch. */
  | "audio-session"
  /** Start a looping silent `<audio>` element from the gesture: older iOS then plays WebAudio despite the silent switch. */
  | "audio-element"
  /** Use no workaround: on iOS the silent switch mutes the audio. */
  | "off";

/** Options for `createWebAudioPlayer`. All of them are optional. */
export interface WebAudioPlayerOptions {
  /** Which workaround to use for the hardware silent switch. Default `"auto"`. */
  silentSwitch?: SilentSwitchMode;
  /** Delay between a buffer being scheduled on an idle player and it sounding, in seconds. Default 0.03. */
  leadSeconds?: number;
  /** For tests: supply the context. */
  createContext?: () => AudioContext;
  /**
   * Output level from 0 (silent) to 1 (default). The audio still runs and is scheduled exactly as usual, only
   * the master gain is set, so tests can exercise the real player without making a sound, in any browser.
   */
  volume?: number;
}

/** Thrown when sound cannot start. */
export class AudioPlaybackError extends Error {
  /** `"blocked"`: the browser refused to start audio, usually because no tap or click came first (call `unlock()` from one). `"unsupported"`: this browser has no WebAudio. */
  readonly code: "blocked" | "unsupported";
  constructor(code: "blocked" | "unsupported", message: string) {
    super(message);
    this.name = "AudioPlaybackError";
    this.code = code;
  }
}

/** When one queued buffer plays, as reported by the player's `chunk-finished` event. */
export interface ChunkTiming {
  /** On the audio clock (`AudioContext.currentTime`), in seconds. */
  startTime: number;
  endTime: number;
}

/** The events a `WebAudioPlayer` emits, with what each one carries. Subscribe with `player.on(name, handler)`. */
export interface PlayerEvents {
  /** Playback began after being idle (the first buffer is scheduled and will sound). */
  started: undefined;
  /** One buffer finished. `startTime` of the next one equals this `endTime` when they were queued gaplessly. */
  "chunk-finished": ChunkTiming;
  /** Nothing is playing or waiting any more. */
  drained: undefined;
}

export interface WebAudioPlayer extends Player {
  unlock(): Promise<void>;
  on<E extends keyof PlayerEvents>(event: E, handler: (payload: PlayerEvents[E]) => void): () => void;
  /** `"suspended"` until `unlock()` (or a gesture-driven `play()`) has run, then `"running"`. `null` before any audio context exists. */
  readonly contextState: AudioContextState | null;
  /** Which silent-switch workaround `unlock()` used, or null if none (yet). */
  readonly silentSwitchUsed: "audio-session" | "audio-element" | null;
  /** Stops everything, releases the audio context and the silent element. The player can be used again. */
  dispose(): Promise<void>;
}

interface Chunk extends ChunkTiming {
  source: AudioBufferSourceNode;
}

const isIOS = (): boolean =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** A short silent mono WAV, as a data: URI, for the `<audio>` workaround. */
function silentWavDataUri(): string {
  const samples = 800; // 0.1 s at 8 kHz, 8-bit unsigned: 128 is silence.
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

/**
 * The `Player` that `pcmSpeaker` plugs into: WebAudio playback of PCM at whatever sample rate the model
 * produces (the browser resamples), with buffers scheduled back to back on the audio clock, so a text handed
 * over while the previous one plays starts exactly when it ends.
 *
 * Call `unlock()` from a tap handler (the facade's `voxxy.unlock()` does). iOS and Chrome start audio only
 * after a gesture, and iOS mutes WebAudio when the hardware silent switch is on unless the page asks for
 * "playback" audio: `unlock()` applies the workaround chosen by `silentSwitch`.
 */
export function createWebAudioPlayer(options: WebAudioPlayerOptions = {}): WebAudioPlayer {
  const lead = options.leadSeconds ?? 0.03;
  const handlers: { [E in keyof PlayerEvents]: Set<(payload: PlayerEvents[E]) => void> } = {
    started: new Set(),
    "chunk-finished": new Set(),
    drained: new Set(),
  };
  const emit = <E extends keyof PlayerEvents>(event: E, payload: PlayerEvents[E]) => handlers[event].forEach((handler) => handler(payload));

  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let nextStart = 0;
  const active = new Set<Chunk>();
  let resuming: Promise<void> | null = null;
  let silentElement: HTMLAudioElement | null = null;
  let silentUsed: "audio-session" | "audio-element" | null = null;

  // iOS (home-screen web apps above all) can leave a context that went through the background "running" but
  // silent: the clock advances, buffers end on time, nothing comes out. Such a context is replaced on the next
  // unlock(), which runs inside a gesture and so can start a fresh one.
  let wentToBackground = false;
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden" && context) wentToBackground = true;
  };
  let watchingVisibility = false;
  function watchVisibility(): void {
    if (watchingVisibility || typeof document === "undefined" || !isIOS()) return;
    document.addEventListener("visibilitychange", onVisibilityChange);
    watchingVisibility = true;
  }

  function getContext(): AudioContext {
    if (!context || context.state === "closed") {
      watchVisibility();
      context = options.createContext?.() ?? new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ latencyHint: "playback" });
      master = context.createGain();
      master.gain.value = Math.min(1, Math.max(0, options.volume ?? 1));
      master.connect(context.destination);
      nextStart = 0;
    }
    return context;
  }

  /** Resumes the context. Where no gesture has happened it stays suspended, so give up after a moment instead of hanging. */
  function resume(ctx: AudioContext): Promise<void> {
    if (ctx.state === "running") return Promise.resolve();
    resuming ??= (async () => {
      try {
        await Promise.race([ctx.resume(), new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
        if (ctx.state !== "running") {
          throw new AudioPlaybackError("blocked", "Audio is blocked until the user interacts with the page: call voxxy.unlock() from a tap handler");
        }
      } finally {
        resuming = null;
      }
    })();
    return resuming;
  }

  function applySilentSwitch(): void {
    const mode = options.silentSwitch ?? "auto";
    if (mode === "off") return;
    const wantsSession = mode === "audio-session" || (mode === "auto" && typeof navigator !== "undefined" && "audioSession" in navigator);
    if (wantsSession) {
      try {
        (navigator as unknown as { audioSession: { type: string } }).audioSession.type = "playback";
        silentUsed = "audio-session";
        return;
      } catch {
        if (mode === "audio-session") return;
      }
    }
    if (mode === "audio-element" || (mode === "auto" && isIOS())) {
      if (!silentElement) {
        silentElement = new Audio(silentWavDataUri());
        silentElement.loop = true;
        silentElement.setAttribute("playsinline", "");
      }
      // Must start inside the gesture. A refusal is not fatal: WebAudio may still be audible.
      void silentElement.play().catch(() => {});
      silentUsed = "audio-element";
    }
  }

  function finish(chunk: Chunk): void {
    if (!active.delete(chunk)) return;
    if (active.size === 0) nextStart = 0;
  }

  return {
    get contextState() {
      return context?.state ?? null;
    },
    get silentSwitchUsed() {
      return silentUsed;
    },
    on(event, handler) {
      const set = handlers[event] as Set<typeof handler>;
      set.add(handler);
      return () => void set.delete(handler);
    },
    async unlock() {
      // Everything up to the first await runs inside the gesture.
      if (wentToBackground && active.size === 0) {
        wentToBackground = false;
        const stale = context;
        context = null;
        master = null;
        void stale?.close().catch(() => {});
      }
      const ctx = getContext();
      const resumed = resume(ctx);
      applySilentSwitch();
      const tick = ctx.createBufferSource(); // The classic nudge: a silent one-sample buffer.
      tick.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      tick.connect(master!);
      tick.start();
      await resumed;
    },
    async play(pcm, sampleRate, signal) {
      if (signal.aborted) throw signal.reason ?? abortError();
      const ctx = getContext();
      // Stay synchronous when running, so buffers handed over back to back are scheduled in call order.
      if (ctx.state !== "running") {
        await resume(ctx);
        if (signal.aborted) throw signal.reason ?? abortError();
      }
      const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
      buffer.getChannelData(0).set(pcm);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(master!);

      const wasIdle = active.size === 0;
      const startTime = Math.max(wasIdle ? ctx.currentTime + lead : ctx.currentTime, nextStart);
      const chunk: Chunk = { source, startTime, endTime: startTime + buffer.duration };
      nextStart = chunk.endTime;
      active.add(chunk);
      if (wasIdle) emit("started", undefined);
      source.start(startTime);

      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          source.onended = null;
          try {
            source.stop();
          } catch {
            // Already stopped.
          }
          source.disconnect();
          finish(chunk);
          if (active.size === 0) emit("drained", undefined);
          reject(signal.reason ?? abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        source.onended = () => {
          signal.removeEventListener("abort", onAbort);
          source.disconnect();
          finish(chunk);
          emit("chunk-finished", { startTime: chunk.startTime, endTime: chunk.endTime });
          if (active.size === 0) emit("drained", undefined);
          resolve();
        };
      });
    },
    async dispose() {
      for (const chunk of [...active]) {
        chunk.source.onended = null;
        try {
          chunk.source.stop();
        } catch {
          // Already stopped.
        }
      }
      active.clear();
      nextStart = 0;
      silentElement?.pause();
      silentElement = null;
      silentUsed = null;
      if (watchingVisibility) document.removeEventListener("visibilitychange", onVisibilityChange);
      watchingVisibility = false;
      wentToBackground = false;
      const closing = context;
      context = null;
      master = null;
      await closing?.close().catch(() => {});
    },
  };
}
