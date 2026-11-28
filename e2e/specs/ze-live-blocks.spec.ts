// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// LIVE-03/07 end to end (docs/prototypes/v03-approved/live-blocks.html): Make live (1b, 1c), the
// host's picker (1e), two people in two canvases editing one live block with presence (2a, 2b),
// who can see this (2d), no access (5c), a deleted source (5e), removing a live block without a
// 4426 close, convert to a copy (2f), and axe in light and dark.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { HOST } from "../env";
import { applyTemplate, createFile, editor, expectSaved, openFile, person, setAccess, typeAfterHeading, type Person } from "../helpers";

async function axe(p: Person) {
  const frame = p.page.frame({ name: "oc" })!;
  await p.page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"]) {
    await frame.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page: p.page }).include(['iframe[name="oc"]', ".lb"]).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
  await frame.evaluate(() => delete document.documentElement.dataset.theme);
}

const live = (p: Person) => p.oc.locator(".lb").first();
const liveBody = (p: Person) => live(p).locator(".lb-b .ProseMirror");

async function newParagraph(p: Person, text: string) {
  await typeAfterHeading(p, "Notes", text);
}

test("make live, insert from the host picker, edit together from two canvases", async ({ browser }) => {
  test.setTimeout(150_000);
  // The host picker lists every live block Priya can open: a name of its own per run, so a
  // repeat (--repeat-each, the nightly) does not find the blocks earlier runs made (RLB-04).
  const NAME = `Release 4.2 checklist ${Date.now().toString(36)}`;
  const priya = await person(browser, "u_priya");
  const a = await createFile(priya, "E2E ze · Sprint planning");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, a, "u_asha", "edit");
  await newParagraph(priya, "Release notes drafted");
  await expectSaved(priya);

  // 1a-1c: the block menu's Make live…, the dialog, the block in place with a toast.
  await editor(priya).getByText("Release notes drafted", { exact: true }).click();
  await priya.page.keyboard.press("ControlOrMeta+/");
  await priya.oc.getByRole("menuitem", { name: "Make live…" }).click();
  const dlg = priya.oc.getByRole("dialog", { name: "Make this a live block" });
  await expect(dlg).toContainText("Starts with the same people as");
  await dlg.getByLabel("Name").fill(NAME);
  await dlg.getByRole("button", { name: "Make live" }).click();
  await expect(dlg).toBeHidden({ timeout: 15_000 });
  await expect(priya.oc.getByText(`${NAME} is live`)).toBeVisible();
  await expect(live(priya).locator(".lb-live")).toHaveText("Live");
  await expect(liveBody(priya)).toContainText("Release notes drafted", { timeout: 15_000 });
  await expect(live(priya)).toHaveAttribute("data-state", "connected");

  // 1e: the second canvas inserts it through the host's own picker.
  const b = await createFile(priya, "E2E ze · Leadership weekly");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, b, "u_asha", "edit");
  await setAccess(priya, b, "u_sam", "view");
  await typeAfterHeading(priya, "Notes", "/live block");
  await expect(priya.oc.getByRole("listbox", { name: "Insert a block" })).toBeVisible();
  await priya.page.keyboard.press("Enter");
  const picker = priya.page.getByRole("dialog", { name: "Insert a live block" });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: NAME }).click();
  await expect(liveBody(priya)).toContainText("Release notes drafted", { timeout: 15_000 });
  await expect(live(priya).locator(".lb-t")).toHaveText(NAME);
  await axe(priya);

  // 2a/2b: Asha edits it in Sprint planning; Priya sees it in Leadership weekly, and back.
  const asha = await person(browser, "u_asha");
  await openFile(asha, a);
  await expect(liveBody(asha)).toContainText("Release notes drafted", { timeout: 15_000 });
  await liveBody(asha).locator("p").first().click();
  await asha.page.keyboard.press("End");
  await asha.page.keyboard.type(" by Asha");
  await expect(liveBody(priya)).toContainText("Release notes drafted by Asha", { timeout: 5_000 });
  await liveBody(priya).locator("p").first().click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.type(" and Priya");
  await expect(liveBody(asha)).toContainText("by Asha and Priya", { timeout: 5_000 });
  await expect(live(priya).locator(".lb-ppl")).toBeVisible();

  // 2d: who can see this: Sam (view on the canvas, nothing on the live file) cannot open it.
  await live(priya).getByRole("button", { name: "Live block options" }).click();
  await priya.oc.getByRole("menuitem", { name: "Who can see this" }).or(priya.oc.getByRole("button", { name: "Who can see this" })).click();
  const pop = priya.oc.locator(".lb-pop");
  await expect(pop).toContainText("You can edit it.");
  await expect(pop).toContainText("1 person with access to this canvas can’t open it.");
  await priya.page.keyboard.press("Escape");

  // 5c: no access, title shown.
  const sam = await person(browser, "u_sam");
  await openFile(sam, b);
  await expect(live(sam)).toHaveAttribute("data-state", "noaccess", { timeout: 15_000 });
  await expect(live(sam)).toContainText("You don’t have access to this live block");
  await expect(live(sam)).not.toContainText("Release notes drafted");

  // The live file holds the text; the canvases hold only the reference (no copy in their CRDT).
  await expectSaved(priya);
  await Promise.all([asha.ctx.close(), sam.ctx.close(), priya.ctx.close()]);
});

test("a deleted source, remove without a 4426 close, and convert to a copy", async ({ browser }) => {
  test.setTimeout(150_000);
  const priya = await person(browser, "u_priya");
  const a = await createFile(priya, "E2E ze · Source canvas");
  await applyTemplate(priya, "Meeting notes");
  await newParagraph(priya, "Keep this line");
  await expectSaved(priya);
  await editor(priya).getByText("Keep this line", { exact: true }).click();
  await priya.page.keyboard.press("ControlOrMeta+/");
  await priya.oc.getByRole("menuitem", { name: "Make live…" }).click();
  await priya.oc.getByRole("dialog", { name: "Make this a live block" }).getByLabel("Name").fill("Copy me");
  await priya.oc.getByRole("button", { name: "Make live", exact: true }).click();
  await expect(liveBody(priya)).toContainText("Keep this line", { timeout: 15_000 });

  // 2f: convert to a copy: plain blocks again, one undo step, the live file untouched.
  await live(priya).getByRole("button", { name: "Live block options" }).click();
  await priya.oc.getByRole("button", { name: "Convert to a copy…" }).or(priya.oc.getByRole("menuitem", { name: "Convert to a copy…" })).click();
  await priya.oc.getByRole("dialog", { name: "Convert to a copy?" }).getByRole("button", { name: "Convert to a copy" }).click();
  await expect(priya.oc.locator(".lb")).toHaveCount(0);
  await expect(editor(priya)).toContainText("Keep this line");
  await priya.oc.getByRole("button", { name: "Undo" }).click();
  await expect(priya.oc.locator(".lb")).toHaveCount(1);

  // Removing it from the canvas: an editor with caps=live is never closed with 4426.
  const closes: number[] = [];
  priya.page.on("websocket", (ws) => ws.on("close", () => closes.push(1)));
  await live(priya).getByRole("button", { name: "Live block options" }).click();
  await priya.oc.getByRole("button", { name: "Remove from this canvas" }).or(priya.oc.getByRole("menuitem", { name: "Remove from this canvas" })).click();
  await expect(priya.oc.locator(".lb")).toHaveCount(0);
  await priya.oc.getByRole("button", { name: "Undo" }).click();
  await expect(priya.oc.locator(".lb")).toHaveCount(1);
  await expectSaved(priya);
  await expect(priya.oc.locator(".banner, [role=alert]").filter({ hasText: /closed|ended|reload/i })).toHaveCount(0);
  const liveId = await live(priya).getAttribute("data-live-file");

  // 5e: the host deletes the file; someone opening the canvas now sees "deleted or moved".
  await setAccess(priya, a, "u_ravi", "view");
  const r = await fetch(`${HOST}/__test/files/${liveId}/delete`, { method: "POST" });
  expect(r.ok).toBe(true);
  const ravi = await person(browser, "u_ravi");
  await openFile(ravi, a);
  await expect(live(ravi)).toHaveAttribute("data-state", "gone", { timeout: 15_000 });
  await expect(live(ravi)).toContainText("This live block was deleted or moved");
  await axe(ravi);
  await Promise.all([ravi.ctx.close(), priya.ctx.close()]);
});
