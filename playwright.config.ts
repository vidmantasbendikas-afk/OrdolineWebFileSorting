import { defineConfig } from "@playwright/test";

// Two projects:
//   unit     tests/unit/*.test.ts: pure TypeScript (Node, no browser, no servers), runs in about a second
//   browser  tests/*.spec.ts: the app on BASE_URL and the model CDN on MODEL_CDN_URL (`docker compose up -d`)
//   memory   tests/memory/*.spec.ts: the memory-saving sorter variant compared with src/ (same servers)
// In Docker (`docker compose run --rm tests`) the image's bundled Chromium is used; on the host, installed Google Chrome.
const inDocker = !!process.env.IN_DOCKER;

export default defineConfig({
  testDir: "tests",
  globalSetup: "./tests/global-setup.ts", // compiles src/ to dist/ before every run
  timeout: 120_000,
  workers: 1, // inference is CPU-heavy; parallel runs only slow each other down
  reporter: [["list"]],
  projects: [
    { name: "unit", testMatch: "unit/**/*.test.ts" },
    { name: "browser", testMatch: "*.spec.ts", testIgnore: "memory/**" },
    // tests/memory: the memory-saving variant (tests/memory/sorter-strips) against src/; also needs the servers
    { name: "memory", testMatch: "memory/**/*.spec.ts" },
  ],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8000",
    channel: process.env.PW_CHANNEL ?? (inDocker ? undefined : "chrome"),
    headless: true,
  },
});
