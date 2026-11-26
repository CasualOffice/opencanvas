// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// ze. Find and replace in a canvas (SRCH-01, ADR-066) and search across canvases (SRCH-04,
// ADR-065), to the approved prototype docs/prototypes/v03-approved/search.html: the find bar,
// a collaborator's text found within one update, replace all as one undo step, view-only find,
// the host-indexed search with a deep link through UI_OpenFile, the hidden entry for hosts
// without the callback, and axe in light and dark.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { HOST_RELOAD } from "../env";
import { applyTemplate, createFile, editor, expectSaved, openFile, person, sharedFile, typeAfterHeading } from "../helpers";

const bar = (oc: import("@playwright/test").FrameLocator) => oc.getByRole("search", { name: "Find in canvas" });

test("find, replace all as one undo step, a collaborator's text, an invalid pattern", async ({ browser }) => {
  const { priya, sam } = await sharedFile(browser, { name: "E2E ze · find", samRole: "edit" });
  await typeAfterHeading(priya, "Notes", "SSO rollout: SSO for admins, then SSO for everyone");
  await expect(editor(sam)).toContainText("SSO for everyone");

  // ⌘F / Ctrl+F in the canvas opens our bar, not the browser's.
  await editor(priya).click();
  await priya.page.keyboard.press("ControlOrMeta+f");
  const fb = bar(priya.oc);
  await expect(fb).toBeVisible();
  await fb.getByLabel("Find in canvas").fill("SSO");
  await expect(fb).toContainText("1 of 3");
  await expect(editor(priya).locator(".oc-find-hit")).toHaveCount(3);
  await expect(editor(priya).locator(".oc-find-hit.cur")).toHaveCount(1);
  await priya.page.keyboard.press("Enter");
  await expect(fb).toContainText("2 of 3");
  await priya.page.keyboard.press("Shift+Enter");
  await expect(fb).toContainText("1 of 3");

  // Sam types another SSO: Priya's count follows within one update, the current match stays.
  await typeAfterHeading(sam, "Notes", "SSO again ");
  await expect(fb).toContainText(/of 4/, { timeout: 3000 });

  // Replace all: one transaction, one toast, one undo step.
  await fb.getByRole("button", { name: "Show replace" }).click();
  await fb.getByLabel("Replace with").fill("single sign-on");
  await fb.getByRole("button", { name: "Replace all" }).click();
  await expect(priya.oc.getByText(/Replaced 4 “SSO” with “single sign-on”/)).toBeVisible();
  await expect(fb).toContainText("No results");
  await expect(editor(sam)).not.toContainText("SSO");
  await expect(editor(sam)).toContainText("single sign-on for everyone");
  await priya.oc.getByRole("button", { name: "Undo" }).click();
  await expect(editor(priya)).toContainText("SSO for everyone");
  await expect(editor(priya)).toContainText("SSO again");
  await expect(fb).toContainText("of 4");

  // A pattern that does not parse says so and clears the old matches.
  await fb.getByRole("button", { name: "Use a pattern (regular expression)" }).click();
  await fb.getByLabel("Find in canvas").fill("(SSO|");
  await expect(fb.getByRole("alert")).toBeVisible();
  await expect(fb).toContainText("Invalid pattern");
  await expect(editor(priya).locator(".oc-find-hit")).toHaveCount(0);
  await fb.getByLabel("Find in canvas").fill("SSO (for|again)");
  await expect(fb).toContainText("of 3");

  // Esc closes and selects the current match.
  await priya.page.keyboard.press("Escape");
  await expect(fb).toBeHidden();
  await expect(editor(priya).locator(".oc-find-hit")).toHaveCount(0);
  await priya.ctx.close();
  await sam.ctx.close();
});

test("view only: find without replace; ⌘⌥F only opens find", async ({ browser }) => {
  const { priya, sam } = await sharedFile(browser, { name: "E2E ze · view", samRole: "view" });
  await typeAfterHeading(priya, "Notes", "Quarterly SSO review");
  await expect(editor(sam)).toContainText("Quarterly SSO review");
  // A read-only editor is not focusable: focus the canvas page, as a click in it does.
  await editor(sam).click();
  await sam.page.frames().find((f) => f.name() === "oc")!.evaluate(() => window.focus());
  await sam.page.keyboard.press("ControlOrMeta+Alt+f");
  const fb = bar(sam.oc);
  await expect(fb).toBeVisible();
  await expect(fb.getByRole("button", { name: "Show replace" })).toHaveCount(0);
  await expect(fb.getByLabel("Replace with")).toHaveCount(0);
  await fb.getByLabel("Find in canvas").fill("sso");
  await expect(fb).toContainText("1 of 1");
  await priya.ctx.close();
  await sam.ctx.close();
});

test("search all canvases: results from the host's index open at the block in another canvas", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const first = await createFile(priya, "E2E ze · indexed", undefined);
  await applyTemplate(priya, "Meeting notes");
  const marker = `quokka${Date.now().toString(36)}`;
  await typeAfterHeading(priya, "Notes", `The ${marker} decision`);
  await expectSaved(priya);
  // Saved: the host indexed search.json from the save.
  const second = await createFile(priya, "E2E ze · searching", undefined);
  await applyTemplate(priya, "Meeting notes");

  // The menu names the entry; ⌘⇧F opens it.
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await expect(priya.oc.locator(".mi", { hasText: "Search all canvases" })).toBeVisible();
  await priya.page.keyboard.press("Escape");
  await editor(priya).click();
  await priya.page.keyboard.press("ControlOrMeta+Shift+f");
  const dlg = priya.oc.getByRole("dialog", { name: "Search all canvases" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("they update when a canvas is saved");
  await dlg.getByRole("combobox", { name: "Search all canvases" }).fill(marker);
  const hit = dlg.getByRole("option").filter({ hasText: marker });
  await expect(hit).toHaveCount(1, { timeout: 10_000 });
  await expect(hit.locator("mark")).toHaveText(marker);
  await expect(dlg.getByRole("option", { selected: true })).toHaveCount(1);

  // Enter: the host navigates (UI_OpenFile) to the other canvas at the block, which flashes.
  await priya.page.keyboard.press("Enter");
  await priya.page.waitForURL(new RegExp(`/files/${first}#block=b_`));
  await expect(editor(priya)).toContainText(marker);
  expect(second).not.toBe(first);

  // No results: the reasons in words.
  await editor(priya).click();
  await priya.page.keyboard.press("ControlOrMeta+Shift+f");
  await dlg.getByRole("combobox").fill(`${marker}zzz nothing`);
  await expect(dlg).toContainText(/No canvases match/);
  await priya.page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await priya.ctx.close();
});

test("a host without GET /search gets no entry and no ⌘⇧F; find still works", async ({ browser }) => {
  const p = await person(browser, "u_priya");
  await createFile(p, "E2E ze · no search", HOST_RELOAD);
  await applyTemplate(p, "Meeting notes");
  await p.oc.getByRole("button", { name: "More options" }).click();
  await expect(p.oc.locator(".mi", { hasText: "Find in canvas" })).toBeVisible();
  await expect(p.oc.locator(".mi", { hasText: "Search all canvases" })).toHaveCount(0);
  await p.page.keyboard.press("Escape");
  await editor(p).click();
  await p.page.keyboard.press("ControlOrMeta+Shift+f");
  await expect(p.oc.getByRole("dialog", { name: "Search all canvases" })).toHaveCount(0);
  await p.ctx.close();
});

test("find bar and search dialog pass axe in light and dark", async ({ browser }) => {
  const p = await person(browser, "u_priya", { colorScheme: "light" });
  const id = await createFile(p, "E2E ze · axe", undefined);
  await applyTemplate(p, "Meeting notes");
  await typeAfterHeading(p, "Notes", "Axe checks SSO here");
  await expectSaved(p);
  await openFile(p, id);
  await p.page.emulateMedia({ reducedMotion: "reduce" });
  const tags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
  for (const scheme of ["light", "dark"] as const) {
    await p.page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await editor(p).click();
    await p.page.keyboard.press("ControlOrMeta+f");
    await bar(p.oc).getByLabel("Find in canvas").fill("SSO");
    await bar(p.oc).getByRole("button", { name: "Show replace" }).click();
    await expect(bar(p.oc)).toContainText("1 of 1");
    const a = await new AxeBuilder({ page: p.page }).include(['iframe[name="oc"]', ".fb"]).include(['iframe[name="oc"]', ".oc-find-hit"]).withTags(tags).analyze();
    const fbViolations = a.violations;
    expect(fbViolations, `${scheme}: ${JSON.stringify(fbViolations.map((v) => [v.id, v.nodes.map((n) => n.target)]))}`).toEqual([]);
    await p.page.keyboard.press("Escape");
    await editor(p).click();
    await p.page.keyboard.press("ControlOrMeta+Shift+f");
    const dlg = p.oc.getByRole("dialog", { name: "Search all canvases" });
    await dlg.getByRole("combobox").fill("Axe checks");
    await expect(dlg.getByRole("option").first()).toBeVisible({ timeout: 10_000 });
    const b = await new AxeBuilder({ page: p.page }).include(['iframe[name="oc"]', ".sa"]).withTags(tags).analyze();
    const saViolations = b.violations;
    expect(saViolations, `${scheme}: ${JSON.stringify(saViolations.map((v) => [v.id, v.nodes.map((n) => n.target)]))}`).toEqual([]);
    await p.page.keyboard.press("Escape");
  }
  await p.ctx.close();
});
