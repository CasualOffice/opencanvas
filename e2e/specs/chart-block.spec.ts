// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (frame 4h): the linked chart block. Priya types a small table into a spreadsheet,
// selects it and places a chart from the selection; the chart follows a changed cell, and Sam
// sees the chart and the change live.
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
});
