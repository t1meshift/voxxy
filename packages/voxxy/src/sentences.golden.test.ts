import { describe, expect, it } from "vitest";
import english from "./test-data/pysbd-en.json" with { type: "json" };
import spanishGolden from "./test-data/pysbd-es-golden.json" with { type: "json" };
import spanishMore from "./test-data/pysbd-es-more.json" with { type: "json" };
import { SentenceSplitter, type SplitterOptions } from "./sentences.js";

// pySBD's own test cases (MIT, see test-data/NOTICE.md), used to measure the splitter on text that somebody else
// chose to be hard. Each case is `text` and the sentences a person says it contains. Run with no merging of
// short sentences (`minChars: 0`), because here the boundaries themselves are the question.

interface Case {
  text: string;
  expected: string[];
  xfail: boolean;
}

function split(text: string, options: SplitterOptions): string[] {
  // No length limits either: pySBD's expectations are whole sentences, however long, and the length cuts are tested elsewhere.
  const splitter = new SentenceSplitter({ minChars: 0, maxChars: 100_000, firstMaxChars: 100_000, ...options });
  return [...splitter.push(text), ...splitter.flush()];
}

/** The text with each sentence's own whitespace normalised: pySBD keeps trailing spaces in its expectations. */
const normalise = (sentences: string[]) => sentences.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

/**
 * A ratchet: `baseline` is how many cases the splitter got right when this was last improved. It may only go up,
 * so a change that makes the splitter worse on somebody else's hard cases fails here. Print the misses with
 * `--silent=false` to see what is left.
 */
function run(name: string, cases: Case[], options: SplitterOptions, baseline: number) {
  describe(name, () => {
    const results = cases.map((c) => ({ c, got: normalise(split(c.text, options)), want: normalise(c.expected) }));
    const failed = results.filter((r) => JSON.stringify(r.got) !== JSON.stringify(r.want));
    const correct = cases.length - failed.length;

    it(`gets at least ${baseline} of pySBD's ${cases.length} cases right`, () => {
      console.log(`[${name}] ${correct}/${cases.length} correct`);
      for (const { c, got, want } of failed) console.log(`   MISS ${JSON.stringify(c.text.slice(0, 90))}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
      expect(correct).toBeGreaterThanOrEqual(baseline);
    });
  });
}

// Measured 2026-11-16 on the first version of the splitter: English 29/48 (one of the 48 is a case pySBD itself
// marks as a known failure), Spanish 4/5 and 17/25. Spanish uses the English abbreviation lists, since none are loaded for it yet.
run("pySBD English golden rules", english as Case[], {}, 29);
run("pySBD Spanish golden rules", spanishGolden as Case[], {}, 4);
run("pySBD Spanish, more cases", spanishMore as Case[], {}, 17);
