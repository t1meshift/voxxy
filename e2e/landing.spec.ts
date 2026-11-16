import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { LOCAL_LANDING, MLVOCA, openHostedLanding, POLLINATIONS } from "./helpers/landing";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": "content-type",
};

test("speech engine selection uses the chosen browser mode and updates privacy @fast", async ({ page }) => {
  await page.addInitScript(() => {
    Math.random = () => 0; // mlvoca first
    let installed = false;
    class Recognition extends EventTarget {
      static async available() { return installed ? "available" : "downloadable"; }
      static async install() { installed = true; return true; }
      #local = false;
      get processLocally() { return this.#local; }
      set processLocally(local: boolean) { this.#local = local; }
      start() {
        document.documentElement.dataset.recognitionMode = this.#local ? "local" : "online";
        this.dispatchEvent(new Event("audiostart"));
        if (document.documentElement.dataset.speechTimeout) {
          this.dispatchEvent(Object.assign(new Event("error"), { error: "no-speech" }));
        }
      }
      stop() {
        this.dispatchEvent(Object.assign(new Event("result"), {
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: "Hello from the microphone." } }],
        }));
        this.dispatchEvent(new Event("end"));
      }
      abort() {}
    }
    class Utterance {
      voice?: { voiceURI: string };
      onend?: () => void;
    }
    const synthesis = Object.assign(new EventTarget(), {
      getVoices() {
        const online = { lang: "en-US", voiceURI: "online", localService: false, default: true };
        const local = { lang: "en-US", voiceURI: "local", localService: true, default: false };
        return document.documentElement.dataset.onlineVoicesOnly ? [online] : [online, local];
      },
      speak(utterance: Utterance) {
        document.documentElement.dataset.playbackMode = utterance.voice?.voiceURI;
        queueMicrotask(() => utterance.onend?.());
      },
      cancel() {},
    });
    Object.defineProperties(globalThis, {
      SpeechRecognition: { value: Recognition },
      SpeechSynthesisUtterance: { value: Utterance },
      speechSynthesis: { value: synthesis },
    });
  });
  await page.route(MLVOCA, (route) => route.fulfill({
    headers: cors,
    body: '{"response":"Hello from the chat.","done":true}',
  }));

  await page.goto(LOCAL_LANDING);
  await page.getByText("Speech engines", { exact: true }).click();
  const recognition = page.getByRole("combobox", { name: "Recognition" });
  const playback = page.getByRole("combobox", { name: "Playback" });
  await expect(recognition).toHaveValue("worker");
  await expect(playback).toHaveValue("worker");

  for (const mode of ["local", "cloud"] as const) {
    await recognition.selectOption(mode);
    await playback.selectOption(mode);
    await expect(page.locator("#chat-privacy")).toContainText(mode === "local"
      ? "Microphone audio stays on your device."
      : "Online recognition may send microphone audio");
    await expect(page.locator("#playback-privacy")).toBeVisible({ visible: mode === "cloud" });

    await page.getByRole("button", { name: mode === "local" ? "Install English speech pack" : "Enable mic", exact: true }).click();
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await expect(page.locator("#voice-note")).toContainText("Listening in English");
    await expect(recognition).toBeDisabled();
    await expect(page.locator("#mic .mic-signal")).toBeHidden();
    await page.getByRole("button", { name: "Stop recording" }).click();
    await expect(page.getByRole("textbox", { name: "Your message" })).toHaveValue("Hello from the microphone.");

    await page.getByRole("button", { name: "Enable audio", exact: true }).click();
    await expect(page.getByRole("button", { name: "Spoken replies", pressed: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("#chat-status")).toHaveText("Reply complete.");
    await expect(page.locator("html")).toHaveAttribute("data-recognition-mode", mode === "local" ? "local" : "online");
    await expect(page.locator("html")).toHaveAttribute("data-playback-mode", mode === "local" ? "local" : "online");
  }

  await page.locator("html").evaluate((root) => { root.dataset.speechTimeout = "true"; });
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.locator("#voice-note")).toContainText("Browser recognition returned no text", { timeout: 2500 });
  await expect(page.getByRole("button", { name: "Record", exact: true })).toBeEnabled();

  await page.locator("html").evaluate((root) => { root.dataset.onlineVoicesOnly = "true"; });
  await playback.selectOption("local");
  await expect(page.locator("#tts-engine-note")).toContainText("No local browser voice");
  await expect(page.getByRole("button", { name: "Audio unavailable" })).toBeDisabled();
});

test("the quickstart copies complete HTML and opens the same examples @fast", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => sessionStorage.setItem("clipboard", text) },
    });
  });
  await page.goto(LOCAL_LANDING + "#api");

  for (const [button, file, exampleControl] of [
    ["Speak text", "speak.html", "#speak"],
    ["Transcribe speech", "transcribe.html", "#mic"],
  ] as const) {
    await page.getByRole("button", { name: button, exact: true }).click();
    const source = await readFile(new URL(`../apps/landing/examples/${file}`, import.meta.url), "utf8");
    expect(await page.locator("#example-source").textContent()).toBe(source);
    await page.getByRole("button", { name: "Copy HTML" }).click();
    await expect(page.locator("#copy-status")).toHaveText("Copied.");
    expect(await page.evaluate(() => sessionStorage.getItem("clipboard"))).toBe(source);

    const [example] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: "Run example" }).click(),
    ]);
    await expect(example).toHaveURL(LOCAL_LANDING + "examples/" + file);
    await expect.poll(() => example.locator(exampleControl).evaluate((element) => typeof (element as HTMLButtonElement).onclick)).toBe("function");
    await example.close();
  }

  const archive = await page.request.get(LOCAL_LANDING + "voxxy.tgz");
  expect(archive.ok()).toBe(true);
  expect((await archive.body()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
});

test("the chat retries after a rate limit and retains successful turns @fast", async ({ page }) => {
  await page.addInitScript(() => { Math.random = () => 0; }); // mlvoca first
  const prompts: string[] = [];
  const requests: string[] = [];

  await page.route(MLVOCA, async (route) => {
    requests.push("mlvoca");
    prompts.push(route.request().postDataJSON().prompt);
    if (prompts.length === 1) {
      await route.fulfill({ status: 429, headers: cors });
      return;
    }
    await route.fulfill({
      headers: cors,
      contentType: "application/x-ndjson",
      body: '{"response":"Here is an example.","done":false}\n{"done":true}',
    });
  });
  await page.route(POLLINATIONS, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    requests.push("Pollinations");
    await route.fulfill({
      headers: cors,
      contentType: "text/event-stream",
      body: [
        'data: {"choices":[{"delta":{"reasoning":"Internal reasoning"}}]}',
        'data: {"choices":[{"delta":{"content":"An echo reflects sound."}}]}',
        "data: [DONE]",
      ].join("\n\n"),
    });
  });

  await page.goto(LOCAL_LANDING);
  const conversation = page.getByRole("region", { name: "Conversation" });
  await expect(page.getByRole("link", { name: "mlvoca" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pollinations" })).toBeVisible();
  await expect(page.getByRole("link", { name: /test stand/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Why do we hear echoes?" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(conversation.locator('[data-role="assistant"] p')).toHaveText("An echo reflects sound.");
  await expect(page.locator("#chat-status")).toHaveText("Reply complete.");

  const input = page.getByRole("textbox", { name: "Your message" });
  await input.fill("Can you give an example?");
  await input.press("Enter");
  await expect(conversation.locator('[data-role="assistant"] p')).toHaveText(["An echo reflects sound.", "Here is an example."]);
  expect(requests).toEqual(["mlvoca", "Pollinations", "mlvoca"]);
  expect(prompts[1]).toContain("User: Why do we hear echoes?\nAssistant: An echo reflects sound.\nUser: Can you give an example?");

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(conversation.locator('[data-role="assistant"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Why do we hear echoes?" })).toBeVisible();
});

test("the Pages chat replaces interrupted output and replies when both services fail @fast", async ({ page }) => {
  await page.addInitScript(() => { Math.random = () => 0.99; }); // Pollinations first
  const requests: string[] = [];
  let mlvocaPrompt = "";
  await page.route(POLLINATIONS, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    requests.push("Pollinations");
    await route.fulfill({
      headers: cors,
      contentType: "text/event-stream",
      body: 'data: {"choices":[{"delta":{"content":"An unfinished answer."}}]}\n\n',
    });
  });
  await page.route(MLVOCA, async (route) => {
    requests.push("mlvoca");
    mlvocaPrompt = route.request().postDataJSON().prompt;
    if (requests.length === 2) {
      await route.fulfill({ status: 503, headers: cors });
      return;
    }
    await route.fulfill({
      headers: cors,
      contentType: "application/x-ndjson",
      body: '{"response":"Here is the actual answer.","done":true}',
    });
  });

  await openHostedLanding(page);
  await page.getByRole("button", { name: "Why do we hear echoes?" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const answers = page.locator('[data-role="assistant"] p');
  await expect(answers).toHaveText(/free AI services couldn’t respond/);
  await expect(page.locator("#chat-status")).toHaveText("Chat services unavailable.");

  const input = page.getByRole("textbox", { name: "Your message" });
  await input.fill("What is reverberation?");
  await input.press("Enter");
  await expect(answers).toHaveText([/free AI services couldn’t respond/, "Here is the actual answer."]);
  await expect(page.locator("#chat-status")).toHaveText("Reply complete.");
  expect(requests).toEqual(["Pollinations", "mlvoca", "Pollinations", "mlvoca"]);
  expect(mlvocaPrompt).toBe("What is reverberation?");
});

test("the API reference is built, linked from the page, and fits a phone @fast", async ({ page }) => {
  await page.goto(LOCAL_LANDING);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reference" }).click();
  await expect(page).toHaveURL(LOCAL_LANDING + "api/");
  await expect(page.getByRole("heading", { name: "Reference", level: 1 })).toBeVisible();

  // A symbol page: the entry point is documented and its type links to the type's own section.
  await page.getByRole("link", { name: "createVoxxy" }).first().click();
  await expect(page).toHaveURL(/api\/voxxy\.html#createVoxxy$/);
  const entry = page.locator("#createVoxxy");
  await expect(entry).toContainText("Creates the handle a page talks to");
  await entry.getByRole("link", { name: "Voxxy", exact: true }).click();
  await expect(page).toHaveURL(/api\/voxxy\.html#Voxxy$/);
  await expect(page.locator("#Voxxy")).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
