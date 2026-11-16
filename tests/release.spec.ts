import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test, expect } from "@playwright/test";
import { MODEL_CDN_URL, MODEL_PATH, ROOT, testImages } from "./helpers.ts";

const SAMPLES = ["sample-photos/profile-rest-1.jpg", "sample-photos/profile-rest-2.jpg", "sample-photos/profile-smile.jpg"];
const MODEL_SHA256 = createHash("sha256").update(readFileSync(MODEL_PATH)).digest("hex");

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

test("package ships one JavaScript file, docs and valid checksums, but no model and no type files", () => {
  const files = listFiles(OUT).map((f) => relative(OUT, f));
  expect(files.filter((f) => f.endsWith(".js"))).toEqual(["ordoline-sorter.js"]);
  expect(files.some((f) => f.endsWith(".onnx"))).toBe(false);
  expect(readFileSync(join(OUT, "ordoline-sorter.js"), "utf8")).toContain(JSON.stringify(MODEL_CDN_URL));
  expect(readFileSync(join(OUT, "ordoline-sorter.js"), "utf8")).toContain(JSON.stringify(MODEL_SHA256)); // downloaded + hashed
  expect(readFileSync(join(OUT, "README.md"), "utf8")).toContain(MODEL_SHA256);
  expect(readFileSync(join(OUT, "README.md"), "utf8")).toContain(MODEL_CDN_URL);
  expect(files.sort()).toEqual(["API.md", "README.md", "SHA256SUMS", "example.html", "ordoline-sorter.js", ...SAMPLES].sort());
  // the <ordoline-sorter> widget is for our own pages only: not in the third-party file or docs
  const bundle = readFileSync(join(OUT, "ordoline-sorter.js"), "utf8");
  expect(bundle).not.toContain("customElements");
  expect(bundle).not.toContain("HTMLElement");
  expect(bundle.split("\n").slice(0, 2).join("\n")).toMatch(/Copyright \(c\) \d{4} UAB Agmis\. All rights reserved\./);
  expect(readFileSync(join(OUT, "README.md"), "utf8")).not.toContain("<ordoline-sorter");
  expect(files.some((f) => f.endsWith(".map"))).toBe(false);
  expect(bundle).not.toMatch(/^\/\/ .*\.ts$/m); // esbuild's per-file path comments
  expect(bundle).not.toContain("src/");
  expect(existsSync(`${OUT}.zip`)).toBe(true);

  // partner docs: no repository internals, advanced options or optional server setup
  const docs = ["API.md", "README.md"].map((f) => readFileSync(join(OUT, f), "utf8")).join("\n");
  for (const internal of ["](../", "<!--", "{{", "npm run", "dist/", "DATA/", "KNOWN_ISSUES", "SHOFU", "webgpu", "ortUrl", "wasmPaths", "Cross-Origin", "numThreads"]) {
    expect(docs, internal).not.toContain(internal);
  }
  expect(readFileSync(join(OUT, "README.md"), "utf8")).toContain(`Ordoline Sorter ${version}`);

  const lines = readFileSync(join(OUT, "SHA256SUMS"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(files.length - 1); // every file except SHA256SUMS itself
  for (const line of lines) {
    const [hash, file] = line.split(/ {2}/);
    expect(createHash("sha256").update(readFileSync(join(OUT, file))).digest("hex"), file).toBe(hash);
  }
});

test("example.html sorts photos with the single file (worker mode)", async ({ page }) => {
  await page.goto(`${URL_BASE}/example.html`);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 60_000 });
  const photos = testImages(1).slice(0, 3).map((i) => i.path);
  await page.locator("#photos").setInputFiles(photos);
  await expect(page.locator("#status")).toContainText("Sorted 3", { timeout: 60_000 });
  await expect(page.locator("#results tr")).toHaveCount(3);
  // each row shows its own photo, loaded locally
  const thumbs = page.locator("#results img");
  await expect(thumbs).toHaveCount(3);
  await expect.poll(() => thumbs.evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await thumbs.evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src.slice(0, 5)))).toEqual(["blob:", "blob:", "blob:"]);
});

test("the single file loads the model from the baked-in URL", async ({ page }) => {
  await page.goto(`${URL_BASE}/example.html`);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 60_000 });
  const model = await page.evaluate(async () => {
    const api = await import(`${location.href.replace(/[^/]*$/, "")}ordoline-sorter.js`);
    return (await api.createSorter({ worker: true })).model; // same instance the example page created
  });
  expect(model.url).toBe(MODEL_CDN_URL);
  expect(model.sha256).toBe(MODEL_SHA256);
  expect(model.worker).toBe(true);
});

test("--model-sha256 that does not match the deployed model stops the build", () => {
  let err = "";
  try { pack(`--model-url=${MODEL_CDN_URL}`, `--model-sha256=${"0".repeat(64)}`, "--out=release/_test/bad-sha"); }
  catch (e) { err = String((e as { stderr?: Buffer }).stderr ?? e); }
  expect(err).toContain(`has SHA-256 ${MODEL_SHA256}`);
});

test("without --model-url, docs and example tell providers to pass modelUrl", () => {
  pack("--out=release/_test/no-url");
  const dir = join(ROOT, "release", "_test", "no-url", NAME);
  expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("no default model URL");
  expect(readFileSync(join(dir, "README.md"), "utf8")).toContain('modelUrl: "https://');
  expect(readFileSync(join(dir, "example.html"), "utf8")).toContain('modelUrl: "https://');
  expect(readFileSync(join(dir, "ordoline-sorter.js"), "utf8")).not.toContain("localhost");
});

test.describe("--include-model", () => {
  const DIR = join(ROOT, "release", "_test", "with-model", `${NAME}-with-model`);
  const BASE = `/release/_test/with-model/${NAME}-with-model`;
  test.beforeAll(() => { pack("--include-model", "--out=release/_test/with-model"); });

  test("ships the model next to the file, with its SHA-256 baked in and no model URL", () => {
    const files = listFiles(DIR).map((f) => relative(DIR, f)).sort();
    expect(files).toEqual(["API.md", "README.md", "SHA256SUMS", "example.html", "model/best.onnx", "ordoline-sorter.js", ...SAMPLES].sort());
    expect(createHash("sha256").update(readFileSync(join(DIR, "model", "best.onnx"))).digest("hex")).toBe(MODEL_SHA256);
    expect(readFileSync(join(DIR, "SHA256SUMS"), "utf8")).toContain(`${MODEL_SHA256}  model/best.onnx`);
    const bundle = readFileSync(join(DIR, "ordoline-sorter.js"), "utf8");
    expect(bundle).toContain(JSON.stringify(MODEL_SHA256));
    expect(bundle).not.toContain("localhost");
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    expect(readme).toContain("The model is included in this package");
    expect(readme).not.toContain("Ordoline's model server");
    expect(readme).not.toMatch(/<!--|\{\{/);
    expect(readFileSync(join(DIR, "example.html"), "utf8")).not.toContain("modelUrl");
    expect(readFileSync(join(DIR, "API.md"), "utf8")).not.toMatch(/modelUrl|modelSha256|<!--/);
  });

  test("example.html loads the included model and sorts the sample photos (worker mode)", async ({ page }) => {
    await page.goto(`${BASE}/example.html`);
    await expect(page.locator("#status")).toContainText("Ready", { timeout: 60_000 });
    await page.locator("#photos").setInputFiles(SAMPLES.map((f) => join(DIR, f)));
    await expect(page.locator("#status")).toContainText("Sorted 3", { timeout: 60_000 });
    await expect(page.locator("#results")).toContainText("Extraoral profile (rest)");
    await expect(page.locator("#results")).toContainText("Extraoral profile (smile)");
    const model = await page.evaluate(async () => {
      const api = await import(`${location.href.replace(/[^/]*$/, "")}ordoline-sorter.js`);
      return (await api.createSorter({ worker: true })).model;
    });
    expect(model.url).toMatch(new RegExp(`${BASE}/model/best\\.onnx$`));
    expect(model.sha256).toBe(MODEL_SHA256);
    expect(model.worker).toBe(true);
  });

  test("--include-model cannot be combined with --model-url", () => {
    let err = "";
    try { pack("--include-model", `--model-url=${MODEL_CDN_URL}`, "--out=release/_test/both"); }
    catch (e) { err = String((e as { stderr?: Buffer }).stderr ?? e); }
    expect(err).toContain("cannot be combined");
  });
});
