import { CONSONANTS, Lexicon, PRIMARY_STRESS, applyStress, type LexToken, type PosTag, type TokenContext } from "./lexicon.js";

/**
 * English grapheme-to-phoneme in misaki's spelling, which is what Paradee (and Kokoro) were trained on. A port of
 * `misaki/en.py` (hexgrad/misaki, Apache-2.0) without spaCy: where Python tags each word with its part of speech, this
 * tokenises with a small rule set and gives tags to a handful of function words ("a", "the", "to", "in", "used", "I")
 * and to numbers and currency, which are the places where misaki's lexicon looks at the tag. Heteronyms such as
 * "read" or "lead" therefore always get their default pronunciation.
 */

const PUNCTS = new Set([...";:,.!?—…\"“”"]);
const NON_QUOTE_PUNCTS = new Set([...";:,.!?—…"]);
const SUBTOKEN_JUNKS = new Set([..."',-._‘’/"]);
const VOWELS = new Set([..."AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ"]);
const DIPHTHONGS = new Set([..."AIOQWYʤʧ"]);
const CURRENCIES = new Set(["$", "£", "€"]);

const SUBTOKEN_REGEX = /^['‘’]+|\p{Lu}(?=\p{Lu}\p{Ll})|(?:^-)?(?:\d?[,.]?\d)+|[-_]+|['‘’]{2,}|\p{L}*?(?:['‘’]\p{L})*?\p{Ll}(?=\p{Lu})|\p{L}+(?:['‘’]\p{L})*|[^-_\p{L}'‘’\d]|['‘’]+$/gu;
const subtokenize = (word: string): string[] => [...word.matchAll(SUBTOKEN_REGEX)].map((m) => m[0]);

interface Tok extends LexToken {
  whitespace: string;
  phonemes: string | null;
  rating: number | null;
  prespace: boolean;
}

const makeTok = (text: string, whitespace: string, tag: PosTag = null): Tok => ({
  text,
  whitespace,
  tag,
  isHead: true,
  stress: null,
  currency: null,
  phonemes: null,
  rating: null,
  prespace: false,
});

const FUNCTION_TAGS: Record<string, string> = { a: "DT", an: "DT", the: "DT", to: "TO", I: "PRP", in: "IN", used: "VBD", am: "VBP" };

function tagOf(text: string): PosTag {
  if (CURRENCIES.has(text)) return "$";
  if (/\d/.test(text)) return "CD";
  return FUNCTION_TAGS[text] ?? null;
}

const OPENING = new Set([..."([{“"]);
const CLOSING = new Set([..."}])”"]);
const PUNCT_CHARS = new Set([...";:,.!?…—–\"“”()[]{}<>"]);

/** What spaCy does with a chunk of text between spaces: peel punctuation off both ends into tokens of their own. */
function tokenizeChunk(chunk: string, whitespace: string): Tok[] {
  const chars = [...chunk];
  let start = 0;
  let end = chars.length;
  const lead: string[] = [];
  const trail: string[] = [];
  while (start < end && PUNCT_CHARS.has(chars[start]!)) lead.push(chars[start++]!);
  while (end > start && PUNCT_CHARS.has(chars[end - 1]!)) trail.unshift(chars[--end]!);
  // "3.5" or "e.g." keep their inner dot; a trailing dot after letters is a sentence end.
  const core = chars.slice(start, end).join("");

  const punct = (c: string, position: "lead" | "trail", ws: string): Tok => {
    const t = makeTok(c, ws);
    if (c === '"') t.phonemes = position === "lead" ? "“" : "”";
    else if (c === "–" || c === "—") t.phonemes = "—";
    else if (OPENING.has(c) && c !== "“") t.phonemes = "(";
    else if (CLOSING.has(c) && c !== "”") t.phonemes = ")";
    else if (c === "<" || c === ">" || c === "{" || c === "}" || c === "[" || c === "]") t.phonemes = c === "<" || c === "{" || c === "[" ? "(" : ")";
    else t.phonemes = [...c].filter((x) => PUNCTS.has(x)).join("");
    t.rating = 4;
    return t;
  };

  const tokens: Tok[] = lead.map((c) => punct(c, "lead", ""));
  if (core) tokens.push(makeTok(core, trail.length ? "" : whitespace, tagOf(core)));
  trail.forEach((c, i) => tokens.push(punct(c, "trail", i === trail.length - 1 ? whitespace : "")));
  if (tokens.length > 0 && !core && lead.length > 0) tokens[tokens.length - 1]!.whitespace = whitespace;
  return tokens;
}

function mergeTokens(tokens: Tok[], unk: string | null = null): Tok {
  const stresses = new Set(tokens.map((t) => t.stress).filter((s): s is number => s !== null));
  const currencies = tokens.map((t) => t.currency).filter((c): c is string => c !== null);
  const ratings = tokens.map((t) => t.rating);
  let phonemes: string | null = null;
  if (unk !== null) {
    phonemes = "";
    for (const t of tokens) {
      if (t.prespace && phonemes && !/\s$/.test(phonemes) && t.phonemes) phonemes += " ";
      phonemes += t.phonemes === null ? unk : t.phonemes;
    }
  }
  const score = (t: Tok) => [...t.text].reduce((sum, c) => sum + (c === c.toLowerCase() ? 1 : 2), 0);
  const best = tokens.reduce((a, b) => (score(b) > score(a) ? b : a));
  return {
    text: tokens.slice(0, -1).map((t) => t.text + t.whitespace).join("") + tokens.at(-1)!.text,
    tag: best.tag,
    whitespace: tokens.at(-1)!.whitespace,
    phonemes,
    isHead: tokens[0]!.isHead,
    stress: stresses.size === 1 ? [...stresses][0]! : null,
    currency: currencies.length ? currencies.sort().at(-1)! : null,
    rating: ratings.includes(null) ? null : Math.min(...(ratings as number[])),
    prespace: tokens[0]!.prespace,
  };
}

const stressWeight = (ps: string | null) => (ps ? [...ps].reduce((sum, c) => sum + (DIPHTHONGS.has(c) ? 2 : 1), 0) : 0);

function tokenContext(ctx: TokenContext, ps: string | null, token: Tok): TokenContext {
  let vowel = ctx.futureVowel;
  if (ps) {
    for (const c of ps) {
      if (VOWELS.has(c) || CONSONANTS.has(c) || NON_QUOTE_PUNCTS.has(c)) {
        vowel = NON_QUOTE_PUNCTS.has(c) ? null : VOWELS.has(c);
        break;
      }
    }
  }
  const futureTo = token.text === "to" || token.text === "To" || (token.text === "TO" && (token.tag === "TO" || token.tag === "IN"));
  return { futureVowel: vowel, futureTo };
}

function resolveTokens(tokens: Tok[]): void {
  const text = tokens.slice(0, -1).map((t) => t.text + t.whitespace).join("") + tokens.at(-1)!.text;
  const kinds = new Set([...text].filter((c) => !SUBTOKEN_JUNKS.has(c)).map((c) => (/\p{L}/u.test(c) ? 0 : /\d/.test(c) ? 1 : 2)));
  const prespace = text.includes(" ") || text.includes("/") || kinds.size > 1;
  tokens.forEach((t, i) => {
    if (t.phonemes === null) {
      if (i === tokens.length - 1 && NON_QUOTE_PUNCTS.has(t.text)) {
        t.phonemes = t.text;
        t.rating = 3;
      } else if ([...t.text].every((c) => SUBTOKEN_JUNKS.has(c))) {
        t.phonemes = "";
        t.rating = 3;
      }
    } else if (i > 0) {
      t.prespace = prespace;
    }
  });
  if (prespace) return;
  const indices = tokens
    .map((t, i) => [t.phonemes?.includes(PRIMARY_STRESS) ?? false, stressWeight(t.phonemes), i] as const)
    .filter((_, i) => tokens[i]!.phonemes);
  if (indices.length === 2 && tokens[indices[0]![2]]!.text.length === 1) {
    const t = tokens[indices[1]![2]]!;
    t.phonemes = applyStress(t.phonemes!, -0.5);
    return;
  }
  const primaries = indices.reduce((sum, [has]) => sum + (has ? 1 : 0), 0);
  if (indices.length < 2 || primaries <= Math.floor((indices.length + 1) / 2)) return;
  const weakest = [...indices].sort((a, b) => Number(a[0]) - Number(b[0]) || a[1] - b[1] || a[2] - b[2]).slice(0, Math.floor(indices.length / 2));
  for (const [, , i] of weakest) tokens[i]!.phonemes = applyStress(tokens[i]!.phonemes!, -0.5);
}

/** What `G2P` asks of its fallback: phonemes for a word the lexicon does not know. */
export type Fallback = (word: string) => Promise<string | null>;

export class EnglishG2p {
  constructor(
    private readonly lexicon: Lexicon,
    private readonly fallback: Fallback,
  ) {}

  /** Splits text into groups of tokens that touch each other, like misaki's `retokenize`. */
  private words(text: string): Array<Tok | Tok[]> {
    const raw: Tok[] = [];
    const chunks = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    chunks.forEach((chunk, i) => raw.push(...tokenizeChunk(chunk, i === chunks.length - 1 ? "" : " ")));

    const words: Array<Tok | Tok[]> = [];
    let currency: string | null = null;
    raw.forEach((token, i) => {
      const parts: Tok[] =
        token.phonemes === null
          ? subtokenize(token.text).map((t) => ({ ...makeTok(t, "", tagOf(t)), stress: token.stress }))
          : [token];
      parts.at(-1)!.whitespace = token.whitespace;
      parts.forEach((tk, j) => {
        if (tk.phonemes !== null) {
          // Already settled (punctuation).
        } else if (tk.tag === "$" && CURRENCIES.has(tk.text)) {
          currency = tk.text;
          tk.phonemes = "";
          tk.rating = 4;
        } else if ((tk.text === "-" || tk.text === "–") && /^\s/.test(tk.whitespace) && j === parts.length - 1) {
          tk.phonemes = "—";
          tk.rating = 3;
        } else if (currency !== null) {
          if (tk.tag !== "CD") currency = null;
          else if (j + 1 === parts.length && (i + 1 === raw.length || raw[i + 1]!.tag !== "CD")) tk.currency = currency;
        }
        if (tk.phonemes !== null) {
          words.push(tk);
        } else {
          const last = words.at(-1);
          if (Array.isArray(last) && !last.at(-1)!.whitespace) {
            tk.isHead = false;
            last.push(tk);
          } else {
            words.push(tk.whitespace ? tk : [tk]);
          }
        }
      });
    });
    return words.map((w) => (Array.isArray(w) && w.length === 1 ? w[0]! : w));
  }

  /** Phonemes for a text, the way misaki spells them, one space between words, punctuation kept. */
  async phonemize(text: string): Promise<string> {
    const tokens = this.words(text);
    let ctx: TokenContext = { futureVowel: null, futureTo: false };
    for (let i = tokens.length - 1; i >= 0; i--) {
      const w = tokens[i]!;
      if (!Array.isArray(w)) {
        if (w.phonemes === null) {
          [w.phonemes, w.rating] = this.lexicon.lookupToken(w, ctx);
          if (w.phonemes === null) w.phonemes = await this.fallback(w.text);
        }
        ctx = tokenContext(ctx, w.phonemes, w);
        continue;
      }
      let left = 0;
      let right = w.length;
      let shouldFallback = false;
      while (left < right) {
        const tk = w.slice(left, right).some((t) => t.phonemes !== null) ? null : mergeTokens(w.slice(left, right));
        const [ps, rating] = tk === null ? [null, null] : this.lexicon.lookupToken(tk, ctx);
        if (ps !== null && tk !== null) {
          w[left]!.phonemes = ps;
          w[left]!.rating = rating;
          for (const x of w.slice(left + 1, right)) {
            x.phonemes = "";
            x.rating = rating;
          }
          ctx = tokenContext(ctx, ps, tk);
          right = left;
          left = 0;
        } else if (left + 1 < right) {
          left++;
        } else {
          right--;
          const t = w[right]!;
          if (t.phonemes === null) {
            if ([...t.text].every((c) => SUBTOKEN_JUNKS.has(c))) {
              t.phonemes = "";
              t.rating = 3;
            } else {
              shouldFallback = true;
              break;
            }
          }
          left = 0;
        }
      }
      if (shouldFallback) {
        const merged = mergeTokens(w);
        w[0]!.phonemes = await this.fallback(merged.text);
        w.slice(1).forEach((t) => (t.phonemes = ""));
      } else {
        resolveTokens(w);
      }
    }
    const merged = tokens.map((t) => (Array.isArray(t) ? mergeTokens(t, "") : t));
    return merged
      .map((t) => (t.phonemes ? t.phonemes.replaceAll("ɾ", "T").replaceAll("ʔ", "t") : "") + t.whitespace)
      .join("");
  }
}
