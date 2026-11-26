// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zf. Automations on a phone (AUTO-06, prototype frames 6a-6c): the panel is a full-screen
// page with 44 px targets; a suggestion opens the editor; the run history is a page too.
import { expect, test } from "@playwright/test";
import { HOST } from "../env";
import { applyTemplate, createFile, openFile, person } from "../helpers";

const phoneCtx = () => {
  const u = test.info().project.use;
  return { viewport: u.viewport, isMobile: u.isMobile, hasTouch: u.hasTouch, deviceScaleFactor: u.deviceScaleFactor, userAgent: u.userAgent };
};

test("phone: the automations page, a rule from a suggestion, the run history", async ({ browser }) => {
  const desk = await person(browser, "u_priya", { viewport: { width: 1280, height: 900 } });
  const id = await createFile(desk, "E2E zf · phone", HOST);
  await applyTemplate(desk, "Meeting notes");
  await desk.ctx.close();
  const p = await person(browser, "u_priya", phoneCtx());
  await openFile(p, id, HOST);
  await p.oc.getByRole("button", { name: "More options" }).tap();
  await p.oc.locator(".mi", { hasText: "Automations" }).tap();
  const panel = p.oc.getByRole("complementary", { name: /Automations|Edit rule|Run history/ });
  await expect(panel).toBeVisible();
  const vp = test.info().project.use.viewport!;
  const box = await panel.boundingBox();
  expect(Math.round(box!.width)).toBe(vp.width);
  await panel.getByRole("button", { name: /The day before Due, notify the Owner/ }).tap();
  await panel.getByRole("button", { name: "Save rule" }).tap();
  await expect(panel).toContainText("Due tomorrow reminder");
  await expect(panel).toContainText(/Next: .* \(Berlin\)/);
  const close = panel.getByRole("button", { name: "Close automations" });
  expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await panel.getByRole("button", { name: "Run history" }).tap();
  await expect(panel).toContainText("Runs keep ids, times and results only");
  await panel.getByRole("button", { name: "Back to automations" }).tap();
  await close.tap();
  await expect(panel).toBeHidden();
  await p.ctx.close();
});
