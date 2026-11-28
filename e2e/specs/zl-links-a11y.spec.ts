// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zl. Links, LINK-A7 (docs/38 §2.7, prototype frame 6): keyboard only (Space previews a selected
// link, Escape closes, the Linked from groups are disclosure buttons reached with Tab), the names a
// screen reader gets (region, groups, chip, preview dialog), no horizontal scroll at 320 px and
// at 200% zoom, and axe on the section.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser } from "@playwright/test";
import { HOST_LINKS } from "../env";
import { applyTemplate, createFile, editor, expectSaved, openFile, person, type Person } from "../helpers";

test.describe.configure({ mode: "serial" });

let target = "";
let source = "";

/** A target with a heading and a source that links to it, saved and indexed. */
async function setup(browser: Browser): Promise<Person> {
  const priya = await person(browser, "u_priya");
  if (target) return priya;
  target = await createFile(priya, "Pricing model 2027", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await expectSaved(priya);
  source = await createFile(priya, "Board deck draft", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await editor(priya).locator("h1, h2, h3").filter({ hasText: "Notes" }).first().click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("Numbers follow [[Pricing");
  await expect(priya.oc.getByRole("option", { name: /Pricing model 2027/ })).toBeVisible({ timeout: 15_000 });
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("for the year.");
  await expectSaved(priya);
  return priya;
}

/** The editor document's horizontal overflow in CSS px (0 = none). */
const overflow = (p: Person) =>
  p.page.frameLocator('iframe[name="oc"]').locator("html").evaluate((el) => el.scrollWidth - el.clientWidth);

test("keyboard only: Space previews a selected link, Escape closes, groups are disclosures", async ({ browser }) => {
  const priya = await setup(browser);
  await openFile(priya, source, HOST_LINKS);
  const link = editor(priya).locator("a.clink").first();
  await expect(link).toHaveText("Pricing model 2027");
  // Put the caret after the link and select it with the keyboard.
  // Click past the end of the line (a click on the link would follow it).
  const line = editor(priya).locator("p").filter({ hasText: "for the year." });
  const box = (await line.boundingBox())!;
  await line.click({ position: { x: box.width - 2, y: box.height / 2 } });
  // Back to just after the link, then one more step selects it (an atom).
  for (let i = 0; i < " for the year.".length; i++) await priya.page.keyboard.press("ArrowLeft");
  await priya.page.keyboard.press("ArrowLeft");
  await expect(editor(priya).locator("a.clink.ProseMirror-selectednode")).toHaveCount(1);
  await priya.page.keyboard.press(" ");
  const pv = priya.oc.getByRole("dialog", { name: "Link preview" });
  await expect(pv).toContainText("Pricing model 2027");
  await priya.page.keyboard.press("Escape");
  await expect(pv).toBeHidden();
  // Space did not type into the document.
  await expect(editor(priya).locator("p").filter({ hasText: "for the year." })).toContainText("Numbers follow Pricing model 2027");

  await openFile(priya, target, HOST_LINKS);
  const end = priya.oc.getByRole("region", { name: "Linked from" });
  const group = end.getByRole("button", { name: /Board deck draft/ });
  await expect(group).toBeVisible({ timeout: 15_000 });
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await group.focus();
  await priya.page.keyboard.press("Enter");
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await priya.page.keyboard.press("Enter");
  await expect(group).toHaveAttribute("aria-expanded", "true");
  // The reference is a real link, next in the tab order.
  await priya.page.keyboard.press("Tab");
  await expect(end.getByRole("link").first()).toBeFocused();
  // The filters are toggle buttons.
  await expect(end.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  const axe = await new AxeBuilder({ page: priya.page }).include("iframe").analyze();
  expect(axe.violations.filter((v) => /lk-|clink/.test(JSON.stringify(v.nodes)))).toEqual([]);
});

test("320 px and 200% zoom: no horizontal scroll, the section and the sheet fit", async ({ browser }) => {
  await setup(browser);
  for (const [w, h, scale] of [
    [320, 700, 1],
    // 200% zoom of a 1280 px window: a 640 px CSS viewport at twice the pixel density.
    [640, 450, 2],
  ] as const) {
    const p = await person(browser, "u_priya", { viewport: { width: w, height: h }, deviceScaleFactor: scale });
    await openFile(p, target, HOST_LINKS);
    const end = p.oc.getByRole("region", { name: "Linked from" });
    await expect(end.getByRole("button", { name: /Board deck draft/ })).toBeVisible({ timeout: 15_000 });
    await end.scrollIntoViewIfNeeded();
    expect(await overflow(p), `horizontal overflow at ${w} px`).toBeLessThanOrEqual(0);
    const box = await end.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= w + 1, `the section fits ${w} px`).toBe(true);
    await p.ctx.close();
  }
});
