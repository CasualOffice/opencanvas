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

test("decision 11: an emptied board shows hints and starters; a starter is one Undo step", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  const bb = (await board.boundingBox())!;
  // Empty the demo board: click empty canvas, select all, delete.
  await page.mouse.click(bb.x + bb.width - 40, bb.y + bb.height - 120);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  const empty = board.locator(".ocbd-empty");
  await expect(empty.getByRole("heading", { name: "Start your board" })).toBeVisible();
  await expect(empty).toContainText("double-click anywhere to type");
  await empty.getByRole("group", { name: "Start from a template" }).getByRole("button", { name: "Retrospective" }).click();
  await expect(empty).toHaveCount(0);
  await expect(board.locator("[data-frame-name]")).toHaveText(["Went well", "To improve", "Actions"]);
  await board.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(board.locator("[data-frame-name]")).toHaveCount(0);
  await expect(empty.getByRole("heading", { name: "Start your board" })).toBeVisible();
});

test("decision 12: Ravi's named cursor and avatar; Follow tracks his view until a zoom stops it", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  // The demo's Ravi is on the board (cursor and viewport in awareness).
  await expect(board.locator(".ocbd-cursor").filter({ hasText: "Ravi Menon" })).toHaveCount(1);
  const av = board.getByRole("group", { name: "People on this board" }).getByRole("button", { name: "Ravi Menon" });
  await av.click();
  const menu = board.getByRole("menu", { name: "Ravi Menon" });
  await expect(menu.getByRole("menuitem", { name: "Go to cursor" })).toBeEnabled();
  await menu.getByRole("menuitem", { name: "Follow" }).click();
  await expect(board.locator(".ocbd-follow")).toContainText("Following Ravi Menon");
  // His viewport is centred at (430, 200), zoom 1: that board point is in the middle of ours.
  const svg = (await board.locator("svg.ocbd-svg").boundingBox())!;
  const t = await board.locator("svg.ocbd-svg > g[transform]").getAttribute("transform");
  const [, tx, ty, z] = t!.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/)!.map(Number);
  expect(z).toBe(1);
  expect(Math.abs(tx! + 430 - svg.width / 2)).toBeLessThan(2);
  expect(Math.abs(ty! + 200 - svg.height / 2)).toBeLessThan(2);
  // A zoom of our own stops following.
  await page.mouse.move(svg.x + svg.width / 2, svg.y + svg.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect(board.locator(".ocbd-follow")).toHaveCount(0);
});

test("BRD-21 leftovers: ⇧F wraps, the drop target is outlined, Copy link to shape, Delete frame and contents", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const board = await openDemo(page, srv.url);
  const bb = (await board.boundingBox())!;
  // Two rectangles in the empty area right of the demo flow.
  const x0 = bb.x + bb.width - 300, y0 = bb.y + bb.height - 230;
  const made: string[] = [];
  for (const [x, y] of [[x0, y0], [x0 + 160, y0 + 30]]) {
    const had = await ids(board);
    await tool(board, "Rectangle");
    await page.mouse.click(x, y);
    await expect.poll(async () => (await ids(board)).length).toBe(had.length + 1);
    made.push((await ids(board)).find((v) => !had.includes(v))!);
    await page.keyboard.press("Escape");
  }
  const [a, b] = made;
  // Select both with the mouse and wrap them: ⇧F.
  const ra = await boxOf(board, a), rb = await boxOf(board, b);
  await page.mouse.click(ra.x + ra.width / 2, ra.y + ra.height / 2);
  await page.keyboard.down("Shift");
  await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.keyboard.up("Shift");
  await page.keyboard.press("Shift+F");
  await expect(board.locator(".ocbd-sr[role=status]")).toHaveText("Wrapped in Frame 1");
  const name = board.locator("[data-frame-name]").last();
  await expect(name).toHaveText("Frame 1");
  const fid = (await name.getAttribute("data-frame-name"))!;
  // Drag b out of the frame, then back in: while it is over the frame the frame is outlined.
  await page.keyboard.press("Escape");
  const drop = board.locator(`[data-drop-frame="${fid}"]`);
  const fb = (await board.locator(`g[data-frame="${fid}"] rect`).first().boundingBox())!;
  let r = await boxOf(board, b);
  const [cx, cy] = [r.x + r.width / 2, r.y + r.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy, { steps: 6 });
  await page.mouse.move(fb.x - 160, cy, { steps: 8 });
  await expect(drop).toHaveCount(0);
  await page.mouse.up();
  await expect(board.locator(".ocbd-sr[role=status]")).toHaveText("Removed from Frame 1");
  r = await boxOf(board, b);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + 60, cy, { steps: 6 });
  await page.mouse.move(cx, cy, { steps: 8 });
  await expect(drop).toHaveCount(1);
  await page.mouse.up();
  await expect(drop).toHaveCount(0);
  await expect(board.locator(".ocbd-sr[role=status]")).toHaveText("Added to Frame 1");
  // Copy link to shape (right-click): the demo's own link names the board block and the shape.
  r = await boxOf(board, a);
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2, { button: "right" });
  await board.getByRole("menuitem", { name: "Copy link to shape" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`#demo&block=[A-Za-z0-9_-]+&shape=${a}$`));
  await expect(page.getByText("Link to shape copied")).toBeVisible();
  // Right-click the frame's name: Delete frame and contents takes it and both rectangles.
  await page.keyboard.press("Escape");
  // (Clicking a menu item can scroll the page to it: measure again.)
  await name.scrollIntoViewIfNeeded();
  const n = (await name.boundingBox())!;
  await page.mouse.click(n.x + 10, n.y + n.height / 2, { button: "right" });
  await board.getByRole("menuitem", { name: "Delete frame and contents" }).click();
  await expect(board.locator(`[data-frame-name="${fid}"]`)).toHaveCount(0);
  expect((await ids(board)).filter((v) => made.includes(v) || v === fid)).toEqual([]);
});

async function tool(board: Locator, name: string) {
  await board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name, exact: true }).click();
}
/** A shape's screen box by its id. */
const boxOf = async (board: Locator, id: string) => (await board.locator(`g[data-s="${id}"] rect`).first().boundingBox())!;
const ids = (board: Locator) => board.locator("g[data-s]").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-s")!))]);

test("BRD-21: draw a frame with F, drop a shape in it, move the frame, present", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  const bb = (await board.boundingBox())!;
  // An empty area right of the demo flow, above the bottom row.
  const x0 = bb.x + bb.width - 330, y0 = bb.y + bb.height - 260;
  await tool(board, "Frame");
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 120, y0 + 80, { steps: 4 });
  await page.mouse.move(x0 + 260, y0 + 160, { steps: 4 });
  await page.mouse.up();
  const name = board.locator("[data-frame-name]").last();
  await expect(name).toHaveText("Frame 1");
  const fid = (await name.getAttribute("data-frame-name"))!;
  // Clicking inside the frame reaches the canvas: the rectangle tool places a shape there.
  const had = await ids(board);
  await tool(board, "Rectangle");
  await page.mouse.click(x0 + 90, y0 + 70);
  await expect.poll(async () => (await ids(board)).length).toBe(had.length + 1);
  const rid = (await ids(board)).find((v) => !had.includes(v))!;
  await page.keyboard.press("Escape");
  // Drop it again inside the frame (centre-drop): it joins and says so.
  const r = await boxOf(board, rid);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + 10, r.y + r.height / 2 + 5, { steps: 5 });
  await page.mouse.move(r.x + r.width / 2 + 20, r.y + r.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
  await expect(board.locator(".ocbd-sr[role=status]")).toHaveText("Added to Frame 1");
  // Dragging the frame by its name moves the shape with it. (Esc first: the shape's toolbar sits above it.)
  await page.keyboard.press("Escape");
  await expect(board.locator(".ocbd-swatch")).toHaveCount(0);
  const before = await boxOf(board, rid);
  const n = (await name.boundingBox())!;
  await page.mouse.move(n.x + 10, n.y + n.height / 2);
  await page.mouse.down();
  await page.mouse.move(n.x - 20, n.y + n.height / 2 - 10, { steps: 5 });
  await page.mouse.move(n.x - 50, n.y + n.height / 2 - 20, { steps: 5 });
  await page.mouse.up();
  const after = await boxOf(board, rid);
  expect(Math.abs(after.x - before.x + 60)).toBeLessThan(3);
  expect(Math.abs(after.y - before.y + 20)).toBeLessThan(3);
  // The zoom area lists frames; Present steps through them and Esc ends.
  await board.getByRole("button", { name: "Frames" }).click();
  await expect(board.getByRole("menu", { name: "Zoom" }).getByRole("menuitem", { name: "Frame 1" })).toBeVisible();
  await page.keyboard.press("Escape");
  await board.locator(`[data-frame-name="${fid}"]`).click();
  await page.keyboard.press("Shift+P");
  const pres = page.getByRole("dialog", { name: "Presenting frames" });
  await expect(pres).toBeVisible();
  await expect(pres).toContainText("Frame 1");
  await page.keyboard.press("Escape");
  await expect(pres).toHaveCount(0);
});
