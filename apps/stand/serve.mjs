// Serves the assembled site and the stand in two modes:
//   plain     http://localhost:4173   no special headers
//   isolated  http://localhost:4174   COOP/COEP set, so crossOriginIsolated is true
//   site      http://localhost:4175/voxxy/   GitHub Pages layout under a subpath
// Builds first unless STAND_SKIP_BUILD is set.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const plainPort = Number(process.env.STAND_PORT ?? 4173);
const isolatedPort = Number(process.env.STAND_ISOLATED_PORT ?? 4174);

if (!process.env.STAND_SKIP_BUILD) {
  // The stand imports the library from its built dist, so build the whole workspace.
  const result = spawnSync("pnpm", ["-w", "run", "build:site"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const site = await preview({
  root: fileURLToPath(new URL("../landing/", import.meta.url)),
  configFile: false,
  appType: "mpa",
  base: "/voxxy/",
  build: { outDir: "../../_site" },
  preview: { port: 4175, strictPort: true, host: "localhost" },
});
site.printUrls();

const isolatedHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Test-only route: /__interrupt?path=/file&after=N answers like /file, but sends
// the full content-length header, only N bytes of body, then drops the socket.
// That is a download cut off partway, which route.fulfill() in Playwright cannot
// produce (it recomputes content-length). Used by interruptRequest() in e2e/helpers.
function interruptPlugin(port) {
  return {
    name: "voxxy-interrupt",
    configurePreviewServer(server) {
      server.middlewares.use("/__interrupt", async (req, res) => {
        const params = new URL(req.url, "http://localhost").searchParams;
        const upstream = await fetch(`http://localhost:${port}${params.get("path")}`);
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
          "content-length": String(body.length),
        });
        res.write(body.subarray(0, Number(params.get("after") ?? 0)));
        setTimeout(() => res.socket?.destroy(), 20);
      });
    },
  };
}

// Plain last: Playwright waits on this port, so by then all previews are up.
for (const [port, headers] of [
  [isolatedPort, isolatedHeaders],
  [plainPort, {}],
]) {
  const server = await preview({
    root,
    plugins: [interruptPlugin(port)],
    preview: { port, strictPort: true, host: "localhost", headers },
  });
  server.printUrls();
}
