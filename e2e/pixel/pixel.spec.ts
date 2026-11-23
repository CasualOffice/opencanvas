// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SCALE-01: the main screens, pixel for pixel (see pixel.config.ts for how to run it).
// Time is frozen (page.clock) so the demo's simulated people, the calendar month and the
// toasts land in the same place on every run. The slash menu is left out: where it opens
// varies from run to run on the same build (seen before any change), so it can't be pixel-compared.
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, extra = "") {
  // Paused, not just installed: an installed clock still flows with real time.
  await page.clock.install({ time: new Date("2026-11-24T10:00:00") });
  await page.clock.pauseAt(new Date("2026-11-24T10:00:01"));
  await page.goto(`/app/#demo&sim=quiet${extra}`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await page.clock.runFor(9_000);
  await page.evaluate(() => document.fonts.ready);
}

/** Scrolls the document so `sel` is at the top of the viewport (no smooth scrolling). */
async function scrollTo(page: Page, sel: string) {
  // Lazy blocks load on timers: keep the paused clock moving until the block is there.
  for (let i = 0; i < 40 && !(await page.locator(sel).count()); i++) await page.clock.runFor(500);
  await page.locator(sel).first().waitFor();
  await page.evaluate((s) => document.querySelector(s)!.scrollIntoView({ block: "start", behavior: "instant" }), sel);
  await page.clock.runFor(1_000);
}

async function settle(page: Page) {
  await page.clock.runFor(1_000);
}

async function shot(page: Page, name: string) {
  await settle(page);
  // Toasts come and go on demo timers that race the screenshot; they're not under test here.
  await page.addStyleTag({ content: ".toasts{visibility:hidden!important}" });
  await expect(page).toHaveScreenshot(`${name}.png`);
}

test("document top", async ({ page }) => {
  await open(page);
  await shot(page, "doc-top");
});

test("document: lists and callout further down", async ({ page }) => {
  await open(page);
  await scrollTo(page, ".ProseMirror ul");
  await shot(page, "doc-list");
});

for (const view of ["Table", "Board", "Calendar", "Gallery"]) {
  test(`database ${view.toLowerCase()} view`, async ({ page }) => {
    await open(page);
    await scrollTo(page, ".ocdb");
    if (view !== "Table") {
      await page.locator(".ocdb").getByRole("tab", { name: view }).click();
      await scrollTo(page, ".ocdb");
    }
    await shot(page, `db-${view.toLowerCase()}`);
  });
}

test("database row peek", async ({ page }) => {
  await open(page);
  await scrollTo(page, ".ocdb");
  await page.locator(".ocdb").getByRole("button", { name: /^Open Launch-token/ }).first().click();
  await shot(page, "db-peek");
});

test("whiteboard chrome", async ({ page }) => {
  await open(page);
  await scrollTo(page, ".ocbd");
  await shot(page, "board");
});

test("comments panel", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await shot(page, "comments");
});

test("more menu", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "More options" }).click();
  await shot(page, "more-menu");
});

test("import dialog", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "More options" }).click();
  // A menu on desktop, a bottom sheet of buttons on a phone.
  await page.getByRole("menuitem", { name: /^Import/ }).or(page.getByRole("button", { name: /^Import…/ })).click();
  await shot(page, "import");
});

test("template gallery", async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as unknown as { __ocEditor: { commands: { clearContent: (e: boolean) => void } } }).__ocEditor.commands.clearContent(true));
  await expect(page.getByRole("button", { name: "Templates" }).first()).toBeVisible();
  await shot(page, "empty");
  await page.getByRole("button", { name: "Templates" }).first().click();
  await shot(page, "gallery");
});

test("view-only access bar", async ({ page }) => {
  await open(page, "&role=view");
  await shot(page, "role-view");
});

test("comment-only access bar", async ({ page }) => {
  await open(page, "&role=comment");
  await shot(page, "role-comment");
});
