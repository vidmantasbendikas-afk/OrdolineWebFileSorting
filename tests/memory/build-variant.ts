// Copyright (c) 2026 UAB Agmis. All rights reserved.
/**
 * Builds the memory-saving variant of the sorter without touching src/: copies src/sorter/, overlays the modified
 * files from tests/memory/sorter-strips/ and compiles the result (type-checked) to dist/sorter-strips/, served next
 * to dist/sorter/ at /dist/sorter-strips/ordoline-sorter.js.
 *
 * The variant reads decoded photos in strips through a small canvas (decode.ts: decodeToTensor; preprocess.ts:
 * preprocessTiled), so a large photo never exists as a full-size RGBA array, and sorter.ts drops the pixels before
 * inference. tests/memory/strips.spec.ts checks that its model input is bit-identical to src/.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OVERLAY = `${ROOT}tests/memory/sorter-strips/`;
const WORK = `${ROOT}dist/.sorter-strips-src/`; // merged sources (dist/ is generated and gitignored)
export const VARIANT_DIR = "dist/sorter-strips";

export function buildVariant(): void {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(`${ROOT}src/sorter/`, WORK, { recursive: true });
  for (const file of readdirSync(OVERLAY)) cpSync(`${OVERLAY}${file}`, `${WORK}${file}`);
  writeFileSync(`${WORK}tsconfig.json`, JSON.stringify({
    extends: "../../tsconfig.build.json",
    compilerOptions: { rootDir: ".", outDir: `../../${VARIANT_DIR}`, declaration: false },
    include: ["*.ts"],
  }));
  execFileSync(`${ROOT}node_modules/.bin/tsc`, ["-p", `${WORK}tsconfig.json`], { stdio: "inherit" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildVariant();
