// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// z — VH-01d phone frames against the real server and sample host: the full-screen list (9a),
//     the preview with Changes and the bottom bar (9b), the list of changes (9c) and the restore
//     sheet (9d).
import { expect, test } from "@playwright/test";
import { applyTemplate, createFile, expectSaved, person, typeAfterHeading } from "../helpers";

const phoneCtx = () => {
  const u = test.info().project.use;
  return { viewport: u.viewport, isMobile: u.isMobile, hasTouch: u.hasTouch, deviceScaleFactor: u.deviceScaleFactor, userAgent: u.userAgent };
};

test("VH-01d 9a-9d: history on a phone", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya", phoneCtx());
  await createFile(priya, "E2E z · phone history");
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "Budget is 40k");
  await expectSaved(priya);
  const oc = priya.oc;

  // Name a version from the ⋯ sheet, then edit.
  await oc.getByRole("button", { name: "More options" }).click();
  await oc.getByRole("button", { name: "Name this version" }).click();
  const input = oc.getByRole("textbox", { name: "Name this version" });
  await input.fill("Budget draft");
  await input.press("Enter");
  await expect(oc.locator(".toast")).toContainText("Saved as “Budget draft”");

  // 9a: the list is a full-screen page with Back and Name in its header.
  const panel = oc.locator("aside.vh-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Back to the canvas" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Name", exact: true })).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(test.info().project.use.viewport!.width - 2);
  const row = panel.locator(".vh-v.named", { hasText: "Budget draft" });
  await expect(row).toBeVisible({ timeout: 10_000 });
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // Edit live so there is something to compare: back to the canvas, type, come back.
  await panel.getByRole("button", { name: "Back to the canvas" }).click();
  // Twice: in the host's iframe, the first tap after an input had focus lands the caret at the
  // start of the canvas (seen without history too; not part of this feature).
  await oc.locator(".wsp .ProseMirror p", { hasText: "Budget is 40k" }).click();
  await oc.locator(".wsp .ProseMirror p", { hasText: "Budget is 40k" }).click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.type(" approved");
  await expectSaved(priya);
  await oc.getByRole("button", { name: "More options" }).click();
  await oc.getByRole("button", { name: /^Version history/ }).click();

  // 9b: the newest save previews full screen; Changes on, then the bottom bar steps and restores.
  await panel.locator(".vh-sess").first().locator(".vh-v").click();
  const pv = oc.locator(".vh-main");
  await expect(pv).toBeVisible();
  await expect(panel).toBeHidden();
  await pv.getByRole("switch", { name: "Changes" }).click();
  await expect(pv.locator("ins.vh-ins")).toContainText("approved");
  await expect(pv.getByText(/^Changes since /)).toBeVisible();
  const restore = pv.getByRole("button", { name: "Restore", exact: true });
  await expect(restore).toBeVisible();
  expect((await restore.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // 9c: "1 of N" opens the list of changes, in words.
  await pv.locator(".vh-pfoot2 .count").click();
  const list = oc.getByRole("dialog", { name: /change/ });
  await expect(list.locator(".vh-ch")).toHaveCount(1);
  await expect(list.locator(".vh-ch")).toContainText("approved");
  await list.getByRole("button", { name: "Close" }).click();

  // 9d: Restore asks first, as a bottom sheet with full-width buttons.
  await restore.click();
  const sheet = oc.getByRole("dialog", { name: "Restore this version" });
  await expect(sheet).toContainText("Restore this version?");
  await expect(sheet.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
  await priya.ctx.close();
});
