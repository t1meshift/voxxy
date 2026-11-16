import { describe, expect, it } from "vitest";
import type { SpeakOptions } from "./provider.js";
import { createSpeakStream, stripMarkdown, type Speaker } from "./speak-stream.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A speaker whose utterances end when the test says so, in order, like a queueing provider. */
function fakeSpeaker() {
  const spoken: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const gates: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  let live = 0;
  let peak = 0;
  let stopped = 0;
  const speaker: Speaker = {
    speak(text: string, options?: SpeakOptions) {
      spoken.push(text);
      signals.push(options?.signal);
      live++;
      peak = Math.max(peak, live);
      return new Promise<void>((resolve, reject) => {
        gates.push({ resolve: () => (live--, resolve()), reject: (error) => (live--, reject(error)) });
        options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      });
    },
    stop() {
      stopped++;
    },
  };
  return {
    speaker,
    spoken,
    signals,
    finish: (index = spoken.length - 1) => gates[index]!.resolve(),
    failWith: (error: unknown, index = spoken.length - 1) => gates[index]!.reject(error),
    peak: () => peak,
    stopped: () => stopped,
  };
}

describe("speak stream", () => {
  it("speaks each sentence as soon as it is complete, in order, while text is still arriving", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker, { minChars: 0 });
    await stream.push("The first sentence. The sec");
    await stream.push("ond one is longer! And a ");
    await tick();
    expect(fake.spoken).toEqual(["The first sentence.", "The second one is longer!"]);
    await stream.push("third.");
    fake.finish(0);
    await tick();
    fake.finish(1);
    const ended = stream.end();
    await tick();
    expect(fake.spoken).toEqual(["The first sentence.", "The second one is longer!", "And a third."]);
    fake.finish(2);
    await expect(ended).resolves.toBeUndefined();
  });

  it("end() resolves only when everything has finished playing", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker);
    await stream.push("One sentence only, to be spoken.");
    let done = false;
    const ended = stream.end().then(() => (done = true));
    await tick();
    expect(fake.spoken).toEqual(["One sentence only, to be spoken."]);
    expect(done).toBe(false);
    fake.finish(0);
    await ended;
    expect(done).toBe(true);
  });

  it("keeps at most maxInFlight sentences with the provider", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker, { maxInFlight: 2, minChars: 0 });
    await stream.push("One. Two. Three. Four. Five. ");
    await tick();
    expect(fake.spoken).toEqual(["One.", "Two."]);

    fake.finish(0);
    await tick();
    expect(fake.spoken).toEqual(["One.", "Two.", "Three."]);

    const ended = stream.end();
    for (let i = 1; i < 5; i++) {
      await tick();
      fake.finish(i);
    }
    await ended;
    expect(fake.spoken).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
    expect(fake.peak()).toBe(2);
  });

  it("makes push() wait while many sentences are already waiting, so a fast text source cannot run far ahead", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker, { maxInFlight: 1, maxPending: 2, minChars: 0 });
    await stream.push("Alpha. Bravo. Charlie. ");
    await tick();
    expect(fake.spoken).toEqual(["Alpha."]); // Bravo and Charlie are pending: the limit.

    let released = false;
    const blocked = stream.push("Delta. Echo. ").then(() => (released = true));
    await tick();
    expect(released).toBe(false);

    fake.finish(0);
    await tick();
    fake.finish(1);
    await blocked;
    expect(released).toBe(true);
  });

  it("cancel() clears what is waiting, stops the provider, and makes end() reject with an AbortError", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker, { minChars: 0 });
    await stream.push("One. Two. Three. Four. ");
    await tick();
    const ended = stream.end();
    stream.cancel();
    await expect(ended).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.stopped()).toBe(1);
    expect(fake.signals.every((s) => s?.aborted)).toBe(true);
    await tick();
    expect(fake.spoken).toEqual(["One.", "Two."]); // Three and Four were never handed over.
    await expect(stream.push("More.")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancel() releases a push() that was waiting", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker, { maxInFlight: 1, maxPending: 1, minChars: 0 });
    await stream.push("Alpha. Bravo. ");
    const blocked = stream.push("Charlie. Delta. ").then(() => "released");
    await tick();
    stream.cancel();
    await expect(blocked).resolves.toBe("released");
  });

  it("follows an abort signal passed in the options", async () => {
    const fake = fakeSpeaker();
    const controller = new AbortController();
    const stream = createSpeakStream(fake.speaker, { signal: controller.signal });
    await stream.push("Some words to say, please. ");
    controller.abort();
    await expect(stream.end()).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.stopped()).toBe(1);
  });

  it("a provider error ends the stream with that error and stops sending", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker, { maxInFlight: 1, minChars: 0 });
    await stream.push("One. Two. Three. ");
    await tick();
    fake.failWith(new Error("audio device lost"));
    await tick();
    await expect(stream.end()).rejects.toThrow("audio device lost");
    expect(fake.spoken).toEqual(["One."]);
    await expect(stream.push("More. ")).rejects.toThrow("audio device lost");
  });

  it("strips Markdown before speaking and skips sentences with nothing to say", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker, { minChars: 0 });
    await stream.push("**Important:** use `pnpm test`. ---\n- see [the docs](https://example.com/x).\n***\n");
    await tick();
    const ended = stream.end();
    await tick();
    expect(fake.spoken).toEqual(["Important: use pnpm test.", "see the docs."]);
    fake.finish(0);
    fake.finish(1);
    await ended;
  });

  it("can be given another normaliser, and an empty result is skipped", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker, { minChars: 0, normalize: (s) => (s.startsWith("skip") ? "" : s.toUpperCase()) });
    await stream.push("skip this one. Say this one. ");
    await tick();
    const ended = stream.end();
    await tick();
    expect(fake.spoken).toEqual(["SAY THIS ONE."]);
    fake.finish(0);
    await ended;
  });

  it("end() with nothing pushed resolves, and pushing after end is an error", async () => {
    const fake = fakeSpeaker();
    const stream = createSpeakStream(fake.speaker);
    await expect(stream.end()).resolves.toBeUndefined();
    await expect(stream.push("late")).rejects.toThrow("ended");
    expect(fake.spoken).toEqual([]);
  });
});

describe("markdown stripping", () => {
  it.each([
    ["**bold** and _italic_ text", "bold and italic text"],
    ["Use `code` here", "Use code here"],
    ["## A heading", "A heading"],
    ["- a list item", "a list item"],
    ["3. numbered item", "numbered item"],
    ["[a link](https://example.com)", "a link"],
    ["snake_case_name stays", "snake_case_name stays"],
    ["2 * 3 = 6", "2 * 3 = 6"],
  ])("%s", (input, expected) => expect(stripMarkdown(input)).toBe(expected));
});
