// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// k. UX pass (docs/19-UX-AUDIT.md), on the `#demo` canvas served by the real server:
//    link popover and ⌘K, keyboard block menu, shortcuts help, slash ranking and table
//    tools, image width/alignment, callout picker, comment @mentions, undo across the
//    header, contrast/target size in the top bar, and SEC-20 (no script URLs in the DOM).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { OC } from "../env";

// `sim=quiet` stops the simulated collaborator from typing, so positions stay put.
async function demo(page: Page, extra = "") {
  await page.goto(`${OC}/app/#demo&sim=quiet${extra}`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator(".ProseMirror .callout")).toBeVisible();
}
const para = (page: Page) => page.locator(".ProseMirror p").filter({ hasText: "The file stays" });
const focused = (page: Page) => page.evaluate(() => ({ role: document.activeElement?.getAttribute("role"), label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.textContent?.trim() ?? "" }));

test("links: ⌘K adds one, clicking it offers open / edit / remove", async ({ page }) => {
  await demo(page);
  await para(page).click({ position: { x: 1, y: 12 } });
  for (let i = 0; i < 8; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("dialog", { name: "Add link" }).getByLabel("Link address");
  await expect(input).toBeFocused();
  await input.fill("example.com/guide");
  await page.keyboard.press("Enter");
  const link = page.locator(".ProseMirror a", { hasText: "The file" });
  await expect(link).toHaveAttribute("href", "https://example.com/guide");

  await link.click();
  const menu = page.getByRole("menu", { name: "Link" });
  await expect(menu.getByRole("menuitem", { name: "Open example.com" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Edit link" }).click();
  const field = page.getByRole("dialog", { name: "Edit link" }).getByLabel("Link address");
  await expect(field).toBeFocused();
  await field.fill("https://example.org");
  await page.keyboard.press("Enter");
  await expect(link).toHaveAttribute("href", "https://example.org");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A second click inside the double-click interval selects a word instead (browser behaviour).
  await page.waitForTimeout(600);
  await link.click();
  await page.getByRole("menuitem", { name: "Remove link" }).click();
  await expect(page.locator(".ProseMirror a", { hasText: "The file" })).toHaveCount(0);
});

test("block menu from the keyboard: ⌘/ opens it, arrows move, Escape returns to the text", async ({ page }) => {
  await demo(page);
  await para(page).click();
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByRole("menu", { name: "Block" })).toBeVisible();
  await expect.poll(() => focused(page)).toMatchObject({ role: "menuitem", text: "Text" });
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focused(page)).toMatchObject({ role: "menuitem", text: "Heading 1" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Block" })).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toBeFocused();

  // ⌘D duplicates the block, ⌘⇧↑ moves it.
  await page.keyboard.press("ControlOrMeta+d");
  await expect(page.locator(".ProseMirror p").filter({ hasText: "The file stays" })).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".ProseMirror p").filter({ hasText: "The file stays" })).toHaveCount(1);
});

test("? opens the keyboard shortcuts; the More menu lists them too", async ({ page }) => {
  await demo(page);
  await page.locator(".dicon").focus();
  await page.keyboard.press("?");
  const dlg = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("Add or edit a link");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: /Keyboard shortcuts/ }).click();
  await expect(dlg).toBeVisible();
});

test("/table offers the table first, starts in a cell, and the table tools add rows", async ({ page }) => {
  await demo(page);
  const last = page.locator(".ProseMirror > p").last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await page.keyboard.type("/table");
  await expect(page.getByRole("listbox", { name: "Insert" }).getByRole("option").first()).toContainText("Simple table");
  await page.keyboard.press("Enter");
  const table = page.locator(".ProseMirror > .tableWrapper table, .ProseMirror > table").last();
  await expect(table.locator("tr")).toHaveCount(3);
  await page.keyboard.type("Owner");
  await expect(table.locator("th").first()).toHaveText("Owner");
  await page.getByRole("button", { name: "Add row below" }).click();
  await expect(table.locator("tr")).toHaveCount(4);
  await page.locator(".tblh").getByRole("button", { name: "Table" }).click();
  await page.getByRole("menuitem", { name: "Add column right" }).click();
  await expect(table.locator("tr").first().locator("th")).toHaveCount(4);
});

test("images resize and align; callouts get a colour and icon picker", async ({ page }) => {
  await demo(page);
  const fig = page.locator(".figure").first();
  await fig.scrollIntoViewIfNeeded();
  await fig.hover();
  await fig.getByRole("button", { name: "Medium size" }).click();
  await fig.getByRole("button", { name: "Align left" }).click();
  await expect(fig).toHaveAttribute("data-align", "left");
  await expect(fig).toHaveAttribute("style", /width: 60%/);
  // Keyboard resize on the handle.
  await fig.getByRole("button", { name: /Image width/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(fig).toHaveAttribute("style", /width: 65%/);

  await page.locator(".callout > .cic").first().click();
  const picker = page.getByRole("dialog", { name: "Callout" });
  await picker.getByRole("button", { name: "Green" }).click();
  await expect(page.locator(".callout").first()).toHaveAttribute("data-tone", "green");
  await picker.getByRole("button", { name: "star" }).click();
  await expect(picker).toHaveCount(0);
});

test("comments: @mention a person from the reply box", async ({ page }) => {
  await demo(page);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const reply = page.getByRole("combobox", { name: "Reply" });
  await reply.click();
  await reply.pressSequentially("Over to @Ash");
  const opt = page.getByRole("listbox", { name: "People" }).getByRole("option", { name: "Asha Rao" });
  await expect(opt).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(reply).toHaveValue("Over to @Asha Rao ");
  await page.keyboard.press("Enter");
  await expect(page.locator(".thread .cmention", { hasText: "@Asha Rao" })).toBeVisible();
});

test("undo covers the header too: a colour change is one ⌘Z away", async ({ page }) => {
  await demo(page);
  const icon = page.locator("button.dicon");
  await expect(icon).toHaveClass(/tone-blue/);
  await icon.click();
  await page.getByRole("dialog", { name: "Icon" }).getByRole("button", { name: "Green" }).click();
  await expect(icon).toHaveClass(/tone-green/);
  await page.keyboard.press("Escape");
  await para(page).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(icon).toHaveClass(/tone-blue/);
});

test("top bar: avatar contrast, target size and names pass axe", async ({ page }) => {
  await demo(page);
  await expect(page.locator(".avs .av")).toHaveCount(5);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page }).include(".top").include(".dhead").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
});

test("SEC-20: script and HTML URLs from the document never reach href or src", async ({ page }) => {
  await demo(page);
  await page.evaluate(() => {
    const ed = (window as unknown as { __ocEditor: { commands: { insertContent(c: unknown): boolean } } }).__ocEditor;
    ed.commands.insertContent([
      { type: "bookmark", attrs: { url: "javascript:alert(1)", title: "Evil card", site: "x" } },
      { type: "fileAttachment", attrs: { name: "evil.txt", size: 3, url: "javascript:alert(2)", mime: "text/plain" } },
      { type: "image", attrs: { src: "data:text/html,<script>alert(3)</script>", alt: "evil image" } },
    ]);
  });
  await expect(page.locator(".bookmark", { hasText: "Evil card" })).toBeVisible();
  await expect(page.locator('[role="img"][aria-label="evil image"]')).toBeVisible();
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll("[href],[src]")]
      .map((el) => el.getAttribute("href") ?? el.getAttribute("src") ?? "")
      .filter((u) => /^\s*(javascript:|data:text\/html)/i.test(u)),
  );
  expect(bad).toEqual([]);
});

test("a blank canvas invites a start; a conflict shows autosave as paused", async ({ page }) => {
  await demo(page);
  // Inside a canvas there is no template button: templates are offered when a canvas is new.
  await expect(page.locator(".top").getByRole("button", { name: "Templates" })).toHaveCount(0);
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  const invite = page.getByRole("group", { name: "Start this canvas" });
  await expect(invite.getByRole("button", { name: "Database" })).toBeVisible();
  // The new canvas takes the caret, so typing just works.
  await expect(page.locator(".ProseMirror")).toBeFocused();
  await page.keyboard.type("Hello");
  await expect(invite).toHaveCount(0);

  await page.goto(`${OC}/app/#demo&sim=conflict`);
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Canvas changed" })).toBeVisible();
  await expect(page.locator(".top .status")).toHaveAttribute("aria-label", "Autosave paused");
});
