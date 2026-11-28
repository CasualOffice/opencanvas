// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zh-sheet. Partial sync (v0.4.1): a spreadsheet is a part, as databases and boards are. Priya
// makes a spreadsheet and a chart of it; once the room splits, Sam loads the sheet over type 101,
// his edit reaches Priya's chart, and after both close the canvas and the room has gone, the
// reopened canvas shows the sheet and the chart as they were left.
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { HOST_PSYNC } from "../env";
import { editor, expectSaved, openFile, person, sharedFile, typeAfterHeading } from "../helpers";

const grid = (oc: FrameLocator) => oc.locator(".ocsh-grid").first();
const cell = (oc: FrameLocator, r: number, c: number) => grid(oc).locator(`[data-r="${r}"][data-c="${c}"]`);
const chart = (oc: FrameLocator) => oc.getByRole("figure", { name: /^Total by Category, column chart$/ });
const values = (oc: FrameLocator) => chart(oc).locator("table tbody tr");

/** Type 101 frames naming a spreadsheet's part, received by the page. */
function sheetFrames(page: Page) {
  const n = { frames: 0 };
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) => {
      const b = f.payload;
      if (typeof b !== "string" && b.length && b[0] === 101) n.frames++;
    }),
  );
  return n;
}

test("a spreadsheet loads as a part, its chart follows, and it survives closing and reopening", async ({ browser }) => {
  test.setTimeout(240_000);
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E zh · partial sheet", samRole: "edit", host: HOST_PSYNC });
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
  await cell(priya.oc, 0, 0).click();
  await cell(priya.oc, 2, 1).click({ modifiers: ["Shift"] });
  await priya.oc.getByRole("button", { name: "Chart from selection" }).click();
  await expect(values(priya.oc).nth(1)).toHaveText("Food20", { timeout: 15_000 });
  await expectSaved(priya);
  // The save makes a whole view; idle for 20 s, the room splits again with the sheet a part.
  await priya.page.waitForTimeout(25_000);

  const subs = sheetFrames(sam.page);
  await sam.page.reload();
  await expect(editor(sam)).toBeVisible({ timeout: 15_000 });
  await expect(cell(sam.oc, 2, 1)).toHaveText("20", { timeout: 15_000 });
  expect(subs.frames).toBeGreaterThan(0);
  // Sam's edit in the sheet's part reaches Priya's sheet and chart.
  await cell(sam.oc, 2, 1).click();
  await sam.page.keyboard.type("35");
  await sam.page.keyboard.press("Enter");
  await expect(cell(priya.oc, 2, 1)).toHaveText("35", { timeout: 10_000 });
  await expect(values(priya.oc).nth(1)).toHaveText("Food35", { timeout: 10_000 });
  await expect(values(sam.oc).nth(1)).toHaveText("Food35", { timeout: 10_000 });
  await expectSaved(sam);

  // Both close the canvas; the room goes once idle (60 s) and opens again from storage.
  await priya.ctx.close();
  await sam.ctx.close();
  await new Promise((r) => setTimeout(r, 65_000));
  const again = await person(browser, "u_priya");
  await openFile(again, fileId, HOST_PSYNC);
  await expect(cell(again.oc, 1, 1)).toHaveText("10", { timeout: 15_000 });
  await expect(cell(again.oc, 2, 1)).toHaveText("35");
  await expect(values(again.oc).nth(1)).toHaveText("Food35", { timeout: 15_000 });
  await again.ctx.close();
});
