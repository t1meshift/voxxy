import { defineConfig, type Plugin } from "vite";

/** Sizes of the fake model files served at /dummy-models/<name>.bin; must match packages/voxxy/src/{stt,tts}/dummy.ts. */
const dummyModels: Record<string, number> = { "stt.bin": 300_000, "tts.bin": 200_000 };

// Stands in for a model CDN: serves files of a known size so the download,
// verification and eviction paths can run without fetching real weights.
const dummyModelsPlugin: Plugin = {
  name: "voxxy-dummy-models",
  configureServer(server) {
    server.middlewares.use(handler);
  },
  configurePreviewServer(server) {
    server.middlewares.use(handler);
  },
};

function handler(
  req: { url?: string },
  res: { writeHead(status: number, headers: Record<string, string>): void; end(chunk?: unknown): void },
  next: () => void,
): void {
  const match = /^\/dummy-models\/([\w.-]+)$/.exec((req.url ?? "").split("?")[0] ?? "");
  const size = match?.[1] ? dummyModels[match[1]] : undefined;
  if (size === undefined) return next();
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size) });
  res.end(Buffer.alloc(size, 7));
}

// The deployed site is static: write the fake model files into the build output.
const dummyModelsStaticPlugin: Plugin = {
  name: "voxxy-dummy-models-static",
  apply: "build",
  generateBundle() {
    for (const [name, size] of Object.entries(dummyModels)) {
      this.emitFile({ type: "asset", fileName: `dummy-models/${name}`, source: new Uint8Array(size).fill(7) });
    }
  },
};

export default defineConfig({
  // Relative assets work at both the stand root and a GitHub Pages subpath.
  base: process.env.STAND_BASE ?? "./",
  worker: { format: "es" },
  plugins: [dummyModelsPlugin, dummyModelsStaticPlugin],
  build: {
    rollupOptions: {
      // index.html: the dummy providers, quick and offline. real.html: Moonshine and Paradee, which download real weights.
      input: { main: "index.html", real: "real.html" },
    },
  },
});
