// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zl. Links on a phone (LINK-04, prototype frames 4a and 4b): "Linked from" is a section at the
// end of the canvas and a sheet from the top bar's menu; a long press on a link opens its
// preview as a sheet with Open and Copy link.
import { expect, test } from "@playwright/test";
import { HOST_LINKS } from "../env";
import { applyTemplate, createFile, editor, expectSaved, openFile, person } from "../helpers";

test("phone: Linked from at the end and as a sheet; long-press preview", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const target = await createFile(priya, "Support macros", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await expectSaved(priya);
  const source = await createFile(priya, "Ops handbook", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await editor(priya).locator("h1, h2, h3").filter({ hasText: "Notes" }).first().click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("Replies use [[Support");
  await expect(priya.oc.getByRole("option", { name: /Support macros/ })).toBeVisible({ timeout: 15_000 });
  await priya.page.keyboard.press("Enter");
  await expectSaved(priya);

  // 4b: a long press on the link: the preview as a sheet.
  const link = editor(priya).locator("a.clink").first();
  await expect(link).toHaveText("Support macros");
  await link.dispatchEvent("touchstart", { touches: [], changedTouches: [] });
  const pv = priya.oc.getByRole("dialog", { name: "Link preview" });
  await expect(pv).toBeVisible();
  await expect(pv).toHaveClass(/sheet/);
  await expect(pv.getByRole("button", { name: "Copy link" })).toBeVisible();
  await priya.oc.locator(".lk-scrim").click({ position: { x: 10, y: 10 } });
  await expect(pv).toBeHidden();

  // 4a: the section at the end of the target, and the sheet from the menu.
  await openFile(priya, target, HOST_LINKS);
  const end = priya.oc.getByRole("region", { name: "Linked from" });
  await expect(end.getByRole("button", { name: /Ops handbook/ })).toBeVisible({ timeout: 15_000 });
  await priya.oc.getByRole("button", { name: "More options" }).click();
  // The phone menu is a sheet of buttons.
  await priya.oc.getByRole("button", { name: "Linked from", exact: true }).click();
  const side = priya.oc.getByRole("complementary", { name: "Linked from" });
  await expect(side).toBeVisible();
  await expect(side).toHaveClass(/sheet/);
  await expect(side).toContainText("Ops handbook");
  const box = (await side.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(391);
  void source;
});
