// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-04: the Spreadsheet block. Priya inserts a sheet from the / menu, types numbers and
// =SUM(A1:A3), inserts a row inside the range from the row header menu (the total holds, the
// formula reads A1:A4), types into the new row, and Sam sees every value live.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator } from "@playwright/test";
import { sharedFile, typeAfterHeading } from "../helpers";

const grid = (oc: FrameLocator) => oc.locator(".ocsh-grid").first();
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

test("SHEET-04: fill handle, paste from Excel, formats, freeze, filter and full screen", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya, sam } = await sharedFile(browser, { name: "E2E sheet 2", samRole: "edit" });
  await typeAfterHeading(priya, "Notes", "");
  await priya.page.keyboard.type("/spreadsheet");
  await priya.page.keyboard.press("Enter");
  await expect(grid(priya.oc)).toBeVisible({ timeout: 15_000 });
  const page = priya.page;

  // A1:A3 = 1, 2, 3; B1 = =A1*2 filled down to B3 with the handle (references shift).
  await cell(priya.oc, 0, 0).click();
  for (const v of ["1", "2", "3"]) (await page.keyboard.type(v), await page.keyboard.press("Enter"));
  await cell(priya.oc, 0, 1).click();
  await page.keyboard.type("=A1*2");
  await page.keyboard.press("Enter");
  await cell(priya.oc, 0, 1).click();
  const fh = (await grid(priya.oc).locator(".ocsh-fh").boundingBox())!;
  const to = (await cell(priya.oc, 2, 1).boundingBox())!;
  await page.mouse.move(fh.x + fh.width / 2, fh.y + fh.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(cell(priya.oc, 2, 1)).toHaveText("6");
  await cell(priya.oc, 2, 1).click();
  await expect(priya.oc.getByLabel("Formula bar")).toHaveValue("=A3*2");

  // Paste a table from Excel at D1: values, a currency format and bold come along; the note offers
  // values only.
  await cell(priya.oc, 0, 3).click();
  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><table><tr><td style="font-weight:700">Venue</td><td>€4,200.00</td></tr><tr><td>Food</td><td>38</td></tr></table></body></html>`;
  await page.frames().find((f) => f.name() === "oc")!.evaluate((h) => {
    const dt = new DataTransfer();
    dt.setData("text/html", h);
    dt.setData("text/plain", "Venue\t€4,200.00\nFood\t38");
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, html);
  await expect(priya.oc.locator(".ocsh-note")).toContainText("Pasted 2 rows × 2 columns from Excel, with formats.");
  await expect(cell(priya.oc, 0, 3)).toHaveClass(/\bb\b/);
  await expect(cell(priya.oc, 0, 4)).toHaveText(/4,200\.00/);
  await cell(priya.oc, 0, 5).click();
  await page.keyboard.type("=E1+E2");
  await page.keyboard.press("Enter");
  await expect(cell(priya.oc, 0, 5)).toHaveText("4238");

  // Full screen (Ctrl+Shift+E): percent format, bold, freeze, a filter; Esc does not close it.
  await cell(priya.oc, 0, 0).click();
  await page.keyboard.press("ControlOrMeta+Shift+E");
  const full = priya.oc.getByRole("dialog", { name: /Spreadsheet/ });
  await expect(full).toBeVisible();
  await full.getByRole("button", { name: "Format as percent" }).click();
  await expect(cell(priya.oc, 0, 0)).toHaveText("100%");
  await full.getByRole("button", { name: "Bold" }).click();
  await expect(cell(priya.oc, 0, 0)).toHaveClass(/\bb\b/);
  await cell(priya.oc, 1, 1).click();
  await full.getByRole("button", { name: "Freeze up to B2" }).click();
  await expect(full.getByRole("button", { name: "Unfreeze" })).toHaveAttribute("aria-pressed", "true");
  await cell(priya.oc, 0, 0).click();
  await page.keyboard.press("Escape");
  await expect(full).toBeVisible();
  await full.getByRole("button", { name: "Create a filter" }).click();
  await grid(priya.oc).getByRole("button", { name: "Filter A" }).click();
  await priya.oc.getByRole("checkbox", { name: "2", exact: true }).uncheck();
  await priya.oc.getByRole("button", { name: "OK", exact: true }).click();
  await expect(cell(priya.oc, 1, 0)).toHaveCount(0);
  await full.getByRole("button", { name: "Close" }).click();
  await expect(full).toHaveCount(0);

  // Sam sees the fill, the paste and the formats.
  await expect(cell(sam.oc, 2, 1)).toHaveText("6", { timeout: 15_000 });
  await expect(cell(sam.oc, 0, 5)).toHaveText("4238");
  await expect(cell(sam.oc, 0, 0)).toHaveText("100%");

  // 320 px wide: the block fits the column (the grid scrolls inside it, the page does not).
  await sam.page.setViewportSize({ width: 320, height: 700 });
  const fr = sam.page.frames().find((f) => f.name() === "oc")!;
  await expect.poll(() => fr.evaluate(() => {
    const b = document.querySelector(".ocsh")!.getBoundingClientRect();
    return b.left >= 0 && b.right <= document.documentElement.clientWidth + 1;
  })).toBe(true);
});
