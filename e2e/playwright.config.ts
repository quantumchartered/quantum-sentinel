import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests of the operator console against an isolated API + database
 * (see start-server.mjs). Uses the installed Google Chrome, so no browser
 * download is needed. Tests share one database and run in order.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "../test-results",
  use: {
    baseURL: "http://127.0.0.1:4100",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  },
  webServer: {
    command: "node e2e/start-server.mjs",
    cwd: "..",
    url: "http://127.0.0.1:4100/health",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
