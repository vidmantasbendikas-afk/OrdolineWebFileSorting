import { test, expect } from "@playwright/test";
import { testImages } from "./helpers.ts";

test("<ordoline-sorter> sorts files and emits events", async ({ page }) => {
  await page.goto("/sorter/demo.html");
  const urls = testImages(1).slice(0, 3).map((i) => i.url);

  const out = await page.evaluate(async (urls) => {
    const el = document.querySelector("ordoline-sorter") as HTMLElement & {
      ready: Promise<void>;
      sort(inputs: unknown[]): Promise<{ summary: { sorted: number } } | null>;
    };
    const events: string[] = [];
    for (const t of ["ordoline-result", "ordoline-done", "ordoline-error"]) el.addEventListener(t, () => events.push(t));
    await el.ready;
    const files = await Promise.all(urls.map(async (u, i) => new File([await (await fetch(u)).blob()], `p${i}.jpg`, { type: "image/jpeg" })));
    const res = await el.sort([...files, new File(["x"], "notes.txt", { type: "text/plain" })]);
    return {
      sorted: res?.summary.sorted,
      events,
      chips: el.shadowRoot!.querySelectorAll(".chip").length,
      status: el.shadowRoot!.querySelector(".status")!.textContent,
    };
  }, urls);

  expect(out.sorted).toBe(3);
  expect(out.events).toEqual(["ordoline-result", "ordoline-result", "ordoline-result", "ordoline-done"]);
  expect(out.chips).toBe(3);
  expect(out.status).toContain("Sorted 3");
});
