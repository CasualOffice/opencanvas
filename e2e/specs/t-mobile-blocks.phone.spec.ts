// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// t. Acceptance (docs/23 Mobile, rows left BLOCKED before): tables and database cells and
//    views, board touch (tap to activate, one-finger pan, pinch, draw, move), the PDF viewer
//    in full screen, mentions and the people list. Runs on WebKit (iPhone) and Chromium (Pixel).
import path from "node:path";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { OC, ROOT } from "../env";
import { editor, sharedFile, shots, typeAfterHeading, blocksReady } from "../helpers";

async function demo(page: Page) {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await expect(page.locator(".ProseMirror p").first()).toBeVisible();
  await expect(page.locator(".app.compact")).toBeVisible();
  await blocksReady(page);
}
const noSideScroll = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1);
const phoneCtx = () => {
  const u = test.info().project.use;
  return { viewport: u.viewport, isMobile: u.isMobile, hasTouch: u.hasTouch, deviceScaleFactor: u.deviceScaleFactor, userAgent: u.userAgent };
};

/** Touch pointer events at viewport points, dispatched on whatever is under each finger. */
async function touch(target: Locator, steps: { type: "pointerdown" | "pointermove" | "pointerup"; id: number; x: number; y: number }[]) {
  await target.evaluate((_el, steps) => {
    for (const s of steps) {
      const el = document.elementFromPoint(s.x, s.y) ?? document.body;
      el.dispatchEvent(
        new PointerEvent(s.type, { bubbles: true, cancelable: true, composed: true, pointerId: s.id, pointerType: "touch", isPrimary: s.id === 1, clientX: s.x, clientY: s.y, button: 0, buttons: s.type === "pointerup" ? 0 : 1 }),
      );
    }
  }, steps);
}
const drag = (id: number, x0: number, y0: number, dx: number, dy: number, n = 6) => [
  { type: "pointerdown" as const, id, x: x0, y: y0 },
  ...Array.from({ length: n }, (_, i) => ({ type: "pointermove" as const, id, x: x0 + (dx * (i + 1)) / n, y: y0 + (dy * (i + 1)) / n })),
  { type: "pointerup" as const, id, x: x0 + dx, y: y0 + dy },
];

test("MOB-04: a table on a phone: insert from the sheet, type in cells, no page overflow", async ({ page }) => {
  await demo(page);
  const last = page.locator(".ProseMirror > p").last();
  await last.scrollIntoViewIfNeeded();
  await last.tap();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  const sheet = page.locator(".sheet[role=dialog][aria-label=Insert]");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /Simple table/ }).first().tap();
  const table = page.locator(".ProseMirror table").last();
  await expect(table.locator("tr")).toHaveCount(3);
  await page.keyboard.type("Owner");
  await expect(table.locator("th").first()).toHaveText("Owner");
  // Tap a body cell and type into it.
  await table.locator("tr").nth(1).locator("td").first().tap();
  await page.keyboard.type("Priya");
  await expect(table.locator("tr").nth(1).locator("td").first()).toHaveText("Priya");
  expect(await noSideScroll(page)).toBe(true);
});

test("MOB-04: database cells and views on a phone: edit a cell, switch views, scroll inside the block", async ({ page }) => {
  await demo(page);
  const db = page.locator(".ocdb").first();
  await db.scrollIntoViewIfNeeded();
  const pts = db.getByRole("textbox", { name: "Points" }).first();
  await pts.scrollIntoViewIfNeeded();
  // Swipe the grid so the cell sits just right of the sticky title column, as a finger would
  // (scrolling it "into view" puts it under that column; see docs/23 MOB-04b).
  await pts.evaluate((el) => {
    const td = el.closest("td")!;
    let sc: HTMLElement | null = td.parentElement;
    while (sc && !(sc.scrollWidth > sc.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowX))) sc = sc.parentElement;
    const sticky = td.parentElement!.querySelector("td")!.getBoundingClientRect();
    sc!.scrollLeft += td.getBoundingClientRect().left - sticky.right;
  });
  await pts.tap({ position: { x: 8, y: 8 } });
  await expect(pts).toBeFocused();
  await pts.fill("42");
  await pts.press("Enter");
  await expect(pts).toHaveValue("42");
  // The table is wider than the phone: it scrolls inside the block, never the page.
  const scroller = await db.evaluate((el) => {
    const all = [el, ...el.querySelectorAll<HTMLElement>("*")];
    return all.some((x) => x.scrollWidth > x.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(x).overflowX));
  });
  expect(scroller, "the wide table scrolls inside the block").toBe(true);
  expect(await noSideScroll(page)).toBe(true);
  // Views.
  const tabs = db.getByRole("tablist", { name: "Views" });
  for (const v of ["Board", "Calendar", "Gallery", "Table"]) {
    await tabs.getByRole("tab", { name: v }).tap();
    await expect(tabs.getByRole("tab", { name: v })).toHaveAttribute("aria-selected", "true");
    expect(await noSideScroll(page), `${v} view keeps the page from scrolling sideways`).toBe(true);
  }
});

// docs/23 MOB-04b, prototype PhoneDb: the sticky title column is at most 132 px, truncates with an
// ellipsis, casts a soft edge once the grid scrolls, and a tap on a title opens the row.
test("MOB-04b: phone database: narrow sticky title, cells tappable once scrolled into view, title opens the row", async ({ page }) => {
  await demo(page);
  const db = page.locator(".ocdb").first();
  await db.scrollIntoViewIfNeeded();
  const first = db.locator(".ocdb-gw th").first();
  expect((await first.boundingBox())!.width).toBeLessThanOrEqual(132.5);
  const title = db.locator(".ocdb-ttl").first();
  await expect(title).toHaveCSS("text-overflow", "ellipsis");
  await expect(title).toHaveCSS("white-space", "nowrap");
  // The soft edge is always there (prototype PhoneDb), so cells read as passing under the title.
  const sticky = db.locator(".ocdb-gw tbody td").first();
  await expect(sticky).not.toHaveCSS("box-shadow", "none");
  await expect(db.locator(".ocdb-gw th").first()).not.toHaveCSS("box-shadow", "none");
  // A plain tap after the cell is scrolled into view reaches the cell, not the title column.
  const pts = db.getByRole("textbox", { name: "Points" }).first();
  await pts.scrollIntoViewIfNeeded();
  await pts.tap();
  await expect(pts).toBeFocused();
  await pts.fill("7");
  await pts.press("Enter");
  await expect(pts).toHaveValue("7");
  await db.locator(".ocdb-gw").evaluate((el) => {
    el.scrollLeft = 0;
    el.scrollLeft = 120;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(sticky).not.toHaveCSS("box-shadow", "none");
  await page.screenshot({ path: path.join(ROOT, `target/fix-shots/mob04b-${test.info().project.name}.png`) });
  if (test.info().project.name === "webkit-phone") await shots(page, "3-phone-db-390");
  expect(await noSideScroll(page)).toBe(true);
  const name = (await title.textContent())!.trim();
  await title.tap();
  await expect(page.getByRole("dialog", { name: `${name}: row details` })).toBeVisible();
});

test("MOB-05: board touch: tap to activate, one-finger pan, pinch, draw and move a shape", async ({ page }) => {
  await demo(page);
  const cover = page.locator(".ocbd-cover").first();
  await cover.scrollIntoViewIfNeeded();
  await expect(cover).toContainText("Tap to open board");
  await cover.tap();
  const board = page.locator(".ocbd.ocbd-full");
  await expect(board).toBeVisible();
  const svg = board.locator("svg.ocbd-svg");
  const view = () => svg.locator(":scope > g[transform]").first().getAttribute("transform");
  const parse = (t: string | null) => {
    const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(t ?? "")!;
    return { tx: +m[1], ty: +m[2], z: +m[3] };
  };
  const r = (await svg.boundingBox())!;
  // An empty spot to put a finger on.
  const empty = await svg.evaluate((el) => {
    const b = el.getBoundingClientRect();
    for (let y = b.top + b.height * 0.85; y > b.top + 60; y -= 17)
      for (let x = b.left + 30; x < b.right - 30; x += 23) {
        const hit = document.elementFromPoint(x, y);
        if (hit && el.contains(hit) && !hit.closest("[data-s]")) return { x, y };
      }
    return null;
  });
  expect(empty, "an empty spot on the board").not.toBeNull();

  // Move a shape (before the view changes): a finger on the shape drags it.
  const shape = svg.locator("text", { hasText: "Every edit merges live" }).first();
  const b0 = (await shape.boundingBox())!;
  await touch(svg, drag(5, b0.x + b0.width / 2, b0.y + b0.height / 2, 40, 30));
  await expect.poll(async () => Math.round((await shape.boundingBox())!.x - b0.x)).toBeGreaterThan(20);
  // One finger on empty canvas pans.
  const v0 = parse(await view());
  await touch(svg, drag(1, empty!.x, empty!.y, 60, -40));
  await expect.poll(async () => Math.round(parse(await view()).tx - v0.tx)).toBe(60);
  // Two fingers pinch out: zoom in.
  const v1 = parse(await view());
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  await touch(svg, [
    { type: "pointerdown", id: 1, x: cx - 30, y: cy },
    { type: "pointerdown", id: 2, x: cx + 30, y: cy },
    { type: "pointermove", id: 1, x: cx - 60, y: cy },
    { type: "pointermove", id: 2, x: cx + 60, y: cy },
    { type: "pointerup", id: 1, x: cx - 60, y: cy },
    { type: "pointerup", id: 2, x: cx + 60, y: cy },
  ]);
  await expect.poll(async () => parse(await view()).z).toBeGreaterThan(v1.z * 1.5);

  // Draw with the pen.
  const count = async () => Number(/(\d+) shapes?/.exec((await board.getAttribute("aria-label")) ?? "")![1]);
  const n0 = await count();
  await board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: "Pen" }).tap();
  await touch(svg, drag(3, empty!.x, empty!.y, 50, -30));
  await expect.poll(count).toBe(n0 + 1);

  expect(await noSideScroll(page)).toBe(true);
});

test("MOB-07: mentions and the people list on a phone", async ({ page }) => {
  await demo(page);
  const last = page.locator(".ProseMirror > p").last();
  await last.scrollIntoViewIfNeeded();
  await last.tap();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ask @");
  const para = page.locator(".ProseMirror > p").filter({ hasText: "Ask" }).last();
  const opt = page.locator(".mi").filter({ hasText: /Asha|Ravi|Sam|Priya/ }).first();
  await expect(opt).toBeVisible();
  const box = (await opt.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(vw + 1);
  expect(box.height, "mention option is a usable tap target").toBeGreaterThanOrEqual(24);
  await opt.tap();
  await expect(para.locator(".mention")).toHaveCount(1);
  expect(await noSideScroll(page)).toBe(true);

  // People list: the avatar stack in the top bar.
  const avs = page.locator(".avs");
  await expect(avs).toBeVisible();
  const more = avs.getByRole("button", { name: /more people here/ });
  if (await more.count()) {
    await more.tap();
    const pop = page.getByRole("dialog", { name: "People here" }).or(page.locator(".pop").filter({ hasText: "(you)" }));
    await expect(pop.first()).toBeVisible();
    const pb = (await pop.first().boundingBox())!;
    expect(pb.x).toBeGreaterThanOrEqual(-1);
    expect(pb.x + pb.width).toBeLessThanOrEqual(vw + 1);
  } else {
    const first = avs.locator(".av").first();
    const ab = (await first.boundingBox())!;
    expect(ab.width).toBeGreaterThanOrEqual(24);
    expect(ab.x + ab.width).toBeLessThanOrEqual(vw + 1);
  }
  expect(await noSideScroll(page)).toBe(true);
});

const PDF = path.join(ROOT, "e2e/fixtures/three-pages.pdf");

test("MOB-06: a PDF on a phone: inline preview, full-screen viewer that fits, back", async ({ browser }) => {
  test.setTimeout(90_000);
  const { priya, sam } = await sharedFile(browser, { name: "E2E t · phone pdf", samRole: "view", ctx: phoneCtx() });
  const oc: FrameLocator = priya.oc;
  await typeAfterHeading(priya, "Notes", "");
  await priya.page.keyboard.type("/file");
  const sheet = oc.locator(".sheet[role=dialog][aria-label=Insert]");
  await expect(sheet).toBeVisible();
  const [chooser] = await Promise.all([priya.page.waitForEvent("filechooser"), sheet.getByRole("button", { name: /^File/ }).first().tap()]);
  await chooser.setFiles(PDF);
  const inline = oc.locator('.filev[data-display="preview"]');
  await expect(inline.locator(".pdfpg")).toHaveText("1 / 3", { timeout: 15_000 });
  await inline.getByRole("button", { name: "Expand to full screen" }).tap();
  const viewer = oc.getByRole("dialog", { name: /^Preview of three-pages\.pdf/ });
  await expect(viewer).toBeVisible();
  await expect(oc.locator('.ocviewer .pdfpage[data-page="1"] canvas')).toBeVisible({ timeout: 15_000 });
  await oc.locator(".ocviewer").evaluate((v) => Promise.all(v.getAnimations({ subtree: true }).map((x) => x.finished.catch(() => undefined))));
  const frame = (await priya.page.locator('iframe[name="oc"]').boundingBox())!;
  const vb = (await oc.locator(".ocviewer").boundingBox())!;
  expect(vb.x).toBeGreaterThanOrEqual(frame.x - 1);
  expect(vb.x + vb.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
  const pg = (await oc.locator('.ocviewer .pdfpage[data-page="1"] canvas').boundingBox())!;
  expect(pg.x + pg.width, "the page fits the phone width").toBeLessThanOrEqual(frame.x + frame.width + 1);
  // Close is on screen (on a 360 px phone the bar used to push it off; fixed in app.css).
  const close = viewer.getByRole("button", { name: /^Close/ }).first();
  const cb = (await close.boundingBox())!;
  expect(cb.x + cb.width, "Close fits the phone width").toBeLessThanOrEqual(frame.x + frame.width + 1);
  expect(cb.width).toBeGreaterThanOrEqual(24);
  // Emulated Chromium enters element full screen here and Playwright cannot tap inside it;
  // a click event stands in for the tap there. WebKit (no element full screen) taps.
  if (test.info().project.name === "webkit-phone") await close.tap();
  else await close.dispatchEvent("click");
  await expect(viewer).toHaveCount(0);
  await expect(editor(sam)).toBeVisible();
  await priya.ctx.close();
  await sam.ctx.close();
});
