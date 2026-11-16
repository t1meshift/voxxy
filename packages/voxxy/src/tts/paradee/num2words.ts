/**
 * English number words, enough for what misaki's `Lexicon.get_number` asks of `num2words`: cardinals, ordinals, years,
 * decimals. Written without "and" ("one hundred one"), because misaki drops that word anyway.
 */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion", "trillion", "quadrillion"];

function belowThousand(n: number): string {
  const words: string[] = [];
  if (n >= 100) {
    words.push(ONES[Math.floor(n / 100)]!, "hundred");
    n %= 100;
  }
  if (n >= 20) {
    const tens = TENS[Math.floor(n / 10)]!;
    words.push(n % 10 ? `${tens}-${ONES[n % 10]}` : tens);
  } else if (n > 0 || words.length === 0) {
    words.push(ONES[n]!);
  }
  return words.join(" ");
}

/** 1234 -> "one thousand two hundred thirty-four". Negative numbers get "minus". */
export function cardinal(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  n = Math.trunc(n);
  if (n < 0) return `minus ${cardinal(-n)}`;
  if (n === 0) return "zero";
  const groups: string[] = [];
  for (let scale = 0; n > 0; scale++) {
    const part = n % 1000;
    if (part) groups.unshift(`${belowThousand(part)}${SCALES[scale] ? ` ${SCALES[scale]}` : ""}`);
    n = Math.floor(n / 1000);
  }
  return groups.join(" ");
}

const ORDINAL_ENDINGS: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};

/** 21 -> "twenty-first", 100 -> "one hundredth". */
export function ordinal(n: number): string {
  const words = cardinal(n);
  const at = Math.max(words.lastIndexOf(" "), words.lastIndexOf("-")) + 1;
  const last = words.slice(at);
  const swapped = ORDINAL_ENDINGS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return words.slice(0, at) + swapped;
}

/** 1999 -> "nineteen ninety-nine", 2005 -> "two thousand five", 1905 -> "nineteen oh five". */
export function year(n: number): string {
  if (n < 1000 || n > 9999) return cardinal(n);
  if (n >= 2000 && n < 2010) return cardinal(n);
  const high = Math.floor(n / 100);
  const low = n % 100;
  if (low === 0) return n % 1000 === 0 ? cardinal(n) : `${cardinal(high)} hundred`;
  return low < 10 ? `${cardinal(high)} oh ${ONES[low]}` : `${cardinal(high)} ${cardinal(low)}`;
}

/** "3.14" -> "three point one four"; "0.5" -> "zero point five". */
export function decimal(text: string): string {
  const [whole = "0", fraction = ""] = text.split(".");
  const head = cardinal(Number(whole || "0"));
  return fraction ? `${head} point ${[...fraction].map((digit) => ONES[Number(digit)]).join(" ")}` : head;
}
