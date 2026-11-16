import { createMicRecorder, createVoxxy, createWebAudioPlayer, MicrophoneError, type ChunkInfo, type KindState, type ModelsState, type SplitterOptions, type SttSession } from "voxxy";
import { moonshineStt } from "voxxy/stt/moonshine";
import { clipRecorder, wavToMono16k } from "voxxy/testing";
import { paradeeTts } from "voxxy/tts/paradee";

// The real engines, driven by controls (each click is a user gesture, which iOS and Chrome need for audio).
// "Speech to text" can hear a recorded clip or your microphone; "text to speech" speaks whatever you type.

const SENTENCE = "The library opens at nine, but the coffee shop next door is usually busy by eight.";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const metrics: Record<string, number | string> = {};
const showMetrics = () => ($("metrics").textContent = JSON.stringify(metrics, null, 2));

// `?volume=0` makes the page silent (the e2e test uses it), `?volume=0.3` quieter.
const player = createWebAudioPlayer({ volume: Number(new URLSearchParams(location.search).get("volume") ?? 1) });
const voxxy = createVoxxy({ platformFallback: { stt: "off", tts: "off" } });

// How speak() cuts text into chunks. Every chunk is one model run and starts with about 0.3 s of quiet.
const CHUNKING: Record<string, SplitterOptions> = {
  sentences: { minChars: 10 },
  packed: { firstMinChars: 30, minChars: 120, maxChars: 240 },
  big: { firstMinChars: 30, minChars: 300, maxChars: 420 },
};

const settings = {
  voice: "af_heart" as "af_heart" | "am_puck",
  speed: 1,
  chunking: "packed",
  source: "clip" as "clip" | "mic",
};

/** One line per chunk: how big it was, how long it took, how long it plays, and what the speed allows next. */
function logChunk(info: ChunkInfo): void {
  const log = $("chunkLog");
  if (info.index === 0) log.textContent = "";
  const speed = info.speedFactor ? `${info.speedFactor.toFixed(1)}x speech` : "?";
  const next = info.nextCap ? `next ≤ ${Math.round(info.nextCap)}` : "next unlimited";
  const quote = info.text.length > 70 ? `${info.text.slice(0, 67)}…` : info.text;
  log.textContent +=
    `#${String(info.index + 1).padStart(2)}  size ${String(info.weight).padStart(3)}  made in ${String(Math.round(info.synthMs)).padStart(5)} ms` +
    `  plays ${info.audioSeconds.toFixed(1).padStart(5)} s  speed ${speed.padEnd(12)} ${next.padEnd(15)} │ ${JSON.stringify(quote)}\n`;
}

/** While a measurement runs, every chunk made is kept here. */
let chunkSink: ChunkInfo[] | null = null;
const onChunk = (info: ChunkInfo) => {
  chunkSink?.push(info);
  logChunk(info);
};

const clipPcm = async () => wavToMono16k(new Uint8Array(await (await fetch("jfk-16k-mono.wav")).arrayBuffer()));
const makeStt = () => moonshineStt({ recorder: settings.source === "mic" ? createMicRecorder() : clipRecorder(clipPcm) });
const makeTts = () => paradeeTts({ player, voice: settings.voice, speed: settings.speed, splitter: CHUNKING[settings.chunking], onChunk });

/** Texts picked to make a way of chunking fail, each for the reason in its name. */
const wrap = (text: string, width: number) => text.replace(new RegExp(`(.{1,${width}})(\\s+|$)`, "g"), "$1\n").trimEnd();
const PRESETS: Record<string, string> = {
  "Gatsby: the opening paragraph": $<HTMLTextAreaElement>("text").value,
  "One very long first sentence (sound waits for it)": "When I was younger and a good deal more inclined to think that every question has a single clean answer, I used to believe that a person who says nothing for a long time must have a great deal to say, whereas the truth, as I have found since, is that silence is usually just silence, and a long sentence is usually just a long sentence. Then it ended. Fine.",
  "A long number (80 digits are 28 seconds)": "The constant is 3.14159265358979323846264338327950288419716939937510582097494459230781640628620899 and that is all. Ok.",
  "Money, dates and times": "It costs $1,234,567.89 or 1,000,000,000 yen on 12/31/1999 at 11:59 p.m. sharp. Ok. See you then.",
  "Hard-wrapped e-mail (a line break every 40 characters)": wrap("In my younger and more vulnerable years my father gave me some advice that I have been turning over in my mind ever since. Whenever you feel like criticizing anyone, he told me, just remember that all the people in this world have not had the advantages that you have had.", 40),
  "One-word sentences": "Yes. No. Maybe. Okay. Fine. Sure. Right. Hm. Ah. Oh. Well. Hey. Stop. Go. Wait. Look.",
  "Hey. I. Am. Here.": "Hey. I. Am. Here.",
  "Shouting and spam": "WHAT?!?! NO WAY!!!! ARE YOU SERIOUS?!?! I CAN'T BELIEVE IT!!!!!!!! REALLY?????? YES!!! OK!!!",
  "Abbreviations in a row": "Dr. Prof. Mr. Mrs. Ms. Jr. Sr. Smith met Mr. Jones at 5 p.m. on Jan. 5th in Washington D.C. and then they left. Next one.",
  "No punctuation at all": "so I went to the shop and then I thought about what you said and then I went home and then I made some tea and then I sat down and thought about it again and then I decided that you were right about most of it but not about the part regarding the money and so I called you but you did not pick up and I left a message that said nothing much really and then I went to bed",
  "Dots without spaces": "Hello.World.This.Is.Joined.Text.With.No.Spaces.After.Dots.Another.Long.One.Here.To.Cross.The.Limit.Of.The.Chunk.And.More.Words.Keep.Coming.Because.Nobody.Typed.A.Space.Anywhere.In.This.Whole.Thing.At.All.Ever.",
  "A URL, an e-mail and code": "See https://example.com/path/to/some/very/long/resource.html?query=1&other=2 or write to first.last@example.co.uk, or run foo.bar.baz() and then npm install --save-dev. Done.",
  "Ellipses": "Well... I mean... you know... it's... complicated... but... fine... I guess... maybe... not.",
};

voxxy.select(makeStt());
voxxy.select(makeTts());

const mb = (bytes: number | null) => (bytes === null ? "?" : `${(bytes / 1e6).toFixed(1)} MB`);

// One row per kind: name, phase, a bar, bytes and speed, and which file is coming in. Rebuilt on every change.
const NAMES = { stt: "Speech to text (Moonshine)", tts: "Text to speech (Paradee)" } as const;
const speed: Record<string, { at: number; loaded: number; rate: number }> = {};

function renderDownloads(models: ModelsState): void {
  const root = $("downloads");
  root.replaceChildren();
  for (const kind of ["stt", "tts"] as const) {
    const m = models[kind];
    const p = m.progress;
    const row = document.createElement("div");
    row.style.cssText = "margin: 0 0 12px; font: 13px/1.5 ui-monospace, monospace";
    const title = document.createElement("div");
    title.textContent = `${NAMES[kind]}: ${m.phase}${m.phase === "ready" ? "" : ` (${mb(m.downloadSize)} to download)`}`;
    row.append(title);

    if (p) {
      // Speed over the last moment, smoothed so the number does not flicker.
      const now = performance.now();
      const last = speed[kind];
      if (last && now - last.at > 250) {
        const instant = ((p.loaded - last.loaded) / (now - last.at)) * 1000;
        speed[kind] = { at: now, loaded: p.loaded, rate: last.rate ? last.rate * 0.6 + instant * 0.4 : instant };
      } else if (!last || p.loaded < last.loaded) {
        speed[kind] = { at: now, loaded: p.loaded, rate: 0 };
      }
      const bar = document.createElement("progress");
      bar.style.cssText = "width: 360px; height: 16px; vertical-align: middle";
      if (p.total) {
        bar.max = p.total;
        bar.value = p.loaded;
      }
      const percent = p.total ? ` ${Math.round((p.loaded / p.total) * 100)}%` : "";
      const rate = speed[kind]?.rate ? `  ${(speed[kind]!.rate / 1e6).toFixed(1)} MB/s` : "";
      const text = document.createElement("span");
      text.textContent = `  ${mb(p.loaded)} of ${mb(p.total)}${percent}${rate}  (file ${p.fileIndex + 1} of ${p.fileCount})`;
      row.append(bar, text);
    } else {
      delete speed[kind];
    }
    if (m.error) {
      const error = document.createElement("div");
      error.style.color = "crimson";
      error.textContent = `Error: ${m.error}`;
      row.append(error);
    }
    root.append(row);
  }
}

const describeKind = (name: string, kind: KindState) =>
  `${name}: ${kind.status}` + (kind.active ? ` via ${kind.active.id} (${kind.active.engine}, ${kind.active.locality})` : "") + (kind.error ? `  ERROR ${kind.error}` : "");

voxxy.models.subscribe(renderDownloads);
voxxy.subscribe(({ stt, tts }) => {
  $("active").textContent = `${describeKind("stt", stt)}\n${describeKind("tts", tts)}`;
  document.title = `stt:${stt.status} tts:${tts.status}`;
});
renderDownloads(voxxy.models.getState());

const ready = () => (["stt", "tts"] as const).every((kind) => voxxy.models.getState()[kind].phase === "ready");
const button = (id: string) => $<HTMLButtonElement>(id);

voxxy.models.subscribe(() => {
  if (ready() && voxxy.getState().tts.status !== "ready") button("load").disabled = false;
});

let optInAt = 0;
$("optin").addEventListener("click", () => {
  button("optin").disabled = true;
  void voxxy.unlock(); // Inside the gesture, so audio is allowed later.
  optInAt = performance.now();
  const stop = voxxy.models.subscribe(() => {
    if (ready()) {
      metrics["downloadAndVerifyMs"] = Math.round(performance.now() - optInAt);
      showMetrics();
      stop();
    }
  });
  void voxxy.models.optIn("stt");
  void voxxy.models.optIn("tts");
});

// Forget the consent and delete the files, so the download can be watched again.
$("forget").addEventListener("click", async () => {
  await Promise.all([voxxy.unload("stt"), voxxy.unload("tts")]);
  await Promise.all([voxxy.models.optOut("stt"), voxxy.models.optOut("tts")]);
  location.reload(); // The wasm file is shared and kept by the other kind until both are gone; start clean.
});

function enableControls(on: boolean): void {
  for (const id of ["speak", "clip", "stream", "speakText", "stopText", "talk", "measure"]) button(id).disabled = !on;
}

$("load").addEventListener("click", async () => {
  button("load").disabled = true;
  void voxxy.unlock();
  const sttStart = performance.now();
  await voxxy.load("stt");
  metrics["sttLoadMs"] = Math.round(performance.now() - sttStart);
  const ttsStart = performance.now();
  await voxxy.load("tts");
  metrics["ttsLoadMs"] = Math.round(performance.now() - ttsStart);
  showMetrics();
  enableControls(true);
});

// Changing a setting builds a new provider (voice and speed are loaded with the model). The files are already
// stored, so it only takes the half-second it takes to load them into the runtime.
async function rebuild(kind: "stt" | "tts"): Promise<void> {
  const wasLoaded = voxxy.getState()[kind].status === "ready";
  voxxy.select(kind === "stt" ? makeStt() : makeTts());
  if (wasLoaded) {
    $("speakInfo").textContent = "Applying the new settings…";
    await voxxy.load(kind);
    $("speakInfo").textContent = "";
  }
}

$("voice").addEventListener("change", () => {
  settings.voice = $<HTMLSelectElement>("voice").value as typeof settings.voice;
  void rebuild("tts");
});
$("speedRange").addEventListener("input", () => {
  settings.speed = Number($<HTMLInputElement>("speedRange").value);
  $("speedValue").textContent = settings.speed.toFixed(2);
});
$("speedRange").addEventListener("change", () => void rebuild("tts")); // On release, not on every step.
$("chunking").addEventListener("change", () => {
  settings.chunking = $<HTMLSelectElement>("chunking").value;
  void rebuild("tts");
});
const presetSelect = $<HTMLSelectElement>("preset");
for (const name of Object.keys(PRESETS)) presetSelect.append(new Option(name, name));
presetSelect.addEventListener("change", () => {
  $<HTMLTextAreaElement>("text").value = PRESETS[presetSelect.value] ?? "";
  $("chunkLog").textContent = "";
  $("speakInfo").textContent = "";
});
$("source").addEventListener("change", () => {
  settings.source = $<HTMLSelectElement>("source").value as typeof settings.source;
  void rebuild("stt");
});

// --- Speak your own text ---------------------------------------------------------------------------------------------

/** Counts chunks and notes when sound starts, for the duration of one speak(). */
function watchPlayer() {
  const startedAt = performance.now();
  let firstAudioMs = 0;
  let chunks = 0;
  const off = [
    player.on("started", () => (firstAudioMs ||= performance.now() - startedAt)),
    player.on("chunk-finished", () => chunks++),
  ];
  return {
    stop: () => off.forEach((f) => f()),
    result: () => ({ firstAudioMs: Math.round(firstAudioMs), chunks, totalMs: Math.round(performance.now() - startedAt) }),
  };
}

$("speakText").addEventListener("click", async () => {
  void voxxy.unlock();
  const text = $<HTMLTextAreaElement>("text").value;
  const watch = watchPlayer();
  $("speakInfo").textContent = "Speaking…";
  try {
    await voxxy.speak(text);
    const r = watch.result();
    $("speakInfo").textContent = `${text.length} characters in ${r.chunks} chunks. First sound after ${r.firstAudioMs} ms; finished playing after ${(r.totalMs / 1000).toFixed(1)} s.`;
  } catch (error) {
    $("speakInfo").textContent = (error as Error).name === "AbortError" ? "Stopped." : `Error: ${(error as Error).message}`;
  } finally {
    watch.stop();
  }
});
$("stopText").addEventListener("click", () => voxxy.stopSpeaking());

// --- Speak to it -----------------------------------------------------------------------------------------------------

let session: SttSession | null = null;
let heldAt = 0;
const talk = $<HTMLButtonElement>("talk");

talk.addEventListener("pointerdown", (event) => {
  if (session) return;
  talk.setPointerCapture(event.pointerId);
  void voxxy.unlock();
  talk.classList.add("on");
  talk.textContent = "Listening… release to send";
  heldAt = performance.now();
  session = voxxy.listen();
});

async function release(): Promise<void> {
  const current = session;
  if (!current) return;
  session = null;
  talk.classList.remove("on");
  talk.textContent = "Hold to talk";
  $("heard").textContent = "Transcribing…";
  const heldMs = Math.round(performance.now() - heldAt);
  const startedAt = performance.now();
  try {
    const text = await current.stop();
    $("heard").textContent = `${text || "(nothing recognised)"}\n\nheld ${heldMs} ms, transcribed in ${Math.round(performance.now() - startedAt)} ms`;
  } catch (error) {
    if (error instanceof MicrophoneError) {
      const hints: Record<string, string> = {
        "too-short": "Too short: hold the button while you speak.",
        "permission-denied": "The browser did not allow the microphone.",
        "no-device": "No microphone found.",
        busy: "The microphone is already in use.",
      };
      $("heard").textContent = hints[error.code] ?? `Microphone error (${error.code}): ${error.message}`;
    } else {
      $("heard").textContent = `Error: ${(error as Error).message}`;
    }
  }
}
for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) talk.addEventListener(event, () => void release());

// --- Quick checks ----------------------------------------------------------------------------------------------------

$("speak").addEventListener("click", async () => {
  void voxxy.unlock();
  const spokeAt = performance.now();
  const stopListening = player.on("started", () => {
    metrics["timeToFirstAudioMs"] = Math.round(performance.now() - spokeAt);
    stopListening();
    showMetrics();
  });
  await voxxy.speak(SENTENCE);
  metrics["speakMs"] = Math.round(performance.now() - spokeAt);
  showMetrics();
});

$("clip").addEventListener("click", async () => {
  const keep = settings.source;
  if (keep !== "clip") {
    // The quick check is always about the clip, whatever the microphone setting says.
    settings.source = "clip";
    await rebuild("stt");
  }
  const heardAt = performance.now();
  const text = await voxxy.listen().stop();
  metrics["transcribeMs"] = Math.round(performance.now() - heardAt);
  metrics["transcript"] = text;
  showMetrics();
  if (keep !== "clip") {
    settings.source = keep;
    await rebuild("stt");
  }
});

// A reply as a chat model would stream it, about 40 tokens a second. Spoken sentence by sentence as it arrives,
// against the alternative of waiting for the whole reply and speaking it in one go.
const REPLY =
  "Sure, I can help with that. First, open the settings page and look for the language section. " +
  "Then pick the language you want from the list. If it is not there, you can add it by pressing the plus button. " +
  "Finally, press save, and the change takes effect the next time you open the app.";

$("stream").addEventListener("click", async () => {
  void voxxy.unlock();
  const tokens = REPLY.split(/(?<=\s)/);

  let firstAt = 0;
  const off = player.on("started", () => ((firstAt ||= performance.now()), off()));
  const startedAt = performance.now();
  const stream = voxxy.speakStream();
  for (const token of tokens) {
    await stream.push(token);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const replyCompleteMs = performance.now() - startedAt;
  await stream.end();
  metrics["streamedFirstAudioMs"] = Math.round(firstAt - startedAt);
  metrics["replyCompleteMs"] = Math.round(replyCompleteMs);

  // The baseline: the whole reply is there, then it is spoken. Its first audio comes after the reply is complete.
  let wholeFirstAt = 0;
  const offWhole = player.on("started", () => ((wholeFirstAt ||= performance.now()), offWhole()));
  const wholeAt = performance.now();
  await voxxy.speak(REPLY);
  metrics["speakWholeReplyFirstAudioMs"] = Math.round(replyCompleteMs + (wholeFirstAt - wholeAt));
  showMetrics();
});

// --- Measurements ----------------------------------------------------------------------------------------------------
// One button, one JSON to copy: what the device is, how fast each engine is on it, and how much memory the page uses.
// Run it after "Load". The runtime is single-threaded (see prepareOrt).

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function memoryMb(): Promise<number | null> {
  const perf = performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>; memory?: { usedJSHeapSize: number } };
  try {
    if (crossOriginIsolated && perf.measureUserAgentSpecificMemory) return Math.round((await perf.measureUserAgentSpecificMemory()).bytes / 1e6); // Includes the workers.
    if (perf.memory) return Math.round(perf.memory.usedJSHeapSize / 1e6); // This page's JS heap only; not the workers or wasm.
  } catch {
    // Not allowed here.
  }
  return null; // Firefox and Safari do not say.
}

const MEASURE_TEXTS: Record<string, string> = {
  short: SENTENCE,
  paragraph: "In my younger and more vulnerable years my father gave me some advice that I’ve been turning over in my mind ever since. “Whenever you feel like criticizing anyone,” he told me, “just remember that all the people in this world haven’t had the advantages that you’ve had.”",
};

async function measure(): Promise<void> {
  const out = $("measureOut");
  button("measure").disabled = true;
  out.textContent = "Measuring… (three runs of each; the speech is real, so mute with ?volume=0)";
  void voxxy.unlock();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const result: Record<string, unknown> = {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    deviceMemoryGb: nav.deviceMemory ?? null,
    crossOriginIsolated,
    chunking: settings.chunking,
    memoryBeforeMb: await memoryMb(),
  };

  const tts: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(MEASURE_TEXTS)) {
    const runs: Array<{ firstAudioMs: number; synthMs: number; audioS: number }> = [];
    for (let i = 0; i < 3; i++) {
      chunkSink = [];
      const watch = watchPlayer();
      await voxxy.speak(text);
      watch.stop();
      const chunks = chunkSink;
      chunkSink = null;
      runs.push({
        firstAudioMs: watch.result().firstAudioMs,
        synthMs: chunks.reduce((sum, c) => sum + c.synthMs, 0),
        audioS: chunks.reduce((sum, c) => sum + c.audioSeconds, 0),
      });
    }
    const synthMs = median(runs.map((r) => r.synthMs));
    const audioS = median(runs.map((r) => r.audioS));
    tts[name] = { characters: text.length, firstAudioMs: median(runs.map((r) => r.firstAudioMs)), synthMs: Math.round(synthMs), audioS: Number(audioS.toFixed(1)), timesFasterThanSpeech: Number((audioS / (synthMs / 1000)).toFixed(2)) };
  }
  result["tts"] = tts;

  // The clip is read the same way each time: through the recorder from "recorded clip", whatever the source setting says.
  const keep = settings.source;
  if (keep !== "clip") {
    settings.source = "clip";
    await rebuild("stt");
  }
  const clipSeconds = (await clipPcm()).length / 16000;
  const times: number[] = [];
  let transcript = "";
  for (let i = 0; i < 3; i++) {
    const startedAt = performance.now();
    transcript = await voxxy.listen().stop();
    times.push(performance.now() - startedAt);
  }
  if (keep !== "clip") {
    settings.source = keep;
    await rebuild("stt");
  }
  result["stt"] = { clipSeconds: Number(clipSeconds.toFixed(1)), transcribeMs: Math.round(median(times)), timesFasterThanSpeech: Number((clipSeconds / (median(times) / 1000)).toFixed(2)), transcript };

  result["memoryAfterMb"] = await memoryMb();
  result["loadMs"] = { download: metrics["downloadAndVerifyMs"] ?? null, stt: metrics["sttLoadMs"] ?? null, tts: metrics["ttsLoadMs"] ?? null };
  result["downloadMb"] = { stt: (voxxy.models.getState().stt.downloadSize ?? 0) / 1e6, tts: (voxxy.models.getState().tts.downloadSize ?? 0) / 1e6 };
  out.textContent = JSON.stringify(result, null, 2);
  (window as unknown as { __measure: unknown }).__measure = result;
  button("measure").disabled = false;
}

$("measure").addEventListener("click", () => void measure());
$("copyMeasure").addEventListener("click", () => void navigator.clipboard?.writeText($("measureOut").textContent ?? ""));

declare global {
  interface Window {
    __real: { voxxy: typeof voxxy; player: typeof player; metrics: typeof metrics };
  }
}
window.__real = { voxxy, player, metrics };
