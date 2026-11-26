// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zf. Automation in the editor (AUTO-06, ADR-067, approved prototype
// docs/prototypes/v03-approved/automation.html): the panel from the canvas menu, suggestions,
// creating a rule, a test run, the rule running on a new row (run history), a URL on an origin
// that is not allowed, view only, a host without automation, axe in light and dark.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator } from "@playwright/test";
import { HOST_RELOAD } from "../env";
import { applyTemplate, createFile, editor, openFile, person, setAccess, typeAfterHeading } from "../helpers";

const panel = (oc: FrameLocator) => oc.getByRole("complementary", { name: /Automations|Edit rule|Run history|Run details/ });

async function openPanel(oc: FrameLocator) {
  await oc.getByRole("button", { name: "More options" }).click();
  await oc.locator(".mi", { hasText: "Automations" }).click();
  await expect(panel(oc)).toBeVisible();
}

test("create a rule, test it, watch it run on a new row, and refuse a URL that is not allowed", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const id = await createFile(priya, "E2E zf · automation", undefined);
  await applyTemplate(priya, "Meeting notes");
  await openPanel(priya.oc);
  const p = panel(priya.oc);
  // 1b: the empty state suggests rules built from this canvas.
  await expect(p).toContainText("Let this canvas do the busywork");
  await expect(p.getByRole("button", { name: /The day before Due, notify the Owner/ })).toBeVisible();
  await p.getByRole("button", { name: /Start from scratch/ }).click();

  // 2a: the trigger picker, grouped; a row is added to the canvas's database.
  await expect(p.getByRole("listbox", { name: "Choose a trigger" })).toContainText("In a database");
  await p.getByRole("option", { name: "A row is added" }).click();
  await p.getByLabel("Name").fill("Welcome new actions");
  await p.getByRole("button", { name: "Add an action" }).click();
  await p.getByRole("option", { name: "Add a comment" }).click();
  await p.getByLabel("Comment text").fill("New action: {row.title}");

  // 2e: a test run changes nothing and sends nothing.
  await p.getByRole("button", { name: "Test run" }).click();
  await expect(p.getByRole("status")).toContainText("Nothing was changed or sent.");
  await expect(p.getByRole("status")).toContainText("Would add a comment");
  await p.getByRole("button", { name: "Save rule" }).click();

  // 1a: the card reads as a sentence and is on.
  await expect(p).toContainText("Welcome new actions");
  await expect(p).toContainText("a row is added to");
  await expect(p.getByRole("switch", { name: "Welcome new actions on" })).toBeChecked();

  // A new row runs it: the run history shows it done.
  await priya.oc.getByRole("button", { name: /New row/ }).first().click();
  // 3a: the person whose change started the run is told, with Undo.
  await expect(priya.oc.getByText("Welcome new actions made 1 change")).toBeVisible({ timeout: 10_000 });
  await p.getByRole("button", { name: "Run history" }).click();
  await expect(async () => {
    await p.getByRole("button", { name: "Back to automations" }).click();
    await p.getByRole("button", { name: "Run history" }).click();
    await expect(p.locator(".rr").first()).toContainText("Welcome new actions", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(p.locator(".rr").first()).toContainText("A row was added");
  await expect(p).toContainText("Runs keep ids, times and results only, never canvas text.");
  await p.locator(".rr").first().click();
  await expect(p).toContainText("Run id");

  // 2d: a URL on another origin is refused as you type and cannot be saved.
  await p.getByRole("button", { name: "Edit rule" }).click();
  await p.getByRole("button", { name: "Add an action" }).click();
  await p.getByRole("option", { name: "Call a URL" }).click();
  await p.getByLabel("URL").fill("https://hooks.slack-mirror.example/rel");
  await expect(p.getByRole("alert").first()).toContainText("This URL isn’t allowed. Automations here may call");
  await p.getByRole("button", { name: "Save rule" }).click();
  await expect(p.locator(".re-errs")).toContainText("to fix before this rule can run");
  await p.getByRole("button", { name: "Cancel" }).click();

  // Switch it off from the list.
  await p.getByRole("switch", { name: "Welcome new actions on" }).uncheck();
  await expect(p.locator(".ar-st").first()).toContainText("Off");
  expect(id).toBeTruthy();
  await priya.ctx.close();
});

test("view only: the rules are visible, not editable; a host without automation has no panel", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const id = await createFile(priya, "E2E zf · view", undefined);
  await applyTemplate(priya, "Meeting notes");
  await openPanel(priya.oc);
  await panel(priya.oc).getByRole("button", { name: /The day before Due, notify the Owner/ }).click();
  await panel(priya.oc).getByRole("button", { name: "Save rule" }).click();
  await expect(panel(priya.oc)).toContainText("Due tomorrow reminder");
  await setAccess(priya, id, "u_sam", "view");
  const sam = await person(browser, "u_sam");
  await openFile(sam, id);
  await openPanel(sam.oc);
  const p = panel(sam.oc);
  await expect(p).toContainText("Due tomorrow reminder");
  await expect(p).toContainText("You can view this canvas. Editors manage its rules.");
  await expect(p.getByRole("switch")).toHaveCount(0);
  await expect(p.getByRole("button", { name: /New rule/ })).toHaveCount(0);
  await expect(p.getByRole("button", { name: "Run history" })).toHaveCount(0);
  await sam.ctx.close();

  const other = await person(browser, "u_priya");
  await createFile(other, "E2E zf · no automation", HOST_RELOAD);
  await applyTemplate(other, "Meeting notes");
  await other.oc.getByRole("button", { name: "More options" }).click();
  await expect(other.oc.locator(".mi", { hasText: "Find in canvas" })).toBeVisible();
  await expect(other.oc.locator(".mi", { hasText: "Automations" })).toHaveCount(0);
  await other.ctx.close();
  await priya.ctx.close();
});

test("the automations panel passes axe in light and dark", async ({ browser }) => {
  const p = await person(browser, "u_priya", { colorScheme: "light" });
  await createFile(p, "E2E zf · axe", undefined);
  await applyTemplate(p, "Meeting notes");
  await p.page.emulateMedia({ reducedMotion: "reduce" });
  const tags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
  await openPanel(p.oc);
  await panel(p.oc).getByRole("button", { name: /The day before Due, notify the Owner/ }).click();
  await panel(p.oc).getByRole("button", { name: "Save rule" }).click();
  for (const scheme of ["light", "dark"] as const) {
    await p.page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await expect(panel(p.oc)).toContainText("Due tomorrow reminder");
    const a = await new AxeBuilder({ page: p.page }).include(['iframe[name="oc"]', ".ap"]).withTags(tags).analyze();
    expect(a.violations, `${scheme} list: ${JSON.stringify(a.violations.map((v) => [v.id, v.nodes.map((n) => n.target)]))}`).toEqual([]);
    await panel(p.oc).getByRole("button", { name: "Edit Due tomorrow reminder" }).click();
    const b = await new AxeBuilder({ page: p.page }).include(['iframe[name="oc"]', ".ap"]).withTags(tags).analyze();
    expect(b.violations, `${scheme} editor: ${JSON.stringify(b.violations.map((v) => [v.id, v.nodes.map((n) => n.target)]))}`).toEqual([]);
    await panel(p.oc).getByRole("button", { name: "Cancel" }).click();
  }
  await p.ctx.close();
});

test("entry points: the database header's Automate menu and “When this is checked…” on a checklist", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  await createFile(priya, "E2E zf · entry points", undefined);
  await applyTemplate(priya, "Meeting notes");
  // 1c, left: the database header has Automate with a menu of starts.
  const automate = priya.oc.getByRole("button", { name: /^Automate/ }).first();
  await automate.click();
  await priya.oc.locator(".mi", { hasText: "When a field changes…" }).click();
  const p = panel(priya.oc);
  await expect(p).toBeVisible();
  await expect(p.getByLabel("Field")).toBeVisible();
  await expect(p.getByLabel("Database").first()).toHaveValue(/.+/);
  await p.getByRole("button", { name: "Cancel" }).click();
  await p.getByRole("button", { name: "Close automations" }).click();

  // 1c, right: a checklist's block menu offers "When this is checked…".
  await typeAfterHeading(priya, "Notes", "[] Changelog reviewed");
  await editor(priya).locator("li", { hasText: "Changelog reviewed" }).click();
  await priya.page.keyboard.press("ControlOrMeta+/");
  await priya.oc.locator(".mi", { hasText: "When this is checked…" }).click();
  await expect(p.getByLabel("Checklist item")).toBeVisible();
  await expect(p.getByLabel("Checklist item")).not.toHaveValue("");
  await p.getByRole("button", { name: "Add an action" }).click();
  await p.getByRole("option", { name: "Add a comment" }).click();
  await p.getByLabel("Comment text").fill("Ready to ship");
  await p.getByRole("button", { name: "Save rule" }).click();
  await expect(p).toContainText("an item in");
  await priya.ctx.close();
});
