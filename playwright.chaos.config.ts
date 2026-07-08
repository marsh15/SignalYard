import { defineConfig, devices } from "@playwright/test";

/**
 * Dedicated config for `npm run record:chaos`.
 *
 * The default `playwright.config.ts` excludes `*.manual.spec.ts` files from
 * `npm run test:e2e` because this recording depends on an external Docker
 * container (`agent-server --mode chaos`) and runs for several minutes. This
 * config drops that exclusion so the manual chaos recording can be invoked
 * directly and deterministically.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /chaos-live\.manual\.spec\.ts/,
  timeout: 6 * 60_000,
  expect: {
    timeout: 5_000
  },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
