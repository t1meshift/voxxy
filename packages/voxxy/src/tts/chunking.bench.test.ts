/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { it } from "vitest";
import { SentenceSplitter, type SplitterOptions } from "../sentences.js";
import { createAdapter } from "./paradee.impl.js";
import { paradeeFiles } from "./paradee.js";

const dir = process.env.VOXXY_MODELS_DIR!;
const wasmPath = createRequire(import.meta.url).resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm");
const base = "https://models.test";
const folders: Record<string, string> = { [`${base}/p/`]: "paradee", [`${base}/lex/`]: "misaki-data", [`${base}/g2p/`]: "paradee-gh" };
const reader = {
  async read(url: string) {
    if (url.endsWith(".wasm")) return new Response(await readFile(wasmPath));
    for (const [prefix, folder] of Object.entries(folders)) if (url.startsWith(prefix)) return new Response(await readFile(join(dir, folder, url.slice(prefix.length))));
    return null;
  },
};

const PRESETS: Record<string, SplitterOptions> = {
  sentences: { minChars: 10 },
  packed: { firstMinChars: 30, minChars: 120, maxChars: 240 },
  big: { firstMinChars: 30, minChars: 300, maxChars: 420 },
};

const wrap = (text: string, width: number) => text.replace(new RegExp(`(.{1,${width}})(\\s+|$)`, "g"), "$1\n");

/** Texts chosen to break a way of chunking, each for a reason given in the name. */
function adversarialTexts(gatsby: string): Record<string, string> {
  const longestGatsby = gatsby.split(/(?<=[.!?”])\s+/).sort((a, b) => b.length - a.length)[0]!;
  return {
  "long first sentence": "When I was younger and a good deal more inclined to think that every question has a single clean answer, I used to believe that a person who says nothing for a long time must have a great deal to say, whereas the truth, as I have found since, is that silence is usually just silence, and a long sentence is usually just a long sentence. Then it ended. Fine.",
  "digits": "The constant is 3.14159265358979323846264338327950288419716939937510582097494459230781640628620899 and that is all. Ok.",
  "money and dates": "It costs $1,234,567.89 or 1,000,000,000 yen on 12/31/1999 at 11:59 p.m. sharp. Ok. See you then.",
  "no punctuation at all": "so I went to the shop and then I thought about what you said and then I went home and then I made some tea and then I sat down and thought about it again and then I decided that you were right about most of it but not about the part regarding the money and so I called you but you did not pick up and I left a message that said nothing much really and then I went to bed",
  "hard wrapped e-mail": wrap("In my younger and more vulnerable years my father gave me some advice that I have been turning over in my mind ever since. Whenever you feel like criticizing anyone, he told me, just remember that all the people in this world have not had the advantages that you have had.", 40),
  "one word sentences": "Yes. No. Maybe. Okay. Fine. Sure. Right. Hm. Ah. Oh. Well. Hey. Stop. Go. Wait. Look.",
  "abbreviation chain": "Dr. Prof. Mr. Mrs. Ms. Jr. Sr. Smith met Mr. Jones at 5 p.m. on Jan. 5th in Washington D.C. and then they left. Next one.",
  "dots without spaces": "Hello.World.This.Is.Joined.Text.With.No.Spaces.After.Dots.Another.Long.One.Here.To.Cross.The.Limit.Of.The.Chunk.And.More.Words.Keep.Coming.Because.Nobody.Typed.A.Space.Anywhere.In.This.Whole.Thing.At.All.Ever.",
  "url, mail, code": "See https://example.com/path/to/some/very/long/resource.html?query=1&other=2 or write to first.last@example.co.uk, or run foo.bar.baz() and then npm install --save-dev. Done.",
  "shouting and spam": "WHAT?!?! NO WAY!!!! ARE YOU SERIOUS?!?! I CAN'T BELIEVE IT!!!!!!!! REALLY?????? YES!!! OK!!!",
  "ellipses": "Well... I mean... you know... it's... complicated... but... fine... I guess... maybe... not.",
  "unclosed quote": "He said, “I will tell you everything I know about the matter, and I will not leave out a single detail, even the ones that make me look bad, because you deserve the truth, and so does everyone else who was there that night, and then he stopped talking. Nobody moved.",
  "Gatsby's longest sentence": longestGatsby,
  "Cyrillic": "Привет, мир. Это проверка. Всё работает, надеюсь.",
  };
}

const leadingQuiet = (pcm: Float32Array, rate: number) => {
  const win = Math.round(rate * 0.02);
  let n = 0;
  for (let i = 0; i + win <= pcm.length; i += win, n++) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += pcm[j]! * pcm[j]!;
    if (Math.sqrt(sum / win) >= 0.01) break;
  }
  return n * 0.02;
};

/** Plays the chunks through a pipeline of capacity 2, as pcmSpeaker does, with synthesis `slow` times slower. */
function timeline(chunks: Array<{ synthMs: number; audioS: number }>, slow: number) {
  const readyAt: number[] = [];
  const startAt: number[] = [];
  const endAt: number[] = [];
  let synthFree = 0;
  let gap = 0;
  let maxGap = 0;
  chunks.forEach((c, i) => {
    const mayStart = i >= 2 ? startAt[i - 2]! : 0; // Room opens when chunk i-2 begins to play.
    const s = Math.max(synthFree, mayStart);
    readyAt[i] = s + (c.synthMs / 1000) * slow;
    synthFree = readyAt[i]!;
    startAt[i] = Math.max(readyAt[i]!, i ? endAt[i - 1]! : 0);
    if (i) {
      const hole = startAt[i]! - endAt[i - 1]!;
      gap += hole;
      maxGap = Math.max(maxGap, hole);
    }
    endAt[i] = startAt[i]! + c.audioS;
  });
  return { firstS: startAt[0] ?? 0, gap, maxGap, totalS: endAt.at(-1) ?? 0 };
}

// A benchmark, not a pass/fail test: it prints a table. Opt in with VOXXY_MODELS_DIR and VOXXY_BENCH=1.
it.skipIf(!dir || !process.env.VOXXY_BENCH)("adversarial texts per chunking", async () => {
  const TEXTS = adversarialTexts(await readFile(join(dir, "gatsby5k.md"), "utf8"));
  const { urls } = paradeeFiles({ baseUrl: `${base}/p/`, lexiconBaseUrl: `${base}/lex/`, g2pBaseUrl: `${base}/g2p/`, wasmBaseUrl: `${base}/ort/` });
  const tts = createAdapter();
  await tts.load({ models: reader, options: { ...urls, voice: "af_heart", speed: 1 } });
  await tts.synthesize("Warm up."); // The first run is slower.

  const rows: string[] = [];
  for (const [label, text] of Object.entries(TEXTS)) {
    for (const [preset, options] of Object.entries(PRESETS)) {
      const splitter = new SentenceSplitter(options);
      const pieces = [...splitter.push(text), ...splitter.flush()];
      const measured: Array<{ synthMs: number; audioS: number; chars: number; lead: number }> = [];
      for (const piece of pieces) {
        const t = performance.now();
        const { pcm, sampleRate } = await tts.synthesize(piece);
        measured.push({ synthMs: performance.now() - t, audioS: pcm.length / sampleRate, chars: piece.length, lead: leadingQuiet(pcm, sampleRate) });
      }
      const here = timeline(measured, 1);
      const slow = timeline(measured, 5);
      const lead = measured.reduce((s, m) => s + m.lead, 0);
      const audio = measured.reduce((s, m) => s + m.audioS, 0);
      rows.push(
        `ROW ${label.padEnd(25)} ${preset.padEnd(9)} chunks ${String(pieces.length).padStart(2)} | first ${String(measured[0]?.chars ?? 0).padStart(3)} ch, ${String(Math.round(measured[0]?.synthMs ?? 0)).padStart(4)} ms | longest chunk ${String(Math.max(0, ...measured.map((m) => m.chars))).padStart(3)} ch ${String(Math.round(Math.max(0, ...measured.map((m) => m.synthMs)))).padStart(4)} ms | quiet at starts ${lead.toFixed(1)} of ${audio.toFixed(1)} s | here: first ${here.firstS.toFixed(2)} s, holes ${here.gap.toFixed(1)} s | 5x slower: first ${slow.firstS.toFixed(2)} s, holes ${slow.gap.toFixed(1)} s (worst ${slow.maxGap.toFixed(1)})`,
      );
    }
  }
  console.log(rows.join("\n"));
}, 900_000);
