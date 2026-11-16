import type { Kind } from "../types.js";
import type { ConsentRecord, ConsentStore } from "./types.js";

const keyOf = (kind: Kind, adapterId: string) => `voxxy:consent:${kind}:${adapterId}`;

/** Keeps consent in memory only. Used as the fallback, and handy in tests. */
export function createMemoryConsentStore(): ConsentStore {
  const records = new Map<string, ConsentRecord>();
  return {
    async get(kind, adapterId) {
      return records.get(keyOf(kind, adapterId)) ?? null;
    },
    async set(kind, adapterId, record) {
      records.set(keyOf(kind, adapterId), record);
    },
    async clear(kind, adapterId) {
      records.delete(keyOf(kind, adapterId));
    },
  };
}

/**
 * Consent in localStorage, a place separate from the Cache API where the weights
 * live. Consent is per kind *and* adapter: a different model has a different
 * size, so the earlier "yes" does not cover it. Falls back to memory where
 * localStorage is missing or throws (some private modes), in which case consent
 * lasts until the page closes.
 */
export function createLocalStorageConsentStore(): ConsentStore {
  const fallback = createMemoryConsentStore();
  const storage = (): Storage | null => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    async get(kind, adapterId) {
      const local = storage();
      if (!local) return fallback.get(kind, adapterId);
      try {
        const raw = local.getItem(keyOf(kind, adapterId));
        if (raw) return JSON.parse(raw) as ConsentRecord;
      } catch {
        // Unreadable or corrupt: treat as no consent, not as a crash.
      }
      // The memory copy exists only if an earlier write to localStorage failed.
      return fallback.get(kind, adapterId);
    },
    async set(kind, adapterId, record) {
      try {
        const local = storage();
        if (!local) throw new Error("no localStorage");
        local.setItem(keyOf(kind, adapterId), JSON.stringify(record));
      } catch {
        // Missing, quota or private mode: keep it for this page's lifetime.
        await fallback.set(kind, adapterId, record);
      }
    },
    async clear(kind, adapterId) {
      try {
        storage()?.removeItem(keyOf(kind, adapterId));
      } catch {
        // Nothing to do.
      }
      await fallback.clear(kind, adapterId);
    },
  };
}
