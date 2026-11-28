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
    await expect(board.locator('[role="menu"].ocbd-ctx')).toHaveCount(0);
    // Q10: the click above may scroll the page to bring the item into view (the shape menu is
    // taller than the inline board and scrolls), so the shape is measured again before the drag;
    // with the old position the drag sometimes landed on a connector or the text below.
    const before = (await first.boundingBox())!;
    const at2 = await centre(first);
    await page.mouse.move(at2.x, at2.y);
    await page.mouse.down();
    await page.mouse.move(at2.x + 80, at2.y + 60, { steps: 6 });
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

test.describe("BRD-22: style panel and rotation", () => {
  test("Style docks inside the board, clear of the toolbar; stroke and width change the drawn rectangle", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    await board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: "Rectangle", exact: true }).click();
    const p = await emptySpot(board, -60, -60);
    await drawRect(page, p.x, p.y);
    await board.locator(".ocbd-swatch").getByRole("button", { name: "Style" }).click();
    const panel = board.getByRole("dialog", { name: "Style" });
    await expect(panel).toBeVisible();
    const pb = (await panel.boundingBox())!, bb = (await board.boundingBox())!, tb = (await board.locator(".ocbd-swatch").boundingBox())!;
    expect(pb.x + pb.width).toBeLessThanOrEqual(bb.x + bb.width + 0.5);
    expect(pb.y + pb.height).toBeLessThanOrEqual(bb.y + bb.height + 0.5);
    expect(pb.x >= tb.x + tb.width || pb.x + pb.width <= tb.x || pb.y >= tb.y + tb.height || pb.y + pb.height <= tb.y).toBe(true);
    await panel.getByRole("radiogroup", { name: "Stroke colour" }).getByRole("radio", { name: "Red" }).click();
    await panel.getByRole("radiogroup", { name: "Stroke width" }).getByRole("radio", { name: "Bold" }).click();
    const r = board.locator("g[data-s]").last().locator("rect").first();
    await expect(r).toHaveAttribute("stroke", "var(--red-fg)");
    await expect(r).toHaveAttribute("stroke-width", "4");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("the rotation handle turns a note in 15° steps; Alt turns it freely", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    const note = board.locator("g[data-s]").filter({ hasText: "Autosave" });
    const id = await note.getAttribute("data-s");
    const c = await centre(note);
    await page.mouse.click(c.x, c.y);
    const h = board.locator(`[data-rot][data-s="${id}"]`);
    await expect(h).toBeVisible();
    const hc = await centre(h);
    const rad = c.y - hc.y;
    // Drag the handle from straight above to about 50° clockwise: 45°.
    await page.mouse.move(hc.x, hc.y);
    await page.mouse.down();
    await page.mouse.move(c.x + Math.sin(0.5) * rad, c.y - Math.cos(0.5) * rad, { steps: 4 });
    await page.mouse.move(c.x + Math.sin((50 * Math.PI) / 180) * rad, c.y - Math.cos((50 * Math.PI) / 180) * rad, { steps: 4 });
    await page.mouse.up();
    const wrap = board.locator(`g[transform^="rotate("]:has(> g[data-s="${id}"])`);
    await expect(wrap).toHaveAttribute("transform", /^rotate\(45 /);
    // Shift+R adds 15°.
    await page.keyboard.press("Shift+R");
    await expect(wrap).toHaveAttribute("transform", /^rotate\(60 /);
  });
});

test.describe("Selection (decision 13)", () => {
  /** Two new rectangles side by side in the empty corner; returns their locators. */
  async function twoRects(page: Page, board: Locator) {
    const before = await board.locator("g[data-s]").count();
    await board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: "Rectangle", exact: true }).dblclick();
    const p = await emptySpot(board, -120, -80);
    await drawRect(page, p.x, p.y);
    await drawRect(page, p.x + 130, p.y);
    await page.keyboard.press("Escape");
    await expect(board.locator("g[data-s]")).toHaveCount(before + 2);
    return { p, a: board.locator("g[data-s]").nth(before), b: board.locator("g[data-s]").nth(before + 1) };
  }
  const rings = (board: Locator) => board.locator(".ocbd-selring").count();

  test("the marquee takes shapes fully inside; with Alt, those it touches", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    const { p } = await twoRects(page, board);
    // Around the first and half of the second.
    for (const alt of [false, true]) {
      await page.mouse.click(p.x - 30, p.y + 120);
      if (alt) await page.keyboard.down("Alt");
      await page.mouse.move(p.x - 15, p.y - 15);
      await page.mouse.down();
      await page.mouse.move(p.x + 80, p.y + 40, { steps: 4 });
      await page.mouse.move(p.x + 175, p.y + 65, { steps: 4 });
      await page.mouse.up();
      if (alt) await page.keyboard.up("Alt");
      expect(await rings(board)).toBe(alt ? 2 : 1);
    }
  });

  test("a side handle resizes one shape; a corner of two scales both", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    const { a, b } = await twoRects(page, board);
    const ra = a.locator("rect").first();
    await page.mouse.click((await centre(ra)).x, (await centre(ra)).y);
    const e = board.locator('[data-rz="e"]');
    await expect(board.locator("[data-rz]")).toHaveCount(8);
    const w0 = (await ra.boundingBox())!.width;
    const ec = await centre(e);
    await page.mouse.move(ec.x, ec.y);
    await page.mouse.down();
    await page.mouse.move(ec.x + 15, ec.y, { steps: 3 });
    await page.mouse.move(ec.x + 30, ec.y, { steps: 3 });
    await page.mouse.up();
    expect(Math.abs((await ra.boundingBox())!.width - (w0 + 30))).toBeLessThan(3);
    // Both: Shift-click the second; four corners; drag the bottom right one.
    const rb = b.locator("rect").first();
    const bw0 = (await rb.boundingBox())!.width;
    await page.keyboard.down("Shift");
    await page.mouse.click((await centre(rb)).x, (await centre(rb)).y);
    await page.keyboard.up("Shift");
    await expect(board.locator("[data-rz]")).toHaveCount(4);
    const se = await centre(board.locator('[data-rz="se"]'));
    await page.mouse.move(se.x, se.y);
    await page.mouse.down();
    await page.mouse.move(se.x + 20, se.y, { steps: 3 });
    await page.mouse.move(se.x + 40, se.y, { steps: 3 });
    await page.mouse.up();
    expect((await rb.boundingBox())!.width).toBeGreaterThan(bw0 + 5);
  });
});

test.describe("BRD-17: the diagram header at narrow widths (decision 8)", () => {
  type Box = { x: number; y: number; width: number; height: number };
  const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5;
  async function header(page: Page, w: number) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const board = await openDemo(page, srv.url);
    const cover = page.locator(".ocbd-cover").first();
    if (await cover.isVisible()) {
      // Compact layout: the cover opens the board full screen; its options open it as a diagram.
      await cover.click();
      await page.locator(".ocbd.ocbd-full").getByRole("button", { name: "Board options" }).click();
      await page.getByRole("menuitem", { name: /Open as diagram/ }).click();
    } else {
      await board.click({ position: { x: 40, y: 40 } });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Shift+D");
    }
    await expect(page.getByRole("dialog", { name: /^Diagram: / })).toBeVisible();
    return page.locator(".ocdg-top");
  }

  test("500 px: the title keeps 8 rem, nothing overlaps, the folded controls are in ⋯", async ({ page }) => {
    const top = await header(page, 500);
    // D11: today the title is squeezed to a letter or two.
    const crumb = (await top.locator(".ocdg-crumb").boundingBox())!;
    expect(crumb.width).toBeGreaterThanOrEqual(128 - 0.5);
    await expect(top).toHaveAttribute("data-fold", "tiny");
    const tb = (await top.boundingBox())!;
    const boxes = await top.locator(":scope > button:visible, :scope > ul, :scope > nav").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number }));
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].x + boxes[i].width).toBeLessThanOrEqual(tb.x + tb.width + 0.5);
      for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `controls ${i} and ${j} overlap`).toBe(false);
    }
    await expect(top.getByRole("button", { name: "Outline" })).toHaveCount(0);
    await top.getByRole("button", { name: "Board options" }).click();
    const menu = page.getByRole("menu", { name: "Board options" });
    await expect(menu.getByRole("menuitem", { name: /^Commands/ })).toBeVisible();
    await menu.getByRole("menuitem", { name: /^Auto-layout/ }).click();
    await expect(page.getByRole("dialog", { name: "Auto-layout" })).toBeVisible();
  });

  test("1280 px: Commands with its ⌘K chip, Outline and the document crumb", async ({ page }) => {
    const top = await header(page, 1280);
    await expect(top).toHaveAttribute("data-fold", "wide");
    await expect(top.locator(".ocdg-cmdk")).toContainText("⌘K");
    await expect(top.getByRole("button", { name: "Outline" })).toBeVisible();
  });
});

test.describe("Quick-connect (decision 10)", () => {
  test("hover previews; a click adds a connected rectangle on that side and takes typing", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    const before = await board.locator("g[data-s]").count();
    await board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: "Rectangle", exact: true }).click();
    const p = await emptySpot(board, -200, -60);
    await drawRect(page, p.x, p.y);
    const plus = board.locator('[data-qc="e"]');
    await expect(board.locator("[data-qc]")).toHaveCount(4);
    await plus.hover();
    await expect(board.locator(".ocbd-qcghost")).toBeVisible();
    await plus.click();
    // The new rectangle and its connector.
    await expect(board.locator("g[data-s]")).toHaveCount(before + 3);
    await page.keyboard.type("Next step");
    await expect(board.locator("textarea.ocbd-edit")).toHaveValue("Next step");
    await page.keyboard.press("Control+Enter");
    await expect(board.locator("g[data-s]").filter({ hasText: "Next step" })).toHaveCount(1);
    const first = (await board.locator("g[data-s]").nth(before).boundingBox())!;
    const made = (await board.locator("g[data-s]").filter({ hasText: "Next step" }).boundingBox())!;
    expect(made.x).toBeGreaterThan(first.x + first.width);
    expect(Math.abs(made.y - first.y)).toBeLessThan(2);
  });
});
