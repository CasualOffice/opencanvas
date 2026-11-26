// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SCALE-02 / UX4-01 acceptance (docs/prototypes/v04-approved/board-toolbar.html, option A): at
// 1280 × 200% (640 × 450 CSS px), a 24 px root and 320 px, with and without the side panel, no
// part of the board's bottom row overlaps another control and every tool is reachable (in the bar
// or in More). Checked on the board's bounding boxes, with axe under reduced motion.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

const ALL = ["Select", "Sticky note", "Pen", "Text", "Rectangle", "Arrow", "Ellipse", "Diamond", "Pan"];
type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** The board, opened the way a person would at this size (compact boards open full screen). */
async function open(page: Page, w: number, h: number, root: number, side: boolean): Promise<Locator> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: w, height: h });
  if (root !== 16) await page.addInitScript((px) => document.addEventListener("DOMContentLoaded", () => (document.documentElement.style.fontSize = `${px}px`)), root);
  await openDemo(page, srv.url);
  if (side) {
    await page.getByRole("button", { name: /^Comments/ }).first().click();
    await expect(page.getByRole("complementary", { name: "Comments" })).toBeVisible();
  }
  const cover = page.locator(".ocbd-cover").first();
  if (await cover.isVisible()) {
    await cover.click();
    return page.locator(".ocbd.ocbd-full");
  }
  return page.locator(".ocbd").first();
}

async function check(page: Page, board: Locator) {
  const dock = board.locator(".ocbd-dock");
  await dock.scrollIntoViewIfNeeded();
  const bb = (await board.boundingBox())!;
  const bar = (await board.getByRole("toolbar", { name: "Board tools" }).boundingBox())!;
  const zoom = (await board.getByRole("group", { name: "Zoom" }).boundingBox())!;
  expect(overlap(bar, zoom), "tool bar and zoom pill overlap").toBe(false);
  for (const b of [bar, zoom]) {
    expect(b.x).toBeGreaterThanOrEqual(bb.x - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(bb.x + bb.width + 0.5);
  }
  const top = await board.locator(".ocbd-top").boundingBox();
  if (top) for (const b of [bar, zoom]) expect(overlap(top, b), "bottom row under the top actions").toBe(false);
  // Nothing covers any control in the row: the hit test at each centre lands on it.
  const covered = await dock.evaluate((d) =>
    [...d.querySelectorAll<HTMLElement>("button")]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !hit || !b.contains(hit);
      })
      .map((b) => b.getAttribute("aria-label")),
  );
  expect(covered).toEqual([]);
  // Every tool reachable: in the bar or in More.
  const shown = await board.locator(".ocbd-tool [data-tool]").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
  await board.getByRole("button", { name: /^More tools/ }).click();
  const menu = board.getByRole("menu", { name: "More tools" });
  await expect(menu).toBeVisible();
  const more = await menu.getByRole("menuitemradio").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
  expect([...shown, ...more]).toEqual(ALL);
  const mb = (await menu.boundingBox())!;
  expect(mb.y).toBeGreaterThanOrEqual(bb.y - 0.5);
  expect(mb.x + mb.width).toBeLessThanOrEqual(bb.x + bb.width + 0.5);
  const r = await new AxeBuilder({ page }).include(".ocbd-dock").include(".ocbd-moremenu").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return shown.length;
}

// At 640 CSS px the editor is in its compact layout: the board opens full screen over any side
// panel, so the side-panel case is checked at 1280 × 150% (853 CSS px, frame 2b) and a 24 px root.
test("1280 at 200% (640 × 450)", async ({ page }) => {
  const board = await open(page, 640, 450, 16, false);
  // Compact 44 px targets: Pan, the end of the priority order, is the one in More.
  expect(await check(page, board)).toBeGreaterThanOrEqual(8);
});
for (const side of [false, true]) {
  const s = side ? ", side panel open" : "";
  test(`1280 at 150% (853 × 533)${s}`, async ({ page }) => {
    await check(page, await open(page, 853, 533, 16, side));
  });
  test(`24 px root at 1280 × 800${s}`, async ({ page }) => {
    await check(page, await open(page, 1280, 800, 24, side));
  });
}

test("320 px: three tools, More and the 100% button, 44 px targets", async ({ page }) => {
  const board = await open(page, 320, 600, 16, false);
  expect(await check(page, board)).toBe(3);
  await expect(board.getByRole("button", { name: /^Zoom \d+%$/ })).toBeVisible();
  const small = await board.locator(".ocbd-dock button").evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.width < 43.5 || r.height < 43.5).length);
  expect(small).toBe(0);
});

test("Tools on the left: a rail that fits the board's height, every tool reachable", async ({ page }) => {
  const board = await open(page, 640, 450, 16, false);
  await board.locator(".ocbd-dock").scrollIntoViewIfNeeded();
  await board.getByRole("button", { name: /^More tools/ }).click();
  await board.getByRole("menuitemcheckbox", { name: "Tools on the left" }).click();
  await expect(board).toHaveAttribute("data-rail", "");
  const bar = (await board.getByRole("toolbar", { name: "Board tools" }).boundingBox())!;
  const zoom = (await board.getByRole("group", { name: "Zoom" }).boundingBox())!;
  expect(overlap(bar, zoom)).toBe(false);
  // Reset the personal setting for the next test.
  await board.getByRole("button", { name: /^More tools/ }).click();
  await board.getByRole("menuitemcheckbox", { name: "Tools on the left" }).click();
  await expect(board).not.toHaveAttribute("data-rail", "");
});
