// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// m. Open items from docs/19 (UX-02): offline detection by heartbeat, @mention notifications
//    to the host, follow mode on click and long-press, text colour and date mentions, block
//    links inside a host.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { OC } from "../env";
import fs from "node:fs";
import path from "node:path";
import { applyTemplate, createFile, editor, person, sharedFile, typeAfterHeading } from "../helpers";

/** The sample host's stored mention notifications for a file (its meta.json). */
function hostMentions(fileId: string): { by: string; mentioned: string[]; blockId: string | null; threadId: string | null; excerpt: string }[] {
  const meta = JSON.parse(fs.readFileSync(path.join(process.env.E2E_TMP!, "host", "meta.json"), "utf8"));
  return meta.mentions?.[fileId] ?? [];
}

test("@mentions reach the host once; host block links and Show in canvas scroll to the block", async ({ browser }) => {
  test.setTimeout(90_000);
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E m · mentions", samRole: "edit" });
  await typeAfterHeading(priya, "Notes", "Review with @Sam");
  await expect(priya.oc.locator(".pop").filter({ hasText: "People" }).getByRole("option", { name: /Sam Ortiz/ })).toBeVisible();
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("before Friday");
  await expect.poll(() => hostMentions(fileId).length, { timeout: 10_000 }).toBe(1);
  const [m] = hostMentions(fileId);
  expect(m).toMatchObject({ by: "u_priya", mentioned: ["u_sam"], threadId: null });
  expect(m.blockId).toMatch(/^b_[0-9a-z]{26}$/);
  expect(m.excerpt).toContain("Review with @Sam Ortiz");
  // More typing in the same block is not a new notification.
  await priya.page.keyboard.type(" please");
  await priya.page.waitForTimeout(1500);
  expect(hostMentions(fileId)).toHaveLength(1);

  // A comment mention: one more call, with the thread.
  await editor(sam).locator("p", { hasText: "Review with" }).selectText();
  await sam.oc.getByRole("button", { name: "Comment", exact: true }).first().click();
  const box = sam.oc.getByRole("combobox").first();
  await box.pressSequentially("Agreed @Pri");
  await sam.oc.getByRole("listbox", { name: "People" }).getByRole("option", { name: "Priya Shah" }).click();
  await box.press("Enter");
  await expect.poll(() => hostMentions(fileId).length, { timeout: 10_000 }).toBe(2);
  expect(hostMentions(fileId)[0]).toMatchObject({ by: "u_sam", mentioned: ["u_priya"], blockId: null });
  expect(hostMentions(fileId)[0].threadId).toMatch(/^t_/);

  // The host lists them; "Show in canvas" scrolls to the block and flashes it.
  await priya.page.getByRole("button", { name: /^Mentions/ }).click();
  const panel = priya.page.getByRole("region", { name: "Mentions" });
  await expect(panel.locator("li")).toHaveCount(2, { timeout: 5_000 });
  await editor(priya).evaluate((el) => el.closest(".scroll")?.scrollTo({ top: 99999 }));
  await panel.getByRole("button", { name: "Show in canvas" }).click();
  const block = editor(priya).locator(`[data-block-id="${m.blockId}"]`);
  await expect(block).toHaveClass(/flash/);
  await expect(block).toBeInViewport();

  // "Copy link to block": the host builds its own URL; opening it lands on the block.
  await priya.page.keyboard.press("Escape");
  await block.click();
  await priya.page.keyboard.press("ControlOrMeta+/");
  await priya.oc.getByRole("menuitem", { name: "Copy link to block" }).click();
  await expect.poll(() => priya.page.evaluate(() => document.body.dataset.blockLink ?? "")).toMatch(new RegExp(`/files/${fileId}#block=${m.blockId}$`));
  const url = await priya.page.evaluate(() => document.body.dataset.blockLink!);
  const reader = await priya.ctx.newPage();
  await reader.goto(url);
  const there = reader.frameLocator('iframe[name="oc"]').locator(`.ProseMirror [data-block-id="${m.blockId}"]`);
  await expect(there).toHaveClass(/flash/, { timeout: 15_000 });
  await expect(there).toBeInViewport();

  await priya.ctx.close();
  await sam.ctx.close();
});

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
  // OFF-06 (frame 1c): offline is a state of the save pill, not a banner.
  await expect(priya.oc.getByText("You're offline. Keep working.")).toHaveCount(0);

  // Typing while offline is kept and syncs once the network is back.
  await editor(priya).locator("p").last().click();
  await priya.page.keyboard.type("Written offline");
  await expect(status).toHaveAttribute("aria-label", /^Offline · \d+ changes? not saved yet/);
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
      // Database and board blocks load lazily: hover only once the block's content is drawn,
      // and hover again if the handle missed the first move (slower CI machines).
      await expect(block.locator(sel).first()).toBeVisible();
      await block.scrollIntoViewIfNeeded();
      const b = (await block.boundingBox())!;
      const grip = page.getByRole("button", { name: "Block options" });
      await expect(async () => {
        await page.mouse.move(b.x + 40, b.y + 30);
        await page.mouse.move(b.x + 40, b.y + 12);
        await expect(grip).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
      await expect.poll(async () => {
        const g = (await grip.boundingBox())!;
        return Math.round(g.x + g.width) <= Math.round(b.x) && g.x >= 0 && Math.abs(g.y - b.y) < 40;
      }).toBe(true);
    }
    await ctx.close();
  });
}

test("follow mode: a click or a long press on an avatar starts following", async ({ page }) => {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  // Someone with a caret in the text (the demo's collaborators).
  const peer = page.locator(".avs .av[aria-pressed]").first();
  await expect(peer).toBeVisible();
  const name = (await peer.getAttribute("aria-label"))!.replace(/^Follow /, "");
  await peer.click();
  await expect(peer).toHaveAttribute("aria-pressed", "true");
  await expect(peer).toHaveAttribute("aria-label", `Stop following ${name}`);
  await peer.click();
  await expect(peer).toHaveAttribute("aria-pressed", "false");
  // Long press: starts following, and the release does not toggle it off again.
  const b = (await peer.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await expect(peer).toHaveAttribute("aria-pressed", "true");
  await page.mouse.up();
  await page.waitForTimeout(200);
  await expect(peer).toHaveAttribute("aria-pressed", "true");
  // A second long press keeps following (it never stops it).
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(peer).toHaveAttribute("aria-pressed", "true");
  // Scrolling the canvas stops following.
  await page.mouse.move(640, 500);
  await page.mouse.wheel(0, 300);
  await expect(peer).toHaveAttribute("aria-pressed", "false");
});

test("text colour from the toolbar; date chips from @tomorrow and /date", async ({ page }) => {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  const para = page.locator(".ProseMirror p").filter({ hasText: "The file stays" });
  await para.click({ position: { x: 1, y: 12 } });
  for (let i = 0; i < 8; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Text colour" }).click();
  await page.getByRole("group", { name: "Text colour" }).getByRole("button", { name: "Red" }).click();
  await expect(para.locator('span[data-color="red"]')).toHaveText("The file");
  // Readable in both themes (AA for text).
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page }).include('.ProseMirror span[data-color="red"]').withRules(["color-contrast"]).analyze();
    expect(r.violations, theme).toEqual([]);
  }

  // @tomorrow → a chip; /date → the picker, then a chosen date.
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Due @tom");
  await expect(page.getByRole("listbox", { name: "Mention" }).getByRole("option", { name: /Tomorrow/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const chips = para.locator(".datechip");
  await expect(chips.first()).toHaveText("Tomorrow");
  await page.keyboard.type("/date");
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "Date" });
  await expect(picker).toBeVisible();
  await picker.getByLabel("Date").fill("2027-03-09");
  await picker.getByRole("button", { name: "Done" }).click();
  await expect(chips.nth(1)).toHaveText(/Mar 9, 2027/);
  await expect(chips.nth(1)).toHaveAttribute("aria-label", /March 9, 2027/);
});
