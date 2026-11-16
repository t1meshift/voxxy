import type { Ort } from "../../onnx/runtime.js";

/** The shape of `g2p.json.gz` from the Paradee repository (Apache-2.0). Only what English needs is typed. */
export interface G2pData {
  vocab: { in: string[]; out: string[] };
  lexicon: Record<string, { w: Record<string, string> }>;
}

type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;

const MAX_WORD = 60; // Letters the model reads of one word.

/** `g2p.json.gz` is gzip; every browser that runs the rest of this has `DecompressionStream`. */
export async function readG2pData(gz: Uint8Array): Promise<G2pData> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as G2pData;
}

/**
 * Paradee's own grapheme-to-phoneme model: a 0.76M-parameter network that reads a word (plus the last letter before
 * it and the first letter after it) and writes the phonemes eSpeak NG would, without eSpeak, which is GPL-3.0.
 * For English it only handles the words misaki's dictionaries lack, mostly names. A port of `paradee/g2p.py`.
 */
export class G2pModel {
  private readonly index: Map<string, number>;

  constructor(
    private readonly ort: Ort,
    private readonly session: Session,
    private readonly data: G2pData,
  ) {
    this.index = new Map(data.vocab.in.map((c, i) => [c, i]));
  }

  /** The word list's answer for `word`, or the model's. */
  async english(word: string, before = "#", after = "#"): Promise<string> {
    return this.data.lexicon["en-us"]?.w[word] ?? (await this.model([["en-us", before, word, after]]))[0]!;
  }

  /** Phonemes for each (language, letter before, word, letter after), from the model alone. */
  async model(items: Array<[string, string, string, string]>): Promise<string[]> {
    if (items.length === 0) return [];
    const { index } = this;
    const unk = index.get("<unk>") ?? 0;
    const id = (key: string) => index.get(key) ?? unk;
    const rows = items.map(([lang, before, word, after]) => [
      id(`<${lang}>`),
      id(before),
      id("<s1>"),
      ...[...word.toLowerCase()].slice(0, MAX_WORD).map(id),
      id("<s2>"),
      id(after),
    ]);
    const width = Math.max(...rows.map((row) => row.length));
    const chars = new BigInt64Array(rows.length * width);
    const pad = new Uint8Array(rows.length * width).fill(1);
    rows.forEach((row, i) => {
      row.forEach((value, j) => {
        chars[i * width + j] = BigInt(value);
        pad[i * width + j] = 0;
      });
    });
    const out = await this.session.run({
      chars: new this.ort.Tensor("int64", chars, [rows.length, width]),
      pad: new this.ort.Tensor("bool", pad, [rows.length, width]),
    });
    const best = out[this.session.outputNames[0]!]!;
    const steps = best.dims[1]!;
    const data = best.data as BigInt64Array | Int32Array;
    return rows.map((row, i) => {
      // CTC: merge repeats, drop blanks (0); each letter has three output steps.
      let text = "";
      let previous = 0;
      for (let k = 0; k < Math.min(3 * row.length, steps); k++) {
        const value = Number(data[i * steps + k]);
        if (value !== previous && value !== 0) text += this.data.vocab.out[value] ?? "";
        previous = value;
      }
      return text;
    });
  }
}
