// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-17: diagram icons in the production build (demo document).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

async function axe(page: Page) {
  await page.evaluate(() => Promise.all(document.querySelector(".ocdg")!.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
  const r = await new AxeBuilder({ page }).include(".ocdg-left").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("Icons: the library, search “s3” and “jitsi”, placing an icon; the panel passes axe", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  await board.getByRole("button", { name: "Diagram", exact: true }).click();
  const dg = page.getByRole("dialog", { name: /^Diagram: / });
  await expect(dg).toBeVisible();
  const panel = dg.getByRole("complementary", { name: "Shapes" });
  await expect(panel.locator('[data-library="icons"] .ocdg-tile[data-icon="server"]')).toBeVisible();
  await axe(page);

  const search = panel.getByRole("searchbox", { name: "Search shapes" });
  await search.fill("s3");
  await expect(panel.locator(".ocdg-tile").first()).toHaveAttribute("data-icon", "object-storage");
  await expect(panel.locator(".ocdg-ihint")).toContainText("not a vendor logo");
  await search.press("Enter");
  const icon = dg.locator('g[data-kind="icon:node"]');
  await expect(icon).toHaveCount(1);
  await expect(icon.locator("path").first()).toBeVisible();
  await expect(icon).toContainText("Object storage");

  await search.fill("jitsi");
  await expect(panel.getByText("No built-in icon for “jitsi”")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Add your own icon" })).toBeVisible();
  await expect(panel.locator(".ocdg-noicon .ocdg-tile")).toHaveCount(3);
  await axe(page);
  if (process.env.DGM_SHOT) await page.screenshot({ path: process.env.DGM_SHOT });
});

test("All icons: the full Lucide set loads lazily, searches and places with its paths", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  await board.getByRole("button", { name: "Diagram", exact: true }).click();
  const dg = page.getByRole("dialog", { name: /^Diagram: / });
  const panel = dg.getByRole("complementary", { name: "Shapes" });
  const all = panel.locator('[data-library="lucide"]');
  await all.locator(".ocdg-lh button").click();
  await expect(all.getByRole("combobox", { name: "Category" })).toBeVisible();
  await expect(all.locator(".ocdg-tile:not(:disabled)").first()).toBeVisible();
  // Virtualised: a window of tiles, not all 2,000+.
  expect(await all.locator(".ocdg-tile").count()).toBeLessThan(120);
  await all.getByRole("combobox", { name: "Category" }).selectOption("gaming");
  // Rocket is the 68th icon in Gaming: row 23, 4.5rem per row.
  await all.locator(".ocdg-allg").evaluate((el) => (el.scrollTop = 22 * 4.5 * parseFloat(getComputedStyle(document.documentElement).fontSize)));
  await expect(all.locator('.ocdg-tile[data-icon="lucide:rocket"]:not(:disabled)')).toBeVisible();
  await all.locator('.ocdg-tile[data-icon="lucide:rocket"]').click();
  const icon = dg.locator('g[data-kind="icon:node"]');
  await expect(icon).toHaveCount(1);
  await expect(icon.locator("path").first()).toBeVisible();
  await axe(page);

  await panel.getByRole("searchbox", { name: "Search shapes" }).fill("fish");
  await expect(panel.locator('section[aria-label="All icons"] .ocdg-tile[data-icon="lucide:fish"]:not(:disabled)')).toBeVisible();
  await axe(page);
});
