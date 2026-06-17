import { expect, test } from "@playwright/test";

test("renders streaming text, tool cards, trace rows, and context diffs", async ({ page }) => {
  await page.goto("/?scenario=tool-stream");

  await expect(page.getByRole("heading", { name: "Signal Yard" })).toBeVisible();
  await expect(page.getByText("orders.lookup")).toBeVisible();
  await expect(page.getByText("ACK sent")).toBeVisible();
  await expect(page.getByText("Trace Timeline")).toBeVisible();
  await expect(page.getByText("Context Inspector")).toBeVisible();
  await expect(page.getByRole("button", { name: "checkout-agent" })).toBeVisible();
  await expect(page.getByText("changed").first()).toBeVisible();
});

test("filters the trace timeline to tool rows", async ({ page }) => {
  await page.goto("/?scenario=rapid-tools");
  await expect(page.getByText("search.docs")).toBeVisible();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.getByText("TOOL_CALL").first()).toBeVisible();
  await expect(page.getByText("search.logs")).toBeVisible();
});

test("shows non-blocking reconnect and keeps composer editable", async ({ page }) => {
  await page.goto("/?scenario=reconnect");

  await expect(page.getByText("reconnecting")).toBeVisible();
  await page.getByLabel("Message").fill("operator note while resuming");
  await expect(page.getByLabel("Message")).toHaveValue("operator note while resuming");
  await expect(page.getByText("connected").first()).toBeVisible();
});

test("renders a large context through the virtual JSON inspector", async ({ page }) => {
  await page.goto("/?scenario=large-context");

  await expect(page.getByRole("button", { name: "large-eval" })).toBeVisible();
  await page.getByRole("button", { name: "large-eval" }).click();
  await expect(page.getByText("orders").first()).toBeVisible();
  await expect(page.getByText("limits").first()).toBeVisible();
});
