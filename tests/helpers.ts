import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type * as SorterApi from "../sorter/ordoline-sorter.js";
import type { CategoryId } from "../sorter/ordoline-sorter.js";

declare global {
  interface Window {
    api: typeof SorterApi;
    apiReady?: boolean;
  }
}

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MODEL_PATH = `${ROOT}model/best.onnx`;
/** The model on the separate CDN origin (docker compose service model-cdn). */
export const MODEL_CDN_URL = process.env.MODEL_CDN_URL ?? "http://localhost:8001/best.onnx";

/** Test-set folder -> categories counted as correct. */
export const TRUTH: Record<string, CategoryId[]> = {
  ceph_front: ["cephalometric_frontal"],
  ceph_side: ["cephalometric_lateral"],
  extr_profile: ["extraoral_profile_rest", "extraoral_profile_smile"],
  extr_rest: ["extraoral_frontal_rest"],
  extr_smile: ["extraoral_frontal_smile"],
  intr_front: ["intraoral_frontal"],
  intr_left: ["intraoral_left"],
  intr_right: ["intraoral_right"],
  intr_upper: ["intraoral_upper"],
  intr_lower: ["intraoral_lower"],
};

export interface TestImage {
  dir: string;
  name: string;
  /** Served URL (path from the site root). */
  url: string;
  /** Absolute file path, for file inputs. */
  path: string;
}

const manifest: Record<string, string[]> = JSON.parse(readFileSync(`${ROOT}js/testfiles.json`, "utf8"));

/** First `perClass` images of every test folder, folders in alphabetical order. */
export function testImages(perClass = Infinity): TestImage[] {
  return Object.keys(manifest).sort().flatMap((dir) =>
    manifest[dir].slice(0, perClass).map((name) => ({
      dir,
      name,
      url: `/data/test/${dir}/${encodeURIComponent(name)}`,
      path: `${ROOT}data/test/${dir}/${name}`,
    })));
}

/** One known, confidently classified image (an intraoral left view). */
export const SAMPLE = testImages().find((i) => i.dir === "intr_left")!;

/** Open the blank harness page and wait until window.api (the sorter module) is available. */
export async function openHarness(page: Page): Promise<void> {
  await page.goto("/tests/harness.html");
  await page.waitForFunction(() => window.apiReady === true);
}
