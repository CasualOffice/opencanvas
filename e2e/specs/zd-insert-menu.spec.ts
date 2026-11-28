// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zd. The categorised insert menu (INS-01, docs/prototypes/insert-menu-approved), desktop: insert
// through a category, an inline variant, an intent, `/h2` and the keyboard alone; axe in light
// and dark with the menu and a flyout open; and the meeting profile's flat list (5a, 5c).
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { HOST_MEETING } from "../env";
import { applyTemplate, createFile, editor, person, sharedFile, typeAfterHeading, type Person } from "../helpers";

const menuOf = (p: Person) => p.oc.getByRole("listbox", { name: "Insert a block" });
const active = (p: Person) => p.oc.locator(".oci [role=option].on");

async function newLine(p: Person) {
  await p.page.keyboard.press("End");
  await p.page.keyboard.press("Enter");
}

/** Presses ↓ until the active option's label starts with `name` (the bands vary with Recent). */
async function downTo(p: Person, name: string) {
  for (let i = 0; i < 12; i++) {
    if (((await active(p).getAttribute("aria-label")) ?? "").startsWith(name)) return;
    await p.page.keyboard.press("ArrowDown");
  }
  await expect(active(p)).toHaveAttribute("aria-label", new RegExp("^" + name));
}

/** Types "/" and waits for the menu. A brand-new canvas may get the "/" before the editor's late
 *  plugins (the "/" suggestion among them) are installed: then the "/" is retyped. */
async function slash(p: Person) {
  await p.page.keyboard.type("/");
  await expect(async () => {
    if (!(await menuOf(p).isVisible())) {
      await p.page.keyboard.press("Backspace");
      await p.page.keyboard.type("/");
    }
    await expect(menuOf(p)).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
}

async function axe(p: Person, include: string[]) {
  const frame = p.page.frame({ name: "oc" })!;
  // Theme switches transition colours; axe must not sample mid-fade.
  await p.page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"]) {
    await frame.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page: p.page }).include(include).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
  await frame.evaluate(() => delete document.documentElement.dataset.theme);
}

test("full profile: category, variant, intent, /h2 and keyboard only", async ({ browser }) => {
  const { priya } = await sharedFile(browser, { name: "E2E zd · insert menu", samRole: "view" });
  const ed = editor(priya);
  const menu = menuOf(priya);

  // The root: Quick insert, goals, Explore and Browse all blocks (1a).
  await typeAfterHeading(priya, "Notes", "");
  await slash(priya);
  await expect(menu.getByRole("group", { name: "Quick insert" }).getByRole("option")).toHaveCount(5);
  await expect(menu.getByRole("option", { name: "Track tasks" })).toBeVisible();
  for (const c of ["Content", "Data & planning", "Visual & diagrams", "Layout"]) await expect(menu.getByRole("option", { name: c })).toBeVisible();
  await expect(menu.getByRole("option", { name: "Browse all blocks" })).toBeVisible();

  // A category opens beside the menu (1b-1d); its block inserts.
  await menu.getByRole("option", { name: "Layout" }).hover();
  const fly = priya.oc.getByRole("listbox", { name: "Layout" });
  await expect(fly).toBeVisible();
  await expect(fly.getByRole("option", { name: "Columns, 2 columns" })).toBeVisible();
  await axe(priya, ['iframe[name="oc"]', ".oci"]);
  const hrs = await ed.locator("hr").count();
  await fly.getByRole("option", { name: "Divider" }).click();
  await expect(ed.locator("hr")).toHaveCount(hrs + 1);
  await expect(menu).toHaveCount(0);

  // An inline variant: Tab cycles the callout style, Enter inserts it (2a).
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("/callout");
  await expect(active(priya)).toHaveAttribute("aria-label", "Callout, Info");
  await priya.page.keyboard.press("Tab");
  await priya.page.keyboard.press("Tab");
  await priya.page.keyboard.press("Tab");
  await expect(active(priya)).toHaveAttribute("aria-label", "Callout, Decision");
  await expect(priya.oc.locator(".oci .mf")).toContainText("insert Decision");
  await priya.page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await priya.page.keyboard.type("Ship it in January");
  await expect(ed.locator('.callout[data-tone="purple"]', { hasText: "Ship it in January" })).toBeVisible();

  // An intent with a why line (3a).
  await typeAfterHeading(priya, "Notes", "/track tasks");
  await expect(menu.getByText("Good for “track tasks”")).toBeVisible();
  await expect(active(priya)).toHaveAttribute("aria-label", "List, Checklist");
  await expect(active(priya)).toContainText("tick tasks off as you go");
  await priya.page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await priya.page.keyboard.type("Book the lab");
  await expect(ed.locator('ul[data-type="taskList"] li', { hasText: "Book the lab" })).toBeVisible();

  // /h2 lands on the variant (2d).
  await typeAfterHeading(priya, "Notes", "/h2");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(active(priya)).toHaveAttribute("aria-label", "Heading, Heading 2");
  await priya.page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await priya.page.keyboard.type("Risks");
  await expect(ed.locator("h2", { hasText: "Risks" })).toBeVisible();

  // No results: Did you mean (6a); Esc keeps the text.
  await newLine(priya);
  await priya.page.keyboard.type("/kanbna");
  await expect(menu.getByText("No blocks match “kanbna”")).toBeVisible();
  await expect(active(priya)).toHaveAttribute("aria-label", "Database, Board view");
  await priya.page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(ed.locator("p", { hasText: "/kanbna" })).toBeVisible();

  // Keyboard only: ↓ to Data & planning, → into it, → to the view step, → Board, Enter (6b, 2b).
  await newLine(priya);
  await priya.page.keyboard.type("/");
  await expect(menu).toBeVisible();
  // Recent shows what was inserted from the menu (4a).
  await expect(menu.getByRole("group", { name: "Recent" })).toBeVisible();
  await downTo(priya, "Data & planning");
  await expect(priya.oc.locator(".oci-live")).toContainText("Data & planning");
  await priya.page.keyboard.press("ArrowRight");
  await expect(active(priya)).toHaveAttribute("aria-label", /^Database, /);
  await priya.page.keyboard.press("ArrowRight");
  const step = priya.oc.getByRole("listbox", { name: "Database view" });
  await expect(step).toBeVisible();
  await expect(step.getByRole("option")).toHaveCount(6); // Table, Board, Calendar, Gallery, Timeline, Workload (v0.4.1)
  await priya.page.keyboard.press("ArrowRight");
  await expect(active(priya)).toHaveAttribute("aria-label", "Board view");
  await axe(priya, ['iframe[name="oc"]', ".oci"]);
  const dbs = await ed.locator("[data-db]").count();
  await priya.page.keyboard.press("Enter");
  await expect.poll(() => ed.locator("[data-db]").count(), { timeout: 10_000 }).toBeGreaterThan(dbs);
  await priya.ctx.close();
});

test("meeting profile: a flat list of its seven blocks; hidden blocks never offered", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  await createFile(priya, "E2E zd · meeting", HOST_MEETING);
  await applyTemplate(priya, "Meeting notes");
  const ed = editor(priya);
  await typeAfterHeading(priya, "Notes", "");
  await slash(priya);
  const menu = menuOf(priya);
  const labels = await menu.getByRole("option").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(labels).toEqual(["Text", "Heading, Heading 2", "List, Checklist", "Callout, Decision", "Simple table", "Date", "Divider"]);
  // No bands, no gallery in a profile (5a).
  await expect(menu.getByText("Explore")).toHaveCount(0);
  await expect(menu.getByRole("option", { name: "Browse all blocks" })).toHaveCount(0);
  await axe(priya, ['iframe[name="oc"]', ".oci"]);
  // Keyboard: ↓ ↓ to List (Checklist), Enter.
  await priya.page.keyboard.press("ArrowDown");
  await priya.page.keyboard.press("ArrowDown");
  await expect(menu.locator("[role=option].on")).toHaveAttribute("aria-label", "List, Checklist");
  await priya.page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await priya.page.keyboard.type("Send the notes");
  await expect(ed.locator('ul[data-type="taskList"] li', { hasText: "Send the notes" })).toBeVisible();
  // A hidden block says only "No blocks match" (5c); /h2 still works.
  await newLine(priya);
  await newLine(priya);
  await priya.page.keyboard.type("/database");
  // Nothing is offered and nothing says why: "No blocks match", or the menu has closed itself
  // after four letters with no match (6a).
  await expect(priya.oc.locator(".oci [role=option]")).toHaveCount(0);
  for (let i = 0; i < 9; i++) await priya.page.keyboard.press("Backspace");
  await priya.page.keyboard.type("/h2");
  await expect(menu.locator("[role=option].on")).toHaveAttribute("aria-label", "Heading, Heading 2");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("Follow-ups");
  await expect(ed.locator("h2", { hasText: "Follow-ups" })).toBeVisible();
  await priya.ctx.close();
});
