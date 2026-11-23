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
