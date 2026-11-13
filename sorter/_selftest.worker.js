import { createSorter } from "./ordoline-sorter.js";

self.onmessage = async (e) => {
  try {
    const s = await createSorter({ executionProviders: ["wasm"] });
    const res = await s.sort(e.data); // URL strings
    self.postMessage({ noDocument: typeof document === "undefined", backend: s.model.backend, categories: res.results.map((r) => r.category) });
  } catch (err) {
    self.postMessage({ error: String(err) + " " + err.stack });
  }
};
