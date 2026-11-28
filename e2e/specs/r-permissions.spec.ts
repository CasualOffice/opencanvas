// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// r. Acceptance (docs/23 Permissions): live role changes down and back up, a forged
//    write from a viewer's devtools, and what a revoke does to the other people.
import path from "node:path";
import { expect, test, type FrameLocator } from "@playwright/test";
import { ROOT } from "../env";
import { editor, expectSaved, setAccess, sharedFile, storedDocumentHas, typeAfterHeading } from "../helpers";

const PDF = path.join(ROOT, "e2e/fixtures/three-pages.pdf");

const banner = (oc: FrameLocator, text: string | RegExp) => oc.locator(".banner", { hasText: text });

test("PERM-01/02: edit → comment → view → comment → edit live, then none closes", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E r · ladder", samRole: "edit" });
  const navigations: string[] = [];
  sam.page.on("framenavigated", (f) => navigations.push(f.url()));
  await expect(editor(sam)).toHaveAttribute("contenteditable", "true");
  await typeAfterHeading(sam, "Notes", "Sam as editor");
  await expect(editor(priya)).toContainText("Sam as editor", { timeout: 2_000 });

  // edit → comment: read-only text, downgrade banner.
  await setAccess(priya, fileId, "u_sam", "comment");
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false");
  await expect(banner(sam.oc, "changed your access to comment only")).toBeVisible();

  // comment → view.
  await setAccess(priya, fileId, "u_sam", "view");
  await expect(banner(sam.oc, "changed your access to view only")).toBeVisible();
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false");

  // view → comment → edit, live, with a toast each time.
  await setAccess(priya, fileId, "u_sam", "comment");
  await expect(sam.oc.locator(".toast", { hasText: "gave you comment access" })).toBeVisible();
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false");
  await setAccess(priya, fileId, "u_sam", "edit");
  await expect(sam.oc.locator(".toast", { hasText: "gave you edit access" })).toBeVisible();
  await expect(editor(sam)).toHaveAttribute("contenteditable", "true");
  await typeAfterHeading(sam, "Decisions", "Sam edits again");
  await expect(editor(priya)).toContainText("Sam edits again", { timeout: 2_000 });
  expect(navigations, "no reload of the editor at any step").toEqual([]);

  // edit → none: closed, and Priya stays editing.
  await setAccess(priya, fileId, "u_sam", "none");
  await expect(sam.oc.getByRole("dialog", { name: "Canvas closed" })).toBeVisible();
  await expect(editor(priya)).toHaveAttribute("contenteditable", "true");

  await priya.ctx.close();
  await sam.ctx.close();
});

// docs/23 PERM-05: the room saved with the callback token of the last person granted edit,
// so once that person was revoked the host answered 403 to every save. Saves now use a
// connected editor's token and fall back on 401/403 (`actor.rs` `save_tokens`).
test("PERM-05: saves keep reaching the host after the last-granted editor is revoked", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E r · revoke saves", samRole: "view" });
  await setAccess(priya, fileId, "u_sam", "edit");
  await expect(editor(sam)).toHaveAttribute("contenteditable", "true");
  await setAccess(priya, fileId, "u_sam", "none");
  await expect(sam.oc.getByRole("dialog", { name: "Canvas closed" })).toBeVisible();
  await typeAfterHeading(priya, "Notes", "After the revoke");
  await expect.poll(() => storedDocumentHas(fileId, "After the revoke"), { timeout: 15_000 }).toBe(true);
  await expectSaved(priya);

  await priya.ctx.close();
  await sam.ctx.close();
});

test("PERM-06: a viewer's forged write from devtools never reaches anyone", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E r · forged", samRole: "view" });
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false");
  // Bypass the read-only view: dispatch a ProseMirror transaction straight into Sam's editor,
  // which y-prosemirror turns into a real update frame on his socket.
  const forged = await sam.page.frame({ name: "oc" })!.evaluate(() => {
    const dom = document.querySelector(".ProseMirror") as HTMLElement & { editor?: { view: { state: { tr: { insertText(t: string, p: number): unknown } }; dispatch(tr: unknown): void } } };
    const ed = dom.editor;
    if (!ed) return false;
    ed.view.dispatch(ed.view.state.tr.insertText("FORGED BY VIEWER", 1));
    return true;
  });
  expect(forged, "Tiptap editor reachable from devtools").toBe(true);
  // The server refuses it; Sam's screen starts over from the room's state.
  await expect(editor(sam)).not.toContainText("FORGED BY VIEWER", { timeout: 10_000 });
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false");
  // Priya keeps typing; the forged text never shows up for her or on the host.
  await typeAfterHeading(priya, "Notes", "Real edit");
  await expectSaved(priya);
  await expect.poll(() => storedDocumentHas(fileId, "Real edit"), { timeout: 15_000 }).toBe(true);
  await expect(editor(priya)).not.toContainText("FORGED BY VIEWER");
  expect(storedDocumentHas(fileId, "FORGED")).toBe(false);

  await priya.ctx.close();
  await sam.ctx.close();
});

test("PERM-03: a downgrade throws away the downgraded person's local unsynced edits", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E r · unsynced", samRole: "edit" });
  // Hold Sam's outgoing frames so his next edit is local only.
  let hold = false;
  const held: (string | Buffer)[] = [];
  let toServer: ((m: string | Buffer) => void) | null = null;
  await sam.ctx.routeWebSocket(/\/v1\/collab\//, (ws) => {
    const server = ws.connectToServer();
    toServer = (m) => server.send(m);
    ws.onMessage((m) => (hold ? held.push(m) : server.send(m)));
  });
  // Reopen so the socket goes through the route.
  await sam.page.reload();
  await expect(editor(sam)).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  hold = true;
  await typeAfterHeading(sam, "Notes", "Unsynced words");
  await setAccess(priya, fileId, "u_sam", "view");
  await expect(banner(sam.oc, "changed your access to view only")).toBeVisible();
  hold = false;
  for (const m of held.splice(0)) toServer!(m);
  await expect(editor(priya)).not.toContainText("Unsynced words");
  // Sam's own screen must not keep showing edits nobody else has (fixed: seen failing first).
  await expect(editor(sam)).not.toContainText("Unsynced words", { timeout: 5_000 });
  // The banner survives the client's restart: a sessionStorage flag per room, shown once.
  await expect(banner(sam.oc, "Edits that hadn't synced weren't kept")).toBeVisible();
  // Shown once: the next load of the same room does not repeat it.
  await sam.page.reload();
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false", { timeout: 15_000 });
  await expect(banner(sam.oc, "Edits that hadn't synced weren't kept")).toHaveCount(0);

  await priya.ctx.close();
  await sam.ctx.close();
});

// docs/23 PERM-02, the browser matrix: what each role is offered for a file block, the
// database, the board and export. The server refuses the writes anyway (PERM-06); this checks
// that the UI does not offer them. Export follows the host's `perms` (sample host: all roles).
test("PERM-02: file, database, board and export controls per role", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E r · matrix", samRole: "edit" });
  const oc = priya.oc;
  await typeAfterHeading(priya, "Notes", "");
  await priya.page.keyboard.type("/file");
  await expect(oc.locator(".pop").filter({ hasText: "File" })).toBeVisible();
  const [chooser] = await Promise.all([priya.page.waitForEvent("filechooser"), priya.page.keyboard.press("Enter")]);
  await chooser.setFiles(PDF);
  await expect(oc.locator(".filev .pdfpg")).toHaveText("1 / 3", { timeout: 15_000 });
  await typeAfterHeading(priya, "Decisions", "");
  await priya.page.keyboard.type("/whiteboard");
  await priya.page.keyboard.press("Enter");
  await expect(oc.locator(".ocbd").first()).toBeVisible({ timeout: 10_000 });
  await expectSaved(priya);

  const seen: Record<string, Record<string, boolean | number>> = {};
  for (const role of ["edit", "comment", "view"] as const) {
    if (role !== "edit") await setAccess(priya, fileId, "u_sam", role);
    await sam.page.reload();
    await expect(editor(sam)).toHaveAttribute("contenteditable", role === "edit" ? "true" : "false", { timeout: 15_000 });
    const s = sam.oc;
    const file = s.locator(".filev").first();
    await expect(file).toBeVisible({ timeout: 15_000 });
    await file.hover();
    await file.getByRole("button", { name: /^Actions for / }).click();
    const rename = (await s.getByRole("menuitem", { name: "Rename" }).count()) > 0;
    const del = (await s.getByRole("menuitem", { name: /^(Delete|Remove)/ }).count()) > 0;
    await sam.page.keyboard.press("Escape");
    const db = s.locator(".ocdb").first();
    await db.scrollIntoViewIfNeeded();
    const addField = (await db.getByRole("button", { name: "Add a field" }).count()) > 0;
    const newRow = (await db.getByRole("button", { name: "New row" }).count()) > 0;
    const board = s.locator(".ocbd").first();
    await board.scrollIntoViewIfNeeded();
    await board.click({ position: { x: 40, y: 40 } });
    const pen = await board.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: "Pen" }).count();
    await s.getByRole("button", { name: "More options" }).click();
    // The top bar menus load after first paint (WEB-08): wait for the menu before counting.
    await expect(s.locator(".pop .mi").first()).toBeVisible({ timeout: 10_000 });
    const exports = await s.locator(".pop .mi").filter({ hasText: /\.(md|html|docx|pdf|ocanvas|json)$/ }).count();
    await sam.page.keyboard.press("Escape");
    seen[role] = { rename, del, addField, newRow, pen, exports };
  }
  test.info().annotations.push({ type: "matrix", description: JSON.stringify(seen) });
  console.log("PERM-02 matrix", JSON.stringify(seen));
  expect(seen.edit).toMatchObject({ rename: true, del: true, addField: true, newRow: true, pen: 1, exports: 6 });
  for (const r of ["comment", "view"] as const) expect(seen[r], r).toMatchObject({ rename: false, del: false, addField: false, newRow: false, pen: 0, exports: 6 });

  await priya.ctx.close();
  await sam.ctx.close();
});
