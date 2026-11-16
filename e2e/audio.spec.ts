import { expect, test, type Page } from "@playwright/test";
import { openStand } from "./helpers/stand";

// The real microphone recorder (Chromium's fake device plays e2e/fixtures/tone-440hz-16k-mono.wav, a 440 Hz tone)
// and the real WebAudio player, in a browser. Resampling and scheduling logic are unit-tested; this checks they work with real audio.

const REAL_MIC = "/?mic=real";
const REAL_AUDIO = "/?audio=real&volume=0"; // The real player and audio clock, with the output turned to zero.

interface Recorded {
  samples: number;
  hz: number;
  rms: number;
}

/** Records for `ms` with a fresh recorder and describes the audio: length, frequency (zero crossings), level. */
function record(page: Page, ms: number, options: { preferWorklet?: boolean; maxDurationMs?: number } = {}): Promise<Recorded & { limitCalls: number }> {
  return page.evaluate(
    async ([duration, opts]) => {
      let limitCalls = 0;
      const recorder = window.__stand.lib.createMicRecorder({ ...opts, onLimitReached: () => limitCalls++ });
      const recording = await recorder.start();
      await new Promise((resolve) => setTimeout(resolve, duration));
      const pcm = await recording.stop();
      await recorder.dispose();
      let sum = 0;
      for (const sample of pcm) sum += sample * sample;
      // Pitch by autocorrelation: the lag (in samples) at which the signal best matches itself. Unlike counting
      // zero crossings, it is not thrown off by the noise the browser's noise suppression leaves around zero.
      const span = Math.min(pcm.length, 8000);
      const start = Math.max(0, Math.floor((pcm.length - span) / 2));
      let bestLag = 0;
      let best = -Infinity;
      for (let lag = 20; lag <= 120; lag++) {
        let correlation = 0;
        for (let i = start; i < start + span - lag; i++) correlation += pcm[i]! * pcm[i + lag]!;
        if (correlation > best) (best = correlation, (bestLag = lag));
      }
      return { samples: pcm.length, hz: 16000 / bestLag, rms: Math.sqrt(sum / pcm.length), limitCalls };
    },
    [ms, options] as const,
  );
}

test.describe("microphone recorder @fast", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "The fake-microphone launch flags exist only in Chromium");
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("records mono 16 kHz audio of the right length and pitch, whatever rate the device runs at", async ({ page }) => {
    const { samples, hz, rms } = await record(page, 1000);
    expect(samples).toBeGreaterThan(14500); // About one second at 16 kHz (the context itself runs at 44.1 or 48 kHz).
    expect(samples).toBeLessThan(17500);
    expect(hz).toBeGreaterThan(425); // The fixture is 440 Hz: it survived the resampling.
    expect(hz).toBeLessThan(455);
    expect(rms).toBeGreaterThan(0.05);
  });

  test("the ScriptProcessor fallback gives the same audio", async ({ page }) => {
    const { samples, hz } = await record(page, 1000, { preferWorklet: false });
    expect(samples).toBeGreaterThan(11500); // Up to one 4096-frame block is lost at the end.
    expect(samples).toBeLessThan(17500);
    expect(hz).toBeGreaterThan(425);
    expect(hz).toBeLessThan(455);
  });

  test("cuts the recording at the maximum length and says so once", async ({ page }) => {
    const { samples, limitCalls } = await record(page, 1200, { maxDurationMs: 400 });
    expect(samples).toBe(6400);
    expect(limitCalls).toBe(1);
  });

  test("a very short tap is reported as too-short, not returned as an empty buffer", async ({ page }) => {
    const code = await page.evaluate(async () => {
      const recorder = window.__stand.lib.createMicRecorder();
      const recording = await recorder.start();
      return recording.stop().then(
        () => "returned audio",
        (error: { code?: string }) => error.code,
      );
    });
    expect(code).toBe("too-short");
  });

  test("a second recording while one is active is refused, not a second stream", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const recorder = window.__stand.lib.createMicRecorder();
      const first = await recorder.start();
      const second = await recorder.start().then(
        () => "started",
        (error: { code?: string }) => error.code,
      );
      first.cancel();
      const afterwards = await recorder.start().then(
        (handle) => (handle.cancel(), "started"),
        (error: { code?: string }) => error.code,
      );
      return { second, afterwards, owner: window.__stand.lib.microphoneOwner() };
    });
    expect(result).toEqual({ second: "busy", afterwards: "started", owner: null });
  });

  test("releases the microphone when recording ends, so the OS indicator goes away", async ({ page }) => {
    const live = await page.evaluate(async () => {
      const streams: MediaStream[] = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await original(constraints);
        streams.push(stream);
        return stream;
      };
      const recorder = window.__stand.lib.createMicRecorder({ minDurationMs: 0 });
      const recording = await recorder.start();
      const duringRecording = streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length;
      await recording.stop();
      const afterStop = streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length;
      await recorder.dispose();
      return { duringRecording, afterStop };
    });
    expect(live).toEqual({ duringRecording: 1, afterStop: 0 });
  });

  test("push-to-talk through the facade: listen() on the real recorder gives a transcript of what was held", async ({ page }) => {
    await page.goto(REAL_MIC);
    await page.click("#go");
    expect(await page.evaluate(() => window.__stand.done)).toBe(true);
    const line = (await page.evaluate(() => window.__stand.lines)).find((l) => l.startsWith("stt: "));
    const samples = Number(/(\d+) samples/.exec(line ?? "")?.[1]);
    expect(samples).toBeGreaterThan(6000); // Held about 500 ms: about 8000 samples at 16 kHz.
    expect(samples).toBeLessThan(11000);
  });
});

test.describe("web audio player @fast", () => {
  test("the context is locked until the gesture, and the whole round trip then runs on the real player", async ({ page }) => {
    await page.goto(REAL_AUDIO);
    expect(await page.evaluate(() => window.__stand.player!.contextState)).toBeNull(); // Nothing created before a gesture.

    await page.click("#go"); // The click calls voxxy.unlock() first.
    expect(await page.evaluate(() => window.__stand.done)).toBe(true);

    const { lines, state } = await page.evaluate(() => ({ lines: window.__stand.lines, state: window.__stand.player!.contextState }));
    expect(state).toBe("running");
    expect(lines).toContain("tts order: hello world > second > third");
    expect(lines).toContain("stop: AbortError, AbortError");
    expect(lines.at(-1)).toBe("round trip ok");
  });

  test("buffers queued while one plays follow it with no gap, and the player reports its events", async ({ page }) => {
    await page.goto(REAL_AUDIO);
    await page.evaluate(() => {
      const w = window as unknown as { __chunks: Array<{ startTime: number; endTime: number }>; __events: string[] };
      w.__chunks = [];
      w.__events = [];
      const player = window.__stand.player!;
      player.on("started", () => w.__events.push("started"));
      player.on("chunk-finished", (timing) => (w.__chunks.push(timing), w.__events.push("chunk-finished")));
      player.on("drained", () => w.__events.push("drained"));
    });
    await page.click("#go");
    await page.evaluate(() => window.__stand.done);

    const { chunks, events } = await page.evaluate(() => {
      const w = window as unknown as { __chunks: Array<{ startTime: number; endTime: number }>; __events: string[] };
      return { chunks: w.__chunks, events: w.__events };
    });
    // "hello world", "second", "third" were queued together: each starts where the one before ends.
    const seamless = chunks.slice(1).filter((chunk, i) => Math.abs(chunk.startTime - chunks[i]!.endTime) < 1e-6);
    expect(seamless.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toBe("started");
    expect(events).toContain("chunk-finished");
    expect(events).toContain("drained");
  });

  test("reports which silent-switch workaround it used", async ({ page }, testInfo) => {
    await page.goto(REAL_AUDIO);
    await page.click("#go");
    await page.evaluate(() => window.__stand.done);
    const used = await page.evaluate(() => window.__stand.player!.silentSwitchUsed);
    testInfo.annotations.push({ type: "silent-switch workaround", description: String(used) });
    expect([null, "audio-session", "audio-element"]).toContain(used);
  });
});
