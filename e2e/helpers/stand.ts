import type { Page, Route } from "@playwright/test";
import type { VoxxyState } from "voxxy";

/** The stand listens here, with no special headers. */
export const PLAIN = "http://localhost:4173/";
/** The same stand served with COOP/COEP, so `crossOriginIsolated` is true. */
export const ISOLATED = "http://localhost:4174/";

export interface StandSnapshot {
  state: VoxxyState;
  /** Lines the stand printed to its log. */
  lines: string[];
  crossOriginIsolated: boolean;
}

/** Opens the stand and waits until its start-up round trip has finished. Returns true if it succeeded. */
export async function openStand(page: Page, url: string = PLAIN): Promise<boolean> {
  await page.goto(url);
  return page.evaluate(() => window.__stand.done);
}

/** Reads state through the stand's `window.__stand` hook, not by scraping the DOM. */
export function readStand(page: Page): Promise<StandSnapshot> {
  return page.evaluate(() => ({
    state: window.__stand.voxxy.getState(),
    lines: window.__stand.lines,
    crossOriginIsolated: window.crossOriginIsolated,
  }));
}

export interface StorageSnapshot {
  cacheNames: string[];
  persisted: boolean | null;
  usage: number | null;
  databases: string[];
}

/** What the browser currently holds for the page's origin. */
export function readStorage(page: Page): Promise<StorageSnapshot> {
  return page.evaluate(async () => ({
    cacheNames: await caches.keys(),
    persisted: (await navigator.storage?.persisted?.()) ?? null,
    usage: (await navigator.storage?.estimate?.())?.usage ?? null,
    databases: ((await indexedDB.databases?.()) ?? []).map((db) => db.name ?? ""),
  }));
}

/** Simulates storage eviction: empties Cache Storage, OPFS and every IndexedDB database of this origin. */
export async function clearBrowserStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const name of await caches.keys()) await caches.delete(name);

    const root = await navigator.storage?.getDirectory?.();
    if (root) {
      for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
        await root.removeEntry(name, { recursive: true });
      }
    }

    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (!db.name) continue;
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(db.name!);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve();
      });
    }
  });
}

/**
 * Cuts the first matching request off partway, like a connection that drops
 * mid-download: the response promises the full length, `afterBytes` arrive,
 * then the socket closes, so reading the body fails. Later matches load normally.
 * Only works for same-origin requests to the stand (it goes through the
 * `/__interrupt` route in apps/stand/serve.mjs). Returns a function that
 * restores normal loading.
 */
export async function interruptRequest(
  page: Page,
  urlPattern: string | RegExp,
  { afterBytes = 1024 }: { afterBytes?: number } = {},
): Promise<() => Promise<void>> {
  let interrupted = false;
  const handler = async (route: Route) => {
    if (interrupted) return route.continue();
    interrupted = true;
    const { origin, pathname, search } = new URL(route.request().url());
    const path = encodeURIComponent(pathname + search);
    await route.continue({ url: `${origin}/__interrupt?path=${path}&after=${afterBytes}` });
  };
  await page.route(urlPattern, handler);
  return () => page.unroute(urlPattern, handler);
}
