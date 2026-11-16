/**
 * How text is cut into pieces for speech: where sentences end, how short ones are packed together, and how the
 * first sound is kept quick. Passed to `speak()` through the TTS provider's `splitter` option, and to `speakStream()`.
 */
export interface SplitterOptions {
  /** A run of text with no sentence end is cut after about this many characters. Default 220. */
  maxChars?: number;
  /**
   * Sentences are packed together until they reach this length, because speech models do poorly on very short
   * utterances (Kokoro's authors put the sweet spot at 100–200 tokens) and every utterance costs a quiet moment at
   * its start. A sentence shorter than this is held and joined to the next one; the end of the text flushes it.
   * The packed text never grows past `maxChars`. Default 10, which only mends tiny fragments; around 120 packs
   * several sentences per chunk. 0 turns this off.
   */
  minChars?: number;
  /**
   * The same, for the very first chunk only. Keep it small so sound starts after one short sentence, and let
   * `minChars` pack everything after it. Default: the same as `minChars`.
   */
  firstMinChars?: number;
  /**
   * The longest the very first chunk may be. The wait before the first sound is the time to synthesise this chunk, and it
   * grows with its length (about 0.4 s for 100 characters on a laptop, several times that on a phone), so a long first
   * sentence is cut at a pause (a comma, a dash) instead of being spoken whole. Later chunks use `maxChars`.
   * Default: 120, or `maxChars` if that is smaller.
   */
  firstMaxChars?: number;
  /**
   * What a line break means.
   * - `"smart"` (default): a break is a sentence end after a line that ends with a full stop, a colon and the like, before a
   *   list marker, before a blank line, and between short lines (headings, verse). A line that stops without punctuation
   *   and is long, or is followed by a lower-case word, is a line cut at the margin of hard-wrapped text, an e-mail or a
   *   PDF, so the sentence goes on.
   * - `"break"`: every line break ends a sentence.
   * - `"space"`: a line break is a space.
   */
  newlines?: "smart" | "break" | "space";
}

/** Never the end of a sentence, whatever follows: titles, initials-like forms, "e.g.". Compared lowercase, without the dot. */
const NEVER_END = new Set(["mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "mt", "gen", "col", "capt", "sgt", "lt", "cmdr", "rev", "hon", "gov", "sen", "rep", "vs", "v", "cf", "e.g", "i.e", "viz", "ca", "approx"]);
/** Often the end of a sentence, but only if a capital letter follows: "…and so on, etc. The next…". */
const MAYBE_END = new Set(["etc", "inc", "ltd", "co", "corp", "no", "fig", "vol", "dept", "est", "u.s", "u.k", "a.m", "p.m"]);

const TERMINATORS = new Set([".", "!", "?", "…"]);
const CLOSERS = new Set(["\"", "'", "”", "’", ")", "]", "}", "»"]);
const SOFT_BREAKS = new Set([",", ";", ":", "—", "–"]);

/** A line that begins like this is the start of a list item, a heading or a quotation, not the middle of a sentence. */
const LIST_MARKER = /^(?:[-*•–—▪◦‣⁃]\s|\d{1,3}[.)]\s|#{1,6}\s|>\s?)/u;
/** A line that ends like this ends a sentence (or announces a list). */
const LINE_END = /[.!?…:;]["'”’)\]}»]*$/u;
/** Lines shorter than this, ending without punctuation, are headings or verse; longer ones were cut at the margin. */
const WRAPPED_LINE = 40;

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
const isDigit = (c: string) => c >= "0" && c <= "9";

/** How far past a limit a text may go before it is cut at all. */
const OVERSHOOT = 1.25;

/** Characters that are spoken as whole words: "%" is "percent", "&" is "and". */
const SYMBOLS = new Set(["%", "&", "+", "@", "=", "$", "£", "€", "#", "°"]);

/**
 * How long a text takes to say, in characters of ordinary prose. Limits are counted in this, not in raw characters,
 * because a digit is read as a word ("7" is "seven", "1999" is "nineteen ninety-nine") and a symbol as one too
 * ("%" is "percent"): 80 digits are 80 characters on the page and almost half a minute of speech. A digit counts as
 * 5, a symbol as 6, anything else as 1.
 */
export function speechWeight(text: string): number {
  let weight = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    weight += isDigit(c) ? 5 : SYMBOLS.has(c) ? 6 : 1;
  }
  return weight;
}

/**
 * Where to cut `text` so that the first part weighs at most `limit`: after the last pause (comma, dash) that fits, else
 * at the last space, else at the limit. Never earlier than `floor` weight if a pause beyond it exists. Null if it all fits already.
 */
export function cutIndex(text: string, limit: number, floor = 0): number | null {
  // A text only a little over the limit is left whole: cutting it would leave an orphan of a word or two ("…in my
  // mind ever" / "since."), which sounds worse than a few more characters in one piece.
  if (speechWeight(text) <= limit * OVERSHOOT) return null;
  const reach = Math.max(1, indexAtWeight(text, limit)); // How far the limit lets us go, in characters.
  const window = text.slice(0, reach);
  const lowest = Math.min(floor, Math.floor(reach / 2)); // Do not cut so early that the first piece is tiny.
  for (let i = window.length - 1; i > lowest; i--) {
    if (SOFT_BREAKS.has(window[i]!) && isSpace(text[i + 1])) return i + 1;
  }
  const space = window.lastIndexOf(" ");
  return space > 0 ? space : reach;
}

/** The index in `text` up to which the speech weight stays within `limit`. */
function indexAtWeight(text: string, limit: number): number {
  let weight = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    weight += isDigit(c) ? 5 : SYMBOLS.has(c) ? 6 : 1;
    if (weight > limit) return i;
  }
  return text.length;
}

/** The word right before the dot at `dot`, in lower case: "Dr" in "Dr. Smith", "e.g" in "e.g. this". */
function wordBefore(text: string, dot: number): string {
  let start = dot;
  while (start > 0 && /[\p{L}.]/u.test(text[start - 1]!)) start--;
  return text.slice(start, dot).toLowerCase();
}

/**
 * Cuts streamed text into sentences as it arrives. `push()` returns the sentences that are complete; the text after
 * the last sentence end stays buffered until more arrives or `flush()` is called. The result does not depend on how
 * the text was cut into deltas.
 *
 * It is a heuristic, not a parser: abbreviations ("Dr.", "e.g."), initials ("J. K. Rowling"), decimals ("3.5"),
 * ellipses and quoted sentences are handled; a sentence that starts with a lower-case letter or a digit after a full stop
 * is taken for a continuation. A sentence end is only recognised once the character after it has arrived (a
 * stream cannot know that "3." is not about to become "3.5"), so a reply's last sentence waits for `flush()`.
 */
export class SentenceSplitter {
  private buffer = "";
  private carry = "";
  /** True once the first chunk has gone out, after which `minChars` and `maxChars` apply instead of the `first…` ones. */
  private released = false;
  private readonly maxChars: number;
  private readonly minChars: number;
  private readonly firstMinChars: number;
  private readonly firstMaxChars: number;
  private readonly newlines: "smart" | "break" | "space";

  constructor(options: SplitterOptions = {}) {
    this.maxChars = options.maxChars ?? 220;
    this.minChars = options.minChars ?? 10;
    this.firstMinChars = options.firstMinChars ?? this.minChars;
    this.firstMaxChars = Math.min(this.maxChars, options.firstMaxChars ?? 120);
    this.newlines = options.newlines ?? "smart";
  }

  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  /** The end of the text: everything still held comes out. */
  flush(): string[] {
    return this.drain(true);
  }

  /** The longest the chunk being built may be: the first chunk is held to a tighter limit than the rest. */
  private limit(): number {
    return this.released ? this.maxChars : this.firstMaxChars;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut(final);
      if (cut === null) break;
      const [end, rest] = cut;
      this.emit(this.buffer.slice(0, end), out, false);
      this.buffer = this.buffer.slice(rest);
    }
    if (final) {
      this.emit(this.buffer, out, true);
      this.buffer = "";
      if (this.carry.trim()) this.release(this.carry.trim(), out);
      this.carry = "";
    }
    return out;
  }

  /** Hands a sentence to the packer: held until it is long enough, joined to the next one, but never packed past the limit. */
  private emit(raw: string, out: string[], final: boolean): void {
    let sentence = raw.replace(/\s+/g, " ").trim(); // Line breaks inside a sentence are spaces.
    if (!sentence) return;
    if (this.carry) {
      if (speechWeight(this.carry) + 1 + speechWeight(sentence) > this.limit()) {
        this.release(this.carry, out); // Adding this sentence would make the chunk too long: send what is held as it is.
      } else {
        sentence = `${this.carry} ${sentence}`;
      }
      this.carry = "";
    }
    const needed = this.released ? this.minChars : this.firstMinChars;
    if (speechWeight(sentence) < needed && !final) {
      this.carry = sentence;
      return;
    }
    this.release(sentence, out);
  }

  private release(chunk: string, out: string[]): void {
    out.push(chunk);
    this.released = true;
  }

  /**
   * Is the line break at `at` the end of a sentence? True or false, or null when the text after it has not arrived
   * far enough to tell.
   */
  private lineBreak(text: string, at: number, final: boolean): boolean | null {
    if (this.newlines === "break") return true;
    if (this.newlines === "space") return false;
    let k = at + 1;
    while (k < text.length && (text[k] === " " || text[k] === "\t" || text[k] === "\r")) k++;
    if (k >= text.length) return final ? true : null;
    if (text[k] === "\n") return true; // A blank line ends anything.
    const previous = text.slice(text.lastIndexOf("\n", at - 1) + 1, at).trimEnd();
    if (LINE_END.test(previous)) return true;
    const first = text[k]!;
    if (isLower(first)) return false; // The sentence goes on.
    const head = text.slice(k, k + 4);
    if (head.length < 4 && !final) return null; // Too little to tell a list marker from a number.
    if (LIST_MARKER.test(head)) return true;
    return previous.length < WRAPPED_LINE;
  }

  /** `[end of the sentence, where the rest starts]`, or null when more text is needed. */
  private findCut(final: boolean): [number, number] | null {
    const text = this.buffer.replace(/^\s+/, "");
    if (text.length !== this.buffer.length) this.buffer = text;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (c === "\n") {
        const breaks = this.lineBreak(text, i, final);
        if (breaks === null) return this.pending(text, i);
        if (breaks) return this.bound(text, i, i + 1);
        continue;
      }
      if (!TERMINATORS.has(c)) continue;

      let j = i + 1;
      while (j < text.length && TERMINATORS.has(text[j]!)) j++;
      while (j < text.length && CLOSERS.has(text[j]!)) j++;
      if (j >= text.length) {
        if (final) return this.bound(text, j, j);
        return this.pending(text, j);
      }
      if (!isSpace(text[j])) {
        i = j - 1; // "3.5", "e.g.x": the stop is inside a token.
        continue;
      }
      let k = j;
      while (k < text.length && isSpace(text[k]) && (this.newlines === "space" || text[k] !== "\n")) k++;
      const next = text[k];
      if (c === "!" || c === "?" || (next === undefined && final)) return this.bound(text, j, k);
      if (next === undefined) return this.pending(text, j); // Wait to see what follows.
      if (next === "\n") return this.bound(text, j, k);
      // A full stop (or ellipsis): is it really the end?
      if (c === "." && text[i + 1] !== "." && this.isAbbreviation(text, i, next)) {
        i = j - 1;
        continue;
      }
      if (isLower(next) || isDigit(next)) {
        i = j - 1;
        continue;
      }
      return this.bound(text, j, k);
    }
    return this.tooLong(text);
  }

  /**
   * A sentence end was seen but the character after it has not arrived. Wait, unless the end itself is already past
   * the limit. The text that is only there to settle the question does not count towards the limit: otherwise the cut
   * would depend on how the text happened to be delivered.
   */
  private pending(text: string, end: number): [number, number] | null {
    const at = this.cutWithin(text.slice(0, end));
    return at === null ? null : [at, at];
  }

  /** A sentence end found past the length limit is cut at the limit's pause or space instead. */
  private bound(text: string, end: number, rest: number): [number, number] {
    const at = this.cutWithin(text.slice(0, end));
    return at === null ? [end, rest] : [at, at];
  }

  /** Where to cut `sentence` if it is too long for the chunk being built (a little over is allowed), or null. */
  private cutWithin(sentence: string): number | null {
    return cutIndex(sentence, this.limit(), this.released ? this.minChars : this.firstMinChars);
  }

  private isAbbreviation(text: string, dot: number, next: string): boolean {
    const word = wordBefore(text, dot);
    if (!word) return false;
    if (/^\p{Lu}$/u.test(text.slice(dot - 1, dot)) && (dot < 2 || !/\p{L}/u.test(text[dot - 2]!))) return true; // An initial: "J. K. Rowling".
    if (NEVER_END.has(word)) return true;
    if (MAYBE_END.has(word)) return !/\p{Lu}/u.test(next);
    return false;
  }

  /** No sentence end in sight and the buffer is long: cut at a pause, a space, or the limit. */
  private tooLong(text: string): [number, number] | null {
    const at = cutIndex(text, this.limit(), this.released ? this.minChars : this.firstMinChars);
    return at === null ? null : [at, at];
  }
}
