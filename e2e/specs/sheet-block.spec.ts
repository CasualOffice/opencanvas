// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-04: the Spreadsheet block. Priya inserts a sheet from the / menu, types numbers and
// =SUM(A1:A3), inserts a row inside the range from the row header menu (the total holds, the
// formula reads A1:A4), types into the new row, and Sam sees every value live.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator } from "@playwright/test";
import { editor, setAccess, sharedFile, typeAfterHeading, type Person } from "../helpers";

const grid = (oc: FrameLocator) => oc.locator(".ocsh-grid").first();
const cell = (oc: FrameLocator, r: number, c: number) => grid(oc).locator(`[data-r="${r}"][data-c="${c}"]`);

async function newSheet(p: Person) {
  await typeAfterHeading(p, "Notes", "");
  await p.page.keyboard.type("/spreadsheet");
  await p.page.keyboard.press("Enter");
  await expect(grid(p.oc)).toBeVisible({ timeout: 15_000 });
}

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

  // Both edit at once: Sam types into B1 while Priya types into A6; each sees the other's edit,
  // and Sam's selection shows on Priya's grid with his name (SHEET-05).
  await cell(sam.oc, 0, 1).click();
  await cell(priya.oc, 5, 0).click();
  await Promise.all([
    (async () => {
      await sam.page.keyboard.type("=A5*2");
      await sam.page.keyboard.press("Enter");
    })(),
    (async () => {
      await priya.page.keyboard.type("4");
      await priya.page.keyboard.press("Enter");
    })(),
  ]);
  await expect(cell(priya.oc, 0, 1)).toHaveText("32", { timeout: 5_000 });
  await expect(cell(sam.oc, 5, 0)).toHaveText("4", { timeout: 5_000 });
  await cell(sam.oc, 2, 2).click();
  await expect(priya.oc.locator(".ocsh-peer").filter({ hasText: "Sam Ortiz" })).toBeVisible({ timeout: 5_000 });
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

test("SHEET-06: phone layout, #REF! named after someone else's delete, view only", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E sheet 3", samRole: "edit" });
  await newSheet(priya);
  await cell(priya.oc, 0, 0).click();
  await priya.page.keyboard.type("5");
  await priya.page.keyboard.press("Enter");

  // Phone (9a): taller rows; a double tap edits in the formula bar with insert keys; tapping a
  // cell while typing a formula inserts its reference.
  await priya.page.setViewportSize({ width: 390, height: 844 });
  await expect(priya.oc.locator(".ocsh.ph")).toBeVisible();
  const ax = await new AxeBuilder({ page: priya.page }).include(['iframe[name="oc"]', ".ocsh"]).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(ax.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await cell(priya.oc, 0, 1).dblclick();
  await expect(priya.oc.getByLabel("Formula bar")).toBeFocused();
  const keys = priya.oc.getByRole("toolbar", { name: "Insert into the formula" });
  await keys.getByRole("button", { name: "=", exact: true }).click();
  await cell(priya.oc, 0, 0).click();
  await expect(priya.oc.getByLabel("Formula bar")).toHaveValue("=A1");
  await priya.page.keyboard.type("*2");
  await priya.page.keyboard.press("Enter");
  await expect(cell(priya.oc, 0, 1)).toHaveText("10");

  // 9b: the action bar's Aa sheet formats; the round handle extends the selection.
  await cell(priya.oc, 0, 0).click();
  await priya.oc.getByRole("toolbar", { name: "Selection" }).getByRole("button", { name: "Format" }).click();
  await priya.oc.getByRole("dialog", { name: "Format" }).getByRole("button", { name: "Bold" }).click();
  await expect(cell(priya.oc, 0, 0)).toHaveClass(/\bb\b/);
  await priya.page.keyboard.press("Escape");
  await cell(priya.oc, 0, 0).click();
  const knob = (await grid(priya.oc).locator(".ocsh-knob.br").boundingBox())!;
  const a3 = (await cell(priya.oc, 2, 0).boundingBox())!;
  await priya.page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
  await priya.page.mouse.down();
  await priya.page.mouse.move(a3.x + a3.width / 2, a3.y + a3.height / 2, { steps: 5 });
  await priya.page.mouse.up();
  await expect(priya.oc.getByLabel("Name box")).toHaveValue("A1:A3");

  // 10b: a formula Sam's delete breaks is named on Priya's screen, with a way to show it.
  await cell(priya.oc, 2, 2).click();
  await priya.page.keyboard.type("=A1*3");
  await priya.page.keyboard.press("Enter");
  await expect(cell(priya.oc, 2, 2)).toHaveText("15");
  await expect(cell(sam.oc, 2, 2)).toHaveText("15", { timeout: 10_000 });
  await grid(sam.oc).locator('[data-hr="0"]').click({ button: "right" });
  await sam.oc.getByRole("menuitem", { name: "Delete row 1" }).click();
  await expect(cell(priya.oc, 1, 2)).toHaveText("#REF!", { timeout: 10_000 });
  await expect(priya.oc.getByText("1 formula now shows #REF!", { exact: false })).toBeVisible();

  // 10a: view only. Selecting and filters work; typing, the fill handle and edit commands do not.
  await setAccess(priya, fileId, "u_sam", "view");
  await sam.page.reload();
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false", { timeout: 15_000 });
  await expect(grid(sam.oc)).toBeVisible({ timeout: 15_000 });
  await expect(sam.oc.getByText("View only").first()).toBeVisible();
  await expect(sam.oc.getByLabel("Formula bar")).toHaveAttribute("readonly", "");
  await cell(sam.oc, 1, 2).click();
  await expect(grid(sam.oc).locator(".ocsh-fh")).toHaveCount(0);
  await sam.page.keyboard.type("99");
  await sam.page.keyboard.press("Enter");
  await expect(cell(sam.oc, 1, 2)).toHaveText("#REF!");
  await cell(sam.oc, 1, 2).click({ button: "right" });
  await expect(sam.oc.getByRole("menuitem", { name: "Create a filter" })).toBeVisible();
  await expect(sam.oc.getByRole("menuitem", { name: /Delete/ })).toHaveCount(0);
});
