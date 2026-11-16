import type { Player } from "../pcm.js";
import type { TtsProvider } from "../provider.js";
import { fakePlayer } from "../testing.js";
import { workerTts } from "../worker-providers.js";

export interface DummyTtsOptions {
  /** See `dummyStt`. Serves `tts.bin` (200000 bytes). */
  files?: boolean;
  baseUrl?: string;
  /** Default: a fake that "plays" 10 times faster than real time. */
  player?: Player;
  maxAhead?: number;
  workerUrl?: string | URL;
  wasmBaseUrl?: string;
}

function spawn(workerUrl?: string | URL): Worker {
  if (workerUrl) return new Worker(workerUrl, { type: "module" });
  return new Worker(new URL("./dummy.worker.js", import.meta.url), { type: "module" });
}

/** Test provider: no model, fake load, speaks a 220 Hz tone, 50 ms per character. Runs in its own worker. */
export function dummyTts({ files = false, baseUrl = "/dummy-models/", player, maxAhead, workerUrl, wasmBaseUrl }: DummyTtsOptions = {}): TtsProvider {
  return workerTts({
    id: "dummy",
    spawn,
    workerUrl,
    wasmBaseUrl,
    maxAhead,
    player: player ?? fakePlayer(),
    ...(files ? { downloadSize: 200_000, files: [{ url: `${baseUrl}tts.bin`, size: 200_000 }] } : {}),
  });
}
