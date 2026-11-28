// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Board audit fixes (docs/41) that need a real browser: a real mouse (BRD-05, BRD-07), layout
// (BRD-08, BRD-10, BRD-11) and the demo's save status (BRD-14). In the production build, `#demo`.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** An empty spot on the demo board: right of the flow, above the bottom row. */
async function emptySpot(board: Locator, dx = 0, dy = 0) {
  const bb = (await board.boundingBox())!;
  return { x: bb.x + bb.width - 260 + dx, y: bb.y + bb.height - 150 + dy };
}
async function tool(board: Locator, name: string) {
  await board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name, exact: true }).click();
}
const texts = (board: Locator) => board.locator("g[data-s]").evaluateAll((els) => els.map((e) => e.textContent ?? ""));

test("BRD-05: a sticky note and a text placed with the mouse take typing at once", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  const p = await emptySpot(board);
  await tool(board, "Sticky note");
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type("Typed with a mouse");
  await expect(board.locator("textarea.ocbd-edit")).toHaveValue("Typed with a mouse");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => texts(board)).toContainEqual(expect.stringMatching(/Typed with a\s*mouse/));
  // The letters went into the note, not to the tool shortcuts (W, T, H... would switch tools).
  await expect(board.getByRole("button", { name: "Select", exact: true })).toHaveAttribute("aria-pressed", "true");

  await tool(board, "Text");
  await page.mouse.click(p.x - 400, p.y + 60);
  await page.keyboard.type("Free text");
  await page.keyboard.press("Enter");
  await expect.poll(() => texts(board)).toContainEqual(expect.stringContaining("Free text"));
});

test("BRD-07: dragging with the rectangle tool sizes the rectangle", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  const p = await emptySpot(board, -60, -40);
  const before = await board.locator("g[data-s]").count();
  await tool(board, "Rectangle");
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 100, p.y + 40, { steps: 4 });
  await page.mouse.move(p.x + 200, p.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect(board.locator("g[data-s]")).toHaveCount(before + 1);
  const r = (await board.locator("g[data-s]").last().locator("rect").first().boundingBox())!;
  expect(Math.abs(r.width - 200)).toBeLessThan(6);
  expect(Math.abs(r.height - 100)).toBeLessThan(6);
  expect(Math.abs(r.x - p.x)).toBeLessThan(6);
});

test("BRD-10: the shape toolbar never covers the board's own controls", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  const controls = async () => {
    const out: Box[] = [];
    for (const l of [board.locator(".ocbd-top"), board.getByRole("toolbar", { name: "Board tools" }), board.getByRole("group", { name: "Zoom" })]) {
      const b = await l.boundingBox();
      if (b) out.push(b);
    }
    return out;
  };
  // A shape in the top right corner, under the top actions, and one at the bottom right, by the zoom pill.
  const bb = (await board.boundingBox())!;
  for (const [x, y] of [[bb.x + bb.width - 120, bb.y + 60], [bb.x + bb.width - 120, bb.y + bb.height - 70]]) {
    await tool(board, "Rectangle");
    await page.mouse.click(x, y);
    const bar = board.locator(".ocbd-swatch");
    await expect(bar).toBeVisible();
    const b = (await bar.boundingBox())!;
    for (const c of await controls()) expect(overlap(b, c), `toolbar at ${Math.round(b.x)},${Math.round(b.y)} over a control at ${Math.round(c.x)},${Math.round(c.y)}`).toBe(false);
    await page.keyboard.press("Escape");
  }
  // Both of them selected (a tall selection on the right): the align toolbar has room neither
  // above nor below, and must still keep off the top actions and the zoom pill.
  await page.mouse.click(bb.x + bb.width - 120, bb.y + bb.height - 70);
  await page.keyboard.down("Shift");
  await page.mouse.click(bb.x + bb.width - 120, bb.y + 60);
  await page.keyboard.up("Shift");
  await expect(board.locator(".ocbd-swatch")).toHaveAttribute("aria-label", "2 shapes");
  const b = (await board.locator(".ocbd-swatch").boundingBox())!;
  for (const c of await controls()) expect(overlap(b, c), "align toolbar over a control").toBe(false);
});

async function diagram(page: Page) {
  const board = await openDemo(page, srv.url);
  await board.getByRole("button", { name: "Diagram", exact: true }).click();
  const dg = page.getByRole("dialog", { name: /^Diagram: / });
  await expect(dg).toBeVisible();
  return dg;
}

test("BRD-08: the auto-layout preview bar is whole, on screen, at the bottom", async ({ page }) => {
  test.setTimeout(120_000);
  const dg = await diagram(page);
  await page.keyboard.press("Shift+L");
  const pop = dg.getByRole("dialog", { name: "Auto-layout" });
  await pop.getByRole("button", { name: "Preview" }).click();
  const bar = dg.getByRole("region", { name: "Layout preview" });
  await expect(bar).toBeVisible();
  const b = (await bar.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(b.y).toBeGreaterThan(vh / 2);
  expect(b.y + b.height).toBeLessThanOrEqual(vh);
  await bar.getByRole("button", { name: "Cancel" }).click();
});

test("BRD-11: the libraries chooser fits a short window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const dg = await diagram(page);
  await dg.getByRole("button", { name: /^Libraries/ }).click();
  const ch = page.locator(".ocdg-chooser");
  await expect(ch).toBeVisible();
  const b = (await ch.boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(0);
  await expect(ch.getByRole("button", { name: "Done" })).toBeInViewport();
});

test("BRD-14: the demo never says Saved, because nothing is saved", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  const p = await emptySpot(board);
  await tool(board, "Rectangle");
  await page.mouse.click(p.x, p.y);
  const status = page.locator("button.status");
  await expect(status).toContainText(/not saved/i);
});
