import * as lib from "voxxy";
import { createMicRecorder, createVoxxy, createWebAudioPlayer, type KindState, type SpeakStream } from "voxxy";
import { fakePlayer } from "voxxy/testing";
import { dummyStt } from "voxxy/stt/dummy";
import { dummyTts } from "voxxy/tts/dummy";

// `?mic=real` uses the real microphone recorder, `?audio=real` the real WebAudio player (a generated tone).
// Both need a user gesture, so those modes wait for the button instead of running on load.
const params = new URLSearchParams(location.search);
const realMic = params.get("mic") === "real";
const realAudio = params.get("audio") === "real";

const out = document.createElement("pre");
const active = document.createElement("pre");
active.id = "active";
document.body.append(active, out);
const log = (line: string) => {
  out.textContent += `${line}\n`;
  console.log(line);
};

// `?volume=0` runs the real player silently (the e2e tests do), so a test run does not hum.
const player = realAudio ? createWebAudioPlayer({ volume: Number(params.get("volume") ?? 1) }) : undefined;
const voxxy = createVoxxy({ platformFallback: { stt: "off", tts: "off" } });

const describeKind = (name: string, kind: KindState) =>
  `${name}: ${kind.status}` +
  (kind.active ? ` via ${kind.active.id} (${kind.active.engine}, ${kind.active.locality}${kind.active.reason ? `, ${kind.active.reason}` : ""})` : "");

voxxy.subscribe(({ stt, tts }) => {
  active.textContent = `${describeKind("stt", stt)}\n${describeKind("tts", tts)}`;
  document.title = `stt:${stt.status} tts:${tts.status}`;
});

// With the fake player, note when sound starts, so the streaming demo can measure time to first audio.
let firstPlayAt: number | null = null;
const speaker = player ?? fakePlayer({ onPlay: () => (firstPlayAt ??= performance.now()) });
player?.on("started", () => (firstPlayAt ??= performance.now()));

// Selected up front, so `voxxy.unlock()` in the click handler reaches the player.
voxxy.select(dummyStt({ recorder: realMic ? createMicRecorder() : undefined }));
voxxy.select(dummyTts({ player: speaker }));

async function roundTrip() {
  await Promise.all([voxxy.load("stt"), voxxy.load("tts")]);
  const { stt, tts } = voxxy.getState();
  log(`loaded: stt=${stt.status} tts=${tts.status}`);
  log(`active: stt=${stt.active?.engine}/${stt.active?.locality} tts=${tts.active?.engine}/${tts.active?.locality}`);

  // Push-to-talk: hold for a moment, release, get text.
  const session = voxxy.listen();
  await new Promise((resolve) => setTimeout(resolve, realMic ? 500 : 200));
  log(`stt: ${await session.stop()}`);

  // Speak calls queue and finish in order.
  const order: string[] = [];
  await Promise.all(["hello world", "second", "third"].map((text) => voxxy.speak(text).then(() => order.push(text))));
  log(`tts order: ${order.join(" > ")}`);

  // stop() clears the queue and rejects what is waiting.
  const waiting = ["a long first sentence", "never spoken"].map((text) =>
    voxxy.speak(text).then(
      () => "played",
      (error: Error) => error.name,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  voxxy.stopSpeaking();
  log(`stop: ${(await Promise.all(waiting)).join(", ")}`);

  // The queue works after a stop.
  await voxxy.speak("again");

  await longTextDemo();
  await streamDemo();
  log("round trip ok");
}

const REPLY = "Sure, I can help with that. First, open the settings page. Then pick the language you want. Finally, press save and you are done.";

/** A reply that arrives token by token, about 40 tokens a second, like a chat model streaming. */
async function streamReply(stream: SpeakStream, text: string, tokenMs = 25): Promise<void> {
  for (const token of text.split(/(?<=\s)/)) {
    await stream.push(token);
    await new Promise((resolve) => setTimeout(resolve, tokenMs));
  }
}

const LONG_TEXT = "Dr. Smith opened the door slowly. The room was dark and quiet. He found the switch on the left wall. The light flickered twice before it stayed on. Nothing had moved since the morning.";

/** One call with a long text: it is cut into sentences inside speak(), so sound starts after the first, not the last. */
async function longTextDemo() {
  firstPlayAt = null;
  const startedAt = performance.now();
  await voxxy.speak(LONG_TEXT);
  const finishedMs = performance.now() - startedAt;
  const firstAudioMs = (firstPlayAt ?? NaN) - startedAt;
  log(`speak long text: first audio before it finished: ${firstAudioMs < finishedMs / 2} (first audio ${Math.round(firstAudioMs)} ms, finished ${Math.round(finishedMs)} ms)`);
}

async function streamDemo() {
  // 1. Speak while it arrives: the first sentence sounds long before the last token exists.
  const sentences: string[] = [];
  firstPlayAt = null;
  const startedAt = performance.now();
  const stream = voxxy.speakStream({ normalize: (s) => (sentences.push(s), s) });
  await streamReply(stream, REPLY);
  const replyFinishedMs = performance.now() - startedAt;
  await stream.end();
  const firstAudioMs = (firstPlayAt ?? NaN) - startedAt;
  log(`stream sentences: ${sentences.join(" | ")}`);
  log(`stream first audio before the reply finished: ${firstAudioMs < replyFinishedMs} (first audio ${Math.round(firstAudioMs)} ms, reply complete ${Math.round(replyFinishedMs)} ms)`);

  // 2. Cancel in the middle: the rest is never spoken, end() rejects with an AbortError.
  const cancelled: string[] = [];
  const second = voxxy.speakStream({ normalize: (s) => (cancelled.push(s), s) });
  const feeding = streamReply(second, REPLY).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 400));
  second.cancel();
  await feeding;
  const outcome = await second.end().then(
    () => "finished",
    (error: Error) => error.name,
  );
  log(`stream cancel: ${outcome}, ${cancelled.length < sentences.length ? "cut short" : "NOT cut short"}`);
}

function run(): Promise<boolean> {
  return roundTrip().then(
    () => true,
    (error) => {
      log(`FAILED: ${error}`);
      return false;
    },
  );
}

let done: Promise<boolean>;
if (realMic || realAudio) {
  // The click is the user gesture that unlocks audio and (on iOS) lets the microphone start.
  let start!: (value: Promise<boolean>) => void;
  done = new Promise<Promise<boolean>>((resolve) => (start = resolve)).then((started) => started);
  const button = document.createElement("button");
  button.id = "go";
  button.textContent = "Start round trip";
  button.addEventListener("click", () => {
    button.disabled = true;
    void voxxy.unlock(); // First thing, synchronously, inside the gesture.
    start(run());
  });
  document.body.prepend(button);
} else {
  done = run();
}

// Test hook: lets e2e tests read state without scraping the DOM (see e2e/helpers/stand.ts).
declare global {
  interface Window {
    __stand: {
      voxxy: typeof voxxy;
      lines: string[];
      done: Promise<boolean>;
      dummyStt: typeof dummyStt;
      dummyTts: typeof dummyTts;
      lib: typeof lib;
      player: typeof player;
    };
  }
}
window.__stand = {
  voxxy,
  get lines() {
    return out.textContent.split("\n").filter(Boolean);
  },
  done,
  dummyStt,
  dummyTts,
  lib,
  player,
};
