import {
  createMicRecorder,
  createVoxxy,
  createWebAudioPlayer,
  MicrophoneError,
  type Kind,
  type SttSession,
} from "voxxy";
import { moonshineStt } from "voxxy/stt/moonshine";
import { detectPlatformStt, platformStt } from "voxxy/stt/platform";
import { paradeeTts } from "voxxy/tts/paradee";
import { platformTts } from "voxxy/tts/platform";
import { chatReply, chatServices, type Turn } from "./chat";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const composer = byId<HTMLFormElement>("composer");
const input = byId<HTMLInputElement>("prompt");
const messages = byId("messages");
const welcome = byId("welcome");
const example = byId<HTMLButtonElement>("example");
const send = byId<HTMLButtonElement>("send");
const stop = byId<HTMLButtonElement>("stop");
const reset = byId<HTMLButtonElement>("reset");
const mic = byId<HTMLButtonElement>("mic");
const audio = byId<HTMLButtonElement>("audio");
const chatStatus = byId("chat-status");
const announcement = byId("chat-announcement");
const voiceNote = byId("voice-note");
const micSignalDescription = byId("mic-signal-description");
const engineControls = {
  stt: { select: byId<HTMLSelectElement>("stt-engine"), note: byId("stt-engine-note") },
  tts: { select: byId<HTMLSelectElement>("tts-engine"), note: byId("tts-engine-note") },
};
const recognitionPrivacy = byId("recognition-privacy");
const playbackPrivacy = byId("playback-privacy");
const serviceLinks = new Map(chatServices.map(({ name, docs }) => {
  const link = document.createElement("a");
  link.textContent = name;
  link.href = docs;
  return [name, link] as const;
}));
const serviceList = new Intl.ListFormat("en").formatToParts([...serviceLinks.keys()]);
byId("chat-services").replaceChildren(...serviceList.map(({ value }) => serviceLinks.get(value) ?? value));
byId("chat-privacy").hidden = false;

const player = createWebAudioPlayer();
const voice = createVoxxy({ platformFallback: { stt: "off", tts: "off" } });
const recorder = createMicRecorder({
  onLevel(level) {
    if (!recording) return;
    const sampleLevel = Math.max(0, (20 * Math.log10(level) + 60) / 60);
    // Respond immediately to speech and let the display decay between blocks.
    micLevel = Math.max(sampleLevel, micLevel * 0.75 + sampleLevel * 0.25);
    mic.style.setProperty("--mic-level", String(micLevel * 4));
    const description = micLevel >= 0.25 ? "Microphone signal detected." : "Microphone signal is quiet.";
    if (micSignalDescription.textContent !== description) micSignalDescription.textContent = description;
  },
  onLimitReached: () => void finishRecording(),
});
const history: Turn[] = [];
let turn: AbortController | undefined;
let recording: SttSession | undefined;
let micLevel = 0;
let transcribing = false;
let preparing: Kind | undefined;
let spokenReplies = false;
let stopPlayback: (() => void) | undefined;

function status(element: HTMLElement, text: string, error = false): void {
  element.textContent = text;
  element.dataset.error = String(error);
}

const mb = (bytes: number) => `${Math.ceil(bytes / 1e6)} MB`;
const workerHint = "Enable voice to download the English models.";

function enableLabel(kind: Kind, label: string): string {
  const { downloadSize, phase } = voice.models.getState()[kind];
  if (kind === "stt" && engineControls.stt.select.value === "local" && phase !== "ready") {
    return "Install English speech pack";
  }
  return downloadSize && phase !== "ready" ? `${label} (${mb(downloadSize)})` : label;
}

function engineAvailability(kind: Kind): "checking" | "unavailable" | "available" {
  const { select, note } = engineControls[kind];
  const model = voice.models.getState()[kind];
  const engine = select.value;
  const registered = model.provider?.id === voice.getState()[kind].selected?.id && !!model.provider;
  const onlineRecognitionUnavailable = kind === "stt" && engine === "cloud" && !detectPlatformStt().cloud;
  const unavailable = onlineRecognitionUnavailable || (registered && model.phase === "unavailable");
  const checking = !registered || (kind === "tts" && engine !== "worker" && model.phase === "not-opted-in");
  let message = "";
  if (unavailable) {
    message = onlineRecognitionUnavailable ? "Online recognition is unavailable in this browser." : model.reason ?? "This engine is unavailable.";
  } else if (engine !== "worker" && checking) {
    message = "Checking browser support…";
  }
  if (note.textContent !== message) status(note, message, unavailable);
  note.hidden = !message;
  if (unavailable) return "unavailable";
  return checking ? "checking" : "available";
}

function renderControls(): void {
  const { stt, tts } = voice.getState();
  const sttAvailability = engineAvailability("stt");
  const ttsAvailability = engineAvailability("tts");
  const lockEngines = !!preparing || !!recording || transcribing || !!turn;
  engineControls.stt.select.disabled = lockEngines;
  engineControls.tts.select.disabled = lockEngines;
  mic.disabled = !!preparing || !!turn || transcribing || sttAvailability !== "available";
  mic.dataset.recording = String(!!recording);
  mic.dataset.levelMeter = String(stt.active?.engine === "worker");
  if (!recording) {
    micLevel = 0;
    mic.style.removeProperty("--mic-level");
    micSignalDescription.textContent = "";
  }
  mic.querySelector("span")!.textContent = sttAvailability === "unavailable" ? "Mic unavailable"
    : sttAvailability === "checking" ? "Checking mic…"
    : recording ? "Stop recording"
    : stt.status === "ready" ? "Record" : enableLabel("stt", "Enable mic");
  audio.disabled = !!preparing || !!recording || transcribing || ttsAvailability !== "available";
  audio.setAttribute("aria-pressed", String(spokenReplies));
  audio.querySelector("span")!.textContent = ttsAvailability === "unavailable" ? "Audio unavailable"
    : ttsAvailability === "checking" ? "Checking audio…"
    : tts.status === "ready" ? "Spoken replies" : enableLabel("tts", "Enable audio");
  send.disabled = !!recording || transcribing;
  send.hidden = !!turn;
  stop.hidden = !turn;
  reset.disabled = !!turn || !!recording || transcribing;
}

function selectVoiceEngine(kind: Kind): void {
  const value = engineControls[kind].select.value;
  const locality = value === "cloud" ? "cloud" : "local";
  if (kind === "stt") {
    voice.select(value === "worker" ? moonshineStt({ recorder }) : platformStt({
      locality,
      onAudioStart: () => queueMicrotask(() => {
        if (recording) status(voiceNote, locality === "cloud" ? "Listening in English (online)…" : "Listening in English…");
      }),
      // Native recognition can end by itself, even before listen() returns.
      onEnd: () => queueMicrotask(() => void finishRecording()),
    }));
  } else {
    spokenReplies = false;
    voice.select(value === "worker" ? paradeeTts({ player }) : platformTts({ locality }));
  }
  recognitionPrivacy.textContent = engineControls.stt.select.value === "cloud"
    ? "Online recognition may send microphone audio to the browser’s speech service."
    : "Microphone audio stays on your device.";
  playbackPrivacy.hidden = engineControls.tts.select.value !== "cloud";
  const useWorkerModels = engineControls.stt.select.value === "worker" && engineControls.tts.select.value === "worker";
  status(voiceNote, useWorkerModels ? workerHint : "");
  renderControls();
}

voice.models.subscribe((models) => {
  if (preparing) {
    const { progress } = models[preparing];
    if (progress?.total) {
      const percent = Math.floor(100 * progress.loaded / progress.total);
      status(voiceNote, `Downloading voice model… ${percent}%`);
    }
  }
  renderControls();
});
voice.subscribe(renderControls);
for (const kind of ["stt", "tts"] as const) {
  engineControls[kind].select.addEventListener("change", () => selectVoiceEngine(kind));
  selectVoiceEngine(kind);
}
globalThis.speechSynthesis?.addEventListener("voiceschanged", () => {
  if (engineControls.tts.select.value !== "worker" && !preparing && voice.models.getState().tts.phase === "unavailable") {
    void voice.models.refresh("tts");
  }
});

async function prepare(kind: Kind): Promise<boolean> {
  preparing = kind;
  status(voiceNote, "Preparing voice model…");
  renderControls();
  try {
    const unlocked = kind === "tts" ? voice.unlock() : Promise.resolve();
    const load = async () => {
      await voice.models.optIn(kind);
      await voice.load(kind);
    };
    // Keep the preparation controls locked until both operations settle.
    const results = await Promise.allSettled([unlocked, load()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    status(voiceNote, kind === "stt" ? "Select Record, then speak English." : "Spoken replies are on.");
    return true;
  } catch (error) {
    const message = engineControls[kind].select.value !== "worker" && error instanceof Error
      ? error.message : "Couldn’t enable voice. Select the control to retry.";
    status(voiceNote, message, true);
    return false;
  } finally {
    preparing = undefined;
    renderControls();
  }
}

async function finishRecording(): Promise<void> {
  if (!recording) return;
  const session = recording;
  const engine = engineControls.stt.select.value;
  recording = undefined;
  transcribing = true;
  status(voiceNote, engine === "cloud" ? "Transcribing…" : "Transcribing on this device…");
  renderControls();
  try {
    const transcript = (await session.stop()).trim();
    if (transcript) {
      input.value = transcript.slice(0, input.maxLength);
      input.focus();
      status(voiceNote, "Review the transcript, then send it.");
    } else {
      status(voiceNote, engine === "worker"
        ? "No English speech recognized. Try recording a full sentence."
        : "Browser recognition returned no text. Try again or choose Moonshine.", true);
    }
  } catch (error) {
    if (error instanceof MicrophoneError && error.code === "too-short") {
      status(voiceNote, "Recording was too short. Try a full sentence.", true);
    } else if (error instanceof MicrophoneError && error.code === "permission-denied") {
      status(voiceNote, "Allow microphone access in your browser and try again.", true);
    } else {
      status(voiceNote, engine !== "worker" && error instanceof Error
        ? error.message : "Couldn’t record speech. Check microphone access and try again.", true);
    }
  } finally {
    transcribing = false;
    renderControls();
  }
}

mic.addEventListener("click", async () => {
  if (recording) {
    await finishRecording();
    return;
  }

  if (voice.getState().stt.status !== "ready") {
    await prepare("stt");
    return;
  }

  try {
    recording = voice.listen();
    status(voiceNote, engineControls.stt.select.value === "worker" ? "Recording in English…" : "Starting microphone…");
  } catch {
    status(voiceNote, "Couldn’t start the microphone. Check browser permissions.", true);
  }
  renderControls();
});

audio.addEventListener("click", async () => {
  if (spokenReplies) {
    spokenReplies = false;
    stopPlayback?.();
    status(voiceNote, "Spoken replies are off.");
  } else if (voice.getState().tts.status !== "ready") {
    spokenReplies = await prepare("tts");
  } else {
    try {
      await voice.unlock();
      spokenReplies = true;
      status(voiceNote, "Spoken replies are on.");
    } catch {
      status(voiceNote, "Couldn’t enable playback. Select Spoken replies to retry.", true);
    }
  }
  renderControls();
});

function addMessage(role: "user" | "assistant", text: string): HTMLParagraphElement {
  const message = document.createElement("div");
  message.className = "message";
  message.dataset.role = role;
  const name = document.createElement("strong");
  name.textContent = role === "user" ? "You" : "Reply";
  const content = document.createElement("p");
  content.textContent = text;
  message.append(name, content);
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
  return content;
}

async function sendMessage(): Promise<void> {
  const prompt = input.value.trim();
  if (!prompt || turn || recording || transcribing) return;

  const controller = new AbortController();
  turn = controller;
  const { signal } = controller;
  input.value = "";
  welcome.hidden = true;
  reset.hidden = false;
  const userMessage = addMessage("user", prompt);
  status(chatStatus, "Waiting for a reply…");
  announcement.textContent = "";
  renderControls();
  if (document.activeElement === document.body) input.focus();

  let content: HTMLParagraphElement | undefined;
  let reply = "";
  let serviceAnswered = true;
  let speech = spokenReplies ? voice.speakStream({ signal }) : undefined;
  stopPlayback = () => {
    speech?.cancel();
    speech = undefined;
  };

  try {
    if (speech) {
      try {
        await voice.unlock();
      } catch {
        stopPlayback();
        status(voiceNote, "Couldn’t start playback. Toggle Spoken replies to retry.", true);
      }
    }

    for await (const update of chatReply(prompt, history, signal)) {
      if (update.type !== "delta") {
        content?.parentElement?.remove();
        content = undefined;
        reply = "";
        if (speech) {
          stopPlayback();
          speech = voice.speakStream({ signal });
        }
        if (update.type === "retry") {
          status(chatStatus, "Trying another chat service…");
          continue;
        }
        serviceAnswered = false;
      }

      content ??= addMessage("assistant", "");
      if (!reply && serviceAnswered) {
        status(chatStatus, "Receiving reply…");
      }
      const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
      reply += update.text;
      content.textContent = reply;
      if (follow) messages.scrollTop = messages.scrollHeight;

      try {
        await speech?.push(update.text);
      } catch {
        stopPlayback();
        if (!signal.aborted) status(voiceNote, "Playback stopped. You can still read the reply.", true);
      }
    }

    if (serviceAnswered) history.push({ prompt, reply });
    if (speech) {
      status(chatStatus, "Speaking reply…");
      try {
        await speech.end();
      } catch {
        if (signal.aborted) signal.throwIfAborted();
        if (speech) status(voiceNote, "Playback stopped. You can still read the reply.", true);
      }
    } else {
      announcement.textContent = reply;
    }
    status(chatStatus, serviceAnswered ? "Reply complete." : "Chat services unavailable.");
  } catch (error) {
    if (!reply.trim()) {
      userMessage.parentElement?.remove();
      content?.parentElement?.remove();
      if (!input.value) input.value = prompt;
      welcome.hidden = messages.children.length > 1;
      reset.hidden = !welcome.hidden;
    }
    if (signal.aborted) {
      status(chatStatus, "Reply stopped.");
    } else {
      const message = error instanceof Error && !(error instanceof SyntaxError)
        ? error.message
        : "Couldn’t read the reply. Try again.";
      status(chatStatus, message, true);
    }
  } finally {
    stopPlayback();
    stopPlayback = undefined;
    turn = undefined;
    renderControls();
    if (document.activeElement === document.body) input.focus();
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});
example.addEventListener("click", () => {
  input.value = example.textContent!.trim();
  input.focus();
});
stop.addEventListener("click", () => turn?.abort());
reset.addEventListener("click", () => {
  history.length = 0;
  messages.replaceChildren(welcome);
  welcome.hidden = false;
  reset.hidden = true;
  input.value = "";
  status(chatStatus, "");
  announcement.textContent = "";
  input.focus();
});
