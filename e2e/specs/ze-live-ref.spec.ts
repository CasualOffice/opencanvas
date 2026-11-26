// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// LIVE-03/04 (frames 1d, 3a, 3b): "Copy link to block" in one canvas, paste in another: the
// paste menu offers Live block / Reference / Link; a block of an ordinary canvas becomes a
// read-only reference card that follows its source.
import { expect, test } from "@playwright/test";
import { applyTemplate, createFile, editor, expectSaved, person, typeAfterHeading } from "../helpers";

test("paste a block link as a reference that follows its source", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya");
  await createFile(priya, "E2E ze · incident review");
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "Export jobs run in the background queue");
  await expectSaved(priya);
  // What "Copy link to block" puts on the clipboard (the host URL and the editor's marker), pasted
  // as a real paste event: the OS clipboard is not reachable from a framed test page.
  const fileId = new URL(priya.page.url()).pathname.split("/").pop()!;
  const blockId = await editor(priya).getByText("Export jobs run in the background queue", { exact: true }).getAttribute("data-block-id");
  expect(blockId).toBeTruthy();
  const source = priya.page.url();

  await createFile(priya, "E2E ze · weekly");
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "");
  const url = `http://localhost:4200/files/${fileId}#block=${blockId}`;
  await priya.page.frame({ name: "oc" })!.evaluate(
    ({ url, fileId, blockId }) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", url);
      dt.setData("text/html", `<a href="${url}" data-oc-file="${fileId}" data-oc-block="${blockId}">${url}</a>`);
      document.querySelector(".ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { url, fileId, blockId },
  );
  const menu = priya.oc.getByRole("dialog", { name: "Paste link" }).or(priya.oc.locator(".lb-paste"));
  await expect(menu).toBeVisible();
  // An ordinary canvas's block cannot be pasted as a live block (1d).
  await expect(menu.getByText("Make it live in its canvas first")).toBeVisible();
  await menu.getByText("Reference", { exact: true }).click();
  const card = priya.oc.locator(".rf").first();
  await expect(card.locator(".rf-k")).toHaveText("Reference");
  await expect(card.locator(".rf-b")).toContainText("Export jobs run in the background queue", { timeout: 15_000 });

  // The source changes; the card follows (Refresh in its menu, or the automatic poll).
  const src = await priya.ctx.newPage();
  await src.goto(source);
  const srcEd = src.frameLocator('iframe[name="oc"]').locator(".ProseMirror");
  await srcEd.getByText("Export jobs run in the background queue", { exact: true }).click();
  await src.keyboard.press("End");
  await src.keyboard.type(" from 4.2 on");
  await expect(src.frameLocator('iframe[name="oc"]').locator(".top .status")).toHaveAttribute("aria-label", /^Saved/, { timeout: 10_000 });
  await card.getByRole("button", { name: "Reference options" }).click();
  await priya.oc.getByRole("menuitem", { name: "Refresh" }).click();
  await expect(card.locator(".rf-b")).toContainText("background queue from 4.2 on", { timeout: 10_000 });
  await expect(card.locator(".rf-up")).toContainText("Updated just now");
  await priya.ctx.close();
});
