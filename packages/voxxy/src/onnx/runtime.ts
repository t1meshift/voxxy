import * as ort from "onnxruntime-web/wasm";
import type { ModelFile, ModelFileReader } from "../models/types.js";

export type Ort = typeof ort;

/** The version of the runtime bundled into the adapters; the wasm file below must match it. */
export const ORT_VERSION = "1.31.1";

/**
 * The runtime's WebAssembly binary, single-threaded capable (it uses threads only if asked to and
 * the page is cross-origin isolated; we ask for one thread). Declared as a file like the weights, so it
 * goes through the same consent, size display, caching and verification, instead of being fetched behind the host's back.
 * By default it comes from jsDelivr, pinned to the exact version; a host that serves its own copy passes `wasmBaseUrl`.
 */
export const ortWasmFile = (baseUrl = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`): ModelFile => ({
  url: `${baseUrl.replace(/\/?$/, "/")}ort-wasm-simd-threaded.wasm`,
  size: 14_848_852,
});

export interface OrtLoadOptions {
  /** URL the wasm file was declared under, to read it back from storage. */
  wasmUrl: string;
  models?: ModelFileReader;
}

/**
 * Prepares the runtime: one thread (no SharedArrayBuffer, so no COOP/COEP needed), wasm binary from storage when
 * it is there, otherwise fetched from `wasmUrl` by the runtime itself (the situation in Node tests).
 *
 * More threads were tried and do not work from a bundled worker: the runtime starts its helper threads from its own
 * loader script (`ort-wasm-simd-threaded.mjs`), which this setup neither ships nor declares as a file, and a worker
 * cannot be started from another origin's script. Starting the stand on an isolated page with 4 threads fails on load.
 */
export async function prepareOrt({ wasmUrl, models }: OrtLoadOptions): Promise<Ort> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const stored = await models?.read(wasmUrl);
  if (stored) {
    ort.env.wasm.wasmBinary = new Uint8Array(await stored.arrayBuffer());
  } else {
    ort.env.wasm.wasmPaths = wasmUrl.slice(0, wasmUrl.lastIndexOf("/") + 1);
  }
  return ort;
}

/** Reads a stored file as bytes, or throws a message that says what to do. */
export async function readBytes(models: ModelFileReader | undefined, url: string): Promise<Uint8Array> {
  const response = await models?.read(url);
  if (!response) throw new Error(`${url} is not in storage: download the model first (voxxy.models.optIn)`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function readJson<T>(models: ModelFileReader | undefined, url: string): Promise<T> {
  const response = await models?.read(url);
  if (!response) throw new Error(`${url} is not in storage: download the model first (voxxy.models.optIn)`);
  return (await response.json()) as T;
}
