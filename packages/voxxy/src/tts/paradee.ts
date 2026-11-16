import type { ModelFile } from "../models/types.js";
import { ortWasmFile } from "../onnx/runtime.js";
import type { ChunkInfo, Player } from "../pcm.js";
import type { TtsProvider } from "../provider.js";
import type { SplitterOptions } from "../sentences.js";
import { workerTts } from "../worker-providers.js";
import type { ParadeeAdapterOptions } from "./paradee.impl.js";

// Fixed commits, so the sizes below stay true.
const MODEL_BASE = "https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.3/resolve/b569f5efb789af5ba643a44af348427242ceb784/";
const LEXICON_BASE = "https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/misaki/data/";
const G2P_BASE = "https://raw.githubusercontent.com/sahilmahendrakar/paradee/2de547e45da92840a636c499eb0782e988be1e47/paradee/data/";

const MODEL = ["onnx/paradee_int8.onnx", 8_462_503] as const;
const CONFIG = ["config.json", 2_103] as const;
const GOLD = ["us_gold.json", 3_000_469] as const;
const SILVER = ["us_silver.json", 3_099_517] as const;
const G2P_MODEL = ["g2p.onnx", 919_774] as const;
const G2P_DATA = ["g2p.json.gz", 1_176_866] as const;

/** Options for `paradeeTts()`. Only `player` is required. */
export interface ParadeeOptions {
  /** Plays the audio: `createWebAudioPlayer()` in a page. */
  player: Player;
  /** American English voices: `af_heart` (default, female) or `am_puck` (male). */
  voice?: "af_heart" | "am_puck";
  /** 1 is normal; above 1 is faster. */
  speed?: number;
  /**
   * Run every sentence of a chunk as a separate utterance. Default false: the chunk goes through the model whole, which
   * gives natural pauses of 0.15 to 0.35 s; separate utterances each carry the model's own padding, 0.65 to 0.7 s apart.
   * (A chunk longer than the model's limit of 510 phonemes is cut at a space either way.)
   */
  splitSentences?: boolean;
  /** Serve the model yourself: the folder that holds `onnx/paradee_int8.onnx` and `config.json`. Default: Hugging Face, pinned to a commit. */
  baseUrl?: string;
  /** The folder that holds misaki's `us_gold.json` and `us_silver.json`. Default: GitHub raw, pinned to a commit. */
  lexiconBaseUrl?: string;
  /** The folder that holds Paradee's `g2p.onnx` and `g2p.json.gz`. Default: GitHub raw, pinned to a commit. */
  g2pBaseUrl?: string;
  /** The folder that holds `ort-wasm-simd-threaded.wasm`. Default: jsDelivr, pinned to the version. */
  wasmBaseUrl?: string;
  /** How many texts may be synthesised ahead of the one playing. Default 1. */
  maxAhead?: number;
  /**
   * How `speak()` cuts text into chunks. Every chunk is one model run and starts with about 0.3 s of quiet, so
   * packing several sentences per chunk (`{ firstMinChars: 30, minChars: 120 }`) means fewer of those and a more
   * natural flow, at the price of a longer wait for the first chunk if `firstMinChars` is large.
   */
  splitter?: SplitterOptions;
  /** Called for every chunk once it is synthesised. */
  onChunk?: (info: ChunkInfo) => void;
  /** The URL of the worker script, for bundlers that cannot find it on their own. Default: the one shipped next to this module. */
  workerUrl?: string | URL;
}

function spawn(workerUrl?: string | URL): Worker {
  // The literal `new Worker(new URL(..., import.meta.url))` form is what bundlers recognise and emit as a worker script.
  if (workerUrl) return new Worker(workerUrl, { type: "module" });
  return new Worker(new URL("./paradee.worker.js", import.meta.url), { type: "module" });
}

const folder = (url: string) => url.replace(/\/?$/, "/");

/** The files this provider needs, as the model manager will download and check them. */
export function paradeeFiles(options: Pick<ParadeeOptions, "baseUrl" | "lexiconBaseUrl" | "g2pBaseUrl" | "wasmBaseUrl"> = {}): {
  files: ModelFile[];
  urls: Omit<ParadeeAdapterOptions, "voice" | "speed">;
} {
  const model = folder(options.baseUrl ?? MODEL_BASE);
  const lexicon = folder(options.lexiconBaseUrl ?? LEXICON_BASE);
  const g2p = folder(options.g2pBaseUrl ?? G2P_BASE);
  const wasm = ortWasmFile(options.wasmBaseUrl);
  const files: ModelFile[] = [
    { url: model + MODEL[0], size: MODEL[1] },
    { url: model + CONFIG[0], size: CONFIG[1] },
    { url: lexicon + GOLD[0], size: GOLD[1] },
    { url: lexicon + SILVER[0], size: SILVER[1] },
    { url: g2p + G2P_MODEL[0], size: G2P_MODEL[1] },
    { url: g2p + G2P_DATA[0], size: G2P_DATA[1] },
    wasm,
  ];
  const [m, c, gold, silver, gm, gd] = files.map((f) => f.url) as [string, string, string, string, string, string];
  return { files, urls: { model: m, config: c, gold, silver, g2pModel: gm, g2pData: gd, wasm: wasm.url } };
}

/**
 * Text-to-speech with Paradee 8M v1.3 (English voices, Apache-2.0), on onnxruntime-web in its own worker, one thread:
 * no COOP/COEP needed. The phonemiser is a JavaScript port of misaki's English G2P plus Paradee's own G2P model:
 * no eSpeak NG, which is GPL-3.0. First use downloads about 31 MB after the user's opt-in through `voxxy.models`: the
 * 8.5 MB model, 6.1 MB of dictionaries, 2.1 MB of G2P model and data, and the 14.8 MB runtime wasm.
 */
export function paradeeTts({ player, voice = "af_heart", speed = 1, splitSentences = false, maxAhead, splitter, onChunk, workerUrl, ...locations }: ParadeeOptions): TtsProvider {
  const { files, urls } = paradeeFiles(locations);
  return workerTts({
    // The voice is a setting, not a different download, so it is not part of the id: consent is per id, and changing
    // the voice must not ask the user again for the same files.
    id: "paradee-8m-v1.3",
    spawn,
    workerUrl,
    player,
    maxAhead,
    splitter,
    onChunk,
    files,
    downloadSize: files.reduce((sum, file) => sum + file.size, 0),
    adapterOptions: { ...urls, voice, speed, splitSentences } satisfies ParadeeAdapterOptions,
  });
}
