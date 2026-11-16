import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const site = new URL("../../_site/", import.meta.url);
await rm(site, { force: true, recursive: true });
await mkdir(site);
await cp(new URL("./dist/", import.meta.url), site, { recursive: true });
await cp(new URL("../../LICENSE", import.meta.url), new URL("../../packages/voxxy/dist/LICENSE", import.meta.url));
execFileSync("pnpm", ["--filter", "voxxy", "pack", "--out", fileURLToPath(new URL("voxxy.tgz", site))], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  stdio: "inherit",
});
await writeFile(new URL(".nojekyll", site), "");
