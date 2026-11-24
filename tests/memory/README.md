# Memory measurements

The sorter's memory in the browser, and a variant that uses less of it. **The variant is not part of `src/`.**
It lives here for comparison, and `src/` is unchanged.

| File | What it is |
|---|---|
| `sorter-strips/` | Modified `decode.ts`, `preprocess.ts`, `sorter.ts`, overlaid on a copy of `src/sorter/` |
| `build-variant.ts` | Builds that overlay (type-checked) to `dist/sorter-strips/` |
| `strips.spec.ts` | Playwright project `memory`: the variant gives bit-identical model input and the same results as `src/` |
| `measure-memory.ts` | Peak-memory report for both versions (Linux only, reads `/proc`) |

```bash
docker compose up -d
docker compose run --rm tests npx playwright test --project=memory   # equivalence tests (~5 s)
docker compose run --rm tests npm run measure:memory                 # memory report (~5 min)
```

## What the variant changes

In `src/`, a decoded photo exists as three full-size copies at once: the bitmap, a canvas of the same size, and
the `getImageData` array in JavaScript. A 24 MP photo is about 96 MB per copy. The array also stays referenced
during inference. The variant reads the bitmap in strips (~4 MB) through a small canvas and runs the first resize
pass strip by strip (`decodeToTensor` → `preprocessTiled`), so only the bitmap is full size. Pillow's resize
handles every row (horizontal pass) or column (vertical pass) independently, so the result is bit-identical. This
is checked by `strips.spec.ts` on wide and tall JPEGs and a transparent PNG.

## Results (2026-11-24)

Peak PSS of the page's renderer process (page + workers), headless Chromium in the `tests` container, in MB.
The rest of the browser (main, GPU, network and zygote processes) adds about 170 MB in every case. Ranges cover
main thread / worker and 1 / 4 threads.

| | `src/` | `sorter-strips` |
|---|---|---|
| Empty page | 56–58 | 57–58 |
| Loading the model (peak) | 325–338 (259 from cache) | 333–345 (271 from cache) |
| Sorting 640 px photos | 250–330 | 263–331 |
| Sorting 2080×1560 photos | 269–361 | 283–334 |
| **Sorting 6000×4000 (24 MP) photos** | **654–691** | **527–539** |
| After sorting, worker | 418–430 | 337–351 |
| After `dispose()`, worker (after ~6 s) | 80–85 | 80–85 |
| After `dispose()`, main thread | 220–234 | 222–230 |

- With 24 MP photos the whole browser needs ~830–860 MB with `src/`, and ~700–710 MB with the variant. That is
  within 768 MB, but with little room to spare, and the OS also needs memory.
- The number of threads changes memory by only ~10–25 MB.
- `dispose()` in worker mode frees everything, but only a few seconds later: the worker is terminated 1 s after
  `dispose()`, and with 4 threads the memory took up to ~5 s to be returned. It is not a leak.
- On the main thread, ~220 MB stays after `dispose()`, because WebAssembly memory cannot shrink.
- Loading the model peaks at ~330–345 MB, partly because of the copy that `sorter.ts` keeps for the Cache API.
  Neither version changes this.
