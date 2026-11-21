// j. Editing behaviour that loads after first paint (late.ts: initial-JS budget): the slash
//    menu, @mentions, autolink while typing and link-on-paste over a selection. The schema
//    is there from the start, so the viewer sees every result live.
import { expect, test } from "@playwright/test";
import { editor, sharedFile, typeAfterHeading } from "../helpers";

test("slash menu, @mention, autolink and link paste work after the late plugins load", async ({ browser }) => {
  const { priya, sam } = await sharedFile(browser, { name: "E2E j · late plugins", samRole: "view" });

  // Slash menu: filter, Enter picks the highlighted item.
  await typeAfterHeading(priya, "Notes", "");
  await priya.page.keyboard.type("/check");
  const menu = priya.oc.locator(".pop").filter({ hasText: "Checklist" });
  await expect(menu).toBeVisible();
  await priya.page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await priya.page.keyboard.type("Ship the budget");
  await expect(editor(sam).locator('ul[data-type="taskList"] li', { hasText: "Ship the budget" })).toBeVisible({ timeout: 2_000 });

  // @mention: search the host's people, Enter inserts the chip.
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("Owner @Sam");
  await expect(priya.oc.locator(".pop").filter({ hasText: "People" }).getByRole("option", { name: /Sam Ortiz/ })).toBeVisible();
  await priya.page.keyboard.press("Enter");
  await expect(editor(sam).locator('.mention[data-id="u_sam"]')).toHaveText(/Sam Ortiz/, { timeout: 2_000 });

  // Autolink: a bare URL becomes a link when the word ends.
  await priya.page.keyboard.type("docs at example.com/budget ok");
  await expect(editor(sam).locator('a[href="http://example.com/budget"]')).toHaveText("example.com/budget", { timeout: 2_000 });

  // Link on paste: a URL pasted over selected text links that text.
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("the plan");
  for (let i = 0; i < "the plan".length; i++) await priya.page.keyboard.press("Shift+ArrowLeft");
  // ProseMirror reads the DOM selection on `selectionchange` (async); a paste dispatched in the
  // same tick can see the selection one key behind ("he plan"). A person never pastes that fast.
  await expect.poll(() => editor(priya).evaluate(() => (window.getSelection()?.toString() ?? ""))).toBe("the plan");
  await priya.page.waitForTimeout(100);
  await editor(priya).evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "https://example.org/plan");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  // Text without collaborators' caret labels (Priya's caret sits inside the link for Sam).
  const linked = editor(sam).locator('a[href="https://example.org/plan"]');
  await expect.poll(() => linked.evaluateAll((els) => els.map((a) => { const c = a.cloneNode(true) as HTMLElement; c.querySelectorAll(".collaboration-carets__caret").forEach((x) => x.remove()); return c.textContent; }).join("")), { timeout: 2_000 }).toBe("the plan");

  await priya.ctx.close();
  await sam.ctx.close();
});
