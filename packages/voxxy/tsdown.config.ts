import { defineConfig } from "tsdown";

// One entry per public module. Each adapter has an entry holding only its provider factory
// (src/stt/<name>.ts, src/tts/<name>.ts) and its own worker script (<name>.worker.ts), which
// the factory reaches through `new Worker(new URL("./<name>.worker.js", import.meta.url))`.
// A host that imports one adapter therefore bundles only that adapter and its worker.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    serve: "src/serve.ts",
    testing: "src/testing.ts",
    "stt/moonshine": "src/stt/moonshine.ts",
    "stt/moonshine.worker": "src/stt/moonshine.worker.ts",
    "stt/platform": "src/stt/platform.ts",
    "tts/paradee": "src/tts/paradee.ts",
    "tts/paradee.worker": "src/tts/paradee.worker.ts",
    "tts/platform": "src/tts/platform.ts",
    "stt/dummy": "src/stt/dummy.ts",
    "stt/dummy.worker": "src/stt/dummy.worker.ts",
    "tts/dummy": "src/tts/dummy.ts",
    "tts/dummy.worker": "src/tts/dummy.worker.ts",
  },
  format: "esm",
  platform: "browser",
  dts: true,
  clean: true,
});
