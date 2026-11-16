import { readBytes, readJson, prepareOrt, type Ort } from "../onnx/runtime.js";
import type { AdapterLoadContext, SttAdapter } from "../types.js";
import { STT_SAMPLE_RATE } from "../audio/resample.js";
import { decodeTokens, parseTokenizer, type MoonshineTokenizer } from "./moonshine-tokenizer.js";

/** What the provider factory tells the worker: where its files were declared. Matches `moonshine.ts`. */
export interface MoonshineAdapterOptions {
  encoder: string;
  decoder: string;
  tokenizer: string;
  wasm: string;
}

// Moonshine tiny: 6 decoder layers, 8 heads of 36 dimensions (hidden size 288).
const LAYERS = 6;
const HEADS = 8;
const HEAD_DIM = 36;
const BOS = 1;
const EOS = 2;
/** Moonshine's own guidance: a token or so per 150 ms of audio at most. Anything past this is a loop. */
const MAX_TOKENS_PER_SECOND = 6.5;

type Tensor = InstanceType<Ort["Tensor"]>;
type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;

/**
 * Moonshine tiny on onnxruntime-web, one thread. The encoder turns the waveform into features once;
 * the merged decoder then runs token by token with a key/value cache (greedy decoding).
 */
export function createAdapter(): SttAdapter {
  let ort: Ort | undefined;
  let encoder: Session | undefined;
  let decoder: Session | undefined;
  let tokenizer: MoonshineTokenizer | undefined;

  async function transcribe(pcm16k: Float32Array, signal?: AbortSignal): Promise<string> {
    if (!ort || !encoder || !decoder || !tokenizer) throw new Error("Moonshine is not loaded");
    if (pcm16k.length === 0) return "";
    signal?.throwIfAborted();

    const features = (await encoder.run({ input_values: new ort.Tensor("float32", pcm16k, [1, pcm16k.length]) })).last_hidden_state as Tensor;
    const seconds = pcm16k.length / STT_SAMPLE_RATE;
    const maxTokens = Math.max(8, Math.ceil(seconds * MAX_TOKENS_PER_SECOND));

    const runtime = ort;
    const empty = () => new runtime.Tensor("float32", new Float32Array(0), [1, HEADS, 0, HEAD_DIM]);
    let cache: Record<string, Tensor> = {};
    for (let layer = 0; layer < LAYERS; layer++) {
      for (const part of ["decoder", "encoder"]) {
        cache[`past_key_values.${layer}.${part}.key`] = empty();
        cache[`past_key_values.${layer}.${part}.value`] = empty();
      }
    }

    const ids: number[] = [];
    let last = BOS;
    for (let step = 0; step < maxTokens; step++) {
      signal?.throwIfAborted();
      const out = await decoder.run({
        input_ids: new ort.Tensor("int64", BigInt64Array.of(BigInt(last)), [1, 1]),
        encoder_hidden_states: features,
        use_cache_branch: new ort.Tensor("bool", [step > 0], [1]),
        ...cache,
      });
      // Carry the cache forward. The encoder half is computed once, on the first step, and kept.
      const next: Record<string, Tensor> = {};
      for (const name of Object.keys(cache)) {
        const present = out[name.replace("past_key_values", "present")] as Tensor;
        next[name] = name.includes(".encoder.") && step > 0 ? cache[name]! : present;
      }
      cache = next;

      const logits = out.logits as Tensor;
      const vocab = logits.dims[logits.dims.length - 1]!;
      const row = (logits.data as Float32Array).subarray((logits.dims[1]! - 1) * vocab, logits.dims[1]! * vocab);
      let best = 0;
      for (let i = 1; i < row.length; i++) if (row[i]! > row[best]!) best = i;
      if (best === EOS) break;
      ids.push(best);
      last = best;
    }
    return decodeTokens(tokenizer, ids);
  }

  return {
    id: "moonshine-tiny",
    async load({ models, options, onProgress, signal }: AdapterLoadContext = {}) {
      const urls = options as MoonshineAdapterOptions | undefined;
      if (!urls) throw new Error("Moonshine needs its file URLs: create it through moonshineStt()");
      onProgress?.(0, 4);
      ort = await prepareOrt({ wasmUrl: urls.wasm, models });
      onProgress?.(1, 4);
      signal?.throwIfAborted();
      const sessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" } as const;
      encoder = await ort.InferenceSession.create(await readBytes(models, urls.encoder), sessionOptions);
      onProgress?.(2, 4);
      signal?.throwIfAborted();
      decoder = await ort.InferenceSession.create(await readBytes(models, urls.decoder), sessionOptions);
      onProgress?.(3, 4);
      tokenizer = parseTokenizer(await readJson(models, urls.tokenizer));
      onProgress?.(4, 4);
    },
    transcribe,
    async dispose() {
      await Promise.all([encoder?.release(), decoder?.release()]);
      encoder = decoder = undefined;
    },
  };
}
