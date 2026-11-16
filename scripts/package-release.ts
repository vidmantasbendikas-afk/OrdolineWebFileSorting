/**
 * Builds the release package for external providers:
 *   release/ordoline-sorter-<version>/      ready-to-copy folder
 *   release/ordoline-sorter-<version>.zip   the same, zipped
 *
 * The sorter API and its worker are bundled by esbuild into ONE file, ordoline-sorter.js. NOT included: the model
 * (hosted by us; its URL is baked in with --model-url) and the <ordoline-sorter> widget (our own pages only).
 * Also: an example page, provider README, API.md, KNOWN_ISSUES.md and SHA256SUMS. No TypeScript types: partners use
 * plain JavaScript.
 *
 * Run:  docker compose run --rm tests npm run package -- --model-url=https://cdn.example.com/ordoline/models/<version>/best.onnx
 *   --model-url=URL      default model URL baked into ordoline-sorter.js (without it, providers must pass modelUrl).
 *                        The model is downloaded from there and its SHA-256 baked in too: browsers then refuse any
 *                        other file served under that URL. Upload the model before packaging; never overwrite it.
 *   --model-sha256=HEX   expected SHA-256; the download must match it (or, if the URL is unreachable, it is used as is)
 *   --out=DIR            output directory relative to the repository (default: release)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = (key: string) => process.argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const modelUrl = arg("model-url");
if (modelUrl !== undefined && !/^https?:\/\//.test(modelUrl)) throw new Error(`--model-url must be an http(s) URL: ${modelUrl}`);
const givenSha256 = arg("model-sha256")?.toLowerCase();
if (givenSha256 !== undefined && !/^[0-9a-f]{64}$/.test(givenSha256)) throw new Error("--model-sha256 must be 64 hex characters");
if (givenSha256 && !modelUrl) throw new Error("--model-sha256 needs --model-url");
const version: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const name = `ordoline-sorter-${version}`;
const releaseDir = join(ROOT, arg("out") ?? "release");
const out = join(releaseDir, name);

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** SHA-256 of the model as deployed at `url`, checked against --model-sha256 when given. */
async function deployedModelSha256(url: string): Promise<string> {
  let actual: string;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    actual = createHash("sha256").update(new Uint8Array(await res.arrayBuffer())).digest("hex");
  } catch (err) {
    if (givenSha256) {
      console.warn(`warning: could not download ${url} (${(err as Error).message}); using --model-sha256 as given`);
      return givenSha256;
    }
    throw new Error(`Could not download the model from ${url} to compute its SHA-256 (${(err as Error).message}). ` +
      "Upload it first, or pass --model-sha256.");
  }
  if (givenSha256 && actual !== givenSha256) throw new Error(`${url} has SHA-256 ${actual}, not --model-sha256 ${givenSha256}`);
  return actual;
}
const modelSha256 = modelUrl ? await deployedModelSha256(modelUrl) : undefined;

// 1. compile check (tsc): the release is only built from sources that type-check
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: ROOT, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
rmSync(`${out}.zip`, { force: true });

// 2. the single file: API + worker, readable (not minified), no source map
await build({
  entryPoints: [join(ROOT, "src", "sorter", "ordoline-sorter.ts")],
  outfile: join(out, "ordoline-sorter.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  legalComments: "none",
  banner: {
    js: `/*! Ordoline Sorter ${version} — single-file build. Docs: API.md
 * Copyright (c) ${new Date().getFullYear()} UAB Agmis. All rights reserved. */`,
  },
  define: modelUrl
    ? { __ORDOLINE_MODEL_URL__: JSON.stringify(modelUrl), __ORDOLINE_MODEL_SHA256__: JSON.stringify(modelSha256) }
    : {},
  logLevel: "warning",
});

// esbuild marks where each source file starts ("// src/sorter/errors.ts"); those repository paths do not belong in
// the release
const bundlePath = join(out, "ordoline-sorter.js");
const bundle = readFileSync(bundlePath, "utf8").replace(/^\/\/ src\/\S+\.ts\n/gm, "");
if (/\bsrc\/(sorter|ui|app)\//.test(bundle)) throw new Error("ordoline-sorter.js still mentions repository paths");
writeFileSync(bundlePath, bundle);

// 4. docs and examples (the model is not shipped)
const modelText = modelUrl
  ? `This build loads the model from \`${modelUrl}\` by default; you do not need to configure anything. The build ` +
    `also contains the model's SHA-256 (\`${modelSha256}\`): browsers refuse a file that does not match it.`
  : "This build has **no default model URL**: pass the URL you received from Ordoline as `modelUrl`, and its " +
    "SHA-256 as `modelSha256` so browsers refuse any other file.";
const exampleModelStep = modelUrl
  ? `Nothing to configure: this build loads the model from \`${modelUrl}\`.`
  : "Edit `example.html`: replace `https://…/best.onnx` in the `modelUrl` line with the model URL you received from " +
    "Ordoline, and add `modelSha256: \"…\",` with its SHA-256 on the next line.";
const fill = (text: string) => {
  const filled = text.replaceAll("{{VERSION}}", version).replaceAll("{{MODEL_URL_TEXT}}", modelText)
    .replaceAll("{{EXAMPLE_MODEL_STEP}}", exampleModelStep)
    .replaceAll("{{MODEL_URL_OPTION}}", modelUrl ? "" : `modelUrl: "https://…/best.onnx", `);
  const left = filled.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`unfilled placeholder ${left[0]}`);
  return filled;
};
write(join(out, "README.md"), fill(readFileSync(join(ROOT, "packaging", "README.md"), "utf8")));
write(join(out, "example.html"), fill(readFileSync(join(ROOT, "packaging", "example.html"), "utf8")));
const api = readFileSync(join(ROOT, "docs", "API.md"), "utf8")
  .replace(/<!-- repo-only -->[\s\S]*?<!-- \/repo-only -->\n?/g, "")
  .replaceAll("(../KNOWN_ISSUES.md)", "(KNOWN_ISSUES.md)");
if (api.includes("](../")) throw new Error("API.md still links into the repository; update package-release.ts");
write(join(out, "API.md"), api);
copyFileSync(join(ROOT, "KNOWN_ISSUES.md"), join(out, "KNOWN_ISSUES.md"));

// 5. checksums of every file
const sums = listFiles(out).sort().map((file) =>
  `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${relative(out, file)}`);
write(join(out, "SHA256SUMS"), sums.join("\n") + "\n");

// 6. zip
execFileSync("zip", ["-r", "-q", "-X", `${name}.zip`, name], { cwd: releaseDir });

const kb = (path: string) => `${Math.round(statSync(path).size / 1024)} KB`;
console.log(`${relative(ROOT, out)}/ordoline-sorter.js  (${kb(join(out, "ordoline-sorter.js"))})`);
console.log(`${relative(ROOT, out)}/  (${sums.length} files; model URL: ${modelUrl ?? "none, providers pass modelUrl"})`);
if (modelSha256) console.log(`model SHA-256: ${modelSha256}`);
console.log(`${relative(ROOT, out)}.zip  (${kb(`${out}.zip`)})`);
