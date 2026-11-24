// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// z — VH-01d / VH-02b against the real server and the sample host (which keeps every save as a
//     version): name a version (2a/2b), preview it read-only (3a), show the changes against a
//     named version (4a, 4d), restore it while someone else edits (6a) with the 30 s Undo (5b),
//     what the other editor sees (6b), the footer source label, a viewer without history (7b),
//     and in-file history on a host without version callbacks. axe in light and dark.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createFile, applyTemplate, expectSaved, openFile, person, setAccess, sharedFile, typeAfterHeading, type Person } from "../helpers";
import { HOST_RELOAD } from "../env";

const live = (p: Person) => p.oc.locator(".wsp > .body > .scroll .ProseMirror");
const panel = (p: Person) => p.oc.locator("aside.vh-panel");
const preview = (p: Person) => p.oc.locator(".vh-main");
const toastOf = (p: Person) => p.oc.locator(".toast");
/** The live canvas's text without collaborators' caret labels (they sit inside the text). */
const liveText = (p: Person) =>
  live(p).evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll(".collaboration-carets__caret").forEach((x) => x.remove());
    return c.textContent ?? "";
  });

async function menu(p: Person, item: string) {
  await p.oc.getByRole("button", { name: "More options" }).click();
  await p.oc.getByRole("menuitem", { name: item }).click();
}

async function nameVersion(p: Person, name: string) {
  await menu(p, "Name this version");
  const input = p.oc.getByRole("textbox", { name: "Name this version" });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press("Enter");
  await expect(toastOf(p)).toContainText(`Saved as “${name}”`);
  await expect(panel(p).locator(".vh-v.named", { hasText: name })).toBeVisible({ timeout: 10_000 });
}

async function axe(p: Person, label: string) {
  for (const theme of ["light", "dark"]) {
    await p.page.frame({ name: "oc" })!.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page: p.page })
      .include(['iframe[name="oc"]', ".vh-panel"])
      .include(['iframe[name="oc"]', ".vh-main"])
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(r.violations.map((v) => `${label} ${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
  await p.page.frame({ name: "oc" })!.evaluate(() => delete document.documentElement.dataset.theme);
}

test("VH-01d: name, preview, show changes, restore with others editing, undo", async ({ browser }) => {
  test.setTimeout(150_000);
  const { priya, sam } = await sharedFile(browser, { name: "E2E z · history", samRole: "edit" });
  await typeAfterHeading(priya, "Notes", "Admins sign in with SAML today");
  await expectSaved(priya);

  // 1a + 2a/2b: the menu entries, then a named version on top of today with "New".
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await expect(priya.oc.getByRole("menuitem", { name: /^Version history/ })).toBeVisible();
  await priya.page.keyboard.press("Escape");
  await nameVersion(priya, "First draft");
  await expect(panel(priya).locator(".vh-v.named", { hasText: "First draft" })).toContainText("New");
  // The owner's addition: who keeps the versions.
  await expect(panel(priya).locator(".vh-pfoot")).toContainText("Kept by Sample host.");

  // Sam edits after the name: SAML → SSO.
  const para = live(sam).locator("p", { hasText: "Admins sign in with SAML today" });
  await para.click();
  await sam.page.keyboard.press("End");
  for (let i = 0; i < " today".length; i++) await sam.page.keyboard.press("ArrowLeft");
  for (let i = 0; i < "SAML".length; i++) await sam.page.keyboard.press("Backspace");
  await sam.page.keyboard.type("SSO");
  await expect.poll(() => liveText(priya)).toContain("Admins sign in with SSO today");
  await expectSaved(sam);

  // 1b/1c + 3a: the newest editing session previews read-only, the live canvas keeps running.
  // The list refreshes on its own after the save: a new session lands above "First draft".
  const newest = panel(priya).locator(".vh-pl section").first().locator(":scope > *").first();
  await expect(newest).toHaveClass(/vh-sess/, { timeout: 10_000 });
  const session = newest;
  await expect(session).toContainText("Edited by Sam Ortiz");
  await session.locator(".vh-v").click();
  await expect(preview(priya)).toBeVisible();
  await expect(preview(priya).getByText("Read only")).toBeVisible();
  await expect(preview(priya).locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
  await expect(preview(priya).locator(".ProseMirror")).toContainText("Admins sign in with SSO today");
  await expect(priya.oc.locator(".wsp > .top")).toBeHidden();

  // 4a + 4d: Show changes, compared with the named version: words struck and underlined.
  await preview(priya).getByRole("switch", { name: "Show changes" }).click();
  await preview(priya).getByRole("button", { name: /^Compare with/ }).click();
  await priya.oc.getByRole("menuitem", { name: /First draft/ }).click();
  await expect(preview(priya).locator(".vh-sum")).toContainText("1 changed");
  await expect(preview(priya).locator("ins.vh-ins")).toHaveText("SSO");
  await expect(preview(priya).locator("del.vh-del")).toHaveText("SAML");
  await expect(preview(priya).locator(".vh-b.vh-chg")).toHaveAttribute("title", "Changed in this version");
  await expect(panel(priya).locator(".vh-v.named", { hasText: "First draft" })).toContainText("Compare from");
  await preview(priya).getByRole("button", { name: "Next change" }).click();
  await expect(preview(priya).locator(".vh-hl")).toHaveCount(1);
  await axe(priya, "preview with changes");

  // Esc: back to the live canvas.
  await priya.page.keyboard.press("Escape");
  await expect(preview(priya)).toBeHidden();
  await expect(priya.oc.locator(".wsp > .top")).toBeVisible();

  // 5a/6a: restore "First draft" while Sam is in the canvas: the confirm names him.
  await panel(priya).locator(".vh-v.named", { hasText: "First draft" }).click();
  await preview(priya).getByRole("button", { name: "Restore this version" }).click();
  const dialog = priya.oc.getByRole("dialog", { name: "Restore this version" });
  await expect(dialog).toContainText("Sam is editing");
  await expect(dialog).toContainText("What they’ve typed so far is saved in “Before restore”.");
  await dialog.getByRole("button", { name: "Restore for everyone" }).click();

  // 5b: the restorer's toast with Undo; the canvas is back and live for everyone.
  await expect(toastOf(priya)).toContainText("Restored “First draft”");
  await expect(toastOf(priya).getByRole("button", { name: "Undo" })).toBeVisible();
  await expect.poll(() => liveText(priya)).toContain("Admins sign in with SAML today");
  await expect.poll(() => liveText(sam)).toContain("Admins sign in with SAML today");
  // 6b: Sam gets a note, not a modal, and no Undo.
  await expect(toastOf(sam)).toContainText("Priya restored “First draft”. Earlier edits are in Version history.");
  await expect(toastOf(sam).getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(panel(priya).locator(".vh-v.restore", { hasText: "Restored from “First draft”" })).toBeVisible({ timeout: 10_000 });
  await expect(panel(priya).locator(".vh-v", { hasText: "Before restore" })).toBeVisible();

  // Undo, within 30 s, by the person who restored.
  await toastOf(priya).getByRole("button", { name: "Undo" }).click();
  await expect(toastOf(priya)).toContainText("Restore undone");
  await expect.poll(() => liveText(priya)).toContain("Admins sign in with SSO today");
  await expect.poll(() => liveText(sam)).toContain("Admins sign in with SSO today");
  await axe(priya, "panel");
  await priya.ctx.close();
  await sam.ctx.close();
});

test("VH-01d 7b: a viewer without the history permission has no history menu items", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E z · viewer");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_ravi", "view");
  const ravi = await person(browser, "u_ravi");
  await openFile(ravi, fileId);
  await ravi.oc.getByRole("button", { name: "More options" }).click();
  await expect(ravi.oc.getByRole("menuitem").first()).toBeVisible();
  await expect(ravi.oc.getByRole("menuitem", { name: /Version history/ })).toHaveCount(0);
  await expect(ravi.oc.getByRole("menuitem", { name: /Name this version/ })).toHaveCount(0);
  await priya.ctx.close();
  await ravi.ctx.close();
});

test("VH-01d footer: a host without version callbacks keeps the history in the file", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  await createFile(priya, "E2E z · in-file", HOST_RELOAD);
  await applyTemplate(priya, "Meeting notes");
  await expectSaved(priya);
  await nameVersion(priya, "Kickoff");
  await expect(panel(priya).locator(".vh-pfoot")).toContainText("Kept in this file.");
  await priya.ctx.close();
});

