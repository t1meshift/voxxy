import { expect, test } from "@playwright/test";
import { openStand, readStand } from "./helpers/stand";

// The dummy providers through the facade in a real browser: their own workers, the speak
// queue, `active` engine info. The unit tests cover the logic; this covers that it runs.

test.describe("providers @fast", () => {
  test("the stand's round trip: active engine info, queue order, stop, and the queue works after a stop", async ({ page }) => {
    expect(await openStand(page)).toBe(true);
    const { lines, state } = await readStand(page);

    expect(lines).toContain("active: stt=worker/local tts=worker/local");
    expect(lines.find((line) => line.startsWith("stt: "))).toMatch(/^stt: dummy transcript: \d+ samples/);
    expect(lines).toContain("tts order: hello world > second > third");
    expect(lines).toContain("stop: AbortError, AbortError");
    expect(lines.at(-1)).toBe("round trip ok");

    // One speak() of a long text starts with its first sentence...
    expect(lines.find((l) => l.startsWith("speak long text"))).toMatch(/first audio before it finished: true/);

    // A reply streamed token by token is spoken sentence by sentence, in order, starting before it is complete...
    expect(lines).toContain(
      "stream sentences: Sure, I can help with that. | First, open the settings page. | Then pick the language you want. | Finally, press save and you are done.",
    );
    expect(lines.find((l) => l.startsWith("stream first audio"))).toMatch(/before the reply finished: true/);
    // ...and cancelling it stops the rest.
    expect(lines).toContain("stream cancel: AbortError, cut short");
    expect(state.stt.active).toMatchObject({ id: "dummy", engine: "worker", locality: "local", reason: null });
  });

  test("the stand shows which engine is in use", async ({ page }) => {
    await openStand(page);
    await expect(page.locator("#active")).toContainText("stt: ready via dummy (worker, local)");
    await expect(page.locator("#active")).toContainText("tts: ready via dummy (worker, local)");
  });

  test("each provider has its own worker, and unloading ends it", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "page.workers() is not verified in WebKit");
    await openStand(page);
    expect(page.workers()).toHaveLength(2);

    await page.evaluate(() => window.__stand.voxxy.unload("tts"));
    await expect.poll(() => page.workers().length).toBe(1);

    await page.evaluate(() => window.__stand.voxxy.dispose());
    await expect.poll(() => page.workers().length).toBe(0);
  });

  test("a provider can be loaded again after unload, with a fresh worker", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "page.workers() is not verified in WebKit");
    await openStand(page);
    await page.evaluate(() => window.__stand.voxxy.unload("tts"));
    await expect.poll(() => page.workers().length).toBe(1);

    await page.evaluate(() => window.__stand.voxxy.load("tts"));
    expect(page.workers()).toHaveLength(2);
    expect(await page.evaluate(() => window.__stand.voxxy.speak("ok").then(() => "spoken"))).toBe("spoken");
  });

  test("speaking before the provider is loaded is refused", async ({ page }) => {
    await openStand(page);
    await page.evaluate(() => window.__stand.voxxy.unload("tts"));
    const error = await page.evaluate(() => window.__stand.voxxy.speak("hi").then(() => null, (e: Error) => e.message));
    expect(error).toBe("No TTS provider is loaded");
  });
});
