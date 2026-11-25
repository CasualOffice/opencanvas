// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// l. Phone UX pass (docs/19): "+" opens the block menu on a new line instead of
//    typing "/" into the middle of a word, and links are edited in a sheet (no
//    window.prompt). Runs in the WebKit phone project (file name matches /phone\.spec/).
import { expect, test } from "@playwright/test";
import { OC } from "../env";

test("phone: + inserts below without touching the text; link sheet", async ({ page }) => {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  const para = page.locator(".ProseMirror p").filter({ hasText: "The file stays" });
  await expect(para).toBeVisible();
  const before = await para.textContent();
  await para.tap();
  const bar = page.getByRole("toolbar", { name: "Editing tools" });
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Insert block" }).tap();
  await expect(page.locator(".sheet[aria-label=Insert]")).toBeVisible();
  await expect(para).toHaveText(before!);
  // INS-01: Divider is in Layout (the phone drills in, 7b).
  await page.locator(".sheet[aria-label=Insert]").getByRole("button", { name: /^Layout/ }).tap();
  await page.locator(".sheet[aria-label=Insert]").getByRole("button", { name: "Divider" }).tap();
  await expect(para).toHaveText(before!);

  // Select a word and link it from the bar: a sheet with a field, never a browser prompt.
  page.on("dialog", () => {
    throw new Error("window.prompt must not be used");
  });
  await para.dblclick();
  await bar.getByRole("button", { name: "Link" }).tap();
  const field = page.getByRole("dialog", { name: "Add link" }).getByLabel("Link address");
  await expect(field).toBeVisible();
  await field.fill("example.com");
  await field.press("Enter");
  await expect(page.locator(".ProseMirror a[href='https://example.com']")).toHaveCount(1);
});
