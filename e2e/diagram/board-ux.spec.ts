// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Whiteboard UX pass (board UX prototype, decisions 6, 7, 11, 12) in the production build, with a
// real mouse: export and copy as image, frames and Present, the empty board, working together.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

async function menu(page: Page, board: Locator, name: string | RegExp) {
  await board.getByRole("button", { name: "Board options" }).click();
  await board.getByRole("menuitem", { name }).click();
}

test("BRD-20: export dialog downloads a dark SVG and copies a PNG", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const board = await openDemo(page, srv.url);
  await menu(page, board, /^Export…/);
  const dlg = board.getByRole("dialog", { name: "Export board" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("radiogroup", { name: "Background" }).getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  await dlg.getByRole("radiogroup", { name: "Background" }).getByRole("radio", { name: "Dark" }).click();
  await dlg.getByRole("radiogroup", { name: "Format" }).getByRole("radio", { name: "SVG" }).click();
  await expect(dlg.getByRole("radiogroup", { name: "Scale" })).toHaveCount(0);
  const [dl] = await Promise.all([page.waitForEvent("download"), dlg.getByRole("button", { name: "Download" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/\.svg$/);
  const text = await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  expect(text).toContain('fill="#141417"');

  await dlg.getByRole("radiogroup", { name: "Format" }).getByRole("radio", { name: "PNG" }).click();
  await dlg.getByRole("radiogroup", { name: "Scale" }).getByRole("radio", { name: "3×" }).click();
  await dlg.getByRole("button", { name: "Copy PNG" }).click();
  await expect(dlg).toHaveCount(0);
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => [...i.types]));
  expect(types).toContain("image/png");
  // The background choice is remembered.
  await menu(page, board, /^Export…/);
  await expect(board.getByRole("dialog").getByRole("radiogroup", { name: "Background" }).getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
});
