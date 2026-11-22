// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// a. New file → template gallery → "Meeting notes" → a viewer sees the content,
//    both avatars on both sides, and the editor's live caret label.
import { expect, test } from "@playwright/test";
import { applyTemplate, createFile, editor, openFile, person, setAccess } from "../helpers";

test("new file from the Meeting notes template, seen live by a viewer", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E a · meeting");

  // isNew + edit → the gallery opens instead of an empty page.
  await applyTemplate(priya, "Meeting notes");
  await expect(editor(priya).locator("h2", { hasText: "Agenda" })).toBeVisible();
  await expect(priya.oc.locator(".ocdb").first()).toBeVisible();

  await setAccess(priya, fileId, "u_sam", "view");
  const sam = await person(browser, "u_sam");
  await openFile(sam, fileId);

  // The viewer gets the content (text + the lazily loaded database), read-only, no gallery.
  await expect(sam.oc.locator(".tgrid")).toHaveCount(0);
  await expect(editor(sam).locator("h2", { hasText: "Agenda" })).toBeVisible();
  await expect(editor(sam).locator("h2", { hasText: "Action items" })).toBeVisible();
  await expect(sam.oc.locator(".ocdb").getByRole("textbox", { name: "Action" }).first()).toHaveValue("Send recap to the channel");
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false");
  await expect(sam.oc.locator(".banner", { hasText: "You can view this canvas" })).toBeVisible();

  // Both avatars on both sides.
  await expect(priya.oc.getByRole("button", { name: "Priya Shah (you)" })).toBeVisible();
  await expect(priya.oc.getByRole("button", { name: "Follow Sam Ortiz" })).toBeVisible();
  await expect(sam.oc.getByRole("button", { name: "Sam Ortiz (you)" })).toBeVisible();
  await expect(sam.oc.getByRole("button", { name: "Follow Priya Shah" })).toBeVisible();
  // The viewer is marked as viewing on the editor's side.
  await expect(priya.oc.locator('.avs .av[title="Sam Ortiz · viewing"] .eye')).toBeVisible();

  // The editor's caret, with her name, shows up for the viewer while she types.
  await editor(priya).locator("li", { hasText: "Updates since last week" }).click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.type(" (live)");
  await expect(editor(sam)).toContainText("Updates since last week (live)", { timeout: 2_000 });
  const caret = editor(sam).locator(".collaboration-carets__caret", { has: sam.oc.locator(".collaboration-carets__label", { hasText: "Priya Shah" }) });
  await expect(caret).toBeVisible();
  // …inside the list item she is typing in.
  await expect(editor(sam).locator("li", { hasText: "Updates since last week" }).locator(".collaboration-carets__label")).toHaveText("Priya Shah");

  await priya.ctx.close();
  await sam.ctx.close();
});
