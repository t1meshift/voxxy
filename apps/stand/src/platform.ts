import { createVoxxy, type PlatformFallbackPolicy, type SttSession } from "voxxy";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const policy = $<HTMLSelectElement>("platformPolicy");
const load = $<HTMLButtonElement>("platformLoad");
const install = $<HTMLButtonElement>("platformInstall");
const talk = $<HTMLButtonElement>("platformTalk");
const speak = $<HTMLButtonElement>("platformSpeak");
const stop = $<HTMLButtonElement>("platformStop");
const result = $("platformResult");
let voice = createDemo();
let unsubscribe = () => {};
let session: SttSession | undefined;

function createDemo() {
  const mode = policy.value as PlatformFallbackPolicy;
  return createVoxxy({ platformFallback: { stt: mode, tts: mode } });
}

function render() {
  const models = voice.platformModels.getState();
  const state = voice.getState();
  const pack = models.stt;
  const installing = pack.phase === "downloading" || pack.phase === "evicted-redownloading";
  install.hidden = !pack.provider || pack.phase === "unavailable" || pack.phase === "ready";
  install.disabled = load.disabled || installing;
  talk.disabled = !state.stt.active;
  speak.disabled = stop.disabled = !state.tts.active;
  $("platformState").textContent = (["stt", "tts"] as const).map((kind) => {
    const { active, status, error, fallbackError } = state[kind];
    if (policy.value === "off") return `${kind.toUpperCase()}: fallback disabled`;
    return `${kind.toUpperCase()}: ` + (active
      ? `${active.engine} (${active.locality}) · ${active.reason}`
      : fallbackError ?? error ?? status);
  }).concat(pack.provider ? [`Language pack: ${pack.reason ?? pack.error ?? pack.phase}`] : []).join("\n");
}

function observe() {
  const releaseState = voice.subscribe(render);
  const releaseModels = voice.platformModels.subscribe(render);
  unsubscribe = () => { releaseState(); releaseModels(); };
  render();
}
observe();

policy.addEventListener("change", async () => {
  unsubscribe();
  session?.cancel();
  session = undefined;
  talk.textContent = "Start listening";
  result.textContent = "";
  const old = voice;
  voice = createDemo();
  observe();
  await old.dispose();
});

load.addEventListener("click", async () => {
  load.disabled = policy.disabled = true;
  session?.cancel();
  session = undefined;
  talk.textContent = "Start listening";
  await Promise.allSettled([voice.load("stt"), voice.load("tts")]);
  load.disabled = policy.disabled = false;
  render();
});

function showError(error: unknown) {
  if (!(error instanceof DOMException && error.name === "AbortError")) result.textContent = String(error);
}

install.addEventListener("click", () => void voice.platformModels.optIn("stt").catch(showError));
talk.addEventListener("click", async () => {
  try {
    if (!session) {
      session = voice.listen();
      talk.textContent = "Stop listening";
      result.textContent = "Listening…";
      return;
    }
    const current = session;
    session = undefined;
    talk.textContent = "Start listening";
    talk.disabled = true;
    result.textContent = (await current.stop()) || "No speech recognised.";
  } catch (error) {
    showError(error);
  }
  render();
});
speak.addEventListener("click", () => void voice.speak($<HTMLTextAreaElement>("text").value).catch(showError));
stop.addEventListener("click", () => voice.stopSpeaking());
