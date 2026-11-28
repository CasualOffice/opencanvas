// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zl. Links and backlinks (LINK-01..05, ADR-081), to the approved prototype
// docs/prototypes/v05-approved/links-backlinks.html: `[[` links a canvas and `#` a heading
// (1a), the link shows the host's title, the hover preview (3a), "Linked from" at the end of the
// target with the sentence around the link and a chip on the linked heading that opens the side
// panel filtered to it (1b, 2a, 2b), a reader who cannot open the linking canvas sees no trace
// of it (5a), unlinked mentions with Link and Undo (2a), and axe on the section.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { HOST_LINKS } from "../env";
import { applyTemplate, createFile, editor, expectSaved, openFile, person, setAccess, typeAfterHeading } from "../helpers";

test.describe.configure({ mode: "serial" });

test("[[ and # link a canvas and a heading; Linked from, chips, preview and access", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  // The target: a heading to link to.
  const target = await createFile(priya, "SSO rollout plan", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "## Phase 2 enforce SSO");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("Owners keep a password fallback for 14 days.");
  await expectSaved(priya);

  // The source links it with [[ (the host's search finds it once saved) and # for the heading.
  const source = await createFile(priya, "Q1 Platform roadmap", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "Scope and dates live in ");
  await expect(editor(priya)).toHaveAttribute("data-links", "ready", { timeout: 15_000 });
  await priya.page.keyboard.type("[[SSO roll");
  const pick = priya.oc.getByRole("dialog", { name: "Link a canvas" });
  await expect(pick.getByRole("option", { name: /SSO rollout plan/ })).toBeVisible({ timeout: 15_000 });
  await priya.page.keyboard.press("Enter");
  const link = editor(priya).locator("a.clink").first();
  await expect(link).toHaveText("SSO rollout plan");
  await expect(link).toHaveAttribute("data-state", "ok");

  await expect(editor(priya)).toHaveAttribute("data-links", "ready", { timeout: 15_000 });

  await priya.page.keyboard.type("and [[SSO roll");
  await expect(pick.getByRole("option", { name: /SSO rollout plan/ })).toBeVisible({ timeout: 15_000 });
  await priya.page.keyboard.press("#");
  const blocks = priya.oc.getByRole("dialog", { name: "Blocks in SSO rollout plan" });
  await expect(blocks.getByRole("option", { name: /Phase 2 enforce SSO/ })).toBeVisible();
  await priya.page.keyboard.type("Phase");
  await priya.page.keyboard.press("Enter");
  const blockLink = editor(priya).locator("a.clink").nth(1);
  await expect(blockLink).toHaveText("SSO rollout plan › Phase 2 enforce SSO");
  await priya.page.keyboard.type(".");
  await expectSaved(priya);

  // 3a: the preview after a short rest, with the canvas's first lines; Esc closes it.
  await link.hover();
  const pv = priya.oc.getByRole("dialog", { name: "Link preview" });
  await expect(pv).toContainText("SSO rollout plan");
  await expect(pv.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  await priya.page.keyboard.press("Escape");
  await expect(pv).toBeHidden();

  // 2a: the target lists the source at its end, with the sentence around the link.
  await openFile(priya, target, HOST_LINKS);
  const end = priya.oc.getByRole("region", { name: "Linked from" });
  await expect(end.getByRole("button", { name: /Q1 Platform roadmap/ })).toBeVisible({ timeout: 15_000 });
  await expect(end).toContainText("Scope and dates live in SSO rollout plan");
  await expect(end).toContainText("Shows only canvases you can open");
  // 1b → 2b: the chip on the linked heading opens the side panel filtered to it.
  const chip = editor(priya).getByRole("button", { name: "Linked from 1 canvas" });
  await expect(chip).toBeVisible();
  await chip.click();
  const side = priya.oc.getByRole("complementary", { name: "Linked from" });
  await expect(side).toContainText("Phase 2 enforce SSO");
  await expect(side).toContainText("Q1 Platform roadmap");
  // 2b: the side panel shares a tab row with Comments; the top bar's menu opens it too.
  await side.getByRole("tab", { name: "Comments" }).click();
  const comments = priya.oc.getByRole("complementary", { name: "Comments" });
  await expect(comments.getByRole("tab", { name: "Linked from" })).toHaveAttribute("aria-selected", "false");
  await comments.getByRole("tab", { name: "Linked from" }).click();
  await expect(side.getByRole("tab", { name: "Linked from" })).toHaveAttribute("aria-selected", "true");
  await side.getByRole("button", { name: "Close" }).click();
  await expect(side).toBeHidden();
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await priya.oc.getByRole("menuitem", { name: "Linked from" }).click();
  await expect(side).toBeVisible();
  const axe = await new AxeBuilder({ page: priya.page }).include("iframe").analyze();
  expect(axe.violations.filter((v) => /lk-|clink/.test(JSON.stringify(v.nodes)))).toEqual([]);

  // 5a: Ravi can open the target but not the source: no trace of it, no count.
  await setAccess(priya, target, "u_ravi", "view", HOST_LINKS);
  const ravi = await person(browser, "u_ravi");
  await openFile(ravi, target, HOST_LINKS);
  const rend = ravi.oc.getByRole("region", { name: "Linked from" });
  await expect(rend).toContainText("No canvas you can open links here yet");
  await expect(rend).not.toContainText("Q1 Platform roadmap");
  await expect(editor(ravi).locator(".lk-chip")).toHaveCount(0);
  void source;
});

test("unlinked mentions: Link edits the other canvas, Undo puts it back", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const target = await createFile(priya, "Hiring plan 2027", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await expectSaved(priya);
  const other = await createFile(priya, "Weekly sync Nov 30", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "We follow the Hiring plan 2027 for the order of interviews.");
  await expectSaved(priya);

  await openFile(priya, target, HOST_LINKS);
  const men = priya.oc.getByRole("button", { name: /Unlinked mentions/ });
  await expect(men).toBeVisible({ timeout: 15_000 });
  await priya.oc.getByRole("button", { name: "Link the mention in Weekly sync Nov 30" }).click();
  const undo = priya.oc.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();

  // The other canvas now holds a link in place of the words.
  const second = await priya.ctx.newPage();
  await second.goto(`${HOST_LINKS}/files/${other}?as=u_priya`);
  const oc2 = second.frameLocator('iframe[name="oc"]');
  await expect(oc2.locator(".ProseMirror a.clink")).toHaveText("Hiring plan 2027", { timeout: 15_000 });
  await undo.click();
  await expect(oc2.locator(".ProseMirror a.clink")).toHaveCount(0, { timeout: 15_000 });
  await expect(oc2.locator(".ProseMirror")).toContainText("We follow the Hiring plan 2027 for the order");
});
