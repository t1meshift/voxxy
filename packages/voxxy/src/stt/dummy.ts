import type { Recorder } from "../pcm.js";
import type { SttProvider } from "../provider.js";
import { fakeRecorder } from "../testing.js";
import { workerStt } from "../worker-providers.js";

export interface DummySttOptions {
  /**
   * Also declare a downloadable file, so the consent, download and eviction paths can be
   * exercised. Needs `baseUrl` to serve `stt.bin` (300000 bytes); the stand does this at
   * /dummy-models/. Default false: no download, no consent.
   */
  files?: boolean;
  baseUrl?: string;
  /** Default: a fake that records silence. */
  recorder?: Recorder;
  workerUrl?: string | URL;
  wasmBaseUrl?: string;
}

function spawn(workerUrl?: string | URL): Worker {
  // The literal `new Worker(new URL(..., import.meta.url))` form is what bundlers
  // (Vite, webpack 5, Rspack, Parcel) recognise and turn into an emitted worker script.
  if (workerUrl) return new Worker(workerUrl, { type: "module" });
  return new Worker(new URL("./dummy.worker.js", import.meta.url), { type: "module" });
}

/** Test provider: no model, fake load, transcript says how long the audio was. Runs in its own worker. */
export function dummyStt({ files = false, baseUrl = "/dummy-models/", recorder, workerUrl, wasmBaseUrl }: DummySttOptions = {}): SttProvider {
  return workerStt({
    id: "dummy",
    spawn,
    workerUrl,
    wasmBaseUrl,
    recorder: recorder ?? fakeRecorder(),
    ...(files ? { downloadSize: 300_000, files: [{ url: `${baseUrl}stt.bin`, size: 300_000 }] } : {}),
  });
}
