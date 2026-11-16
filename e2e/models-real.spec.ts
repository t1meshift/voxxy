import { expect, test } from "@playwright/test";

// Real weights from Hugging Face, GitHub and jsDelivr (about 50 MB over the wire). Slow and needs the network, so it
// carries @models and runs only on request: pnpm test:e2e:models. Chromium only: wire sizes come from the DevTools protocol.

test.describe("real engines @models", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Wire sizes are read through the Chrome DevTools protocol");

  test("download, load, speak a sentence, transcribe a clip", async ({ page, context }, testInfo) => {
    test.setTimeout(10 * 60_000);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const urls = new Map<string, string>();
    const wire = new Map<string, number>();
    cdp.on("Network.responseReceived", ({ requestId, response }) => void urls.set(requestId, new URL(response.url).host));
    cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
      const host = urls.get(requestId);
      if (host) wire.set(host, (wire.get(host) ?? 0) + encodedDataLength);
    });

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/real.html?volume=0");

    // Consent and download, in the background.
    const downloadStart = Date.now();
    await page.click("#optin");
    await page.waitForFunction(() => (["stt", "tts"] as const).every((k) => window.__real.voxxy.models.getState()[k].phase === "ready"), undefined, { timeout: 5 * 60_000 });
    const downloadMs = Date.now() - downloadStart;
    const sizes = await page.evaluate(() => ({
      stt: window.__real.voxxy.models.getState().stt.downloadSize,
      tts: window.__real.voxxy.models.getState().tts.downloadSize,
    }));

    await page.click("#load");
    await expect(page.locator("#speak")).toBeEnabled({ timeout: 120_000 });
    const active = await page.evaluate(() => window.__real.voxxy.getState());
    expect(active.stt.active).toMatchObject({ engine: "worker", locality: "local" });
    expect(active.tts.active).toMatchObject({ engine: "worker", locality: "local" });

    await page.click("#speak");
    await page.waitForFunction(() => "speakMs" in window.__real.metrics, undefined, { timeout: 60_000 });
    await page.click("#clip");
    await page.waitForFunction(() => "transcript" in window.__real.metrics, undefined, { timeout: 60_000 });

    await page.click("#stream");
    await page.waitForFunction(() => "speakWholeReplyFirstAudioMs" in window.__real.metrics, undefined, { timeout: 120_000 });

    // Your own text, cut into chunks two ways: packing several sentences into a chunk means fewer chunks.
    const speakWith = async (chunking: string) => {
      await page.selectOption("#chunking", chunking);
      await page.waitForFunction(() => window.__real.voxxy.getState().tts.status === "ready");
      await page.fill("#text", "Open the settings page. Look for the language section. Pick the language you want. If it is not there, add it with the plus button. Then press save. The change takes effect the next time you open the app.");
      await page.evaluate(() => (document.getElementById("speakInfo")!.textContent = ""));
      await page.click("#speakText");
      await page.waitForFunction(() => /chunks\./.test(document.getElementById("speakInfo")!.textContent ?? ""), undefined, { timeout: 60_000 });
      return Number(/in (\d+) chunks/.exec((await page.textContent("#speakInfo"))!)?.[1]);
    };
    const chunksOneByOne = await speakWith("sentences");
    const chunksPacked = await speakWith("big");
    console.log(`[real engines] chunks for the same text: one sentence at a time ${chunksOneByOne}, packed ${chunksPacked}`);
    expect(chunksOneByOne).toBeGreaterThan(1);
    expect(chunksPacked).toBeLessThan(chunksOneByOne);

    // The log shows one line per chunk.
    expect((await page.textContent("#chunkLog"))!.trim().split("\n")).toHaveLength(chunksPacked);

    // Push to talk on the (fake) microphone: held for a moment, it gives a result, not an error.
    await page.selectOption("#source", "mic");
    await page.waitForFunction(() => window.__real.voxxy.getState().stt.status === "ready");
    await page.locator("#talk").scrollIntoViewIfNeeded();
    const talk = (await page.locator("#talk").boundingBox())!;
    await page.mouse.move(talk.x + talk.width / 2, talk.y + talk.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await page.waitForFunction(() => /held \d+ ms/.test(document.getElementById("heard")!.textContent ?? ""), undefined, { timeout: 30_000 });

    const metrics = await page.evaluate(() => window.__real.metrics);
    const wireTotal = [...wire.values()].reduce((a, b) => a + b, 0);
    const report = {
      declaredDownloadBytes: sizes,
      wireBytesByHost: Object.fromEntries(wire),
      wireBytesTotal: wireTotal,
      downloadAndVerifyMs: downloadMs,
      ...metrics,
    };
    console.log(`[real engines] ${JSON.stringify(report, null, 2)}`);
    testInfo.annotations.push({ type: "report", description: JSON.stringify(report) });

    expect(String(metrics.transcript).toLowerCase()).toMatch(/not what your country can do for you/);
    expect(Number(metrics.timeToFirstAudioMs)).toBeGreaterThan(0);
    // Streaming starts the voice long before the reply is complete; speaking the finished reply cannot.
    expect(Number(metrics.streamedFirstAudioMs)).toBeLessThan(Number(metrics.replyCompleteMs));
    expect(Number(metrics.streamedFirstAudioMs)).toBeLessThan(Number(metrics.speakWholeReplyFirstAudioMs));
    expect(errors).toEqual([]);
  });
});
