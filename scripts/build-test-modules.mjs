import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const srcDir = new URL("../src/", import.meta.url);
const distDir = new URL("../dist/", import.meta.url);
const files = (await readdir(srcDir))
  .filter((file) => file.endsWith(".ts"))
  .filter((file) => file !== "index.ts");

await Promise.all(files.map((file) => build({
  entryPoints: [join(srcDir.pathname, file)],
  outfile: join(distDir.pathname, file.replace(/\.ts$/, ".js")),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["@actions/core", "@actions/github", "@octokit/rest", "@anthropic-ai/sdk"],
  sourcemap: false,
  logLevel: "silent",
})));
