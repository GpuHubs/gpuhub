import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
cpSync(join(here, "public"), dist, { recursive: true });

await build({
  entryPoints: ["background", "offscreen", "popup", "sandbox"].map((n) => join(here, "src", `${n}.ts`)),
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome124",
  minify: true,
  logLevel: "warning",
  conditions: ["browser"],
});
console.log("built extension/dist");
