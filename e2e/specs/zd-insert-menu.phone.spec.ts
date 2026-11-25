// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zd. The insert menu on a phone (INS-01, frames 7a-7f): the bottom sheet from the toolbar "+",
// drill-in categories, variants as a second step, "/h2" and an intent while typing, and the
// meeting profile's large tiles.
import { expect, test } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { HOST, HOST_MEETING } from "../env";
import { applyTemplate, createFile, editor, openFile, person, typeAfterHeading, type Person } from "../helpers";

const phoneCtx = () => {
  const u = test.info().project.use;
  return { viewport: u.viewport, isMobile: u.isMobile, hasTouch: u.hasTouch, deviceScaleFactor: u.deviceScaleFactor, userAgent: u.userAgent };
};
/** The sample host's files page is not laid out for phones: make the canvas at desktop width,
 *  then open it in a phone context. */
async function phoneFile(browser: Browser, name: string, host: string): Promise<Person> {
  const desk = await person(browser, "u_priya", { viewport: { width: 1280, height: 900 } });
  const id = await createFile(desk, name, host);
  await applyTemplate(desk, "Meeting notes");
  await desk.ctx.close();
  const p = await person(browser, "u_priya", phoneCtx());
  await openFile(p, id, host);
  return p;
}

const sheetOf = (p: Person) => p.oc.locator(".sheet[role=dialog][aria-label=Insert]");

test("phone: sheet, category, variant step, /h2 and an intent", async ({ browser }) => {
  const priya = await phoneFile(browser, "E2E zd · phone", HOST);
  const ed = editor(priya);
  const sheet = sheetOf(priya);

  // The toolbar "+" opens the sheet (7a): search, Quick insert, goals, Explore.
  await ed.locator("h2", { hasText: "Notes" }).tap();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("Enter");
  await priya.oc.getByRole("toolbar", { name: "Editing tools" }).getByRole("button", { name: "Insert block" }).tap();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Search or describe what you need")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Track tasks" })).toBeVisible();

  // Layout → Columns → its layouts as a step (7b, 7c) → 3 columns.
  await sheet.getByRole("button", { name: /^Layout/ }).tap();
  await expect(sheet.locator(".sh-hd b")).toHaveText("Layout");
  await sheet.getByRole("button", { name: /^Columns/ }).tap();
  await expect(sheet.locator(".sh-hd")).toContainText("Choose a layout");
  const cols = await ed.locator("[data-type=columns], .columns").count();
  await sheet.getByRole("button", { name: "3 columns" }).tap();
  await expect(sheet).toHaveCount(0);
  await expect(ed.locator("[data-type=columns], .columns")).toHaveCount(cols + 1);

  // "/h2" while typing: one result on its variant.
  await typeAfterHeading(priya, "Notes", "/h2");
  await expect(sheet.getByRole("button", { name: "Heading, Heading 2" })).toBeVisible();
  await sheet.getByRole("button", { name: "Heading, Heading 2" }).tap();
  await expect(sheet).toHaveCount(0);
  await priya.page.keyboard.type("From the phone");
  await expect(ed.locator("h2", { hasText: "From the phone" })).toBeVisible();

  // An intent phrase.
  await typeAfterHeading(priya, "Notes", "/track tasks");
  await expect(sheet.getByText("Good for “track tasks”")).toBeVisible();
  await sheet.getByRole("button", { name: "List, Checklist" }).tap();
  await expect(sheet).toHaveCount(0);
  await priya.page.keyboard.type("Call the venue");
  await expect(ed.locator('ul[data-type="taskList"] li', { hasText: "Call the venue" })).toBeVisible();
  await priya.ctx.close();
});

test("phone, meeting profile: large tiles with the meeting variants (7f)", async ({ browser }) => {
  const priya = await phoneFile(browser, "E2E zd · phone meeting", HOST_MEETING);
  await typeAfterHeading(priya, "Notes", "/");
  const sheet = sheetOf(priya);
  // A just-opened canvas may take the "/" before the late "/" plugin is installed: retype it.
  await expect(async () => {
    if (!(await sheet.isVisible())) {
      await priya.page.keyboard.press("Backspace");
      await priya.page.keyboard.type("/");
    }
    await expect(sheet).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  const tiles = await sheet.locator(".mx-g button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(tiles).toEqual(["Text", "Heading, Heading 2", "List, Checklist", "Callout, Decision", "Simple table", "Date", "Divider"]);
  await expect(sheet.getByRole("button", { name: /Browse all blocks/ })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Callout, Decision" }).tap();
  await expect(sheet).toHaveCount(0);
  await expect(editor(priya).locator('.callout[data-tone="purple"]')).toHaveCount(1);
  await priya.ctx.close();
});
