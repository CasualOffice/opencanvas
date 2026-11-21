// m. Open items from docs/19 (UX-02): offline detection by heartbeat, @mention notifications
//    to the host, follow mode on click and long-press, text colour and date mentions, block
//    links inside a host.
import { expect, test } from "@playwright/test";
import { OC } from "../env";
import { applyTemplate, createFile, editor, person } from "../helpers";

test("a silent network drop shows Offline within 20 s, and the canvas recovers", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  // A silent drop: the browser never says it is offline (no `offline` event, onLine stays
  // true), so only the server heartbeat can reveal it.
  await priya.ctx.addInitScript(() => {
    for (const t of ["offline", "online"]) window.addEventListener(t, (e) => e.stopImmediatePropagation(), true);
    Object.defineProperty(Navigator.prototype, "onLine", { get: () => true });
  });
  await createFile(priya, "E2E m · offline");
  await applyTemplate(priya, "Meeting notes");
  const status = priya.oc.locator(".top .status");
  await expect(status).toHaveAttribute("aria-label", /^Saved/, { timeout: 10_000 });

  await priya.ctx.setOffline(true);
  const t0 = Date.now();
  await expect(status).toHaveAttribute("aria-label", /^Offline/, { timeout: 20_000 });
  const ms = Date.now() - t0;
  test.info().annotations.push({ type: "offline", description: `shown after ${ms} ms` });
  expect(ms).toBeLessThan(20_000);
  await expect(priya.oc.getByText("You're offline. Keep working.")).toBeVisible();

  // Typing while offline is kept and syncs once the network is back.
  await editor(priya).locator("p").last().click();
  await priya.page.keyboard.type("Written offline");
  await priya.ctx.setOffline(false);
  await expect(status).toHaveAttribute("aria-label", /^(Saved|Saving|Unsaved)/, { timeout: 20_000 });
  await expect(status).toHaveAttribute("aria-label", /^Saved/, { timeout: 15_000 });
  await priya.ctx.close();
});

test("one undo stack: ⌘Z steps back through a cell edit, a board move and typing, in order", async ({ page }) => {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  const para = page.locator(".ProseMirror p").filter({ hasText: "The file stays" });
  await expect(para).toBeVisible();
  const settle = () => page.waitForTimeout(700); // past the 500 ms capture window

  // 1. Typing.
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus typing");
  await expect(para).toContainText("plus typing");
  await settle();

  // 2. A board move: select a shape and nudge it 10 px.
  const board = page.locator('[aria-roledescription="whiteboard"]').first();
  const label = board.locator("text", { hasText: "Every edit merges live" }).first();
  await label.scrollIntoViewIfNeeded();
  await label.click();
  const x0 = (await label.boundingBox())!.x;
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => Math.round((await label.boundingBox())!.x - x0)).toBeGreaterThan(5);
  await settle();

  // 3. A database cell.
  const pts = page.locator(".ocdb").getByRole("textbox", { name: "Points" }).first();
  const before = await pts.inputValue();
  await pts.fill("99");
  await pts.press("Enter");
  await expect(pts).toHaveValue("99");
  await settle();

  // ⌘Z in the text: cell, then board, then typing.
  await para.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(pts).toHaveValue(before);
  await expect(para).toContainText("plus typing");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => Math.round((await label.boundingBox())!.x - x0)).toBe(0);
  await expect(para).toContainText("plus typing");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(para).not.toContainText("plus typing");
  // ⌘⇧Z redoes in the same order.
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(para).toContainText("plus typing");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => Math.round((await label.boundingBox())!.x - x0)).toBeGreaterThan(5);
});

for (const width of [1440, 1100]) {
  test(`block handle sits left of wide database and board blocks at ${width} px`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${OC}/app/#demo&sim=quiet`);
    for (const sel of [".ocdb", '[aria-roledescription="whiteboard"]']) {
      const block = page.locator(".ProseMirror > .react-renderer > .wideblock").filter({ has: page.locator(sel) }).first();
      await block.scrollIntoViewIfNeeded();
      const b = (await block.boundingBox())!;
      await page.mouse.move(b.x + 40, b.y + 12);
      const grip = page.getByRole("button", { name: "Block options" });
      await expect(grip).toBeVisible();
      await expect.poll(async () => {
        const g = (await grip.boundingBox())!;
        return Math.round(g.x + g.width) <= Math.round(b.x) && g.x >= 0 && Math.abs(g.y - b.y) < 40;
      }).toBe(true);
    }
    await ctx.close();
  });
}
