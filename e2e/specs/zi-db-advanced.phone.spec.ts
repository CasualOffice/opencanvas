// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zi (phone). A 5,000-row database on a 390 px phone (prototype large-tables 4a, 4c): the card
// list is virtualized, tapping the count opens Go to row, a long press starts selecting and the
// action bar offers the full count; axe with reduced motion.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { blocksReady } from "../helpers";
import { OC } from "../env";
import { fillDemoDb } from "./zi-db-fixture";

test("phone: card list, Go to row, long-press selection", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await blocksReady(page);
  await expect(page.locator(".ocdb").first()).toBeVisible({ timeout: 20_000 });
  await fillDemoDb(page, 5000, 8);
  const sc = page.locator(".ocdb-lt.phone .ocdb-lt-sc").first();
  await expect(sc).toBeVisible();
  await sc.scrollIntoViewIfNeeded();
  expect(await page.locator(".ocdb-lt-card").count()).toBeLessThan(120);
  await page.locator(".ocdb-hcb").tap();
  await page.getByRole("dialog", { name: "Go to row" }).getByRole("textbox").fill("2500");
  await page.getByRole("button", { name: "Go", exact: true }).tap();
  await expect(page.locator(".ocdb-lt-r.flash .ocdb-lt-card .t b")).toHaveText("#2,500");

  // Cards next to the one Go to row landed on (row 2,500): on screen, unlike nth() over the overscan.
  const card = page.locator(".ocdb-lt-card", { hasText: "Task 2501" });
  await expect(card).toBeInViewport();
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  const bar = page.getByRole("toolbar", { name: "Selected rows" });
  await expect(bar).toContainText("1 selected");
  await page.locator(".ocdb-lt-card", { hasText: "Task 2502" }).tap();
  await expect(bar).toContainText("2 selected");
  await expect(bar.getByRole("button", { name: "Select all 5,000" })).toBeVisible();
  const h = await bar.getByRole("button", { name: "Edit" }).boundingBox();
  expect(h!.height).toBeGreaterThanOrEqual(44);
  const r = await new AxeBuilder({ page }).include(".ocdb-lt").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});
