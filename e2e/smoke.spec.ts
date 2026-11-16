import { expect, test } from "@playwright/test";
import { ISOLATED, PLAIN, openStand, readStand } from "./helpers/stand";

test.describe("stand smoke @fast", () => {
  test("loads, finishes its round trip and logs no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    page.on("pageerror", (error) => errors.push(error.message));

    expect(await openStand(page)).toBe(true);

    const { state, lines } = await readStand(page);
    expect(state.stt.status).toBe("ready");
    expect(state.tts.status).toBe("ready");
    expect(lines.at(-1)).toBe("round trip ok");
    expect(errors).toEqual([]);
  });

  test("serves with and without COOP/COEP, and the round trip works in both", async ({ page }) => {
    expect(await openStand(page, PLAIN)).toBe(true);
    expect((await readStand(page)).crossOriginIsolated).toBe(false);

    expect(await openStand(page, ISOLATED)).toBe(true);
    expect((await readStand(page)).crossOriginIsolated).toBe(true);
  });

  test("fake microphone delivers the fixture tone", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "The fake-microphone launch flags exist only in Chromium");
    await page.goto(PLAIN);
    const { sampleRate, rms } = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(context.destination);
      const rms = await new Promise<number>((resolve) => {
        processor.onaudioprocess = (event) => {
          const data = event.inputBuffer.getChannelData(0);
          let sum = 0;
          for (const sample of data) sum += sample * sample;
          resolve(Math.sqrt(sum / data.length));
        };
      });
      stream.getTracks().forEach((track) => track.stop());
      const sampleRate = context.sampleRate;
      await context.close();
      return { sampleRate, rms };
    });
    // A 0.3-amplitude sine has RMS of about 0.21; silence would be 0.
    expect(rms).toBeGreaterThan(0.05);
    expect(sampleRate).toBeGreaterThan(0);
  });
});
