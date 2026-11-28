// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Whiteboard UX pass (BRD-17..22, docs/prototypes/board-ux-approved/board-ux.html) with a real
// mouse and real layout, in the production build, `#demo`. Unit tests: web/packages/board/src/ux-*.test.tsx.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

/** An empty spot on the demo board: right of the flow, above the bottom row. */
async function emptySpot(board: Locator, dx = 0, dy = 0) {
  const bb = (await board.boundingBox())!;
  return { x: bb.x + bb.width - 260 + dx, y: bb.y + bb.height - 150 + dy };
}
const order = (board: Locator) => board.locator("g[data-s]").evaluateAll((els) => els.map((e) => e.getAttribute("data-s")));
async function centre(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function drawRect(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 30, { steps: 3 });
  await page.mouse.move(x + 90, y + 50, { steps: 3 });
  await page.mouse.up();
}

test.describe("BRD-18: context menu", () => {
  test("right-click a shape: the menu opens at the pointer, hover opens Arrange, Bring to front reorders", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    // A sticky on its own (the first shape is a frame with a note on top of its middle).
    const first = board.locator("g[data-s]").filter({ hasText: "Autosave" });
    const id = await first.getAttribute("data-s");
    const at = await centre(first);
    await page.mouse.click(at.x, at.y, { button: "right" });
    const menu = board.locator('[role="menu"].ocbd-ctx').first();
    await expect(menu).toBeVisible();
    const mb = (await menu.boundingBox())!;
    const bb = (await board.boundingBox())!;
    expect(mb.x).toBeGreaterThanOrEqual(bb.x);
    expect(mb.x + mb.width).toBeLessThanOrEqual(bb.x + bb.width + 0.5);
    expect(mb.y + mb.height).toBeLessThanOrEqual(bb.y + bb.height + 0.5);
    await menu.getByRole("menuitem", { name: /^Arrange/ }).hover();
    const sub = board.getByRole("menu", { name: "Arrange" });
    await expect(sub).toBeVisible();
    await sub.getByRole("menuitem", { name: /Bring to front/ }).click();
    await expect(menu).toBeHidden();
    await expect.poll(async () => (await order(board)).at(-1)).toBe(id);
  });

  test("right-click empty canvas: the canvas menu; Escape closes it, focus back on the board", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    const p = await emptySpot(board);
    await page.mouse.click(p.x, p.y, { button: "right" });
    const menu = board.getByRole("menu", { name: "Board menu" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemcheckbox", { name: /Snap to objects/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(board).toBeFocused();
  });

  test("Lock from the menu: a dragged locked shape stays put", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    const first = board.locator("g[data-s]").filter({ hasText: "Autosave" });
    const at = await centre(first);
    await page.mouse.click(at.x, at.y, { button: "right" });
    await board.getByRole("menuitem", { name: /^Lock/ }).click();
    const before = (await first.boundingBox())!;
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 80, at.y + 60, { steps: 6 });
    await page.mouse.up();
    const after = (await first.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    await expect(board.locator(".ocbd-swatch").getByRole("button", { name: "Unlock" })).toBeVisible();
  });
});

test.describe("BRD-19: tool lock", () => {
  test("Q keeps the Rectangle tool for several shapes; Escape releases it", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    const before = await board.locator("g[data-s]").count();
    await board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: "Rectangle", exact: true }).click();
    await page.keyboard.press("q");
    await expect(board.getByRole("button", { name: "Keep tool active" })).toHaveAttribute("aria-pressed", "true");
    const p = await emptySpot(board, -60, -60);
    await drawRect(page, p.x, p.y);
    await drawRect(page, p.x + 120, p.y);
    await expect(board.locator("g[data-s]")).toHaveCount(before + 2);
    await expect(board.getByRole("button", { name: "Rectangle", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(board.getByRole("button", { name: "Select", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(board.getByRole("button", { name: "Keep tool active" })).toHaveAttribute("aria-pressed", "false");
  });

  test("double-clicking a tool locks it", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    await board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: "Rectangle", exact: true }).dblclick();
    await expect(board.getByRole("button", { name: "Keep tool active" })).toHaveAttribute("aria-pressed", "true");
  });
});
