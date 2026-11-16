/** The slice of a Hugging Face `tokenizer.json` that decoding needs. */
interface TokenizerJson {
  model: { vocab: Record<string, number> };
  added_tokens: Array<{ id: number; content: string; special: boolean }>;
}

export interface MoonshineTokenizer {
  /** Token text by id, with `▁` (the SentencePiece word marker) already shown as a space. */
  tokens: string[];
  special: Set<number>;
}

/**
 * Moonshine's tokenizer is a SentencePiece-style BPE with byte fallback. Transcription only goes
 * ids to text, so the merges are not needed: just the vocabulary.
 */
export function parseTokenizer(json: TokenizerJson): MoonshineTokenizer {
  const tokens: string[] = [];
  for (const [token, id] of Object.entries(json.model.vocab)) tokens[id] = token;
  const special = new Set<number>([0, 1, 2]); // <unk>, <s>, </s>
  for (const added of json.added_tokens) {
    tokens[added.id] = added.content;
    if (added.special || added.content.startsWith("<<")) special.add(added.id);
  }
  return { tokens, special };
}

const BYTE_TOKEN = /^<0x([0-9A-Fa-f]{2})>$/;

/** Ids to text: join the pieces, turn `▁` into spaces, rebuild multi-byte characters from byte tokens, drop the leading space. */
export function decodeTokens({ tokens, special }: MoonshineTokenizer, ids: readonly number[]): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (const id of ids) {
    if (special.has(id)) continue;
    const token = tokens[id];
    if (token === undefined) continue;
    const byte = BYTE_TOKEN.exec(token);
    if (byte) bytes.push(parseInt(byte[1]!, 16));
    else bytes.push(...encoder.encode(token.replaceAll("▁", " ")));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/^ /, "");
}
