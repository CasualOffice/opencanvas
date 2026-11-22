// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// x — docs/23 two-user acceptance, comments: a thread, a reply and resolve travel live between
//     two people; a commenter can comment but not change the document.
import { expect, test } from "@playwright/test";
import { editor, sharedFile, storedDocumentHas, typeAfterHeading, type Person } from "../helpers";

const side = (p: Person) => p.oc.locator("aside.side[aria-label=Comments]");
const openComments = async (p: Person) => {
  if (!(await side(p).isVisible())) await p.oc.getByRole("button", { name: /^Comments/ }).first().click();
  await expect(side(p)).toBeVisible();
};
const thread = (p: Person, quote: string) => side(p).locator(".thread").filter({ hasText: quote });

test("COMMENT-2U: thread, reply and resolve live across two people; a commenter only comments", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E x · comments", samRole: "comment" });
  await typeAfterHeading(priya, "Notes", "Budget is final");
  await expect(editor(sam).locator("p", { hasText: "Budget is final" })).toBeVisible({ timeout: 5_000 });

  // Priya starts a thread on the sentence.
  await editor(priya).locator("p", { hasText: "Budget is final" }).selectText();
  await priya.oc.getByRole("button", { name: "Comment", exact: true }).first().click();
  const first = priya.oc.getByRole("combobox", { name: "Add a comment" }).first();
  await first.pressSequentially("Is it signed off?");
  await first.press("Enter");

  // Sam (commenter) sees it live and replies.
  await openComments(sam);
  const st = thread(sam, "Is it signed off?");
  await expect(st).toBeVisible({ timeout: 5_000 });
  await expect(st).toContainText("Budget is final");
  const reply = st.getByRole("combobox", { name: "Reply" });
  await reply.click();
  await reply.pressSequentially("Yes, signed on Friday");
  await reply.press("Enter");

  // Priya sees the reply live, attributed to Sam.
  await openComments(priya);
  const pt = thread(priya, "Is it signed off?");
  await expect(pt).toContainText("Yes, signed on Friday", { timeout: 5_000 });
  await expect(pt.locator(".msg").filter({ hasText: "Yes, signed on Friday" })).toContainText("Sam Ortiz");

  // Sam resolves it; it leaves Priya's open list live and shows under "resolved".
  await st.getByRole("button", { name: "Resolve thread" }).click();
  await expect(thread(priya, "Is it signed off?")).toHaveCount(0, { timeout: 5_000 });
  await priya.oc.getByRole("button", { name: /^Show 1 resolved/ }).click();
  await expect(thread(priya, "Is it signed off?")).toHaveClass(/resolved/);
  await expect.poll(() => storedDocumentHas(fileId, "Yes, signed on Friday"), { timeout: 15_000 }).toBe(true);

  // A commenter only comments: the text is read-only, and typing changes nothing for anyone.
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false");
  await editor(sam).locator("p", { hasText: "Budget is final" }).click();
  await sam.page.keyboard.type(" SAM-WAS-HERE");
  await sam.page.waitForTimeout(1_000);
  await expect(editor(sam)).not.toContainText("SAM-WAS-HERE");
  await expect(editor(priya)).not.toContainText("SAM-WAS-HERE");
  expect(storedDocumentHas(fileId, "SAM-WAS-HERE")).toBe(false);

  await priya.ctx.close();
  await sam.ctx.close();
});
