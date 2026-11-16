import { expect, test } from "@playwright/test";

// Performance on this machine: the stand's "Measure" button. Real weights (about 80 MB), so @models. Prints the JSON.
// Memory is the JS heap of the page here; on an isolated page (port 4174) it would include the workers.

test.describe("measure @models", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Memory numbers come from Chromium");

  test("speed of both engines", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/real.html?volume=0");
    await page.click("#optin");
    await page.waitForFunction(() => (["stt", "tts"] as const).every((k) => window.__real.voxxy.models.getState()[k].phase === "ready"), undefined, { timeout: 5 * 60_000 });
    await page.click("#load");
    await expect(page.locator("#measure")).toBeEnabled({ timeout: 120_000 });
    await page.click("#measure");
    await page.waitForFunction(() => "__measure" in window, undefined, { timeout: 5 * 60_000 });
    const result = await page.evaluate(() => (window as unknown as { __measure: Record<string, unknown> }).__measure);
    console.log(`MEASURE\n${JSON.stringify(result, null, 2)}`);
    expect(errors).toEqual([]);
    expect((result["stt"] as { transcript: string }).transcript.length).toBeGreaterThan(10);
  });
});
