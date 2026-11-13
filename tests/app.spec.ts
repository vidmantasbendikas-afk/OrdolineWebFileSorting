import { test, expect } from "@playwright/test";
import { MODEL_CDN_URL, ROOT, testImages } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-status")).toContainText("ready", { timeout: 60_000 });
});

test("loads the model from the CDN given in config.json", async ({ page }) => {
  const url = await page.evaluate(() => (window as unknown as { state: { sorter: { model: { url: string } } } }).state.sorter.model.url);
  expect(url).toBe(MODEL_CDN_URL);
});

test("uploads, sorts and clears photos", async ({ page }) => {
  const photos = testImages(1).map((i) => i.path);
  await page.locator("#file-input").setInputFiles([...photos, `${ROOT}package.json`]); // non-image is skipped

  await expect(page.locator("#queue-count")).toHaveText(String(photos.length));
  await page.locator("#submit-btn").click();
  await expect(page.locator("#sort-progress-text")).toContainText(`sorted ${photos.length}`, { timeout: 60_000 });
  await expect(page.locator(".chip")).toHaveCount(photos.length);
  await expect(page.locator("#queue-grid .q-item")).toHaveCount(0);
  await expect(page.locator("#queue-count")).toHaveText("0");

  const total = await page.locator(".cat-count").evaluateAll((els) => els.reduce((n, el) => n + Number(el.textContent), 0));
  expect(total).toBe(photos.length);

  await page.locator("#clear-btn").click();
  await expect(page.locator(".chip")).toHaveCount(0);
});

test("test-set button reports accuracy", async ({ page }) => {
  await page.locator("#test-count").selectOption("1");
  await page.locator("#validate-btn").click();
  await expect(page.locator("#overall-result")).toHaveText(/Test-set accuracy: \d+\/10 = [\d.]+%/, { timeout: 60_000 });
  await expect(page.locator(".chip")).toHaveCount(10);
});

test("layout does not jump while photos are queued, sorted and cleared", async ({ page }) => {
  const top = async () => ({
    sortButton: (await page.locator("#submit-btn").boundingBox())!.y,
    results: (await page.locator("#results").boundingBox())!.y,
  });
  const before = await top();

  await page.locator("#file-input").setInputFiles(testImages(3).map((i) => i.path)); // 30 photos: more than the box shows
  await expect(page.locator("#queue-count")).toHaveText("30");
  expect(await top(), "after queueing").toEqual(before);

  await page.locator("#submit-btn").click();
  await expect(page.locator("#sort-progress-text")).toContainText("sorted 30", { timeout: 120_000 });
  expect(await top(), "after sorting").toEqual(before);

  await page.locator("#clear-btn").click();
  expect(await top(), "after clearing").toEqual(before);
});
