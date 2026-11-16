import type { Recorder } from "../pcm.js";
import type { ModelFile } from "../models/types.js";
import { ortWasmFile } from "../onnx/runtime.js";
import type { SttProvider } from "../provider.js";
import { workerStt } from "../worker-providers.js";
import type { MoonshineAdapterOptions } from "./moonshine.impl.js";

/** A fixed commit, so the sizes below stay true. */
const REVISION = "a6da1241cd305dcd64eab1edbd615f2bb9aabb95";
const HF_BASE = `https://huggingface.co/onnx-community/moonshine-tiny-ONNX/resolve/${REVISION}/`;

/**
 * Quantisations that were tried on a real clip (see the README). Sizes are of the files at `REVISION`.
 * The all-8-bit files (`*_int8`, `*_uint8`) are not offered: with an 8-bit encoder Moonshine stops after a few words
 * (the JFK clip came out as "And so my fellow American"), whichever decoder it is paired with.
 */
const VARIANTS = {
  /** 4-bit encoder, 8-bit decoder: transcribed the test clip as well as all-q4, in a little over half the download. */
  compact: { encoder: ["onnx/encoder_model_q4.onnx", 10_732_274], decoder: ["onnx/decoder_model_merged_uint8.onnx", 20_189_543] },
  /** 4-bit encoder and decoder: the combination planning named. Larger, because the decoder keeps more in fp32. */
  q4: { encoder: ["onnx/encoder_model_q4.onnx", 10_732_274], decoder: ["onnx/decoder_model_merged_q4.onnx", 44_650_684] },
} as const;
const TOKENIZER = ["tokenizer.json", 3_761_754] as const;

/** Options for `moonshineStt()`. Only `recorder` is required. */
export interface MoonshineOptions {
  /** Captures mono 16 kHz audio: `createMicRecorder()` in a page. */
  recorder: Recorder;
  /** Default `"compact"` (31 MB of model files); `"q4"` is 55 MB. */
  variant?: keyof typeof VARIANTS;
  /** Serve the model files yourself: the folder that holds `onnx/` and `tokenizer.json`. Default: Hugging Face, pinned to a commit. */
  baseUrl?: string;
  /** Serve the onnxruntime-web wasm file yourself: the folder that holds `ort-wasm-simd-threaded.wasm`. Default: jsDelivr, pinned to the version. */
  wasmBaseUrl?: string;
  /** The URL of the worker script, for bundlers that cannot find it on their own. Default: the one shipped next to this module. */
  workerUrl?: string | URL;
}

function spawn(workerUrl?: string | URL): Worker {
  // The literal `new Worker(new URL(..., import.meta.url))` form is what bundlers recognise and emit as a worker script.
  if (workerUrl) return new Worker(workerUrl, { type: "module" });
  return new Worker(new URL("./moonshine.worker.js", import.meta.url), { type: "module" });
}

/** The files this provider needs, as the model manager will download and check them. */
export function moonshineFiles({ variant = "compact", baseUrl = HF_BASE, wasmBaseUrl }: Pick<MoonshineOptions, "variant" | "baseUrl" | "wasmBaseUrl"> = {}): {
  files: ModelFile[];
  urls: MoonshineAdapterOptions;
} {
  const root = baseUrl.replace(/\/?$/, "/");
  const chosen = VARIANTS[variant];
  const wasm = ortWasmFile(wasmBaseUrl);
  const files: ModelFile[] = [
    { url: root + chosen.encoder[0], size: chosen.encoder[1] },
    { url: root + chosen.decoder[0], size: chosen.decoder[1] },
    { url: root + TOKENIZER[0], size: TOKENIZER[1] },
    wasm,
  ];
  return { files, urls: { encoder: files[0]!.url, decoder: files[1]!.url, tokenizer: files[2]!.url, wasm: wasm.url } };
}

/**
 * Speech-to-text with Moonshine tiny (English, MIT), running on onnxruntime-web in its own worker, one thread: no
 * COOP/COEP needed. First use downloads the model (about 35 MB with the default `compact`, tokenizer included) and the
 * runtime's wasm (14.8 MB, 3.8 MB gzipped on the wire), after the user's opt-in through `voxxy.models`.
 */
export function moonshineStt({ recorder, variant, baseUrl, wasmBaseUrl, workerUrl }: MoonshineOptions): SttProvider {
  const { files, urls } = moonshineFiles({ variant, baseUrl, wasmBaseUrl });
  return workerStt({
    id: `moonshine-tiny-${variant ?? "compact"}`,
    spawn,
    workerUrl,
    recorder,
    files,
    downloadSize: files.reduce((sum, file) => sum + file.size, 0),
    adapterOptions: urls,
  });
}
