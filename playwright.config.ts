import { defineConfig } from "@playwright/test";

// Expects the app on BASE_URL and the model CDN on MODEL_CDN_URL: `docker compose up -d` provides both.
// In Docker (`docker compose run --rm tests`) the image's bundled Chromium is used; on the host, installed Google Chrome.
const inDocker = !!process.env.IN_DOCKER;

export default defineConfig({
  testDir: "tests",
  globalSetup: "./tests/global-setup.ts", // compiles src/ to dist/ before every run
  timeout: 120_000,
  workers: 1, // inference is CPU-heavy; parallel runs only slow each other down
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8000",
    channel: process.env.PW_CHANNEL ?? (inDocker ? undefined : "chrome"),
    headless: true,
  },
});
