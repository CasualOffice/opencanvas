// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// v. docs/23 FC-10 on a phone (webkit-phone): the import dialog from the "…" menu, a CSV
//    preview that fits the screen (the table scrolls inside), done; axe light and dark.
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { OC, ROOT } from "../env";
import { shots } from "../helpers";

const CSV = "Task,Owner,Due,Done\nFinish embed SDK docs,Ravi,2026-12-04,false\nReview mention list,Priya,2026-12-06,true\nFix PDF zoom on iPhone,Sam,,false\n";

async function axe(page: Page) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    // Let the dialog's entrance animation finish: axe reads colours mid-fade otherwise.
    await page.evaluate(() => Promise.all(document.getAnimations().filter((x) => x.playState === "running" && x.effect?.getComputedTiming().iterations !== Infinity).map((x) => x.finished)));
    const r = await new AxeBuilder({ page }).include(".imp").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

test("FC-10 phone: Import… from the menu, CSV preview fits, done", async ({ page }) => {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await expect(page.locator(".app.compact")).toBeVisible();
  await page.getByRole("button", { name: "More options" }).tap();
  await page.getByRole("button", { name: "Import…" }).tap();
  const dlg = page.getByRole("dialog", { name: "Import into this canvas" });
  await expect(dlg).toBeVisible();
  await axe(page);
  await dlg.getByLabel("Choose a file to import").setInputFiles({ name: "tasks.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await expect(dlg.getByLabel("Type of Due")).toHaveValue("date");
  const vw = page.viewportSize()!.width;
  const box = (await dlg.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(vw + 1);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: path.join(ROOT, `target/fix-shots/import-phone-${test.info().project.name}.png`) });
  await shots(page, "4-import-csv-390");
  await axe(page);
  await dlg.getByRole("button", { name: "Import 3 rows" }).tap();
  await expect(dlg.getByRole("status")).toContainText("Imported a database with 3 rows");
  await shots(page, "4-import-done-390");
  await axe(page);
});
