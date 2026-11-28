// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Whiteboard QA pass (docs/41 §7, BRD-33..): defects found with a real mouse and keyboard in the
// production build, `#demo`. Each test was seen failing before its fix.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

const pressed = (board: Locator) => board.locator('.ocbd-tool [aria-pressed="true"]').first();
async function click(page: Page, l: Locator) {
  const b = (await l.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
/** The number of shapes on the demo's board, read from its Y.Doc. */
const count = (page: Page) =>
  page.evaluate(() => {
    const ed = (window as unknown as { __ocEditor: { extensionManager: { extensions: { name: string; options: { document: { getMap(n: string): Map<string, { get(k: string): { length: number } }> } } }[] } } }).__ocEditor;
    const boards = ed.extensionManager.extensions.find((e) => e.name === "collaboration")!.options.document.getMap("boards");
    return [...boards.values()][0].get("order").length;
  });

test.describe("BRD-33: keyboard focus survives full screen and Present", () => {
  test("after Full screen and Exit full screen (mouse), tool shortcuts still reach the board", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    await click(page, board.getByRole("button", { name: "Full screen" }));
    const full = page.locator(".ocbd-full");
    await expect(full).toBeVisible();
    await page.keyboard.press("r");
    await expect(pressed(full)).toHaveAttribute("aria-label", "Rectangle");
    await click(page, full.getByRole("button", { name: "Exit full screen" }));
    await expect(full).toBeHidden();
    await page.keyboard.press("o");
    await expect(pressed(page.locator(".ocbd").first())).toHaveAttribute("aria-label", "Ellipse");
  });

  test("Escape out of Present: focus is back on the board, so Undo works at once", async ({ page }) => {
    const board = await openDemo(page, srv.url);
    await click(page, board.getByRole("button", { name: "Full screen" }));
    const full = page.locator(".ocbd-full");
    await expect(full).toBeVisible();
    const n0 = await count(page);
    await page.keyboard.press("f");
    await page.mouse.move(150, 600);
    await page.mouse.down();
    await page.mouse.move(400, 780, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => count(page)).toBe(n0 + 1);
    await page.keyboard.press("Shift+P");
    await expect(page.getByRole("dialog", { name: "Presenting frames" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Presenting frames" })).toBeHidden();
    await expect(full).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => count(page)).toBe(n0);
  });
});

test("BRD-34: the diagram opened from full screen is named after the heading above the board", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  await click(page, board.getByRole("button", { name: "Full screen" }));
  const full = page.locator(".ocbd-full");
  await expect(full).toBeVisible();
  await click(page, full.getByRole("button", { name: "Diagram" }));
  await expect(page.locator(".ocdg-name").first()).toHaveText("How a session flows");
});

test("D12: a shape placed by a click next to the board's controls lands clear of them", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  type B = { x: number; y: number; width: number; height: number };
  const hit = (a: B, b: B) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const top = (await board.locator(".ocbd-top").boundingBox())!;
  const zoom = (await board.locator(".ocbd-zoom").boundingBox())!;
  const bar = (await board.locator(".ocbd-tool").boundingBox())!;
  const spots: [string, number, number][] = [
    ["Sticky note", top.x + 40, top.y + top.height + 10],
    ["Sticky note", zoom.x + 30, zoom.y - 10],
    ["Rectangle", bar.x + bar.width - 20, bar.y - 10],
  ];
  for (const [tool, x, y] of spots) {
    await click(page, board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: tool }));
    const n = await count(page);
    await page.mouse.click(x, y);
    await expect.poll(() => count(page)).toBe(n + 1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const id = await page.evaluate(() => {
      const ed = (window as unknown as { __ocEditor: { extensionManager: { extensions: { name: string; options: { document: { getMap(n: string): Map<string, { get(k: string): { toArray(): string[] } }> } } }[] } } }).__ocEditor;
      const boards = ed.extensionManager.extensions.find((e) => e.name === "collaboration")!.options.document.getMap("boards");
      return [...boards.values()][0].get("order").toArray().at(-1)!;
    });
    const r = (await board.locator(`g[data-s="${id}"]`).boundingBox())!;
    for (const [name, c] of [["top actions", top], ["zoom pill", zoom], ["tool bar", bar]] as const) expect(hit(r, c), `${tool} at ${x},${y} under the ${name}`).toBe(false);
  }
});

test("BRD-35: turned a quarter with the mouse, a sticky's + handles stay clear of its resize handles", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  const st = board.locator("g[data-s]").filter({ hasText: "Room on owner" });
  await click(page, st);
  const h = (await board.locator("[data-rot]").first().boundingBox())!;
  const c = (await st.boundingBox())!;
  const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy - 20, { steps: 4 });
  await page.mouse.move(cx + 120, cy, { steps: 6 });
  await page.mouse.up();
  const centres = async (sel: string) => (await board.locator(sel).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })));
  const qc = await centres("[data-qc]");
  const rz = await centres("[data-rz]");
  expect(qc.length).toBe(4);
  expect(rz.length).toBe(8);
  const closest = Math.min(...qc.flatMap((a) => rz.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1]))));
  // Unturned, a + handle is 16 px from the nearest resize handle; it must stay about that far.
  expect(closest, "a + handle sits on a resize handle").toBeGreaterThan(12);
});

test("Q9: the demo loads every module (the test server sends .mjs and .wasm with their types)", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await openDemo(page, srv.url);
  await page.waitForTimeout(500);
  expect(errors.filter((e) => /module script|MIME/i.test(e))).toEqual([]);
});
