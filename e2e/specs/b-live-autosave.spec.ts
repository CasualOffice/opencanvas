// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// b. Live typing and database cell edits reach the other person within 2 s,
//    autosave lands a new version in the host, and a reload shows the saved content.
import { expect, test } from "@playwright/test";
import { editor, expectSaved, hostVersion, sharedFile, typeAfterHeading } from "../helpers";
import { storedDocument } from "../ocanvas";

test("live typing + database cell edits propagate, autosave reaches the host, reload keeps it", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E b · live", samRole: "edit" });
  await expectSaved(priya);
  const before = hostVersion(fileId);

  // Paragraph typing: Priya → Sam.
  await typeAfterHeading(priya, "Notes", "Typed live by Priya");
  const t0 = Date.now();
  await expect(editor(sam).locator("p", { hasText: "Typed live by Priya" })).toBeVisible({ timeout: 2_000 });
  const textMs = Date.now() - t0;

  // A fast burst (key repeat, a quick typist) must not trip the server's frame-rate limit.
  const burst = "x".repeat(150);
  await priya.page.keyboard.type(" " + burst);
  await expect(editor(sam)).toContainText(burst, { timeout: 2_000 });
  await expect(priya.oc.getByRole("dialog", { name: "Canvas closed" })).toHaveCount(0);

  // Database cells: Sam ticks "Done" and renames a row → Priya.
  const row = (p: typeof sam, name: RegExp) => p.oc.locator(".ocdb").getByRole("row", { name });
  const done = (p: typeof sam) => row(p, /Book a design review/).getByRole("checkbox", { name: "Done" });
  await expect(done(priya)).toHaveAttribute("aria-checked", "false");
  await done(sam).click();
  const t1 = Date.now();
  await expect(done(priya)).toHaveAttribute("aria-checked", "true", { timeout: 2_000 });
  const cellMs = Date.now() - t1;

  // (By position: the row's accessible name changes with the title.)
  await expect(row(sam, /Confirm Meet side-panel width/)).toBeVisible();
  const title = sam.oc.locator(".ocdb").getByRole("textbox", { name: "Action" }).nth(2);
  await expect(title).toHaveValue("Confirm Meet side-panel width");
  await title.fill("Confirm the Meet panel width");
  await title.press("Enter");
  const t2 = Date.now();
  await expect(priya.oc.locator(".ocdb").getByRole("textbox", { name: "Action" }).nth(2)).toHaveValue("Confirm the Meet panel width", { timeout: 2_000 });
  const titleMs = Date.now() - t2;
  test.info().annotations.push({ type: "propagation", description: `text ${textMs} ms, checkbox ${cellMs} ms, title ${titleMs} ms` });

  // Autosave: the host's version goes up and its stored file has the edits.
  await expect.poll(() => hostVersion(fileId), { timeout: 15_000 }).toBeGreaterThan(before);
  await expect
    .poll(() => {
      const d = storedDocument(fileId);
      return !!d && d.includes("Typed live by Priya") && d.includes("Confirm the Meet panel width");
    }, { timeout: 15_000 })
    .toBe(true);
  await expectSaved(priya);
  await expectSaved(sam);

  // Reload shows the saved content.
  await sam.page.reload();
  await expect(editor(sam).locator("p", { hasText: "Typed live by Priya" })).toBeVisible({ timeout: 15_000 });
  await expect(done(sam)).toHaveAttribute("aria-checked", "true");
  await expect(sam.oc.locator(".ocdb").getByRole("textbox", { name: "Action" }).nth(2)).toHaveValue("Confirm the Meet panel width");

  await priya.ctx.close();
  await sam.ctx.close();
});
