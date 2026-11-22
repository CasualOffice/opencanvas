// r. Acceptance (docs/23 Permissions): live role changes down and back up, a forged
//    write from a viewer's devtools, and what a revoke does to the other people.
import { expect, test, type FrameLocator } from "@playwright/test";
import { editor, expectSaved, setAccess, sharedFile, storedDocumentHas, typeAfterHeading } from "../helpers";

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

// Known FAIL (docs/23 PERM-05): the room saves with the callback token of the last person
// granted edit; after that person is revoked the host answers 403 to every save, even
// though Priya (edit) is still in the room. Remove test.fail once fixed.
test("PERM-05: saves keep reaching the host after the last-granted editor is revoked", async ({ browser }) => {
  test.fail();
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
  // Known FAIL (docs/23 PERM-03): after the client starts over, the downgrade banner is gone.
  test.fail();
  await expect(banner(sam.oc, "Edits that hadn't synced weren't kept")).toBeVisible();

  await priya.ctx.close();
  await sam.ctx.close();
});
