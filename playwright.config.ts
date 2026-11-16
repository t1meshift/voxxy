import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const fixture = fileURLToPath(new URL("./e2e/fixtures/tone-440hz-16k-mono.wav", import.meta.url));

// Set PW_CHROMIUM_CHANNEL=chrome to use an installed Google Chrome instead of
// Playwright's own Chromium download (see TESTING.md).
const channel = process.env.PW_CHROMIUM_CHANNEL || undefined;

export default defineConfig({
  testDir: "e2e",
  // Default run is the quick one. An explicit `--grep` (`pnpm test:e2e:models`) replaces it instead of narrowing it.
  grep: process.argv.some((arg) => arg.startsWith("--grep")) ? undefined : /@fast/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    // Builds the site (4175) and the stand, plain (4173) and with COOP/COEP (4174).
    command: "pnpm --filter @voxxy/stand serve",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel,
        permissions: ["microphone"],
        launchOptions: {
          args: [
            // Headless Chromium is muted by Playwright already; this keeps `--headed` runs quiet too.
            ...(process.env.PW_UNMUTE ? [] : ["--mute-audio"]),
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${fixture}`,
          ],
        },
      },
    },
    // Opt-in: `pnpm test:e2e:all-browsers`. No fake-microphone flags exist for these two.
    // Playwright does not mute Firefox. The tests that run the real player turn its volume to zero (`?volume=0`),
    // which works in every browser; this pref is a second layer in case something else makes a sound.
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], launchOptions: { firefoxUserPrefs: process.env.PW_UNMUTE ? {} : { "media.volume_scale": "0.0" } } },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
