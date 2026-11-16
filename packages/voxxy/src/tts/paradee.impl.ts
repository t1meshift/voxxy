import { prepareOrt, readBytes, readJson, type Ort } from "../onnx/runtime.js";
import { SentenceSplitter } from "../sentences.js";
import type { AdapterLoadContext, SpeechResult, TtsAdapter } from "../types.js";
import { EnglishG2p } from "./paradee/g2p-en.js";
import { G2pModel, readG2pData } from "./paradee/g2p-model.js";
import { Lexicon } from "./paradee/lexicon.js";
import { speakableEnglish } from "./paradee/speakable.js";

/** What the provider factory tells the worker: where its files were declared, and the voice. Matches `paradee.ts`. */
export interface ParadeeAdapterOptions {
  model: string;
  config: string;
  gold: string;
  silver: string;
  g2pModel: string;
  g2pData: string;
  wasm: string;
  /** American English voices only: the lexicon shipped is the American one. */
  voice: "af_heart" | "am_puck";
  speed: number;
  /** Run each sentence of a text as its own utterance, or (default) the whole text at once, up to the model's limit. */
  splitSentences?: boolean;
}

interface ParadeeConfig {
  sample_rate: number;
  voices: string[];
  vocab: Record<string, number>;
}

type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;

/** The model reads at most 512 ids, two of which are the pad at each end. */
const MAX_PHONEMES = 510;

/**
 * One sentence at a time, as the model was trained. The Python package cuts on any `.!?…` plus a space, so "Dr. Smith"
 * becomes two utterances; this uses the library's splitter, which knows titles, initials and decimals. (A text handed
 * over by `speak()` is already one sentence; this is for callers that give the adapter a whole paragraph.)
 */
const sentencesOf = (text: string): string[] => {
  const splitter = new SentenceSplitter({ maxChars: 400, minChars: 0 });
  return [...splitter.push(text), ...splitter.flush()];
};

function* chunks(phonemes: string): Generator<string> {
  let rest = phonemes;
  while (rest.length > MAX_PHONEMES) {
    const at = rest.lastIndexOf(" ", MAX_PHONEMES);
    const cut = at > 0 ? at : MAX_PHONEMES;
    yield rest.slice(0, cut);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) yield rest;
}

/**
 * Paradee 8M v1.3 (int8) on onnxruntime-web, one thread. Text goes through a JavaScript port of misaki's English G2P
 * (dictionary lookup, no eSpeak: it is GPL-3.0) with Paradee's own small G2P model for words the dictionaries lack,
 * then the phoneme ids go through one ONNX graph to 24 kHz audio.
 */
export function createAdapter(): TtsAdapter {
  let session: Session | undefined;
  let ort: Ort | undefined;
  let config: ParadeeConfig | undefined;
  let g2p: EnglishG2p | undefined;
  let g2pSession: Session | undefined;
  let settings: ParadeeAdapterOptions | undefined;

  async function synthesize(text: string, signal?: AbortSignal): Promise<SpeechResult> {
    if (!ort || !session || !config || !g2p || !settings) throw new Error("Paradee is not loaded");
    const voice = config.voices.indexOf(settings.voice);
    const parts: Float32Array[] = [];
    // Links, addresses, file names and code are turned into what a person would say; the model has never heard them.
    const spoken = speakableEnglish(text);
    for (const sentence of settings.splitSentences ? sentencesOf(spoken) : [spoken]) {
      signal?.throwIfAborted();
      for (const phonemes of chunks(await g2p.phonemize(sentence))) {
        signal?.throwIfAborted();
        const ids = [0, ...[...phonemes].flatMap((c) => (c in config!.vocab ? [config!.vocab[c]!] : [])).slice(0, MAX_PHONEMES), 0];
        const out = await session.run({
          input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
          speed: new ort.Tensor("float32", Float32Array.of(settings.speed), [1]),
          voice: new ort.Tensor("int64", BigInt64Array.of(BigInt(voice)), [1]),
        });
        const waveform = (out.waveform!.data as Float32Array).slice(); // Copy: the tensor's memory is the runtime's.
        parts.push(waveform);
      }
    }
    const pcm = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) (pcm.set(part, offset), (offset += part.length));
    return { pcm, sampleRate: config.sample_rate };
  }

  return {
    id: "paradee-8m-v1.3",
    async load({ models, options, onProgress, signal }: AdapterLoadContext = {}) {
      const urls = options as ParadeeAdapterOptions | undefined;
      if (!urls) throw new Error("Paradee needs its file URLs: create it through paradeeTts()");
      if (urls.voice !== "af_heart" && urls.voice !== "am_puck") throw new Error(`Voice "${urls.voice}" is not supported: only the American English voices`);
      settings = urls;
      const steps = 7;
      let done = 0;
      const step = () => onProgress?.(++done, steps);

      ort = await prepareOrt({ wasmUrl: urls.wasm, models });
      step();
      const sessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" } as const;
      session = await ort.InferenceSession.create(await readBytes(models, urls.model), sessionOptions);
      config = await readJson<ParadeeConfig>(models, urls.config);
      step();
      signal?.throwIfAborted();

      const [gold, silver] = await Promise.all([readJson<Record<string, never>>(models, urls.gold), readJson<Record<string, never>>(models, urls.silver)]);
      const lexicon = new Lexicon(gold, silver);
      step();
      signal?.throwIfAborted();

      g2pSession = await ort.InferenceSession.create(await readBytes(models, urls.g2pModel), sessionOptions);
      step();
      const g2pData = await readG2pData(await readBytes(models, urls.g2pData));
      step();
      const model = new G2pModel(ort, g2pSession, g2pData);
      g2p = new EnglishG2p(lexicon, (word) => englishFallback(model, lexicon, word));
      step();
      step();
    },
    synthesize,
    async dispose() {
      await Promise.all([session?.release(), g2pSession?.release()]);
      session = g2pSession = undefined;
      g2p = undefined;
    },
  };
}

/**
 * Words the dictionaries lack, like Paradee's `_EnglishFallback`: its word list first, then its model. Digits
 * inside such a word ("Se8") are read as numbers by the dictionary side.
 */
async function englishFallback(model: G2pModel, lexicon: Lexicon, text: string): Promise<string | null> {
  const said: string[] = [];
  for (const part of text.match(/\d+|\D+/g) ?? []) {
    if (/^\d+$/.test(part)) {
      const [ps] = lexicon.lookupToken({ text: part, tag: "CD", isHead: true, stress: null, currency: null }, { futureVowel: null, futureTo: false });
      if (ps) said.push(ps);
    } else {
      const word = part.replace(/^[-.,/:']+|[-.,/:']+$/g, "");
      if (/[\p{L}\p{N}]/u.test(word)) said.push(await model.english(word));
    }
  }
  return said.length ? said.join(" ") : null;
}
