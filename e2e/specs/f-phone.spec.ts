// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// f. Phone (390×844, WebKit): slash menu as a bottom sheet, the mobile toolbar while
//    typing, and a board that needs a tap before it takes touches.
import { expect, test } from "@playwright/test";
import { editor, sharedFile } from "../helpers";

test("phone: bottom-sheet slash menu, mobile toolbar, tap-to-activate board", async ({ browser }) => {
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
  const { priya, sam } = await sharedFile(browser, { name: "E2E f · phone", samRole: "view", ctx: phone });
  await expect(priya.oc.locator(".app.compact")).toBeVisible();

  // Typing brings up the toolbar above the keyboard.
  await expect(priya.oc.getByRole("toolbar", { name: "Editing tools" })).toHaveCount(0);
  await editor(priya).locator("h2", { hasText: "Notes" }).tap();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("From my phone");
  await expect(priya.oc.getByRole("toolbar", { name: "Editing tools" })).toBeVisible();
  await expect(editor(sam)).toContainText("From my phone", { timeout: 2_000 });

  // "/" opens the block menu as a bottom sheet (not an anchored popover).
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("/");
  const sheet = priya.oc.locator(".sheet[role=dialog][aria-label=Insert]");
  await expect(sheet).toBeVisible();
  await expect(priya.oc.locator(".pop")).toHaveCount(0);
  const box = (await sheet.boundingBox())!;
  const frame = (await priya.page.locator('iframe[name="oc"]').boundingBox())!;
  expect(Math.round(box.x + box.width)).toBeGreaterThanOrEqual(Math.round(frame.x + frame.width) - 1);
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(Math.round(frame.y + frame.height) - 2);

  // Insert a whiteboard from the sheet: it shows a cover until tapped.
  await sheet.getByRole("button", { name: "Whiteboard" }).tap();
  await expect(sheet).toHaveCount(0);
  const cover = priya.oc.locator(".ocbd-cover");
  await expect(cover).toBeVisible({ timeout: 10_000 });
  await expect(cover).toContainText("Tap to open board");
  await expect(priya.oc.locator(".ocbd-full")).toHaveCount(0);
  await cover.tap();
  await expect(priya.oc.locator(".ocbd.ocbd-full")).toBeVisible();

  // The viewer gets the board too, behind its own cover.
  await expect(sam.oc.locator(".ocbd-cover")).toContainText("Tap to view board", { timeout: 10_000 });

  await priya.ctx.close();
  await sam.ctx.close();
});
