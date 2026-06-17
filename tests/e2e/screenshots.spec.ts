import { expect, test } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const screenshotDir = path.join(process.cwd(), "docs", "screenshots");
const recordingDir = path.join(process.cwd(), "docs", "recordings");

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

test.use({ video: "on" });

test("records the mandatory chaos scenario", async ({ page }) => {
  await mkdir(recordingDir, { recursive: true });

  await page.goto("/?scenario=chaos");
  await expect(page.getByText("Duplicate seq")).toBeVisible();
  await expect(page.getByText("Run complete")).toBeVisible();

  const video = page.video();
  await page.close();

  if (video) {
    await copyFile(await video.path(), path.join(recordingDir, "chaos.webm"));
  }
});
