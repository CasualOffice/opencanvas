// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14 S11: diagram mode on a 390 px phone, in the production build (phone project), with axe.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).include(".ocdg").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
/** Every visible button in `sel` is at least 44 × 44 CSS px. */
const small = (page: Page, sel: string) =>
  page.evaluate((s) => [...document.querySelectorAll<HTMLElement>(s)].filter((b) => b.offsetParent).map((b) => [b.getAttribute("aria-label") ?? b.textContent?.trim(), b.getBoundingClientRect()] as const).filter(([, r]) => r.width < 43.5 || r.height < 43.5).map(([n, r]) => `${n} ${r.width}x${r.height}`), sel);

test("S11: phone layout, bottom bar, selected shape, add and connect, options; targets 44 px; axe", async ({ page }) => {
  await openDemo(page, srv.url);
  // The demo board is a plain whiteboard: its cover opens it full screen; the options menu opens it as a diagram.
  const cover = page.locator(".ocbd-cover").first();
  await cover.scrollIntoViewIfNeeded();
  await cover.tap();
  await page.locator(".ocbd.ocbd-full").getByRole("button", { name: "Board options" }).tap();
  await page.getByRole("menuitem", { name: /Open as diagram/ }).tap();
  const dialog = page.getByRole("dialog", { name: /^Diagram: / });
  // The diagram chunk loads on first use.
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toHaveClass(/ocdg-phone/);
  // 11b: full screen, no side panel or rulers, the bottom bar.
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBe(390);
  await expect(dialog.getByRole("complementary", { name: "Properties" })).toBeHidden();
  const bar = dialog.getByRole("navigation", { name: "Diagram tools" });
  await expect(bar.getByRole("button")).toHaveText(["Select", "Pan", "Add", "Outline", "Undo"]);
  expect(await small(page, ".ocdg-pbar button, .ocdg-top button")).toEqual([]);
  await axe(page);

  // Select a shape through the outline sheet; 11c: the action bar.
  await bar.getByRole("button", { name: "Outline" }).tap();
  const outline = page.getByRole("dialog", { name: "Outline" });
  const first = outline.locator('[role="tree"] > [role="treeitem"]').first();
  const name = (await first.locator(".ocdg-on").textContent())!.trim();
  await first.tap();
  await expect(outline).toBeHidden();
  const acts = dialog.getByRole("toolbar", { name: `${name} actions` });
  await expect(acts).toBeVisible();
  expect(await small(page, ".ocdg-pact button")).toEqual([]);
  await acts.getByRole("button", { name: "Name and colour" }).tap();
  await expect(page.getByRole("dialog", { name })).toBeVisible();
  await axe(page);
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Close" }).tap();

  // 11d: add a shape connected to the selected one.
  const count = () => page.evaluate(() => document.querySelectorAll(".ocdg svg.ocbd-svg [data-s]").length);
  const n0 = await count();
  await bar.getByRole("button", { name: "Add" }).tap();
  const add = page.getByRole("dialog", { name: "Add a shape" });
  await expect(add.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await axe(page);
  await add.getByRole("button", { name: "Process" }).tap();
  await expect(add).toBeHidden();
  await expect.poll(count).toBeGreaterThan(n0);

  // 11e: options say what needs a larger screen.
  await dialog.getByRole("button", { name: "Board options" }).tap();
  const opts = page.getByRole("dialog", { name: "Diagram" });
  await expect(opts.getByRole("button", { name: /Auto-layout/ })).toBeDisabled();
  await expect(opts.getByRole("button", { name: "Export as PNG" })).toBeEnabled();
  expect(await small(page, ".ocdg-psheet button")).toEqual([]);
  await axe(page);
  const side = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  expect(side).toBe(true);
});
