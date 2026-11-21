// c. The owner changes Sam's role on the host's files page ("Save access" → role API):
//    view → edit makes Sam's editor editable without a reload; edit → none closes his session.
import { expect, test } from "@playwright/test";
import { editor, setAccess, sharedFile, typeAfterHeading } from "../helpers";

test("live role change view → edit → none", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E c · roles", samRole: "view" });
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false");
  await expect(sam.oc.locator(".banner", { hasText: "You can view this canvas" })).toBeVisible();
  const navigations: string[] = [];
  sam.page.on("framenavigated", (f) => navigations.push(f.url()));

  // view → edit
  await setAccess(priya, fileId, "u_sam", "edit");
  await expect(editor(sam)).toHaveAttribute("contenteditable", "true");
  await expect(sam.oc.locator(".toast", { hasText: "gave you edit access" })).toBeVisible();
  await expect(sam.oc.locator(".banner", { hasText: "You can view this canvas" })).toHaveCount(0);
  // The server accepts his writes now: Priya sees them.
  await typeAfterHeading(sam, "Notes", "Sam can edit now");
  await expect(editor(priya).locator("p", { hasText: "Sam can edit now" })).toBeVisible({ timeout: 2_000 });
  expect(navigations, "no reload of the editor").toEqual([]);

  // edit → none: the session closes with the closed state.
  await setAccess(priya, fileId, "u_sam", "none");
  const closed = sam.oc.getByRole("dialog", { name: "Canvas closed" });
  await expect(closed).toBeVisible();
  await expect(closed).toContainText("Your access to this canvas changed");
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false");
  // Priya is unaffected.
  await expect(editor(priya)).toHaveAttribute("contenteditable", "true");
  await expect(priya.oc.getByRole("button", { name: "Follow Sam Ortiz" })).toHaveCount(0);

  await priya.ctx.close();
  await sam.ctx.close();
});
