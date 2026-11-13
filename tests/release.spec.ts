import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test, expect } from "@playwright/test";
import { MODEL_CDN_URL, ROOT, testImages } from "./helpers.ts";

const version: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const NAME = `ordoline-sorter-${version}`;
// Packaged into release/_test/ (not the real release/), with the model URL pointing at the local model CDN:
// the same setup a provider has (their page on one origin, our model on another).
const OUT = join(ROOT, "release", "_test", NAME);
const URL_BASE = `/release/_test/${NAME}`;
const pack = (...args: string[]) =>
  execFileSync("node", ["scripts/package-release.ts", ...args], { cwd: ROOT, stdio: "pipe" });

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? listFiles(join(dir, e)) : [join(dir, e)]));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  pack(`--model-url=${MODEL_CDN_URL}`, "--out=release/_test");
});

test("package ships one JavaScript file, types, docs and valid checksums, but no model", () => {
  const files = listFiles(OUT).map((f) => relative(OUT, f));
  expect(files.filter((f) => f.endsWith(".js"))).toEqual(["ordoline-sorter.js"]);
  expect(files.some((f) => f.endsWith(".onnx"))).toBe(false);
  expect(readFileSync(join(OUT, "ordoline-sorter.js"), "utf8")).toContain(JSON.stringify(MODEL_CDN_URL));
  expect(readFileSync(join(OUT, "README.md"), "utf8")).toContain(MODEL_CDN_URL);
  for (const f of ["ordoline-sorter.d.ts", "README.md", "API.md", "KNOWN_ISSUES.md", "example.html", "SHA256SUMS"]) {
    expect(files, f).toContain(f);
  }
  // the <ordoline-sorter> widget is for our own pages only: not in the third-party file, types or docs
  const bundle = readFileSync(join(OUT, "ordoline-sorter.js"), "utf8");
  expect(bundle).not.toContain("customElements");
  expect(bundle).not.toContain("HTMLElement");
  expect(files.some((f) => f.includes("element") || f.startsWith("types/ui"))).toBe(false);
  expect(readFileSync(join(OUT, "README.md"), "utf8")).not.toContain("<ordoline-sorter");
  expect(files.some((f) => f.endsWith(".map"))).toBe(false);
  expect(existsSync(`${OUT}.zip`)).toBe(true);

  const api = readFileSync(join(OUT, "API.md"), "utf8");
  expect(api).not.toContain("](../");
  expect(api).not.toContain("repo-only");
  expect(readFileSync(join(OUT, "README.md"), "utf8")).toContain(`Ordoline Sorter ${version}`);

  const lines = readFileSync(join(OUT, "SHA256SUMS"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(files.length - 1); // every file except SHA256SUMS itself
  for (const line of lines) {
    const [hash, file] = line.split(/ {2}/);
    expect(createHash("sha256").update(readFileSync(join(OUT, file))).digest("hex"), file).toBe(hash);
  }
});

test("types work for a TypeScript consumer", () => {
  const dir = join(ROOT, "release", "_test", "_typecheck");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "consumer.ts"), `
    import { createSorter, CATEGORIES, type ClassificationResult, type SortResult } from "../${NAME}/ordoline-sorter.js";
    const s = await createSorter({ worker: true, modelUrl: "x" });
    const r: ClassificationResult = await s.classify("photo.jpg");
    if (r.ok) r.category satisfies (typeof CATEGORIES)[number]["id"];
    const all: SortResult = await s.sort([], { signal: new AbortController().signal });
    all.summary.aborted satisfies boolean;
    export {};
  `);
  execFileSync("npx", ["tsc", "--ignoreConfig", "--noEmit", "--strict", "--target", "es2022", "--module", "esnext",
    "--moduleResolution", "bundler", "--lib", "es2022,dom", "--types", "", join(dir, "consumer.ts")], { cwd: ROOT, stdio: "pipe" });
});

test("example.html sorts photos with the single file (worker mode)", async ({ page }) => {
  await page.goto(`${URL_BASE}/example.html`);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 60_000 });
  const photos = testImages(1).slice(0, 3).map((i) => i.path);
  await page.locator("#photos").setInputFiles(photos);
  await expect(page.locator("#status")).toContainText("Sorted 3", { timeout: 60_000 });
  await expect(page.locator("#results tr")).toHaveCount(3);
});

test("the single file loads the model from the baked-in URL", async ({ page }) => {
  await page.goto(`${URL_BASE}/example.html`);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 60_000 });
  const model = await page.evaluate(async () => {
    const api = await import(`${location.href.replace(/[^/]*$/, "")}ordoline-sorter.js`);
    return (await api.createSorter({ worker: true })).model; // same instance the example page created
  });
  expect(model.url).toBe(MODEL_CDN_URL);
  expect(model.worker).toBe(true);
});

test("without --model-url, docs and example tell providers to pass modelUrl", () => {
  pack("--out=release/_test/no-url");
  const dir = join(ROOT, "release", "_test", "no-url", NAME);
  expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("no default model URL");
  expect(readFileSync(join(dir, "README.md"), "utf8")).toContain('modelUrl: "https://');
  expect(readFileSync(join(dir, "example.html"), "utf8")).toContain('modelUrl: "https://');
  expect(readFileSync(join(dir, "ordoline-sorter.js"), "utf8")).not.toContain("localhost");
});
