// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// ze. Find and search on a phone (SRCH-01/04, prototype frames 5a-5c): the find bar replaces
// the top bar, Up/Down/Replace/Options sit above the keyboard, replace and options share one
// sheet, and "Search all canvases" is a full-screen page. Targets are 44 px.
import { expect, test } from "@playwright/test";
import { HOST } from "../env";
import { applyTemplate, createFile, editor, expectSaved, openFile, person, typeAfterHeading, type Person } from "../helpers";

const phoneCtx = () => {
  const u = test.info().project.use;
  return { viewport: u.viewport, isMobile: u.isMobile, hasTouch: u.hasTouch, deviceScaleFactor: u.deviceScaleFactor, userAgent: u.userAgent };
};

async function phoneFile(browser: import("@playwright/test").Browser, name: string, text: string): Promise<Person> {
  const desk = await person(browser, "u_priya", { viewport: { width: 1280, height: 900 } });
  const id = await createFile(desk, name, HOST);
  await applyTemplate(desk, "Meeting notes");
  await typeAfterHeading(desk, "Notes", text);
  await expectSaved(desk);
  await desk.ctx.close();
  const p = await person(browser, "u_priya", phoneCtx());
  await openFile(p, id, HOST);
  return p;
}

test("phone: find replaces the top bar; replace and options in one sheet", async ({ browser }) => {
  const p = await phoneFile(browser, "E2E ze · phone find", "SSO on phones, SSO everywhere");
  await p.oc.getByRole("button", { name: "More options" }).tap();
  await p.oc.locator(".mi", { hasText: "Find in canvas" }).tap();
  const fb = p.oc.getByRole("search", { name: "Find in canvas" });
  await expect(fb).toBeVisible();
  // At the top of the canvas, in place of its top bar.
  const box = await fb.boundingBox();
  const frame = await p.page.locator('iframe[name="oc"]').boundingBox();
  expect(box!.y - frame!.y).toBeLessThan(8);
  await fb.getByLabel("Find in canvas").fill("SSO");
  await expect(fb).toContainText("1 of 2");
  const tools = p.oc.getByRole("toolbar", { name: "Find" });
  const next = tools.getByRole("button", { name: "Next match" });
  const nb = await next.boundingBox();
  expect(nb!.height).toBeGreaterThanOrEqual(44);
  await next.tap();
  await expect(fb).toContainText("2 of 2");

  await tools.getByRole("button", { name: "Replace" }).tap();
  const sheet = p.oc.getByRole("dialog", { name: "Replace and options" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Replace with").fill("single sign-on");
  await sheet.getByRole("button", { name: /Replace all/ }).tap();
  await expect(editor(p)).toContainText("single sign-on on phones, single sign-on everywhere");
  await sheet.getByRole("button", { name: "Close" }).tap();
  await fb.getByRole("button", { name: "Done" }).tap();
  await expect(fb).toBeHidden();
  await p.ctx.close();
});

test("phone: search all canvases is a full-screen page", async ({ browser }) => {
  const marker = `wombat${Date.now().toString(36)}`;
  const p = await phoneFile(browser, "E2E ze · phone search", `Find the ${marker} note`);
  await p.oc.getByRole("button", { name: "More options" }).tap();
  await p.oc.locator(".mi", { hasText: "Search all canvases" }).tap();
  const dlg = p.oc.getByRole("dialog", { name: "Search all canvases" });
  await expect(dlg).toBeVisible();
  const vp = test.info().project.use.viewport!;
  const b = await dlg.boundingBox();
  expect(Math.round(b!.width)).toBe(vp.width);
  await dlg.getByRole("combobox").fill(marker);
  const hit = dlg.getByRole("option").filter({ hasText: marker });
  await expect(hit).toHaveCount(1, { timeout: 10_000 });
  expect((await hit.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await expect(dlg).toContainText("they update when a canvas is saved");
  // The result is in this canvas: it scrolls there and find opens with the query.
  await hit.tap();
  await expect(dlg).toBeHidden();
  await expect(p.oc.getByRole("search", { name: "Find in canvas" }).getByLabel("Find in canvas")).toHaveValue(marker);
  await p.ctx.close();
});
