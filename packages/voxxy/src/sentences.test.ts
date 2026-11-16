import { describe, expect, it } from "vitest";
import { SentenceSplitter, speechWeight, type SplitterOptions } from "./sentences.js";

/** Splits `text` in one go. */
function split(text: string, options?: SplitterOptions): string[] {
  const splitter = new SentenceSplitter(options);
  return [...splitter.push(text), ...splitter.flush()];
}

/** Feeds `text` in pieces of `size` characters. */
function splitInPieces(text: string, size: number, options?: SplitterOptions): string[] {
  const splitter = new SentenceSplitter(options);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)));
  return [...out, ...splitter.flush()];
}

describe("sentence splitter: random text", () => {
  // A small deterministic generator, so a failure can be reproduced from its seed.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  }
  const PIECES = [
    "word", "Another", "the", "I", "A", "Dr.", "Mr.", "e.g.", "U.S.", "3.5", "10,000", "1999", "$5.00", "etc.", "Inc.", "p.m.",
    ".", "!", "?", "...", "…", ",", ";", ":", "—", "-", '"', "“", "”", "(", ")", "'", "\n", "\n\n", "  ", "\t", "ünï", "日本", "🎉", "x".repeat(40), "a.b.c", "https://example.com/a.b.c",
  ];
  const OPTIONS: SplitterOptions[] = [
    {},
    { minChars: 0 },
    { firstMinChars: 30, minChars: 120, maxChars: 240 },
    { firstMinChars: 30, minChars: 300, maxChars: 420 },
    { maxChars: 40, minChars: 5 },
    { newlines: "space", maxChars: 80 },
    { newlines: "break", maxChars: 120 },
    { firstMaxChars: 40, minChars: 60, maxChars: 150 },
    { firstMaxChars: 25, firstMinChars: 20, minChars: 100, maxChars: 200 },
  ];

  const compact = (s: string) => s.replace(/\s+/g, "");

  it("never loses or invents text, never makes a chunk past maxChars, and does not depend on the deltas", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = rng(seed);
      let text = "";
      for (let i = 0, n = 5 + Math.floor(next() * 80); i < n; i++) text += PIECES[Math.floor(next() * PIECES.length)] + (next() < 0.8 ? " " : "");
      for (const options of OPTIONS) {
        const maxChars = options.maxChars ?? 220;
        const whole = split(text, options);
        const where = `seed ${seed}, ${JSON.stringify(options)}`;
        expect(compact(whole.join("")), where).toBe(compact(text));
        for (const chunk of whole) {
          expect(chunk.trim().length, `empty chunk, ${where}`).toBeGreaterThan(0);
          // A chunk may run a quarter over the limit, so a sentence just past it is not cut into an orphan.
          expect(chunk.length, `long chunk, ${where}`).toBeLessThanOrEqual(Math.floor(maxChars * 1.25) + 1);
        }
        for (const size of [1, 7]) expect(splitInPieces(text, size, options), `deltas of ${size}, ${where}`).toEqual(whole);
      }
    }
  });
});

describe("sentence splitter", () => {
  it("splits at . ! ? and ellipses followed by a capital", () => {
    expect(split("It works. Does it? Yes! Wait… Really.", { minChars: 0 })).toEqual(["It works.", "Does it?", "Yes!", "Wait…", "Really."]);
  });

  it("does not cut inside decimals, versions, URLs or e-mail addresses", () => {
    expect(split("It is 3.5 meters long and v1.2.3 is out. See example.com for more.")).toEqual([
      "It is 3.5 meters long and v1.2.3 is out.",
      "See example.com for more.",
    ]);
  });

  it.each([
    ["Dr. Smith met Mr. Jones and Prof. Lee at St. Mary's. They left."],
    ["She works for Acme Inc. in Paris. Then she left."],
    ["J. K. Rowling wrote it. Everyone read it."],
    ["Use fruit, e.g. apples, or pears. Both work."],
  ])("does not cut at abbreviations or initials: %s", (text) => {
    const sentences = split(text);
    expect(sentences).toHaveLength(2);
    expect(sentences.join(" ")).toBe(text);
  });

  it("cuts after 'etc.' only when a capital follows", () => {
    expect(split("We bought apples, pears, etc. Then we left.")).toEqual(["We bought apples, pears, etc.", "Then we left."]);
    expect(split("We bought apples, pears, etc. and left.")).toEqual(["We bought apples, pears, etc. and left."]);
  });

  it("takes a lower-case letter or a digit after a full stop for a continuation", () => {
    expect(split("It ended at 5 p.m. tomorrow. Then it began.")).toEqual(["It ended at 5 p.m. tomorrow.", "Then it began."]);
    expect(split("Well... maybe. Yes.", { minChars: 0 })).toEqual(["Well... maybe.", "Yes."]);
  });

  it("keeps closing quotes and brackets with the sentence", () => {
    expect(split('He said "Stop." Then he left. (It was late.) Done!')).toEqual(['He said "Stop."', "Then he left.", "(It was late.)", "Done!"]);
  });

  it("splits at line breaks, and ignores blank lines", () => {
    expect(split("A heading\n\nFirst item\n- second item\nThird.", { minChars: 0 })).toEqual(["A heading", "First item", "- second item", "Third."]);
    expect(split("one two\nthree", { newlines: "space" })).toEqual(["one two three"]);
    expect(split("one two\nThree four", { newlines: "break", minChars: 0 })).toEqual(["one two", "Three four"]);
  });

  describe("line breaks", () => {
    const wrapped = "In my younger and more vulnerable years my father gave me\nsome advice that I have been turning over in my mind ever\nsince. Whenever you feel like criticizing anyone, he told me,\njust remember that all the people in this world have not\nhad the advantages that you have had.";

    it("keeps a sentence together when a line was cut at the margin", () => {
      expect(split(wrapped, { firstMaxChars: 400 })).toEqual([
        "In my younger and more vulnerable years my father gave me some advice that I have been turning over in my mind ever since.",
        "Whenever you feel like criticizing anyone, he told me, just remember that all the people in this world have not had the advantages that you have had.",
      ]);
    });

    it("still ends a sentence at a full stop before a line break, at a blank line, and before a list marker", () => {
      expect(split("First sentence ends here.\nSecond one starts. And more text\n\nNew paragraph here\n- an item\n2) another item", { minChars: 0 })).toEqual([
        "First sentence ends here.",
        "Second one starts.",
        "And more text",
        "New paragraph here",
        "- an item",
        "2) another item",
      ]);
    });

    it("takes short lines without punctuation for headings or verse, and long ones for wrapped text", () => {
      expect(split("A short heading\nBody text starts here and goes on.", { minChars: 0 })).toEqual(["A short heading", "Body text starts here and goes on."]);
      expect(split("Roses are red\nViolets are blue\nSugar is sweet", { minChars: 0 })).toEqual(["Roses are red", "Violets are blue", "Sugar is sweet"]);
      expect(split("a line that was cut right at the margin of the page here\nContinues", { minChars: 0 })).toEqual([
        "a line that was cut right at the margin of the page here Continues",
      ]);
    });

    it("does not mistake a number that continues the line for a list marker", () => {
      expect(split("The total came to nearly three thousand dollars and\n250 cents more")).toEqual(["The total came to nearly three thousand dollars and 250 cents more"]);
      expect(split("short\n2. second item here", { minChars: 0 })).toEqual(["short", "2. second item here"]);
    });

    it("waits for the next line before deciding, and decides the same way however the text arrives", () => {
      const splitter = new SentenceSplitter({ minChars: 0 });
      expect(splitter.push("A line that was cut at the margin of the wrapped page\n")).toEqual([]);
      expect(splitter.push("continues here.")).toEqual([]);
      expect(splitter.flush()).toEqual(["A line that was cut at the margin of the wrapped page continues here."]);
      for (const size of [1, 2, 5]) expect(splitInPieces(wrapped, size, { firstMaxChars: 400 })).toEqual(split(wrapped, { firstMaxChars: 400 }));
    });
  });

  describe("length counted in speech, not characters", () => {
    it("weighs a digit as a word and a symbol as a word", () => {
      expect(speechWeight("abc")).toBe(3);
      expect(speechWeight("a1")).toBe(6);
      expect(speechWeight("5%")).toBe(11);
      expect(speechWeight("")).toBe(0);
    });

    it("cuts a long number early: 80 digits are not 80 characters of speech", () => {
      const digits = "3.14159265358979323846264338327950288419716939937510582097494459230781640628620899";
      const chunks = split(`The constant is ${digits} and that is all.`, { firstMaxChars: 120, maxChars: 220, minChars: 0 });
      expect(chunks[0]!.length).toBeLessThan(40); // By characters it would have fit whole in 120.
      expect(chunks.every((c) => speechWeight(c) <= 220)).toBe(true);
      expect(chunks.join(" ").replace(/\s+/g, "")).toBe(`Theconstantis${digits}andthatisall.`);
    });

    it("lets a text with a few digits keep its usual size", () => {
      const text = "The meeting is at 9 on Tuesday and it lasts about 45 minutes in room 3. Bring your notes along.";
      expect(split(text, { firstMinChars: 0, minChars: 0 })).toEqual(["The meeting is at 9 on Tuesday and it lasts about 45 minutes in room 3.", "Bring your notes along."]);
    });

    it("counts digits when packing, too", () => {
      const chunks = split("Room 101 is on floor 2. Room 202 is on floor 3. Room 303 is on floor 4.", { firstMinChars: 0, minChars: 80, maxChars: 100 });
      expect(chunks.every((c) => speechWeight(c) <= 100)).toBe(true);
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe("the first chunk", () => {
    const long = "When I was younger and a good deal more inclined to think that every question has a single clean answer, I used to believe that silence meant a great deal, whereas the truth is simpler than that. Then it ended.";

    it("is cut at a pause when the first sentence is long, so sound does not wait for all of it", () => {
      const chunks = split(long, { firstMaxChars: 110 });
      expect(chunks[0]!.length).toBeLessThanOrEqual(110);
      expect(chunks[0]).toMatch(/answer,$/); // The comma is the last pause that fits.
      expect(chunks.join(" ")).toBe(long);
    });

    it("does not leave an orphan word: a sentence a little over the limit is kept whole", () => {
      const sentence = "In my younger and more vulnerable years my father gave me some advice that I have been turning over in my mind ever since."; // 124 characters
      expect(split(`${sentence} Whenever you feel like criticizing anyone, he told me.`)[0]).toBe(sentence);
      // Well over the limit it is cut, at the last space that fits.
      const long = `${sentence} ${sentence.slice(0, 60).trimEnd()} and then some more words in the same sentence.`;
      const cut = split(long, { firstMaxChars: 60 })[0]!;
      expect(cut.length).toBeLessThanOrEqual(60);
    });

    it("limits only the first chunk: the rest may use maxChars", () => {
      const chunks = split(long, { firstMaxChars: 60, maxChars: 220, minChars: 0 });
      expect(chunks[0]!.length).toBeLessThanOrEqual(60);
      expect(Math.max(...chunks.slice(1).map((c) => c.length))).toBeGreaterThan(60);
    });

    it("defaults to 120 characters, and never exceeds maxChars", () => {
      expect(split("word ".repeat(80).trim(), { maxChars: 400 })[0]!.length).toBeLessThanOrEqual(120);
      expect(split("word ".repeat(80).trim(), { maxChars: 50 })[0]!.length).toBeLessThanOrEqual(50);
    });

    it("applies to a first chunk that is packed from several sentences, too", () => {
      const chunks = split("Short one. Another short one follows. A third sentence is here. And a fourth.", { firstMinChars: 200, firstMaxChars: 40, minChars: 0 });
      expect(chunks[0]!.length).toBeLessThanOrEqual(40);
    });
  });

  it("holds the last sentence until it is sure it ended, then flush() releases it", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("First sentence here.")).toEqual([]); // Could still be "here.5"
    expect(splitter.push(" Second")).toEqual(["First sentence here."]);
    expect(splitter.push(" one.")).toEqual([]);
    expect(splitter.flush()).toEqual(["Second one."]);
    expect(splitter.flush()).toEqual([]);
  });

  it("gives the same sentences however the text is cut into deltas", () => {
    const text = 'Dr. Smith paid $3.5 million. "Is that right?" she asked. It was 5 p.m. Then it ended... or did it! J. K. Rowling smiled.';
    const whole = split(text);
    for (const size of [1, 2, 3, 7, 13]) expect(splitInPieces(text, size)).toEqual(whole);
  });

  it("joins a very short sentence to the next, because speech models do badly on tiny utterances", () => {
    expect(split("Sure. Here is how it works. Ok.")).toEqual(["Sure. Here is how it works.", "Ok."]);
    expect(split("Sure. Here is how it works.", { minChars: 0 })).toEqual(["Sure.", "Here is how it works."]);
  });

  describe("packing sentences into chunks", () => {
    const text = "Short one. A second sentence follows it. Then comes a third, a little longer than the others. Fourth. The fifth sentence closes the paragraph.";

    it("packs sentences until a chunk reaches minChars, and never past maxChars", () => {
      const chunks = split(text, { minChars: 60, maxChars: 120 });
      expect(chunks.join(" ")).toBe(text);
      expect(chunks.length).toBeLessThan(split(text, { minChars: 0 }).length);
      expect(chunks.every((c) => c.length <= 120)).toBe(true);
    });

    it("keeps the first chunk small with firstMinChars, and packs the rest", () => {
      const chunks = split(text, { firstMinChars: 8, minChars: 80, maxChars: 200 });
      expect(chunks[0]).toBe("Short one.");
      expect(chunks.slice(1).join(" ")).toBe(text.replace("Short one. ", ""));
      expect(chunks.slice(1, -1).every((c) => c.length >= 80)).toBe(true);
    });

    it("sends what is held as it is when the next sentence would not fit", () => {
      const chunks = split("A sentence of moderate length here. " + "Another one that is quite a bit longer than the first one was, indeed.", { minChars: 100, maxChars: 80 });
      expect(chunks).toEqual(["A sentence of moderate length here.", "Another one that is quite a bit longer than the first one was, indeed."]);
    });

    it("gives the same chunks however the text is cut into deltas", () => {
      const options = { firstMinChars: 12, minChars: 70, maxChars: 140 };
      const whole = split(text, options);
      for (const size of [1, 3, 11]) expect(splitInPieces(text, size, options)).toEqual(whole);
    });

    it("with equal minimums it is the old behaviour", () => {
      expect(split(text, { firstMinChars: 10, minChars: 10 })).toEqual(split(text, { minChars: 10 }));
    });
  });

  it("cuts a long run with no sentence end, at a pause if there is one", () => {
    const run = "first part of a very long thought, second part of that thought; third part goes on and on without any end in sight";
    const parts = split(run, { maxChars: 60 });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 60)).toBe(true);
    expect(parts[0]).toBe("first part of a very long thought,");
    expect(parts.join(" ")).toBe(run);
  });

  it("cuts at a space, or at the limit when there is not even a space", () => {
    expect(split("word ".repeat(30).trim(), { maxChars: 50 }).every((p) => p.length <= 50)).toBe(true);
    const blob = "x".repeat(130);
    expect(split(blob, { maxChars: 50 }).map((p) => p.length)).toEqual([50, 50, 30]);
  });

  it("applies the length limit to a sentence that ends too late, too", () => {
    const long = `${"word ".repeat(60)}end. Next one.`;
    expect(split(long, { maxChars: 100 }).every((p) => p.length <= 125)).toBe(true); // A quarter over is allowed.
  });

  it("handles empty and whitespace-only input", () => {
    expect(split("")).toEqual([]);
    expect(split("   \n  ")).toEqual([]);
  });
});
