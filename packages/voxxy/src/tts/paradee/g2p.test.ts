import { describe, expect, it } from "vitest";
import { EnglishG2p } from "./g2p-en.js";
import { Lexicon, applyStress } from "./lexicon.js";
import { cardinal, decimal, ordinal, year } from "./num2words.js";

describe("number words", () => {
  it.each([
    [0, "zero"],
    [7, "seven"],
    [13, "thirteen"],
    [21, "twenty-one"],
    [100, "one hundred"],
    [101, "one hundred one"],
    [1234, "one thousand two hundred thirty-four"],
    [1_000_000, "one million"],
    [12_345_678, "twelve million three hundred forty-five thousand six hundred seventy-eight"],
    [-5, "minus five"],
  ])("cardinal %i", (n, words) => expect(cardinal(n)).toBe(words));

  it.each([
    [1, "first"],
    [2, "second"],
    [3, "third"],
    [5, "fifth"],
    [9, "ninth"],
    [12, "twelfth"],
    [20, "twentieth"],
    [21, "twenty-first"],
    [100, "one hundredth"],
    [101, "one hundred first"],
  ])("ordinal %i", (n, words) => expect(ordinal(n)).toBe(words));

  it.each([
    [1999, "nineteen ninety-nine"],
    [2000, "two thousand"],
    [2005, "two thousand five"],
    [2024, "twenty twenty-four"],
    [1905, "nineteen oh five"],
    [1900, "nineteen hundred"],
  ])("year %i", (n, words) => expect(year(n)).toBe(words));

  it("reads decimals digit by digit after the point", () => {
    expect(decimal("3.14")).toBe("three point one four");
    expect(decimal("0.5")).toBe("zero point five");
  });
});

describe("stress", () => {
  it("adds secondary stress before the first vowel", () => {
    expect(applyStress("kæt", 0.5)).toBe("kˌæt");
  });
  it("promotes secondary to primary when asked for more", () => {
    expect(applyStress("kˌæt", 1)).toBe("kˈæt");
  });
  it("lowers primary to secondary for -1, and strips both below that", () => {
    expect(applyStress("kˈæt", -1)).toBe("kˌæt");
    expect(applyStress("kˈætˌɪŋ", -2)).toBe("kætɪŋ");
  });
  it("leaves it alone when no change is asked for", () => {
    expect(applyStress("kˈæt", null)).toBe("kˈæt");
  });
});

// A dictionary of a few words, shaped like misaki's.
const gold = {
  the: "ðə",
  cat: "kˈæt",
  dog: "dˈɔɡ",
  walk: "wˈɔk",
  eat: "ˈit",
  apple: "ˈæpᵊl",
  and: "ˈænd",
  to: "tˈu",
  a: "ɐ",
  five: "fˈIv",
  fifth: "fˈɪfθ",
  three: "θɹˈi",
  nineteen: "nˈInTˌin",
  ninety: "nˈInTi",
  nine: "nˈIn",
  twenty: "twˈɛnti",
  one: "wˈʌn",
  dollar: "dˈɑləɹ",
  point: "pˈɔɪnt",
  percent: "pəɹsˈɛnt",
  well: "wˈɛl",
  known: "nˈOn",
  "well-known": "wˈɛlnˈOn",
  I: "ˌI",
  read: { DEFAULT: "ɹˈid", VBD: "ɹˈɛd" },
  Zed: "zˈɛd",
};
const lexicon = new Lexicon(gold as never, {} as never);
const fallbackCalls: string[] = [];
const g2p = new EnglishG2p(lexicon, async (word) => {
  fallbackCalls.push(word);
  return `<${word}>`;
});

describe("English phonemes", () => {
  it("looks words up and keeps punctuation", async () => {
    expect(await g2p.phonemize("The cat.")).toBe("ðə kˈæt.");
    expect(await g2p.phonemize("cat, dog!")).toBe("kˈæt, dˈɔɡ!");
    expect(await g2p.phonemize("cat? dog…")).toBe("kˈæt? dˈɔɡ…");
  });

  it("builds -s, -ed and -ing forms from the stem", async () => {
    expect(await g2p.phonemize("cats")).toBe("kˈæts");
    expect(await g2p.phonemize("dogs")).toBe("dˈɔɡz");
    expect(await g2p.phonemize("walked")).toBe("wˈɔkt");
    expect(await g2p.phonemize("walking")).toBe("wˈɔkɪŋ");
    expect(await g2p.phonemize("eating")).toBe("ˈiTɪŋ"); // The stem's t after a vowel is a flap, which Kokoro spells T.
  });

  it("finds capitalised words in the lowercase entries", async () => {
    expect(await g2p.phonemize("Cat")).toContain("kˈæt");
  });

  it("uses the vowel after 'the' to choose its sound", async () => {
    expect(await g2p.phonemize("the apple")).toBe("ði ˈæpᵊl");
    expect(await g2p.phonemize("the cat")).toBe("ðə kˈæt");
  });

  it("turns straight quotes into opening and closing quotes and brackets into brackets", async () => {
    expect(await g2p.phonemize('"cat" (dog)')).toBe("“kˈæt” (dˈɔɡ)");
  });

  it("treats whitespace of any kind as one space", async () => {
    expect(await g2p.phonemize("  cat \n\n  dog  ")).toBe("kˈæt dˈɔɡ");
  });

  it("reads numbers, ordinals, years, decimals, percentages and money", async () => {
    expect(await g2p.phonemize("5")).toBe("fˈIv");
    expect(await g2p.phonemize("5th")).toBe("fˈɪfθ");
    expect(await g2p.phonemize("$5")).toBe("fˈIv dˈɑləɹz");
    expect(await g2p.phonemize("5%")).toBe("fˈIv pəɹsˈɛnt");
    expect(await g2p.phonemize("1999")).toBe("nˈInTˌin nˈInTi nˈIn");
    expect(await g2p.phonemize("3.5")).toBe("θɹˈi pɔɪnt fˈIv"); // "point" is read unstressed, as in misaki.
  });

  it("sends what the dictionary lacks to the fallback, and only that", async () => {
    fallbackCalls.length = 0;
    expect(await g2p.phonemize("cat Qwxzt dog")).toBe("kˈæt <Qwxzt> dˈɔɡ");
    expect(fallbackCalls).toEqual(["Qwxzt"]);
  });

  it("keeps a hyphenated word together when the dictionary has it, and splits it when not", async () => {
    expect(await g2p.phonemize("well-known")).toBe("wˈɛlnˈOn");
    // Two stressed halves: the first is toned down to secondary stress, as misaki does for compounds.
    expect(await g2p.phonemize("dog-cat")).toBe("dˌɔɡkˈæt");
  });

  it("maps flaps and glottal stops the way Kokoro was trained", async () => {
    // eating -> ɾ in the dictionary-built form is rewritten to T at the end.
    const out = await new EnglishG2p(new Lexicon({ x: "bˈɑɾɚ", y: "wˈʔ" } as never, {} as never), async () => null).phonemize("x y");
    expect(out).toBe("bˈɑTɚ wˈt");
  });

  it("returns an empty string for empty or punctuation-only input without throwing", async () => {
    expect(await g2p.phonemize("")).toBe("");
    expect(await g2p.phonemize("   ")).toBe("");
    expect(typeof (await g2p.phonemize("..."))).toBe("string");
  });
});
