// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14 S2: the shapes panel in the production build (demo document).
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

test("S2: search, click and drag shapes onto the canvas; the panel passes axe", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  await board.getByRole("button", { name: "Diagram", exact: true }).click();
  const dg = page.getByRole("dialog", { name: /^Diagram: / });
  await expect(dg).toBeVisible();
  const panel = dg.getByRole("complementary", { name: "Shapes" });
  await expect(panel.getByRole("button", { name: "Add Process" })).toBeVisible();
  const count = async () => Number(/(\d+) shapes?/.exec((await dg.locator(".ocbd").getAttribute("aria-label")) ?? "")?.[1] ?? -1);
  const n0 = await count();

  // "/" focuses search; the best match is first and Enter adds it.
  await dg.locator(".ocbd").focus();
  await page.keyboard.press("/");
  await expect(panel.getByRole("searchbox", { name: "Search shapes" })).toBeFocused();
  await page.keyboard.type("data");
  await expect(panel.locator(".ocdg-tile").first()).toHaveAttribute("data-kind", "network:database");
  await page.keyboard.press("Enter");
  await expect.poll(count).toBe(n0 + 1);
  await expect(dg.locator('g[data-kind="network:database"] path')).toHaveCount(1);

  // Drag a tile onto the canvas.
  const svg = (await dg.locator("svg.ocbd-svg").boundingBox())!;
  await panel.locator('.ocdg-tile[data-kind="flowchart:stored-data"]').dragTo(dg.locator("svg.ocbd-svg"), { targetPosition: { x: svg.width - 160, y: 140 } });
  await expect.poll(count).toBe(n0 + 2);
  await expect(dg.locator('g[data-kind="flowchart:stored-data"]')).toHaveCount(1);

  await page.evaluate(() => Promise.all(document.querySelector(".ocdg")!.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
  const r = await new AxeBuilder({ page }).include(".ocdg-left").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`)).toEqual([]);
  if (process.env.DGM_SHOT) await page.screenshot({ path: process.env.DGM_SHOT });
});
