import type { Page } from "@playwright/test";

export const LOCAL_LANDING = "http://localhost:4175/voxxy/";
export const MLVOCA = "https://mlvoca.com/api/generate";
export const POLLINATIONS = "https://text.pollinations.ai/openai";

export async function openHostedLanding(page: Page): Promise<void> {
  const hosted = "https://voxxy-test.github.io/voxxy/";
  // Serve the assembled assets locally and let the browser call APIs from a Pages origin.
  await page.route(`${hosted}**`, async (route) => {
    const url = route.request().url().replace(hosted, LOCAL_LANDING);
    await route.fulfill({ response: await route.fetch({ url }) });
  });
  await page.goto(hosted);
}
