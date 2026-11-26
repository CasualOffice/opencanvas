// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zi. v0.4 databases on the `#demo` canvas (DB4-03, DB4-07): a formula field added from the
//     field panel computes in the browser through the lazy WASM engine (errors as cells); a
//     5,000-row table is virtualized with Go to row (Ctrl+G), explicit "Select all N" and bulk
//     edit with one undo; axe with reduced motion on both.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { blocksReady } from "../helpers";
import { OC } from "../env";
import { fillDemoDb } from "./zi-db-fixture";

async function demo(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await blocksReady(page);
  await expect(page.locator(".ocdb").first()).toBeVisible({ timeout: 20_000 });
}

async function axe(page: Page, sel: string) {
  const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("formula field: add, check as you type, save, values and error cells", async ({ page }) => {
  await demo(page);
  const db = page.locator(".ocdb").first();
  await db.scrollIntoViewIfNeeded();
  await db.getByRole("button", { name: "Add a field" }).first().click();
  await page.getByRole("radio", { name: "Formula" }).click();
  const code = page.getByRole("combobox", { name: "Formula" });
  await expect(code).toBeVisible({ timeout: 15_000 });
  await code.fill('IF(TRUE, 1, "x")');
  await expect(page.locator(".ocdb-fx-err")).toContainText("#TYPE");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await code.fill("round(10 / 4, 1)");
  await expect(page.locator(".ocdb-fx-type")).toHaveText("Number");
  await page.keyboard.press("Control+Enter");
  await expect(db.locator(".ocdb-comp").first()).toHaveText("2.5");
  await axe(page, ".ocdb");
  // An error value per cell, the reason on focus.
  await db.locator(".ocdb-hcell", { hasText: "Formula" }).click();
  await page.getByRole("button", { name: "Edit formula" }).click();
  await page.getByRole("combobox", { name: "Formula" }).fill("1 / 0");
  await page.getByRole("button", { name: "Save" }).click();
  const err = db.locator(".ocdb-ferr").first();
  await expect(err).toHaveText("#DIV/0");
  await err.focus();
  await expect(err).toHaveAttribute("data-tip", "Division by zero");
});

test("5,000 rows: virtualized, Go to row, Select all N, bulk edit with one undo", async ({ page }) => {
  await demo(page);
  await fillDemoDb(page, 5000, 12);
  const sc = page.locator(".ocdb-lt-sc").first();
  await expect(sc).toBeVisible();
  await sc.scrollIntoViewIfNeeded();
  expect(await page.locator(".ocdb-lt-r").count()).toBeLessThan(200);
  await page.locator(".ocdb-hcb").click();
  await page.getByRole("dialog", { name: "Go to row" }).getByRole("textbox").fill("4000");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ocdb-lt-r.flash .ocdb-lt-num")).toHaveText("4,000");
  await sc.focus();
  await page.keyboard.press("Control+g");
  await expect(page.getByRole("dialog", { name: "Go to row" })).toBeVisible();
  await page.getByRole("button", { name: "Top" }).click();

  await page.getByRole("checkbox", { name: "Select the rows on screen" }).click();
  const bar = page.getByRole("toolbar", { name: "Selected rows" });
  await bar.getByRole("button", { name: "Select all 5,000" }).click();
  await expect(bar).toContainText("5,000 selected");
  await bar.getByRole("button", { name: "Edit field" }).click();
  const dlg = page.getByRole("dialog", { name: "Edit 5,000 rows" });
  await dlg.getByLabel("Field").selectOption({ label: "Status" });
  await dlg.getByLabel("New value").selectOption("Done");
  await dlg.getByRole("button", { name: "Set Status on 5,000 rows" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __countDone(): number }).__countDone())).toBe(5000);
  await axe(page, ".ocdb-lt");
  await sc.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __countDone(): number }).__countDone())).toBeLessThan(5000);
});
