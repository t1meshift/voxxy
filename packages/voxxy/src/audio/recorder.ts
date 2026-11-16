import type { Recorder, RecordingHandle } from "../pcm.js";
import { abortError } from "../provider.js";
import { MicrophoneError, claimMicrophone, mapMediaError } from "./errors.js";
import { Resampler, STT_SAMPLE_RATE } from "./resample.js";

/** Runs on the audio thread: batches the 128-frame blocks into larger messages and hands back the remainder on request. */
const WORKLET_NAME = "voxxy-capture";
const WORKLET_SOURCE = `
class VoxxyCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        if (this.filled > 0) this.port.postMessage({ samples: this.block.slice(0, this.filled) });
        this.filled = 0;
        this.port.postMessage({ flushed: true });
      }
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i];
        if (this.filled === this.block.length) {
          this.port.postMessage({ samples: this.block.slice() });
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", VoxxyCapture);
`;

/** Options for `createMicRecorder`. All of them are optional. */
export interface MicRecorderOptions {
  /** A recording shorter than this is rejected with `MicrophoneError("too-short")`. Default 250 ms. */
  minDurationMs?: number;
  /** Audio past this length is dropped. Default 60 s. */
  maxDurationMs?: number;
  /** Called once when `maxDurationMs` is reached, so the host can end push-to-talk. */
  onLimitReached?: () => void;
  /** Reports the RMS amplitude of each captured block on a linear 0–1 scale. */
  onLevel?: (level: number) => void;
  /** Merged into the `getUserMedia` audio constraints. */
  constraints?: MediaTrackConstraints;
  /**
   * How long to keep the microphone open after a recording, so the next press starts at once. Default 0:
   * the stream is released when recording stops, so the OS recording indicator goes away. Anything above
   * 0 keeps that indicator on for that long.
   */
  idleReleaseMs?: number;
  /** Use an AudioWorklet where available (default). False forces the ScriptProcessor fallback. */
  preferWorklet?: boolean;
}

export interface MicRecorder extends Recorder {
  /** Releases the microphone and closes the audio context. The recorder can be used again afterwards. */
  dispose(): Promise<void>;
}

interface Capture {
  /** Where the microphone feeds in. */
  input: AudioNode;
  /** Asks for the audio that is still buffered, and waits for it. */
  flush(): Promise<void>;
  disconnect(): void;
}

const loadedWorklets = new WeakSet<BaseAudioContext>();

async function createCapture(context: AudioContext, onSamples: (samples: Float32Array) => void, preferWorklet: boolean): Promise<Capture> {
  // Nodes that are not connected towards the destination may never be pulled in some browsers, so route through a muted gain.
  const mute = context.createGain();
  mute.gain.value = 0;
  mute.connect(context.destination);

  if (preferWorklet && context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    try {
      if (!loadedWorklets.has(context)) {
        // A Blob URL keeps the library to plain files. A page whose CSP forbids blob: scripts falls through to the fallback.
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
        try {
          await context.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        loadedWorklets.add(context);
      }
      const node = new AudioWorkletNode(context, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      let onFlushed: (() => void) | null = null;
      node.port.onmessage = (event: MessageEvent<{ samples?: Float32Array; flushed?: boolean }>) => {
        if (event.data.samples) onSamples(event.data.samples);
        if (event.data.flushed) onFlushed?.();
      };
      node.connect(mute);
      return {
        input: node,
        flush: () =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 300); // Never hang stop() on a worklet that went away.
            onFlushed = () => (clearTimeout(timer), resolve());
            node.port.postMessage("flush");
          }),
        disconnect() {
          node.port.onmessage = null;
          node.disconnect();
          mute.disconnect();
        },
      };
    } catch {
      // No worklet here (old Safari, a CSP that blocks blob:): use the fallback below.
    }
  }

  // Deprecated, but present everywhere the worklet is not. Runs on the main thread. The last partial block (up to ~90 ms) is lost on stop.
  const processor = context.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => onSamples(event.inputBuffer.getChannelData(0).slice());
  processor.connect(mute);
  return {
    input: processor,
    flush: async () => {},
    disconnect() {
      processor.onaudioprocess = null;
      processor.disconnect();
      mute.disconnect();
    },
  };
}

interface AudioSessionLike {
  type: string;
}
const audioSession = (): AudioSessionLike | null =>
  typeof navigator !== "undefined" ? ((navigator as unknown as { audioSession?: AudioSessionLike }).audioSession ?? null) : null;

/**
 * Safari refuses `getUserMedia` while the page's audio session is "playback" (which the player sets so that speech
 * is not muted by the silent switch) with "AudioSession category is not compatible with audio capture".
 * Switches to "play-and-record" for the recording and returns a function that puts the previous type back.
 */
function enterRecordingSession(): () => void {
  const session = audioSession();
  if (!session) return () => {};
  let previous: string;
  try {
    previous = session.type;
    if (previous === "play-and-record") return () => {};
    session.type = "play-and-record";
  } catch {
    return () => {};
  }
  return () => {
    try {
      session.type = previous;
    } catch {
      // Not restorable here; the player sets its own type again on the next unlock().
    }
  };
}

async function openStream(constraints: MediaTrackConstraints | undefined): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneError("unsupported", "Microphone capture is not available here (is the page served over https?)");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...constraints },
    });
  } catch (error) {
    throw mapMediaError(error);
  }
}

/**
 * Push-to-talk recorder: the `Recorder` that `pcmListener` plugs into. Yields mono 16 kHz Float32 PCM.
 *
 * - The audio context runs at whatever rate the device chose (44.1 or 48 kHz on iOS) and is resampled to 16 kHz here.
 * - Capture uses an AudioWorklet where available, a ScriptProcessor otherwise.
 * - The microphone is released when a recording ends, so the OS indicator goes away (see `idleReleaseMs`).
 * - One recording at a time, and one owner of the microphone across the library (`claimMicrophone`).
 *
 * `start()` should be called from a user gesture (the button press): the audio context needs one to run on iOS.
 */
export function createMicRecorder(options: MicRecorderOptions = {}): MicRecorder {
  const minDurationMs = options.minDurationMs ?? 250;
  const maxDurationMs = options.maxDurationMs ?? 60_000;
  const idleReleaseMs = options.idleReleaseMs ?? 0;

  let context: AudioContext | null = null;
  let idleStream: MediaStream | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const stopTracks = (stream: MediaStream | null) => stream?.getTracks().forEach((track) => track.stop());

  let leaveSession: (() => void) | null = null;
  const restoreSession = () => {
    leaveSession?.();
    leaveSession = null;
  };

  function releaseIdle(): void {
    clearTimeout(idleTimer);
    stopTracks(idleStream);
    idleStream = null;
    restoreSession();
  }

  async function ensureContext(): Promise<AudioContext> {
    if (!context || context.state === "closed") {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      context = new Ctor({ latencyHint: "interactive" });
    }
    // iOS Safari also reports "interrupted" (after a call, a route change, or our own suspend()), so anything but "running" needs a resume.
    if (context.state !== "running") {
      // A resume() that cannot get a user gesture stays pending forever on iOS; don't let it hang start().
      await Promise.race([context.resume().catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
    }
    return context;
  }

  async function start(signal?: AbortSignal): Promise<RecordingHandle> {
    signal?.throwIfAborted();
    const releaseClaim = claimMicrophone("voxxy recorder");
    let stream: MediaStream | null = null;
    let capture: Capture | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let finished = false;

    const teardown = () => {
      if (finished) return;
      finished = true;
      source?.disconnect();
      capture?.disconnect();
      void context?.suspend().catch(() => {});
      if (stream) {
        if (idleReleaseMs > 0) {
          idleStream = stream;
          idleTimer = setTimeout(releaseIdle, idleReleaseMs);
        } else {
          stopTracks(stream);
          restoreSession();
        }
      } else {
        restoreSession();
      }
      releaseClaim();
    };

    try {
      clearTimeout(idleTimer);
      leaveSession ??= enterRecordingSession(); // Before getUserMedia, and still inside the gesture.
      // iOS only lets an AudioContext start while the user gesture is still live, and the getUserMedia permission
      // prompt below consumes it. So create and resume the context first, synchronously from the press.
      const contextReady = ensureContext();
      contextReady.catch(() => {});
      stream = idleStream ?? (await openStream(options.constraints));
      idleStream = null;
      signal?.throwIfAborted();
      const ctx = await contextReady;
      // The permission prompt or the new input route can leave the context suspended again; try once more.
      if (ctx.state !== "running") await ensureContext();
      signal?.throwIfAborted();

      const resampler = new Resampler(ctx.sampleRate, STT_SAMPLE_RATE);
      const chunks: Float32Array[] = [];
      let total = 0;
      let limitReached = false;
      const limit = Math.round((maxDurationMs / 1000) * STT_SAMPLE_RATE);
      const keep = (samples: Float32Array) => {
        if (total >= limit) return;
        const room = limit - total;
        const part = samples.length > room ? samples.subarray(0, room) : samples;
        chunks.push(part);
        total += part.length;
        if (total >= limit && !limitReached) {
          limitReached = true;
          options.onLimitReached?.();
        }
      };

      const onLevel = options.onLevel;
      capture = await createCapture(ctx, (samples) => {
        if (finished || total >= limit) return;
        keep(resampler.push(samples));
        if (onLevel && samples.length) {
          let energy = 0;
          for (const sample of samples) energy += sample * sample;
          onLevel(Math.min(1, Math.sqrt(energy / samples.length)));
        }
      }, options.preferWorklet ?? true);
      signal?.throwIfAborted();
      source = ctx.createMediaStreamSource(stream);
      source.connect(capture.input);

      let result: Promise<Float32Array> | null = null;
      return {
        stop() {
          result ??= (async () => {
            if (finished) throw abortError("Recording was cancelled");
            await capture!.flush();
            keep(resampler.flush());
            teardown();
            const durationMs = (total / STT_SAMPLE_RATE) * 1000;
            if (durationMs < minDurationMs) {
              throw new MicrophoneError("too-short", `The recording was ${Math.round(durationMs)} ms, shorter than ${minDurationMs} ms`);
            }
            const pcm = new Float32Array(total);
            let offset = 0;
            for (const chunk of chunks) (pcm.set(chunk, offset), (offset += chunk.length));
            return pcm;
          })();
          return result;
        },
        cancel() {
          teardown();
        },
      };
    } catch (error) {
      teardown();
      throw error instanceof MicrophoneError || (error instanceof DOMException && error.name === "AbortError") ? error : mapMediaError(error);
    }
  }

  return {
    start,
    async dispose() {
      releaseIdle();
      const closing = context;
      context = null;
      await closing?.close().catch(() => {});
    },
  };
}
