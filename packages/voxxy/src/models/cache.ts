import type { FileCache } from "./types.js";

const SIZE_HEADER = "x-voxxy-size";

/**
 * Weights in the Cache API. Chosen over OPFS because:
 * - it works the same in a window and in a worker, so the adapter can read the
 *   files the host's downloader wrote;
 * - `cache.put()` takes a streaming response and stores it all or nothing, which
 *   gives "a partial file never looks finished" for free;
 * - OPFS writing needs `createWritable` (not in Safari before 26) or a sync
 *   access handle (workers only), so it needs more code paths for no gain here.
 * Both are cleared together by the browser's eviction, so neither is safer.
 */
export function createCacheApiFileCache(name = "voxxy-models"): FileCache {
  return {
    async stat(url) {
      const hit = await (await caches.open(name)).match(url);
      const size = hit?.headers.get(SIZE_HEADER);
      return size === null || size === undefined ? null : Number(size);
    },
    async write(url, body, size) {
      const cache = await caches.open(name);
      await cache.put(
        url,
        new Response(body, { headers: { [SIZE_HEADER]: String(size), "content-type": "application/octet-stream" } }),
      );
    },
    async read(url) {
      return (await (await caches.open(name)).match(url)) ?? null;
    },
    async delete(url) {
      await (await caches.open(name)).delete(url);
    },
  };
}

export const hasCacheApi = (): boolean => typeof caches !== "undefined";
