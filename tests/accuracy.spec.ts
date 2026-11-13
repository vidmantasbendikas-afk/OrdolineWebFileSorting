import { test, expect } from "@playwright/test";
import { openHarness, testImages, TRUTH } from "./helpers.ts";

// Baseline on this model: 269/300 = 89.7% (same as the original app's canvas preprocessing).
const MIN_ACCURACY = 0.89;

test("full test set accuracy @slow", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  await openHarness(page);
  const images = testImages();
  const categories = await page.evaluate(async (urls) => {
    const res = await (await window.api.createSorter()).sort(urls);
    return res.results.map((r) => (r.ok ? r.category : r.error.code));
  }, images.map((i) => i.url));

  const perFolder: Record<string, string> = {};
  let correct = 0;
  for (const dir of Object.keys(TRUTH)) {
    const idx = images.flatMap((img, i) => (img.dir === dir ? [i] : []));
    const ok = idx.filter((i) => (TRUTH[dir] as string[]).includes(categories[i])).length;
    perFolder[dir] = `${ok}/${idx.length}`;
    correct += ok;
  }
  const accuracy = correct / images.length;
  console.log(`accuracy ${correct}/${images.length} = ${(accuracy * 100).toFixed(1)}%`, perFolder);
  expect(accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
});
