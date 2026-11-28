// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DB5-01: the database Timeline (Gantt) and Workload views (prototype
// v04-approved/timeline.html). Priya schedules rows from the No dates tray, stretches a bar with
// the keyboard, links a dependency with L (Blocked by is created on demand), moves the blocker
// past its dependent and shifts it from the toast, turns on the critical path, makes a milestone,
// opens Workload, and Sam sees it all live. On a phone the Timeline is a list by week.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator, type Locator } from "@playwright/test";
import fs from "node:fs";
import { OC } from "../env";
import { sharedFile, typeAfterHeading } from "../helpers";

let dbId = "";
/** The database this test inserted (the template has its own). */
const db = (oc: FrameLocator): Locator => (dbId ? oc.locator(`[data-db="${dbId}"] .ocdb`) : oc.locator(".ocdb").filter({ hasNot: oc.getByRole("textbox", { name: "Action" }) }).last());
const bar = (oc: FrameLocator, name: string) => db(oc).locator("[data-bar]").and(oc.getByRole("button", { name: new RegExp(`^${name},`) }));

test("DB5-01: timeline bars, dependencies, shift dependents, critical path, milestone, workload, phone list", async ({ browser }) => {
  test.setTimeout(150_000);
  const { priya, sam } = await sharedFile(browser, { name: "E2E timeline", samRole: "edit" });
  const page = priya.page;
  await typeAfterHeading(priya, "Notes", "");
  await page.keyboard.type("/database");
  await page.keyboard.press("Enter");
  let d = db(priya.oc);
  await expect(d).toBeVisible({ timeout: 15_000 });
  dbId = (await d.evaluate((el) => el.closest("[data-db]")?.getAttribute("data-db"))) ?? "";
  expect(dbId).not.toBe("");
  d = db(priya.oc);

  // Three named rows in the table.
  const names = d.locator("tbody").getByRole("textbox", { name: "Name" });
  await expect(names).toHaveCount(3);
  for (const [i, n] of ["API freeze", "SDK docs", "Partner beta"].entries()) {
    await names.nth(i).fill(n);
    await names.nth(i).press("Enter");
  }

  // Timeline: no dates yet, so all three wait in the tray; clicking one schedules it today.
  await d.getByRole("tab", { name: "Timeline" }).click();
  const tray = d.getByLabel("No dates");
  await expect(tray).toContainText("No dates (3)");
  for (const n of ["API freeze", "SDK docs", "Partner beta"]) await tray.getByRole("button", { name: n }).click();
  await expect(tray).toHaveCount(0);

  // An end date field from the settings, then Shift+→ stretches API freeze by three working days.
  await d.getByRole("button", { name: "Timeline view settings" }).click();
  await priya.oc.getByRole("button", { name: "Add Due field" }).click();
  await page.keyboard.press("Escape");
  await bar(priya.oc, "API freeze").focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(d.locator(".ocdb-sr").last()).toContainText("API freeze moved to");
  await expect(bar(priya.oc, "API freeze")).toHaveAttribute("aria-label", /API freeze, \w+ \d+ to \w+ \d+/);

  // L on SDK docs: type to pick API freeze. "Blocked by" appears; SDK docs now starts too early.
  await bar(priya.oc, "SDK docs").focus();
  await page.keyboard.press("l");
  await priya.oc.getByRole("textbox", { name: "Find a task" }).fill("API");
  await page.keyboard.press("Enter");
  await expect(bar(priya.oc, "API freeze")).toHaveAttribute("aria-label", /blocks SDK docs/);
  await expect(bar(priya.oc, "SDK docs")).toHaveClass(/\blate\b/);

  // Moving API freeze a day: the toast offers to shift its dependent; Shift clears the conflict.
  await bar(priya.oc, "API freeze").focus();
  await page.keyboard.press("ArrowRight");
  const toast = d.getByRole("alert");
  await expect(toast).toContainText("1 task now starts before API freeze ends");
  await toast.getByRole("button", { name: /^Shift 1 task by \d+ days?$/ }).click();
  await expect(bar(priya.oc, "SDK docs")).not.toHaveClass(/\blate\b/);

  // Critical path and a milestone.
  await d.getByRole("button", { name: "Critical path" }).click();
  await expect(bar(priya.oc, "API freeze")).toHaveClass(/\bcrit\b/);
  await bar(priya.oc, "Partner beta").focus();
  await page.keyboard.press("m");
  await expect(bar(priya.oc, "Partner beta")).toHaveAttribute("aria-label", /milestone on/);

  // axe on the Timeline view.
  const ax = await new AxeBuilder({ page }).include(['iframe[name="oc"]', ".ocdb-tl"]).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(ax.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  // Sam sees the dependency live.
  await db(sam.oc).getByRole("tab", { name: "Timeline" }).click();
  await expect(bar(sam.oc, "API freeze")).toHaveAttribute("aria-label", /blocks SDK docs/, { timeout: 10_000 });

  // Workload: nobody is assigned, so the tasks sit on the Unassigned row.
  await d.getByRole("tab", { name: "Workload" }).click();
  await expect(d.getByRole("rowheader", { name: "Unassigned" })).toBeVisible();

  // Exports render the rows as a table with the dates and Blocked by (frame 7).
  await priya.oc.getByRole("button", { name: "More options" }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), priya.oc.getByRole("menuitem", { name: /^Markdown/ }).click()]);
  const md = fs.readFileSync((await dl.path())!, "utf8");
  expect(md).toMatch(/\| Date \| .*Due .*\| Blocked by \|/);
  expect(md).toMatch(/\| SDK docs \|.*\| API freeze \|/);

  // Phone: the Timeline is a list by week.
  await page.setViewportSize({ width: 390, height: 844 });
  await d.getByRole("tab", { name: "Timeline" }).click();
  await expect(d.getByRole("region", { name: /^Week of / }).first()).toBeVisible();
  await expect(d.locator(".ocdb-tl-it").filter({ hasText: "API freeze" })).toBeVisible();
});

test("DB5-01: drag to move, resize and link; the bar menu removes dates", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya } = await sharedFile(browser, { name: "E2E timeline drag", samRole: "edit" });
  const page = priya.page;
  await typeAfterHeading(priya, "Notes", "");
  await page.keyboard.type("/database");
  await page.keyboard.press("Enter");
  dbId = "";
  let d = db(priya.oc);
  await expect(d).toBeVisible({ timeout: 15_000 });
  dbId = (await d.evaluate((el) => el.closest("[data-db]")?.getAttribute("data-db"))) ?? "";
  d = db(priya.oc);
  const names = d.locator("tbody").getByRole("textbox", { name: "Name" });
  for (const [i, n] of ["API freeze", "SDK docs"].entries()) {
    await names.nth(i).fill(n);
    await names.nth(i).press("Enter");
  }
  await d.getByRole("tab", { name: "Timeline" }).click();
  await d.getByRole("button", { name: "Timeline view settings" }).click();
  await priya.oc.getByRole("button", { name: "Add Due field" }).click();
  await page.keyboard.press("Escape");
  for (const n of ["API freeze", "SDK docs"]) await d.getByLabel("No dates").getByRole("button", { name: n }).click();
  await d.getByRole("group", { name: "Zoom" }).getByRole("button", { name: "Day" }).click();

  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  };
  const label = async (n: string) => (await bar(priya.oc, n).getAttribute("aria-label")) ?? "";

  // Move: drag the bar body three days right; its dates change.
  const before = await label("API freeze");
  let b = (await bar(priya.oc, "API freeze").boundingBox())!;
  await drag({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + b.width * 3, y: b.y + b.height / 2 });
  await expect.poll(() => label("API freeze")).not.toBe(before);

  // Resize: drag the right edge four days; the bar gets longer. With Mon-Fri on, an end dropped on
  // a weekend snaps back to the Friday, so two days from a Thursday or Friday gained at most one
  // working day (the test failed on weekends). Four calendar days from any weekday end gain at
  // least two working days, so the bar is at least three days wide whatever today is.
  const w0 = (await bar(priya.oc, "API freeze").boundingBox())!.width;
  b = (await bar(priya.oc, "API freeze").boundingBox())!;
  await drag({ x: b.x + b.width - 2, y: b.y + b.height / 2 }, { x: b.x + b.width - 2 + w0 * 4, y: b.y + b.height / 2 });
  await expect.poll(async () => (await bar(priya.oc, "API freeze").boundingBox())!.width).toBeGreaterThan(w0 * 2);

  // Link: drag the round handle at API freeze's end onto SDK docs.
  b = (await bar(priya.oc, "API freeze").boundingBox())!;
  const t = (await bar(priya.oc, "SDK docs").boundingBox())!;
  await bar(priya.oc, "API freeze").hover();
  await drag({ x: b.x + b.width + 5, y: b.y + b.height / 2 }, { x: t.x + t.width / 2, y: t.y + t.height / 2 });
  await expect(bar(priya.oc, "SDK docs")).toHaveAttribute("aria-label", /blocked by API freeze/);

  // The bar menu (Shift+F10): Remove dates sends SDK docs back to the tray.
  await bar(priya.oc, "SDK docs").focus();
  await page.keyboard.press("Shift+F10");
  await priya.oc.getByRole("menuitem", { name: "Remove dates" }).click();
  await expect(d.getByLabel("No dates").getByRole("button", { name: "SDK docs" })).toBeVisible();
});

test("the public demo shows the newer blocks: a budget sheet, its chart, and the backlog's Timeline and Workload", async ({ page }) => {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  const sheet = page.locator(".ocsh-grid").first();
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  // Total = SUM of four formulas (4,200 + 4,560 + 960 + 1,850), shown as currency.
  await expect(sheet.locator('[data-r="5"][data-c="1"]')).toHaveText(/11,570\.00/);
  await expect(page.getByRole("figure", { name: "Budget by item, column chart" })).toBeVisible();
  const backlog = page.locator(".ocdb").filter({ has: page.getByRole("tab", { name: "Timeline" }) }).first();
  await backlog.getByRole("tab", { name: "Timeline" }).click();
  await expect(backlog.locator("[data-bar]").first()).toBeVisible();
  await expect(backlog.getByRole("button", { name: /blocked by/ }).first()).toBeVisible();
  await backlog.getByRole("tab", { name: "Workload" }).click();
  await expect(backlog.locator(".ocdb-wl-t")).toBeVisible();
});

test("v0.4.1: /timeline inserts a Timeline; jump to from an empty range; drag to reassign in Workload; Months on a phone", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya } = await sharedFile(browser, { name: "E2E timeline v041", samRole: "edit" });
  const page = priya.page;
  await typeAfterHeading(priya, "Notes", "");
  await page.keyboard.type("/timeline");
  await page.keyboard.press("Enter");
  dbId = "";
  let d = db(priya.oc);
  await expect(d).toBeVisible({ timeout: 15_000 });
  dbId = (await d.evaluate((el) => el.closest("[data-db]")?.getAttribute("data-db"))) ?? "";
  d = db(priya.oc);
  // The insert menu's Timeline variant opens the new database on its Timeline.
  await expect(d.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
  await expect(d.locator(".ocdb-tl")).toBeVisible();

  await d.getByRole("tab", { name: "Table" }).click();
  const names = d.locator("tbody").getByRole("textbox", { name: "Name" });
  for (const [i, n] of ["API freeze", "SDK docs"].entries()) {
    await names.nth(i).fill(n);
    await names.nth(i).press("Enter");
  }
  await d.getByRole("tab", { name: "Timeline" }).click();
  for (const n of ["API freeze", "SDK docs"]) await d.getByLabel("No dates").getByRole("button", { name: n }).click();

  // 6b: scrolled to the far end at Day zoom nothing is in range; Jump to brings the tasks back.
  await d.getByRole("group", { name: "Zoom" }).getByRole("button", { name: "Day" }).click();
  await d.locator(".ocdb-tl-r").evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  const gap = d.locator(".ocdb-tl-gap");
  await expect(gap).toContainText("Nothing scheduled");
  await expect(gap).toContainText("The last task ended");
  await gap.getByRole("button", { name: /^Jump to / }).click();
  await expect(gap).toHaveCount(0);
  await expect(bar(priya.oc, "API freeze")).toBeInViewport();

  // Workload: assign API freeze to Sam with the select, then drag SDK docs onto Sam's row.
  await d.getByRole("tab", { name: "Workload" }).click();
  const cell = (who: string) => d.locator("tr").filter({ has: priya.oc.getByRole("rowheader", { name: who }) }).locator("td button:enabled").first();
  await cell("Unassigned").click();
  const sel = priya.oc.getByRole("combobox", { name: "Assign API freeze to" });
  const sam = await sel.locator("option", { hasText: "Sam" }).first().getAttribute("value");
  await sel.selectOption(sam!);
  await page.keyboard.press("Escape");
  const samRow = d.locator(`tr[data-who="${sam}"]`);
  await expect(samRow).toBeVisible();
  await cell("Unassigned").click();
  const task = priya.oc.getByRole("dialog").getByRole("button", { name: "SDK docs" });
  const a = (await task.boundingBox())!;
  const t = (await samRow.locator("th").boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 10 });
  await expect(samRow).toHaveClass(/\bdrop\b/);
  await page.mouse.up();
  await expect(d.locator(".ocdb-sr").last()).toContainText("SDK docs assigned to Sam");
  await expect(d.getByRole("rowheader", { name: "Unassigned" })).toHaveCount(0);

  // Phone: the list by week switches to Months.
  await page.setViewportSize({ width: 390, height: 844 });
  await d.getByRole("tab", { name: "Timeline" }).click();
  await d.getByRole("group", { name: "Group by" }).getByRole("button", { name: "Months" }).click();
  await expect(d.getByRole("region", { name: /^[A-Z][a-z]{2} \d{4}$/ }).first()).toBeVisible();
  await expect(d.getByRole("region", { name: /^Week of / })).toHaveCount(0);
});
