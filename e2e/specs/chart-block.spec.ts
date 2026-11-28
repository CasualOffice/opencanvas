// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (frame 4h): the linked chart. Priya types a small table into a spreadsheet, selects it
// and makes a chart from the selection: it floats over the sheet, follows a changed cell, and Sam
// sees the chart and the change live; "Copy to canvas" places a linked chart block. A database
// chart, and the database opened as a live spreadsheet (8a), edited from both sides.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator } from "@playwright/test";
import { sharedFile, typeAfterHeading } from "../helpers";

const grid = (oc: FrameLocator) => oc.locator(".ocsh-grid").first();
const cell = (oc: FrameLocator, r: number, c: number) => grid(oc).locator(`[data-r="${r}"][data-c="${c}"]`);
const chart = (oc: FrameLocator) => oc.getByRole("figure", { name: /^Total by Category, column chart$/ });
const values = (oc: FrameLocator) => chart(oc).locator("table tbody tr");

test("SHEET-06: chart from a sheet range follows the cells, live for a second person", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya, sam } = await sharedFile(browser, { name: "E2E chart", samRole: "edit" });
  await typeAfterHeading(priya, "Notes", "");
  await priya.page.keyboard.type("/spreadsheet");
  await priya.page.keyboard.press("Enter");
  await expect(grid(priya.oc)).toBeVisible({ timeout: 15_000 });

  const rows = [
    ["Category", "Total"],
    ["Venue", "10"],
    ["Food", "20"],
  ];
  for (const [r, row] of rows.entries())
    for (const [c, v] of row.entries()) {
      await cell(priya.oc, r, c).click();
      await priya.page.keyboard.type(v);
      await priya.page.keyboard.press("Enter");
    }
  await expect(cell(priya.oc, 2, 1)).toHaveText("20");

  // Select A1:B3 and place a chart from it (sheet toolbar).
  await cell(priya.oc, 0, 0).click();
  await cell(priya.oc, 2, 1).click({ modifiers: ["Shift"] });
  await priya.oc.getByRole("button", { name: "Chart from selection" }).click();
  await expect(chart(priya.oc)).toBeVisible({ timeout: 15_000 });
  // 4h: it floats over the sheet, next to the range (column D), not after the block.
  const floating = priya.oc.locator(".ocsh-chart");
  await expect(floating.getByRole("figure")).toBeVisible();
  await expect(priya.oc.locator("[data-chart]")).toHaveCount(0);
  const d1 = (await cell(priya.oc, 0, 3).boundingBox())!;
  const f1 = (await floating.boundingBox())!;
  expect(Math.abs(f1.x - d1.x)).toBeLessThan(2);
  await expect(chart(priya.oc).locator("svg rect")).toHaveCount(2);
  await expect(values(priya.oc).nth(1)).toHaveText("Food20");

  // A changed cell redraws the chart.
  await cell(priya.oc, 2, 1).click();
  await priya.page.keyboard.type("35");
  await priya.page.keyboard.press("Enter");
  await expect(values(priya.oc).nth(1)).toHaveText("Food35", { timeout: 5_000 });

  // The data table is the accessible fallback; the table button shows it.
  await chart(priya.oc).getByRole("button", { name: "Show data table" }).click();
  await expect(chart(priya.oc).locator(".occh-tbl")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await priya.page.frames().find((f) => f.name() === "oc")!.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page: priya.page }).include(['iframe[name="oc"]', ".occh"]).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }

  // Sam sees the chart and the change.
  await expect(chart(sam.oc)).toBeVisible({ timeout: 15_000 });
  await expect(values(sam.oc).nth(1)).toHaveText("Food35", { timeout: 15_000 });
  // Sam changes a value; Priya's chart follows.
  await cell(sam.oc, 1, 1).click();
  await sam.page.keyboard.type("50");
  await sam.page.keyboard.press("Enter");
  await expect(values(priya.oc).nth(0)).toHaveText("Venue50", { timeout: 10_000 });

  // The arrow keys on its handle move it a cell; Sam sees it move.
  await floating.getByRole("button", { name: "Move chart" }).focus();
  await priya.page.keyboard.press("ArrowRight");
  const e1 = (await cell(priya.oc, 0, 4).boundingBox())!;
  await expect.poll(async () => Math.round((await floating.boundingBox())!.x - e1.x)).toBe(0);
  const samE = (await cell(sam.oc, 0, 4).boundingBox())!;
  await expect.poll(async () => Math.round((await sam.oc.locator(".ocsh-chart").boundingBox())!.x - samE.x), { timeout: 10_000 }).toBe(0);

  // Copy to canvas: a chart block after the sheet, linked to the same range.
  await floating.getByRole("button", { name: "Copy to canvas" }).click();
  const block = priya.oc.locator("[data-chart]").getByRole("figure", { name: /^Total by Category, column chart$/ });
  await expect(block).toBeVisible({ timeout: 15_000 });
  await expect(block.locator("table tbody tr").nth(0)).toHaveText("Venue50");
  // Deleting the floating chart leaves the block.
  await floating.getByRole("button", { name: "Delete chart" }).click();
  await expect(floating).toHaveCount(0);
  await expect(block).toBeVisible();
});

test("SHEET-06: a database chart, and the database as a live spreadsheet edited from both sides", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya, sam } = await sharedFile(browser, { name: "E2E db chart", samRole: "edit" });
  const page = priya.page;
  await typeAfterHeading(priya, "Notes", "");
  await page.keyboard.type("/database");
  await page.keyboard.press("Enter");
  const any = priya.oc.locator("[data-db] .ocdb").filter({ hasNot: priya.oc.getByRole("textbox", { name: "Action" }) }).last();
  await expect(any).toBeVisible({ timeout: 15_000 });
  const dbId = (await any.evaluate((el) => el.closest("[data-db]")?.getAttribute("data-db"))) ?? "";
  expect(dbId).not.toBe("");
  const db = (oc: FrameLocator) => oc.locator(`[data-db="${dbId}"] .ocdb`);
  const names = (oc: FrameLocator) => db(oc).locator("tbody").getByRole("textbox", { name: "Name" });
  await expect(names(priya.oc)).toHaveCount(3);
  for (const [i, n] of ["Venue", "Food", "Print"].entries()) {
    await names(priya.oc).nth(i).fill(n);
    await names(priya.oc).nth(i).press("Enter");
  }

  // Chart from the database's options: grouped by Status, counted.
  await db(priya.oc).getByRole("button", { name: "Database options" }).click();
  await priya.oc.getByRole("button", { name: "Chart", exact: true }).click();
  const dbChart = (oc: FrameLocator) => oc.locator("[data-chart]").getByRole("figure", { name: /by Status, column chart$/ });
  await expect(dbChart(priya.oc)).toBeVisible({ timeout: 15_000 });
  await expect(dbChart(priya.oc).locator("table tbody tr")).toHaveText(["Not started3"]);
  await expect(dbChart(sam.oc).locator("table tbody tr")).toHaveText(["Not started3"], { timeout: 15_000 });
  const r = await new AxeBuilder({ page }).include(['iframe[name="oc"]', "[data-chart] .occh"]).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  // 8a: Open as spreadsheet, the live view: a header row of field names, a row per record.
  await db(priya.oc).getByRole("button", { name: "Database options" }).click();
  await priya.oc.getByRole("button", { name: "Open as spreadsheet…" }).click();
  const dlg = priya.oc.getByRole("dialog", { name: /as a spreadsheet/ });
  await expect(dlg.getByRole("radio", { name: /View as spreadsheet/ })).toBeChecked();
  await dlg.getByRole("button", { name: "Open" }).click();
  await expect(cell(priya.oc, 0, 0)).toHaveText("Name", { timeout: 15_000 });
  await expect(cell(priya.oc, 1, 0)).toHaveText("Venue");
  await expect(cell(priya.oc, 3, 0)).toHaveText("Print");

  // The database to the sheet: a renamed record shows in its row, here and for Sam.
  await names(priya.oc).nth(0).fill("Venue hire");
  await names(priya.oc).nth(0).press("Enter");
  await expect(cell(priya.oc, 1, 0)).toHaveText("Venue hire", { timeout: 10_000 });
  await expect(cell(sam.oc, 1, 0)).toHaveText("Venue hire", { timeout: 15_000 });
  // The sheet to the database: Sam types over a field cell; the record changes for Priya.
  await cell(sam.oc, 2, 0).click();
  await sam.page.keyboard.type("Catering");
  await sam.page.keyboard.press("Enter");
  await expect(names(priya.oc).nth(1)).toHaveValue("Catering", { timeout: 15_000 });
  await expect(cell(priya.oc, 2, 0)).toHaveText("Catering");
});
