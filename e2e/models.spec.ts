import { expect, test, type Page } from "@playwright/test";
import { clearBrowserStorage, interruptRequest, openStand, readStorage } from "./helpers/stand";

// Real Cache API, localStorage and fetch against the stand's fake model files
// (300000 and 200000 bytes at /dummy-models/). These cover that
// the storage layer works in a browser at all.

const phase = (page: Page, kind: "stt" | "tts") => page.evaluate((k) => window.__stand.voxxy.models.getState()[k].phase, kind);

async function selectDummy(page: Page, kind: "stt" | "tts" = "stt") {
  await page.evaluate((k) => {
    const { voxxy, dummyStt, dummyTts } = window.__stand;
    voxxy.select(k === "stt" ? dummyStt({ files: true }) : dummyTts({ files: true }));
  }, kind);
  await page.waitForFunction((k) => window.__stand.voxxy.models.getState()[k].provider !== null, kind);
}

const waitForPhase = (page: Page, kind: "stt" | "tts", wanted: string) =>
  page.waitForFunction(([k, p]) => window.__stand.voxxy.models.getState()[k as "stt"].phase === p, [kind, wanted], { timeout: 10_000 });

test.describe("model storage @fast", () => {
  test.beforeEach(async ({ page }) => {
    await openStand(page);
    await clearBrowserStorage(page);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await openStand(page);
  });

  test("opt in downloads into Cache Storage and ends ready; consent is not asked again after a reload", async ({ page }) => {
    await selectDummy(page);
    expect(await phase(page, "stt")).toBe("not-opted-in");
    expect(await page.evaluate(() => window.__stand.voxxy.models.getState().stt.downloadSize)).toBe(300_000);

    await page.evaluate(() => window.__stand.voxxy.models.optIn("stt"));
    await waitForPhase(page, "stt", "ready");
    expect((await readStorage(page)).cacheNames).toContain("voxxy-models");

    await page.reload();
    await openStand(page);
    await selectDummy(page);
    await waitForPhase(page, "stt", "ready"); // from the cache and the stored consent, no new opt-in
  });

  test("STT and TTS opt in independently", async ({ page }) => {
    await selectDummy(page, "stt");
    await selectDummy(page, "tts");
    await page.evaluate(() => window.__stand.voxxy.models.optIn("tts"));
    await waitForPhase(page, "tts", "ready");
    expect(await phase(page, "stt")).toBe("not-opted-in");
  });

  test("after eviction the consent survives and the files come back with progress", async ({ page }) => {
    await selectDummy(page);
    await page.evaluate(() => window.__stand.voxxy.models.optIn("stt"));
    await waitForPhase(page, "stt", "ready");

    // The browser drops the cache but not localStorage.
    await page.evaluate(async () => {
      for (const name of await caches.keys()) await caches.delete(name);
    });
    await page.evaluate(() => {
      window.__phases = [];
      window.__stand.voxxy.models.subscribe((s) => window.__phases.push(s.stt.phase));
      return window.__stand.voxxy.models.refresh("stt");
    });
    await waitForPhase(page, "stt", "ready");
    const phases = await page.evaluate(() => window.__phases);
    expect(phases).toContain("evicted-redownloading");
    expect(phases).not.toContain("not-opted-in");
  });

  test("load() without consent is refused; with consent it downloads first and then loads", async ({ page }) => {
    await selectDummy(page);
    const refused = await page.evaluate(() => window.__stand.voxxy.load("stt").then(() => null, (e: Error) => e.name));
    expect(refused).toBe("ModelNotReadyError");

    await page.evaluate(() => window.__stand.voxxy.models.optIn("stt"));
    await page.evaluate(() => window.__stand.voxxy.load("stt"));
    expect(await page.evaluate(() => window.__stand.voxxy.getState().stt.status)).toBe("ready");
  });

  test("an interrupted download ends in error, keeps nothing partial, and retry completes it", async ({ browserName, page }) => {
    test.skip(browserName !== "chromium", "Interruption helper is verified in Chromium only");
    const restore = await interruptRequest(page, "**/dummy-models/stt.bin", { afterBytes: 1000 });
    await selectDummy(page);
    await page.evaluate(() => window.__stand.voxxy.models.optIn("stt"));
    await waitForPhase(page, "stt", "error");
    expect(await page.evaluate(async () => (await caches.has("voxxy-models")) && (await (await caches.open("voxxy-models")).keys()).length)).toBeFalsy();

    await restore();
    await page.evaluate(() => window.__stand.voxxy.models.retry("stt"));
    await waitForPhase(page, "stt", "ready");
  });
});

declare global {
  interface Window {
    __phases: string[];
  }
}
