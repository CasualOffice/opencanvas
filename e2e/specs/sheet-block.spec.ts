// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-04: the Spreadsheet block. Priya inserts a sheet from the / menu, types numbers and
// =SUM(A1:A3), inserts a row inside the range from the row header menu (the total holds, the
// formula reads A1:A4), types into the new row, and Sam sees every value live.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator } from "@playwright/test";
import { sharedFile, typeAfterHeading } from "../helpers";

const grid = (oc: FrameLocator) => oc.locator(".ocsh").first().getByRole("grid");
const cell = (oc: FrameLocator, r: number, c: number) => grid(oc).locator(`[data-r="${r}"][data-c="${c}"]`);

test("SHEET-04: insert a spreadsheet, SUM, insert a row inside the range, a second person sees it", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya, sam } = await sharedFile(browser, { name: "E2E sheet", samRole: "edit" });
  await typeAfterHeading(priya, "Notes", "");
  await priya.page.keyboard.type("/spreadsheet");
  await priya.page.keyboard.press("Enter");
  await expect(grid(priya.oc)).toBeVisible({ timeout: 15_000 });

  await cell(priya.oc, 0, 0).click();
  for (const v of ["1", "2", "3", "=SUM(A1:A3)"]) {
    await priya.page.keyboard.type(v);
    await priya.page.keyboard.press("Enter");
  }
  await expect(cell(priya.oc, 3, 0)).toHaveText("6");
  // Enter moved down after each entry: the active cell is A5.
  await expect(priya.oc.getByLabel("Name box")).toHaveValue("A5");

  // Insert a row above row 2, inside the summed range: the total holds and the range grows.
  await priya.oc.locator(".ocsh").first().locator('[data-hr="1"]').click({ button: "right" });
  await priya.oc.getByRole("menuitem", { name: "Insert 1 row above" }).click();
  await expect(cell(priya.oc, 4, 0)).toHaveText("6");
  await cell(priya.oc, 4, 0).click();
  await expect(priya.oc.getByLabel("Formula bar")).toHaveValue("=SUM(A1:A4)");

  // A value in the new row counts.
  await cell(priya.oc, 1, 0).click();
  await priya.page.keyboard.type("10");
  await priya.page.keyboard.press("Enter");
  await expect(cell(priya.oc, 4, 0)).toHaveText("16");

  // Keyboard: Ctrl+Up jumps to the top of the column.
  await priya.page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect(priya.oc.getByLabel("Name box")).toHaveValue("A1");

  // axe on the block, light and dark.
  for (const theme of ["light", "dark"]) {
    await priya.page.frames().find((f) => f.name() === "oc")!.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page: priya.page }).include(['iframe[name="oc"]', ".ocsh"]).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }

  // Sam sees the same sheet, live.
  await expect(cell(sam.oc, 4, 0)).toHaveText("16", { timeout: 15_000 });
  await expect(cell(sam.oc, 1, 0)).toHaveText("10");
});
