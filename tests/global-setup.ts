import { execFileSync } from "node:child_process";
import { ROOT } from "./helpers.ts";

/** Compile src/ to dist/ so the tests always run against the current TypeScript sources. */
export default function globalSetup(): void {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: ROOT, stdio: "inherit" });
}
