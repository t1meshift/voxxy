import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { LOCAL_LANDING, MLVOCA, openHostedLanding, POLLINATIONS } from "./helpers/landing";

const fixture = fileURLToPath(new URL("../apps/stand/public/jfk-16k-mono.wav", import.meta.url));

test.use({
  launchOptions: {
    args: [
      ...(process.env.PW_UNMUTE ? [] : ["--mute-audio"]),
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${fixture}`,
    ],
  },
});

test("records speech, gets a live reply and plays it locally @live-chat", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Requires Chromium's file-backed microphone");
  test.setTimeout(6 * 60_000);

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Math.random = () => 0; // mlvoca first
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      start.apply(this, args);
      if (this.buffer?.length) document.documentElement.dataset.playedReply = "true";
    };
  });
  await page.goto(LOCAL_LANDING);

  await page.getByRole("button", { name: /Enable mic/ }).click();
  const record = page.getByRole("button", { name: "Record", exact: true });
  await expect(record).toBeEnabled({ timeout: 150_000 });

  await page.getByRole("button", { name: /Enable audio/ }).click();
  await expect(page.getByRole("button", { name: "Spoken replies", pressed: true })).toBeEnabled({ timeout: 150_000 });

  const signal = page.locator("#mic .mic-signal");
  await expect(signal).toBeHidden();
  await record.click();
  await expect(signal).toBeVisible();
  await Promise.all([
    page.waitForTimeout(8_500), // Record enough of the 11-second fixture for the quoted phrase.
    expect.poll(() => signal.locator("path").first().evaluate((bar) => Number(getComputedStyle(bar).strokeOpacity))).toBeGreaterThan(0.24),
  ]);
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(signal).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Your message" })).toHaveValue(/what your country can do for you/i, { timeout: 30_000 });

  const response = page.waitForResponse((reply) => reply.url() === MLVOCA && reply.request().method() === "POST", { timeout: 120_000 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.locator('[data-role="assistant"] p')).toContainText(/\S/, { timeout: 120_000 });
  await expect(page.locator("html")).toHaveAttribute("data-played-reply", "true", { timeout: 60_000 });
  await expect(page.locator("#chat-status")).toHaveText("Reply complete.", { timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("GitHub Pages origin receives an anonymous Pollinations reply @live-chat", async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => { Math.random = () => 0.99; }); // Pollinations first
  await openHostedLanding(page);
  const prompt = `Ignore test ID ${randomUUID()}. In one sentence, why do we hear echoes?`;
  await page.getByRole("textbox", { name: "Your message" }).fill(prompt);
  const response = page.waitForResponse((reply) => reply.url() === POLLINATIONS && reply.request().method() === "POST", { timeout: 120_000 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.locator('[data-role="assistant"] p')).toContainText(/\S/, { timeout: 120_000 });
  await expect(page.locator("#chat-status")).toHaveText("Reply complete.", { timeout: 120_000 });
});
