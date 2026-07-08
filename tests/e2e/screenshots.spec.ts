import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const screenshotDir = path.join(process.cwd(), "docs", "screenshots");

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Desktop Chromium captures the deliverable artifacts once.");
});

test("captures tool stream, trace, and context diff screenshots", async ({ page }) => {
  await mkdir(screenshotDir, { recursive: true });

  await page.goto("/?scenario=tool-stream");
  await expect(page.getByText("orders.lookup")).toBeVisible();
  await page.screenshot({
    path: path.join(screenshotDir, "tool-stream.png"),
    fullPage: true
  });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.screenshot({
    path: path.join(screenshotDir, "trace-tools-filter.png"),
    fullPage: true
  });

  await page.getByRole("button", { name: "checkout-agent" }).click();
  await page.screenshot({
    path: path.join(screenshotDir, "context-diff.png"),
    fullPage: true
  });
});

// The mandatory chaos-mode recording (docs/recordings/chaos.webm) is produced
// separately by `npm run record:chaos` (tests/e2e/chaos-live.manual.spec.ts)
// against the real Dockerized agent-server in --mode chaos, not by this
// deterministic harness. That keeps this fast default suite independent of
// Docker while ensuring the actual deliverable reflects real server behavior.
