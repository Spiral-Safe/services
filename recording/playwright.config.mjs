import { resolve } from "node:path";
import { defineConfig } from "playwright/test";

export const recordingDefaults = Object.freeze({
  viewport: Object.freeze({ width: 1440, height: 900 }),
  videoSize: Object.freeze({ width: 1440, height: 900 }),
  colorScheme: "dark",
  actionTimeoutMs: 20_000,
  holdMs: 900,
  settleMs: 650,
});

// This standard Playwright config also documents the capture contract for tools
// that inspect the repository. The custom recorder consumes the same defaults.
export default defineConfig({
  outputDir: resolve("recording/output/.playwright"),
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: {
    viewport: recordingDefaults.viewport,
    colorScheme: recordingDefaults.colorScheme,
    bypassCSP: true,
    actionTimeout: recordingDefaults.actionTimeoutMs,
    screenshot: "on",
    trace: "on",
    video: "on",
  },
});
