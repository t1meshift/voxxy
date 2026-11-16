/**
 * Makes English text sayable before it is phonemised. A speech model trained on sentences has never heard a URL: given
 * "https://example.com/a/b.html?x=1&y=2" it babbles for seven seconds ("CH tips, Xample, Combat Towson…"), reads
 * "foo.bar.baz()" as "Few Bar Baths", and drops the dots from file names. So these shapes are turned into what a
 * person would say. The rules are plain pattern matches on common cases, not a parser: they do not know every
 * top-level domain or file type, and a few strange inputs will still come out odd.
 *
 * - addresses: "first.last@example.co.uk" → "first dot last at example dot co dot uk"
 * - links: "https://example.com/a/b?x=1" → "a link to example dot com" (the path and query are not read);
 *   "example.com" → "example dot com"
 * - files: "report_final_v2.pdf" → "report final v2 dot pdf"
 * - code: "foo.bar.baz()" → "foo dot bar dot baz"; "--save-dev" → "save-dev"; "snake_case" → "snake case"
 * - a dot between two words with no space after it ("hello.How are you") is a missing space, not a dot to read
 */

/** Endings that make a bare "name.ending" a web address. Short ambiguous ones ("it", "in", "me", "us") are left out: "end.in" is a typo. */
const TLDS = "com|org|net|io|dev|app|ai|edu|gov|info|tv|xyz|tech|cloud|online|site|shop|uk|de|fr|ru|jp|cn|br|mx|nl|au|ca";
const FILE_EXTENSIONS = "pdf|txt|md|json|js|ts|tsx|jsx|py|rb|go|rs|java|html|htm|css|png|jpg|jpeg|gif|svg|webp|zip|gz|csv|docx|xlsx|pptx|mp3|mp4|wav|yaml|yml|xml|log|sh|exe|dmg|iso|ini|toml";

/** Punctuation that belongs to the sentence around a link, not to the link. */
const TRAILING = /[.,;:!?)\]}"'”’]+$/;

const spokenHost = (host: string) => host.replace(/^www\./i, "").split(".").filter(Boolean).join(" dot ");
const spaced = (text: string) => text.replace(/[_-]+/g, " ").trim();

/** What is said for a link: the host, and "a link to" in front when there is a path or query that is not read. */
function sayLink(host: string, rest: string): string {
  const tail = TRAILING.exec(rest)?.[0] ?? "";
  const path = rest.slice(0, rest.length - tail.length);
  return (path && path !== "/" ? `a link to ${spokenHost(host)}` : spokenHost(host)) + tail;
}

export function speakableEnglish(text: string): string {
  let out = text;

  // E-mail addresses.
  out = out.replace(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, (_m, local: string, host: string) => {
    const spokenLocal = local.replace(/\./g, " dot ").replace(/\+/g, " plus ").replace(/[_-]+/g, " ");
    return `${spokenLocal} at ${spokenHost(host)}`;
  });

  // Links: with a scheme, with "www.", then bare domains.
  out = out.replace(/\bhttps?:\/\/([^\s/?#]+)([^\s]*)/gi, (_m, host: string, rest: string) => {
    const cleanHost = host.replace(TRAILING, "");
    return sayLink(cleanHost, rest + host.slice(cleanHost.length));
  });
  out = out.replace(/\bwww\.([a-z0-9-]+(?:\.[a-z0-9-]+)+)([^\s]*)/gi, (_m, host: string, rest: string) => sayLink(host, rest));
  out = out.replace(new RegExp(`\\b((?:[a-z0-9-]+\\.)+(?:${TLDS}))\\b(/[^\\s]*)?`, "gi"), (_m, host: string, rest: string | undefined) => sayLink(host, rest ?? ""));

  // File names.
  out = out.replace(new RegExp(`\\b([A-Za-z0-9_-]+)\\.(${FILE_EXTENSIONS})\\b`, "gi"), (_m, name: string, ext: string) => `${spaced(name)} dot ${ext}`);

  // Code: a chain of three or more dotted identifiers (two dots at least, each part two letters at least), with its "()".
  out = out.replace(/\b([A-Za-z][A-Za-z0-9_]+(?:\.[A-Za-z][A-Za-z0-9_]+){2,})\b(?:\(\))?/g, (_m, chain: string) =>
    // "Hello.World.This.Is": capitals after the dots mean run-together sentences, not code.
    /\.[A-Z]/.test(chain) ? chain.replace(/\./g, ". ") : spaced(chain.replace(/\./g, " dot ")),
  );
  out = out.replace(/\b([a-z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\(\)/g, (_m, a: string, b: string) => `${spaced(a)} dot ${spaced(b)}`);
  out = out.replace(/\b([A-Za-z][A-Za-z0-9]*)\(\)/g, "$1");
  out = out.replace(/(^|\s)--+(?=[A-Za-z])/g, "$1");
  out = out.replace(/\b([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)\b/g, (_m, id: string) => id.replace(/_/g, " "));

  // A dot with a letter on both sides and no space after it is a missing space: "hello.How are you".
  out = out.replace(/(\p{L}{2,})\.(?=\p{L}{2})/gu, "$1. ");

  return out.replace(/[ \t]{2,}/g, " ").trim();
}
