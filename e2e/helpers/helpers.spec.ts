import { expect, test } from "@playwright/test";
import { clearBrowserStorage, interruptRequest, openStand, readStorage } from "./stand";

// These check the test helpers themselves, so later tasks can rely on them.
test.describe("e2e helpers @fast", () => {
  test("clearBrowserStorage empties Cache Storage, OPFS and IndexedDB", async ({ page }) => {
    await openStand(page);
    await page.evaluate(async () => {
      await (await caches.open("voxxy-test")).put("/x", new Response("x"));
      const root = await navigator.storage.getDirectory();
      await root.getFileHandle("model.bin", { create: true });
      await new Promise<void>((resolve) => {
        const request = indexedDB.open("voxxy-test");
        request.onsuccess = () => (request.result.close(), resolve());
      });
    });
    expect((await readStorage(page)).cacheNames).toContain("voxxy-test");
    expect((await readStorage(page)).databases).toContain("voxxy-test");

    await clearBrowserStorage(page);

    const after = await readStorage(page);
    expect(after.cacheNames).toEqual([]);
    expect(after.databases).toEqual([]);
    expect(await page.evaluate(async () => (await (await navigator.storage.getDirectory()).entries().next()).done)).toBe(true);
  });

  test("interruptRequest makes a download fail partway, once", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Content-length mismatch handling is verified in Chromium only");
    await openStand(page);
    const restore = await interruptRequest(page, "**/index.html", { afterBytes: 20 });

    const firstFailed = await page.evaluate(() =>
      fetch("/index.html").then((r) => r.text()).then(() => false, () => true),
    );
    const secondText = await page.evaluate(() => fetch("/index.html").then((r) => r.text()));

    expect(firstFailed).toBe(true);
    expect(secondText).toContain("voxxy stand");
    await restore();
  });
});
