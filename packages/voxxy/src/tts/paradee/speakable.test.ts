import { describe, expect, it } from "vitest";
import { speakableEnglish } from "./speakable.js";

describe("speakableEnglish", () => {
  it.each([
    // Links
    ["See https://example.com/path/to/some/very/long/resource.html?query=1&other=2 for details.", "See a link to example dot com for details."],
    ["Open https://www.example.org/docs now.", "Open a link to example dot org now."],
    ["Go to https://example.com.", "Go to example dot com."],
    ["Go to https://example.com/.", "Go to example dot com."],
    ["Open www.example.org/docs now.", "Open a link to example dot org now."],
    ["Visit example.com for details.", "Visit example dot com for details."],
    ["Visit example.com/pricing (it is cheap).", "Visit a link to example dot com (it is cheap)."],
    ["The site (docs.example.io), or the other one.", "The site (docs dot example dot io), or the other one."],
    // Addresses
    ["Write to first.last@example.co.uk today.", "Write to first dot last at example dot co dot uk today."],
    ["Mail john_doe+news@mail.example.com now", "Mail john doe plus news at mail dot example dot com now"],
    // Files
    ["The file is report_final_v2.pdf in the folder.", "The file is report final v2 dot pdf in the folder."],
    ["Edit Next.js and node.js files, or main.py.", "Edit Next dot js and node dot js files, or main dot py."],
    // Code
    ["Run foo.bar.baz() and then npm install --save-dev.", "Run foo dot bar dot baz and then npm install save-dev."],
    ["Call user.getName() first.", "Call user dot getName first."],
    ["Use the snake_case_name variable.", "Use the snake case name variable."],
    ["Call init() once.", "Call init once."],
  ])("%s", (input, expected) => expect(speakableEnglish(input)).toBe(expected));

  it("reads a dot between words with no space after it as a missing space, not as 'dot'", () => {
    expect(speakableEnglish("hello.How are you")).toBe("hello. How are you");
    expect(speakableEnglish("Mr.Smith left.")).toBe("Mr. Smith left.");
    expect(speakableEnglish("Hello.World.This.Is.Joined.Text")).toBe("Hello. World. This. Is. Joined. Text");
  });

  it.each([
    "The U.S.A. and the U.K. agreed.",
    "Meet at 5 p.m. on Tuesday, e.g. in room 3.5.",
    "It costs $1,234.56 and weighs 3.14 kilos.",
    "Dr. Smith went home. Then he slept.",
    "Plain text with a well-known idea.",
    "Ver. 2.0 is out.",
  ])("leaves ordinary text alone: %s", (text) => expect(speakableEnglish(text)).toBe(text));

  it("does not crash on empty, odd or very long input", () => {
    expect(speakableEnglish("")).toBe("");
    expect(speakableEnglish("...")).toBe("...");
    expect(speakableEnglish("@@@ ::: ///")).toBe("@@@ ::: ///");
    expect(speakableEnglish("a.".repeat(5000)).length).toBeGreaterThan(0);
    expect(speakableEnglish(`https://${"a".repeat(2000)}.com/${"b".repeat(2000)}`)).toContain("a link to");
  });
});
