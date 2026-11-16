/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelFileReader } from "../models/types.js";
import { createRequire } from "node:module";
import { wavToMono16k } from "../test-utils/wav.js";
import { createAdapter } from "./moonshine.impl.js";
import { decodeTokens, parseTokenizer } from "./moonshine-tokenizer.js";
import { moonshineFiles } from "./moonshine.js";

// Real weights, run in Node on onnxruntime-web (wasm, one thread). Set VOXXY_MODELS_DIR to a folder holding
// `moonshine/` (a copy of onnx-community/moonshine-tiny-ONNX: onnx/ and tokenizer.json) and `jfk.wav`.
// Without it these are skipped; the browser version of the same check is the @models e2e test.
const dir = process.env.VOXXY_MODELS_DIR;
const wasmPath = createRequire(import.meta.url).resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm");

function localReader(root: string, prefix: string): ModelFileReader {
  return {
    async read(url) {
      const path = url.endsWith("ort-wasm-simd-threaded.wasm") ? wasmPath : url.startsWith(prefix) ? join(root, url.slice(prefix.length)) : null;
      if (!path) return null;
      return new Response(await readFile(path));
    },
  };
}

describe("moonshine tokenizer", () => {
  const tokenizer = parseTokenizer({
    model: { vocab: { "<unk>": 0, "<s>": 1, "</s>": 2, "<0xC3>": 3, "<0xA9>": 4, "▁hello": 5, "▁caf": 6, "▁world": 7 } },
    added_tokens: [{ id: 8, content: "<<ST_0>>", special: true }],
  });

  it("joins pieces, shows ▁ as a space and drops the leading one", () => {
    expect(decodeTokens(tokenizer, [5, 7])).toBe("hello world");
  });

  it("skips special tokens and rebuilds multi-byte characters from byte tokens", () => {
    expect(decodeTokens(tokenizer, [1, 6, 3, 4, 8, 2])).toBe("café");
  });
});

describe("moonshine file list", () => {
  it("adds up to the sizes quoted in the README", () => {
    const { files } = moonshineFiles();
    expect(files.reduce((sum, f) => sum + f.size, 0)).toBe(10_732_274 + 20_189_543 + 3_761_754 + 14_848_852);
  });

  it("can serve everything from the host's own folders", () => {
    const { files } = moonshineFiles({ baseUrl: "https://cdn.example/m", wasmBaseUrl: "https://cdn.example/ort" });
    expect(files.map((f) => f.url)).toEqual([
      "https://cdn.example/m/onnx/encoder_model_q4.onnx",
      "https://cdn.example/m/onnx/decoder_model_merged_uint8.onnx",
      "https://cdn.example/m/tokenizer.json",
      "https://cdn.example/ort/ort-wasm-simd-threaded.wasm",
    ]);
  });
});

describe.skipIf(!dir)("moonshine on real weights (Node)", () => {
  it.each(["compact", "q4"] as const)("transcribes the JFK clip with %s", async (variant) => {
    const { urls } = moonshineFiles({ variant, baseUrl: "https://models.test/" });
    const adapter = createAdapter();
    const t0 = performance.now();
    await adapter.load({ models: localReader(join(dir!, "moonshine"), "https://models.test/"), options: urls });
    const loadMs = performance.now() - t0;

    const pcm = wavToMono16k(new Uint8Array(await readFile(join(dir!, "jfk.wav"))));
    const t1 = performance.now();
    const text = await adapter.transcribe(pcm);
    const ms = performance.now() - t1;
    console.log(`[moonshine ${variant}] load ${loadMs.toFixed(0)} ms, ${(pcm.length / 16000).toFixed(1)} s of audio in ${ms.toFixed(0)} ms (${(ms / ((pcm.length / 16000) * 1000)).toFixed(2)}x realtime): ${text}`);
    // The clip is "...ask not what your country can do for you, ask what you can do for your country."
    expect(text.toLowerCase()).toMatch(/not what your country can do for you/);
    expect(text.toLowerCase()).toMatch(/ask what you can do for your country/);
    await adapter.dispose();
  }, 120_000);
});
