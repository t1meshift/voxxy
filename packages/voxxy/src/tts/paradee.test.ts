/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { ModelFileReader } from "../models/types.js";
import { pcmSpeaker } from "../pcm.js";
import { createAdapter as createMoonshine } from "../stt/moonshine.impl.js";
import { moonshineFiles } from "../stt/moonshine.js";
import { monoToWav, wavToMono16k } from "../test-utils/wav.js";
import { resample } from "../audio/resample.js";
import { createAdapter } from "./paradee.impl.js";
import { paradeeFiles } from "./paradee.js";

// Real weights, in Node. Set VOXXY_MODELS_DIR to a folder holding `paradee/` (the Hugging Face repo: onnx/, config.json),
// `misaki-data/` (us_gold.json, us_silver.json), `paradee-gh/` (g2p.onnx, g2p.json.gz) and `moonshine/` for the round trip.
// Without it these are skipped; the browser version is the @models e2e test.
const dir = process.env.VOXXY_MODELS_DIR;
const wasmPath = createRequire(import.meta.url).resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm");

function localReader(root: string, prefixes: Record<string, string>): ModelFileReader {
  return {
    async read(url) {
      if (url.endsWith("ort-wasm-simd-threaded.wasm")) return new Response(await readFile(wasmPath));
      for (const [prefix, folder] of Object.entries(prefixes)) {
        if (url.startsWith(prefix)) return new Response(await readFile(join(root, folder, url.slice(prefix.length))));
      }
      return null;
    },
  };
}

/** Word error rate: edit distance over words, as a fraction of the reference's words. */
function wer(reference: string, hypothesis: string): number {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const r = words(reference);
  const h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array<number>(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return d[r.length]![h.length]! / r.length;
}

const SENTENCES = [
  "The quick brown fox jumps over the lazy dog.",
  "Please call Stella and ask her to bring these things with her from the store.",
  "She sells seashells by the seashore, and the shells she sells are surely seashells.",
  "It was the best of times, it was the worst of times.",
  "The meeting starts at 9 o'clock on Tuesday, and it will last about 45 minutes.",
  "Our new office is on the 3rd floor, and the rent is $1,200 a month.",
  "I can't believe it's already 2025, but we're still waiting for the results.",
  "Dr. Smith said that Paris is wonderful in the spring.",
];

describe("paradee file list", () => {
  it("adds up to the sizes quoted in the README", () => {
    const { files } = paradeeFiles();
    expect(files.reduce((sum, f) => sum + f.size, 0)).toBe(8_462_503 + 2_103 + 3_000_469 + 3_099_517 + 919_774 + 1_176_866 + 14_848_852);
  });

  it("can be served from the host's own folders", () => {
    const { files } = paradeeFiles({ baseUrl: "https://cdn.example/p", lexiconBaseUrl: "https://cdn.example/lex", g2pBaseUrl: "https://cdn.example/g2p", wasmBaseUrl: "https://cdn.example/ort" });
    expect(files.map((f) => f.url)).toEqual([
      "https://cdn.example/p/onnx/paradee_int8.onnx",
      "https://cdn.example/p/config.json",
      "https://cdn.example/lex/us_gold.json",
      "https://cdn.example/lex/us_silver.json",
      "https://cdn.example/g2p/g2p.onnx",
      "https://cdn.example/g2p/g2p.json.gz",
      "https://cdn.example/ort/ort-wasm-simd-threaded.wasm",
    ]);
  });
});

describe.skipIf(!dir)("paradee on real weights (Node)", () => {
  it("speaks sentences that Moonshine then hears correctly", async () => {
    const base = "https://models.test";
    const { urls } = paradeeFiles({ baseUrl: `${base}/p/`, lexiconBaseUrl: `${base}/lex/`, g2pBaseUrl: `${base}/g2p/`, wasmBaseUrl: `${base}/ort/` });
    const tts = createAdapter();
    const t0 = performance.now();
    await tts.load({
      models: localReader(dir!, { [`${base}/p/`]: "paradee", [`${base}/lex/`]: "misaki-data", [`${base}/g2p/`]: "paradee-gh" }),
      options: { ...urls, voice: "af_heart", speed: 1 },
    });
    console.log(`[paradee] load ${(performance.now() - t0).toFixed(0)} ms`);

    const stt = createMoonshine();
    const { urls: sttUrls } = moonshineFiles({ baseUrl: `${base}/m/`, wasmBaseUrl: `${base}/ort/` });
    await stt.load({ models: localReader(dir!, { [`${base}/m/`]: "moonshine" }), options: sttUrls });

    let totalWer = 0;
    for (const sentence of SENTENCES) {
      const t1 = performance.now();
      const { pcm, sampleRate } = await tts.synthesize(sentence);
      const ms = performance.now() - t1;
      const heard = await stt.transcribe(resample(pcm, sampleRate, 16000));
      const error = wer(sentence, heard);
      totalWer += error;
      const seconds = pcm.length / sampleRate;
      console.log(`[paradee] ${ms.toFixed(0)} ms for ${seconds.toFixed(1)} s of audio (${(seconds / (ms / 1000)).toFixed(0)}x realtime), WER ${(error * 100).toFixed(0)}%\n   said:  ${sentence}\n   heard: ${heard}`);
      expect(pcm.length).toBeGreaterThan(sampleRate * 0.5);
      expect(sampleRate).toBe(24000);
      expect(pcm.every(Number.isFinite)).toBe(true);
    }
    console.log(`[paradee] mean WER through Moonshine: ${((totalWer / SENTENCES.length) * 100).toFixed(1)}%`);
    expect(totalWer / SENTENCES.length).toBeLessThan(0.25);
    await Promise.all([tts.dispose(), stt.dispose()]);
  }, 300_000);

  it("speaks a long text, a page of The Great Gatsby, starting after the first sentence and not after the last", async () => {
    const base = "https://models.test";
    const { urls } = paradeeFiles({ baseUrl: `${base}/p/`, lexiconBaseUrl: `${base}/lex/`, g2pBaseUrl: `${base}/g2p/`, wasmBaseUrl: `${base}/ort/` });
    const adapter = createAdapter();
    await adapter.load({
      models: localReader(dir!, { [`${base}/p/`]: "paradee", [`${base}/lex/`]: "misaki-data", [`${base}/g2p/`]: "paradee-gh" }),
      options: { ...urls, voice: "af_heart", speed: 1 },
    });
    const text = (await readFile(join(dir!, "gatsby5k.md"), "utf8")).trim();

    const startedAt = performance.now();
    let firstSoundMs = 0;
    let played = 0;
    let seconds = 0;
    let peakQueued = 0;
    let queued = 0;
    const speaker = pcmSpeaker({
      synthesize: (sentence) => adapter.synthesize(sentence),
      player: {
        async play(pcm, rate) {
          queued++;
          peakQueued = Math.max(peakQueued, queued);
          if (!firstSoundMs) firstSoundMs = performance.now() - startedAt;
          played++;
          seconds += pcm.length / rate;
          await new Promise((resolve) => setTimeout(resolve, 5)); // "Plays" much faster than real time, so synthesis is the pace.
          queued--;
        },
      },
    });
    await speaker.speak(text);
    const totalMs = performance.now() - startedAt;
    console.log(`[paradee long] ${text.length} chars: first sound after ${firstSoundMs.toFixed(0)} ms, all of it synthesised in ${totalMs.toFixed(0)} ms, ${played} sentences, ${seconds.toFixed(0)} s of audio, never more than ${peakQueued} buffers with the player at once`);
    expect(played).toBeGreaterThan(20);
    expect(seconds).toBeGreaterThan(200);
    expect(firstSoundMs).toBeLessThan(totalMs / 10); // Whole text in one go would be 16 s before anything; here it is under a second.
    expect(peakQueued).toBeLessThanOrEqual(2);
    await adapter.dispose();
  }, 300_000);

  it("copes with names, hyphens, quotes, brackets, symbols and odd spacing", async () => {
    const base = "https://models.test";
    const { urls } = paradeeFiles({ baseUrl: `${base}/p/`, lexiconBaseUrl: `${base}/lex/`, g2pBaseUrl: `${base}/g2p/`, wasmBaseUrl: `${base}/ort/` });
    const tts = createAdapter();
    await tts.load({
      models: localReader(dir!, { [`${base}/p/`]: "paradee", [`${base}/lex/`]: "misaki-data", [`${base}/g2p/`]: "paradee-gh" }),
      options: { ...urls, voice: "am_puck", speed: 1 },
    });
    const stt = createMoonshine();
    const { urls: sttUrls } = moonshineFiles({ baseUrl: `${base}/m/`, wasmBaseUrl: `${base}/ort/` });
    await stt.load({ models: localReader(dir!, { [`${base}/m/`]: "moonshine" }), options: sttUrls });

    const odd = [
      `He said, "this is a well-known problem," and then he left.`,
      "NASA and the FBI released a statement (finally) about the launch.",
      "Kubernetes and Zhang Wei were mentioned in the report.",
      "Fifty percent of the 12 students passed the exam.",
      "Well... maybe? Yes — I think so!",
      "   Extra   spaces\nand a new line should not matter.  ",
      "Ünïcödé and emoji 🎉 must not crash it.",
    ];
    for (const sentence of odd) {
      const { pcm } = await tts.synthesize(sentence);
      const heard = await stt.transcribe(resample(pcm, 24000, 16000));
      console.log(`[paradee odd] WER ${(wer(sentence, heard) * 100).toFixed(0)}%\n   said:  ${sentence.replace(/\s+/g, " ")}\n   heard: ${heard}`);
      expect(pcm.length).toBeGreaterThan(2000);
      expect(pcm.every(Number.isFinite)).toBe(true);
    }
    expect((await tts.synthesize("")).pcm).toHaveLength(0);
    expect((await tts.synthesize("   ... ")).pcm.length).toBeGreaterThanOrEqual(0);
    await Promise.all([tts.dispose(), stt.dispose()]);
  }, 300_000);

  it("writes a WAV for listening", async () => {
    const out = process.env.VOXXY_WAV_OUT;
    if (!out) return;
    const base = "https://models.test";
    const { urls } = paradeeFiles({ baseUrl: `${base}/p/`, lexiconBaseUrl: `${base}/lex/`, g2pBaseUrl: `${base}/g2p/`, wasmBaseUrl: `${base}/ort/` });
    const tts = createAdapter();
    await tts.load({
      models: localReader(dir!, { [`${base}/p/`]: "paradee", [`${base}/lex/`]: "misaki-data", [`${base}/g2p/`]: "paradee-gh" }),
      options: { ...urls, voice: "af_heart", speed: 1 },
    });
    const { pcm, sampleRate } = await tts.synthesize(SENTENCES.slice(0, 3).join(" "));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, monoToWav(pcm, sampleRate));
    expect(wavToMono16k(monoToWav(pcm, sampleRate)).length).toBeGreaterThan(1000);
  }, 120_000);
});
