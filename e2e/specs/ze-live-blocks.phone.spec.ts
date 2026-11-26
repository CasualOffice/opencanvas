// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// LIVE-03 on a phone (frames 6a, 6b): the header keeps the Live mark, the title and a 44 px
// options button; tapping the header opens the sheet with the source, the role and the menu.
import { expect, test } from "@playwright/test";
import { applyTemplate, createFile, editor, expectSaved, openFile, person, typeAfterHeading } from "../helpers";

test("a live block on a phone: compact header and the options sheet", async ({ browser }) => {
  test.setTimeout(120_000);
  // Made on a desktop-sized window (the block menu shortcut), opened on the phone.
  const desk = await person(browser, "u_priya", { viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
  const id = await createFile(desk, "E2E ze · phone");
  await applyTemplate(desk, "Meeting notes");
  await typeAfterHeading(desk, "Notes", "Phone checklist line");
  await expectSaved(desk);
  await editor(desk).getByText("Phone checklist line", { exact: true }).click();
  await desk.page.keyboard.press("ControlOrMeta+/");
  await desk.oc.getByRole("menuitem", { name: "Make live…" }).click();
  await desk.oc.getByRole("dialog", { name: "Make this a live block" }).getByLabel("Name").fill("Phone list");
  await desk.oc.getByRole("button", { name: "Make live", exact: true }).click();
  await expect(desk.oc.locator(".lb .lb-b .ProseMirror")).toContainText("Phone checklist line", { timeout: 15_000 });
  await expectSaved(desk);
  await desk.ctx.close();

  const phone = await person(browser, "u_priya");
  await openFile(phone, id);
  const lb = phone.oc.locator(".lb").first();
  await expect(lb.locator(".lb-b .ProseMirror")).toContainText("Phone checklist line", { timeout: 15_000 });
  await expect(lb.locator(".lb-live")).toBeVisible();
  await expect(lb.locator(".lb-t")).toHaveText("Phone list");
  await expect(lb.locator(".lb-src")).toHaveCount(0);
  const opts = lb.getByRole("button", { name: "Live block options" });
  const box = await opts.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  await lb.locator(".lb-t").tap();
  await expect(phone.oc.getByText("Live block from Sample host. You can edit it.")).toBeVisible();
  await expect(phone.oc.getByText("Who can see this", { exact: true })).toBeVisible();
  await phone.ctx.close();
});
