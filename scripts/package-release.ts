/**
 * Builds the release package for external providers:
 *   release/ordoline-sorter-<version>/      ready-to-copy folder
 *   release/ordoline-sorter-<version>.zip   the same, zipped
 *
 * The sorter API and its worker are bundled by esbuild into ONE file, ordoline-sorter.js. NOT included: the model
 * (hosted by us; its URL is baked in with --model-url) and the <ordoline-sorter> widget (our own pages only).
 * Also: types, an example page, provider README, API.md, KNOWN_ISSUES.md and SHA256SUMS.
 *
 * Run:  docker compose run --rm tests npm run package -- --model-url=https://cdn.example.com/ordoline/best.onnx
 *   --model-url=URL  default model URL baked into ordoline-sorter.js (without it, providers must pass modelUrl)
 *   --out=DIR        output directory relative to the repository (default: release)
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

// 1. type declarations (tsc) into dist/
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
  banner: { js: `/*! Ordoline Sorter ${version} — single-file build. Docs: API.md */` },
  define: modelUrl ? { __ORDOLINE_MODEL_URL__: JSON.stringify(modelUrl) } : {},
  logLevel: "warning",
});

// 3. types for TypeScript users: ordoline-sorter.d.ts -> types/
for (const file of listFiles(join(ROOT, "dist", "sorter")).filter((f) => f.endsWith(".d.ts"))) {
  write(join(out, "types", relative(join(ROOT, "dist", "sorter"), file)), readFileSync(file, "utf8"));
}
write(join(out, "ordoline-sorter.d.ts"), 'export * from "./types/ordoline-sorter.js";\n');

// 4. docs and examples (the model is not shipped)
const modelText = modelUrl
  ? `This build loads the model from \`${modelUrl}\` by default; you do not need to configure anything.`
  : "This build has **no default model URL**: pass the URL you received from Ordoline as `modelUrl`.";
const fill = (text: string) => text.replaceAll("{{VERSION}}", version).replaceAll("{{MODEL_URL_TEXT}}", modelText)
  .replaceAll("{{MODEL_URL_OPTION}}", modelUrl ? "" : `modelUrl: "https://…/best.onnx", `);
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
console.log(`${relative(ROOT, out)}.zip  (${kb(`${out}.zip`)})`);
