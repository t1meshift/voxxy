import { cardinal, decimal, ordinal, year } from "./num2words.js";

/**
 * A port of the dictionary half of misaki's English G2P (hexgrad/misaki, `misaki/en.py`, Apache-2.0): the gold and
 * silver lexicons, suffix stemming (-s, -ed, -ing), stress handling and number reading. What it leaves out is
 * spaCy's part-of-speech tagging, which the Python version uses to pick between pronunciations of the same
 * spelling ("read", "lead", "live"). Without tags the default pronunciation is taken.
 */

export type PosTag = string | null;
type Entry = string | Record<string, string | null>;

export interface TokenContext {
  futureVowel: boolean | null;
  futureTo: boolean;
}

export interface LexToken {
  text: string;
  tag: PosTag;
  isHead: boolean;
  /** Stress override (misaki's `_.stress`). */
  stress: number | null;
  /** `$`, `£` or `€` when this number is an amount of money. */
  currency: string | null;
}

export const STRESSES = "ˌˈ";
export const PRIMARY_STRESS = "ˈ";
export const SECONDARY_STRESS = "ˌ";
const VOWELS = new Set([..."AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ"]);
export const CONSONANTS = new Set([..."bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ"]);
const US_TAUS = new Set([..."AIOWYiuæɑəɛɪɹʊʌ"]);
const LEXICON_ORDS = (c: string) => c === "'" || c === "-" || /^[A-Za-z]$/.test(c);

const CURRENCIES: Record<string, [string, string]> = { $: ["dollar", "cent"], "£": ["pound", "pence"], "€": ["euro", "cent"] };
const ORDINALS = ["st", "nd", "rd", "th"];
const ADD_SYMBOLS: Record<string, string> = { ".": "dot", "/": "slash" };
const SYMBOLS: Record<string, string> = { "%": "percent", "&": "and", "+": "plus", "@": "at" };

const isDigits = (text: string) => /^[0-9]+$/.test(text);
const isAlpha = (text: string) => /^\p{L}+$/u.test(text);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

export function applyStress(ps: string, stress: number | null): string {
  const restress = (value: string): string => {
    const chars = [...value];
    const keyed: Array<[number, string]> = chars.map((c, i) => [i, c]);
    chars.forEach((c, i) => {
      if (!STRESSES.includes(c)) return;
      const j = chars.findIndex((v, k) => k >= i && VOWELS.has(v));
      if (j >= 0) keyed[i] = [j - 0.5, c];
    });
    return keyed.sort((a, b) => a[0] - b[0]).map(([, c]) => c).join("");
  };
  const has = (set: Iterable<string>) => [...set].some((c) => ps.includes(c));
  const hasAny = (chars: string) => [...chars].some((c) => ps.includes(c));
  if (stress === null) return ps;
  if (stress < -1) return ps.replaceAll(PRIMARY_STRESS, "").replaceAll(SECONDARY_STRESS, "");
  if (stress === -1 || ((stress === 0 || stress === -0.5) && ps.includes(PRIMARY_STRESS))) {
    return ps.replaceAll(SECONDARY_STRESS, "").replaceAll(PRIMARY_STRESS, SECONDARY_STRESS);
  }
  if ((stress === 0 || stress === 0.5 || stress === 1) && !hasAny(STRESSES)) {
    return has(VOWELS) ? restress(SECONDARY_STRESS + ps) : ps;
  }
  if (stress >= 1 && !ps.includes(PRIMARY_STRESS) && ps.includes(SECONDARY_STRESS)) {
    return ps.replaceAll(SECONDARY_STRESS, PRIMARY_STRESS);
  }
  if (stress > 1 && !hasAny(STRESSES)) {
    return has(VOWELS) ? restress(PRIMARY_STRESS + ps) : ps;
  }
  return ps;
}

/** Misaki's `grow_dictionary`: lower-case entries gain a capitalised twin, and the other way round. */
function grow(dictionary: Record<string, Entry>): Map<string, Entry> {
  const grown = new Map<string, Entry>();
  for (const [key, value] of Object.entries(dictionary)) {
    if (key.length < 2) continue;
    if (key === key.toLowerCase()) {
      if (key !== capitalize(key)) grown.set(capitalize(key), value);
    } else if (key === capitalize(key)) {
      grown.set(key.toLowerCase(), value);
    }
  }
  for (const [key, value] of Object.entries(dictionary)) grown.set(key, value);
  return grown;
}

type Result = [string | null, number | null];

export class Lexicon {
  private readonly golds: Map<string, Entry>;
  private readonly silvers: Map<string, Entry>;
  private readonly capStresses = [0.5, 2] as const;

  constructor(gold: Record<string, Entry>, silver: Record<string, Entry>, private readonly british = false) {
    this.golds = grow(gold);
    this.silvers = grow(silver);
  }

  private gold(word: string): string {
    const entry = this.golds.get(word);
    return typeof entry === "string" ? entry : (entry?.DEFAULT as string);
  }

  private getNNP(word: string): Result {
    const parts = [...word].filter((c) => /\p{L}/u.test(c)).map((c) => this.golds.get(c.toUpperCase()));
    if (parts.some((p) => typeof p !== "string")) return [null, null];
    const ps = applyStress((parts as string[]).join(""), 0);
    const at = ps.lastIndexOf(SECONDARY_STRESS);
    return [at < 0 ? ps : ps.slice(0, at) + PRIMARY_STRESS + ps.slice(at + 1), 3];
  }

  private specialCase(word: string, tag: PosTag, stress: number | null, ctx: TokenContext): Result {
    if (tag === "ADD" && word in ADD_SYMBOLS) return this.lookup(ADD_SYMBOLS[word]!, null, -0.5, ctx);
    if (word in SYMBOLS) return this.lookup(SYMBOLS[word]!, null, null, ctx);
    if (word.replace(/^\.+|\.+$/g, "").includes(".") && isAlpha(word.replaceAll(".", "")) && Math.max(...word.split(".").map((p) => p.length)) < 3) {
      return this.getNNP(word);
    }
    if (word === "a" || word === "A") return [tag === "DT" ? "ɐ" : "ˈA", 4];
    if (word === "am" || word === "Am" || word === "AM") {
      if (tag?.startsWith("NN")) return this.getNNP(word);
      if (ctx.futureVowel === null || word !== "am" || (stress !== null && stress > 0)) return [this.gold("am"), 4];
      return ["ɐm", 4];
    }
    if (word === "an" || word === "An" || word === "AN") {
      return word === "AN" && tag?.startsWith("NN") ? this.getNNP(word) : ["ɐn", 4];
    }
    if (word === "I" && tag === "PRP") return [`${SECONDARY_STRESS}I`, 4];
    if ((word === "by" || word === "By" || word === "BY") && Lexicon.parentTag(tag) === "ADV") return ["bˈI", 4];
    if (word === "to" || word === "To" || (word === "TO" && (tag === "TO" || tag === "IN"))) {
      return [ctx.futureVowel === null ? this.gold("to") : ctx.futureVowel ? "tʊ" : "tə", 4];
    }
    if (word === "in" || word === "In" || (word === "IN" && tag !== "NNP")) {
      return [(ctx.futureVowel === null || tag !== "IN" ? PRIMARY_STRESS : "") + "ɪn", 4];
    }
    if (word === "the" || word === "The" || (word === "THE" && tag === "DT")) return [ctx.futureVowel === true ? "ði" : "ðə", 4];
    if (tag === "IN" && /^vs\.?$/i.test(word)) return this.lookup("versus", null, null, ctx);
    if (word === "used" || word === "Used" || word === "USED") {
      const used = this.golds.get("used") as Record<string, string>;
      return [(tag === "VBD" || tag === "JJ") && ctx.futureTo ? used.VBD! : used.DEFAULT!, 4];
    }
    return [null, null];
  }

  static parentTag(tag: PosTag): PosTag {
    if (tag === null) return tag;
    if (tag.startsWith("VB")) return "VERB";
    if (tag.startsWith("NN")) return "NOUN";
    if (tag.startsWith("ADV") || tag.startsWith("RB")) return "ADV";
    if (tag.startsWith("ADJ") || tag.startsWith("JJ")) return "ADJ";
    return tag;
  }

  private isKnown(word: string): boolean {
    if (this.golds.has(word) || word in SYMBOLS || this.silvers.has(word)) return true;
    if (!isAlpha(word) || ![...word].every(LEXICON_ORDS)) return false;
    if (word.length === 1) return true;
    if (word === word.toUpperCase() && this.golds.has(word.toLowerCase())) return true;
    return word.slice(1) === word.slice(1).toUpperCase();
  }

  private lookup(word: string, tag: PosTag, stress: number | null, ctx: TokenContext | null): Result {
    let isNNP: boolean | null = null;
    if (word === word.toUpperCase() && !this.golds.has(word)) {
      word = word.toLowerCase();
      isNNP = tag === "NNP";
    }
    let entry: Entry | null | undefined = this.golds.get(word);
    let rating = 4;
    if (entry === undefined && !isNNP) {
      entry = this.silvers.get(word);
      rating = 3;
    }
    let ps: string | null | undefined;
    if (entry !== undefined && typeof entry === "object" && entry !== null) {
      let key: string | null = tag;
      if (ctx && ctx.futureVowel === null && "None" in entry) key = "None";
      else if (key === null || !(key in entry)) key = Lexicon.parentTag(tag);
      ps = key !== null && key in entry ? entry[key] : entry.DEFAULT;
    } else {
      ps = entry as string | null | undefined;
    }
    if (ps === undefined || ps === null || (isNNP && !ps.includes(PRIMARY_STRESS))) {
      const [nnp, nnpRating] = this.getNNP(word);
      if (nnp !== null) return [nnp, nnpRating];
    }
    if (ps === undefined || ps === null) return [null, null];
    return [applyStress(ps, stress), rating];
  }

  private sSuffix(stem: string | null): string | null {
    if (!stem) return null;
    const last = stem.at(-1)!;
    if ("ptkfθ".includes(last)) return `${stem}s`;
    if ("szʃʒʧʤ".includes(last)) return `${stem}${this.british ? "ɪ" : "ᵻ"}z`;
    return `${stem}z`;
  }

  private stemS(word: string, tag: PosTag, stress: number | null, ctx: TokenContext): Result {
    if (word.length < 3 || !word.endsWith("s")) return [null, null];
    let stem: string;
    if (!word.endsWith("ss") && this.isKnown(word.slice(0, -1))) stem = word.slice(0, -1);
    else if ((word.endsWith("'s") || (word.length > 4 && word.endsWith("es") && !word.endsWith("ies"))) && this.isKnown(word.slice(0, -2))) stem = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith("ies") && this.isKnown(`${word.slice(0, -3)}y`)) stem = `${word.slice(0, -3)}y`;
    else return [null, null];
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [this.sSuffix(ps), rating];
  }

  private edSuffix(stem: string | null): string | null {
    if (!stem) return null;
    const last = stem.at(-1)!;
    if ("pkfθʃsʧ".includes(last)) return `${stem}t`;
    if (last === "d") return `${stem}${this.british ? "ɪ" : "ᵻ"}d`;
    if (last !== "t") return `${stem}d`;
    if (this.british || stem.length < 2) return `${stem}ɪd`;
    if (US_TAUS.has(stem.at(-2)!)) return `${stem.slice(0, -1)}ɾᵻd`;
    return `${stem}ᵻd`;
  }

  private stemEd(word: string, tag: PosTag, stress: number | null, ctx: TokenContext): Result {
    if (word.length < 4 || !word.endsWith("d")) return [null, null];
    let stem: string;
    if (!word.endsWith("dd") && this.isKnown(word.slice(0, -1))) stem = word.slice(0, -1);
    else if (word.length > 4 && word.endsWith("ed") && !word.endsWith("eed") && this.isKnown(word.slice(0, -2))) stem = word.slice(0, -2);
    else return [null, null];
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [this.edSuffix(ps), rating];
  }

  private ingSuffix(stem: string | null): string | null {
    if (!stem) return null;
    if (this.british) {
      if ("əː".includes(stem.at(-1)!)) return null;
    } else if (stem.length > 1 && stem.at(-1) === "t" && US_TAUS.has(stem.at(-2)!)) {
      return `${stem.slice(0, -1)}ɾɪŋ`;
    }
    return `${stem}ɪŋ`;
  }

  private stemIng(word: string, tag: PosTag, stress: number | null, ctx: TokenContext): Result {
    if (word.length < 5 || !word.endsWith("ing")) return [null, null];
    let stem: string;
    if (word.length > 5 && this.isKnown(word.slice(0, -3))) stem = word.slice(0, -3);
    else if (this.isKnown(`${word.slice(0, -3)}e`)) stem = `${word.slice(0, -3)}e`;
    else if (word.length > 5 && /([bcdgklmnprstvxz])\1ing$|cking$/.test(word) && this.isKnown(word.slice(0, -4))) stem = word.slice(0, -4);
    else return [null, null];
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [this.ingSuffix(ps), rating];
  }

  private getWord(word: string, tag: PosTag, stress: number | null, ctx: TokenContext): Result {
    const special = this.specialCase(word, tag, stress, ctx);
    if (special[0] !== null) return special;
    const lower = word.toLowerCase();
    if (
      word.length > 1 &&
      isAlpha(word.replaceAll("'", "")) &&
      word !== lower &&
      (tag !== "NNP" || word.length > 7) &&
      !this.golds.has(word) &&
      !this.silvers.has(word) &&
      (word === word.toUpperCase() || word.slice(1) === word.slice(1).toLowerCase()) &&
      (this.golds.has(lower) ||
        this.silvers.has(lower) ||
        [this.stemS, this.stemEd, this.stemIng].some((stem) => stem.call(this, lower, tag, stress, ctx)[0] !== null))
    ) {
      word = lower;
    }
    if (this.isKnown(word)) return this.lookup(word, tag, stress, ctx);
    if (word.endsWith("s'") && this.isKnown(`${word.slice(0, -2)}'s`)) return this.lookup(`${word.slice(0, -2)}'s`, tag, stress, ctx);
    if (word.endsWith("'") && this.isKnown(word.slice(0, -1))) return this.lookup(word.slice(0, -1), tag, stress, ctx);
    const s = this.stemS(word, tag, stress, ctx);
    if (s[0] !== null) return s;
    const ed = this.stemEd(word, tag, stress, ctx);
    if (ed[0] !== null) return ed;
    const ing = this.stemIng(word, tag, stress === null ? 0.5 : stress, ctx);
    if (ing[0] !== null) return ing;
    return [null, null];
  }

  private static isCurrency(word: string): boolean {
    if (!word.includes(".")) return true;
    if (word.split(".").length > 2) return false;
    const cents = word.split(".")[1]!;
    return cents.length < 3 || /^0+$/.test(cents);
  }

  private getNumber(word: string, currency: string | null, isHead: boolean): Result {
    const suffixMatch = /[a-z']+$/.exec(word);
    const suffix = suffixMatch?.[0] ?? null;
    if (suffix) word = word.slice(0, -suffix.length);
    const result: Array<[string, number]> = [];
    const noCtx = null;
    if (word.startsWith("-")) {
      result.push(this.lookup("minus", null, null, noCtx) as [string, number]);
      word = word.slice(1);
    }
    // `first` is misaki's hook for the "a hundred" reading, which needs a link flag we do not support.
    const extend = (text: string, _first = true) => {
      for (const w of text.split(/[^a-z]+/).filter((part) => part !== "")) {
        if (w === "and") continue; // misaki keeps "and" only with a flag we never set.
        result.push(this.lookup(w, null, w === "point" ? -2 : null, noCtx) as [string, number]);
      }
    };
    const digitsEach = (num: string) => [...num].forEach((n) => extend(cardinal(Number(n)), false));

    if (isDigits(word) && suffix !== null && ORDINALS.includes(suffix)) {
      extend(ordinal(Number(word)));
    } else if (result.length === 0 && word.length === 4 && !(currency && currency in CURRENCIES) && isDigits(word)) {
      extend(year(Number(word)));
    } else if (!isHead && !word.includes(".")) {
      const num = word.replaceAll(",", "");
      if (num[0] === "0" || num.length > 3) digitsEach(num);
      else if (num.length === 3 && !num.endsWith("00")) {
        extend(cardinal(Number(num[0])));
        if (num[1] === "0") {
          result.push(this.lookup("O", null, -2, noCtx) as [string, number]);
          extend(cardinal(Number(num[2])), false);
        } else {
          extend(cardinal(Number(num.slice(1))), false);
        }
      } else extend(cardinal(Number(num)));
    } else if (word.split(".").length > 2 || !isHead) {
      let first = true;
      for (const num of word.replaceAll(",", "").split(".")) {
        if (!num) {
          // Nothing to say for an empty part.
        } else if (num[0] === "0" || (num.length !== 2 && [...num.slice(1)].some((n) => n !== "0"))) digitsEach(num);
        else extend(cardinal(Number(num)), first);
        first = false;
      }
    } else if (currency && currency in CURRENCIES && Lexicon.isCurrency(word)) {
      const units = CURRENCIES[currency]!;
      let pairs: Array<[number, string]> = word
        .replaceAll(",", "")
        .split(".")
        .slice(0, 2)
        .map((num, i) => [num ? Number(num) : 0, units[i]!]);
      if (pairs.length > 1) {
        if (pairs[1]![0] === 0) pairs = pairs.slice(0, 1);
        else if (pairs[0]![0] === 0) pairs = pairs.slice(1);
      }
      pairs.forEach(([num, unit], i) => {
        if (i > 0) result.push(this.lookup("and", null, null, noCtx) as [string, number]);
        extend(cardinal(num), i === 0);
        const said = Math.abs(num) !== 1 && unit !== "pence" ? this.stemS(`${unit}s`, null, null, { futureVowel: null, futureTo: false }) : this.lookup(unit, null, null, noCtx);
        result.push(said as [string, number]);
      });
    } else {
      const plain = word.replaceAll(",", "");
      if (isDigits(word)) extend(cardinal(Number(word)));
      else if (!word.includes(".")) extend(suffix !== null && ORDINALS.includes(suffix) ? ordinal(Number(plain)) : cardinal(Number(plain)));
      else if (plain.startsWith(".")) extend(`point ${[...plain.slice(1)].map((n) => cardinal(Number(n))).join(" ")}`);
      else extend(decimal(plain));
    }
    if (result.length === 0) return [null, null];
    const ps = result.map(([p]) => p).join(" ");
    const rating = Math.min(...result.map(([, r]) => r));
    if (suffix === "s" || suffix === "'s") return [this.sSuffix(ps), rating];
    if (suffix === "ed" || suffix === "'d") return [this.edSuffix(ps), rating];
    if (suffix === "ing") return [this.ingSuffix(ps), rating];
    return [ps, rating];
  }

  private appendCurrency(ps: string, currency: string | null): string {
    if (!currency || !(currency in CURRENCIES)) return ps;
    const [plural] = this.stemS(`${CURRENCIES[currency]![0]}s`, null, null, { futureVowel: null, futureTo: false });
    return plural ? `${ps} ${plural}` : ps;
  }

  static isNumber(word: string, isHead: boolean): boolean {
    if (![...word].some((c) => isDigits(c))) return false;
    for (const suffix of ["ing", "'d", "ed", "'s", ...ORDINALS, "s"]) {
      if (word.endsWith(suffix)) {
        word = word.slice(0, -suffix.length);
        break;
      }
    }
    return [...word].every((c, i) => isDigits(c) || c === "," || c === "." || (isHead && i === 0 && c === "-"));
  }

  /** Phonemes and a rating (4 = gold, 3 = silver, lower = guessed) for one token, or `[null, null]` if the lexicon has nothing. */
  lookupToken(token: LexToken, ctx: TokenContext): Result {
    const word = token.text.replaceAll("‘", "'").replaceAll("’", "'").normalize("NFKC");
    const stress = word === word.toLowerCase() ? null : this.capStresses[Number(word === word.toUpperCase())]!;
    const [ps, rating] = this.getWord(word, token.tag, stress, ctx);
    if (ps !== null) return [applyStress(this.appendCurrency(ps, token.currency), token.stress), rating];
    if (Lexicon.isNumber(word, token.isHead)) {
      const [numeric, numericRating] = this.getNumber(word, token.currency, token.isHead);
      return numeric === null ? [null, null] : [applyStress(numeric, token.stress), numericRating];
    }
    return [null, null];
  }
}
