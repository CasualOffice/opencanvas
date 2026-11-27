// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zf. SHEET-08: a Spreadsheet block edited offline merges on reconnect (OFF-02..07 for the
// `sheets` root). Priya keeps the canvas offline, changes A1 and types into B1 with no network;
// Sam, online, changes A2 and types into C1. Priya's formula recomputes from the device while
// offline; after reconnecting both see every cell and the SUM over both edits, and the stored
// document holds Priya's offline text.
import { expect, test, type FrameLocator } from "@playwright/test";
import { HOST_OFFLINE as H } from "../env";
import { applyTemplate, createFile, editor, openFile, person, setAccess, storedDocumentHas, typeAfterHeading, type Person } from "../helpers";

const pill = (p: Person) => p.oc.locator(".top .status");
const grid = (oc: FrameLocator) => oc.locator(".ocsh-grid").first();
const cell = (oc: FrameLocator, r: number, c: number) => grid(oc).locator(`[data-r="${r}"][data-c="${c}"]`);

async function enter(p: Person, r: number, c: number, v: string) {
  await cell(p.oc, r, c).click();
  await p.page.keyboard.type(v);
  await p.page.keyboard.press("Enter");
}

test("SHEET-08: a sheet edited offline merges with a collaborator's edits on reconnect", async ({ browser }) => {
  test.setTimeout(150_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E zf · offline sheet", H);
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "");
  await priya.page.keyboard.type("/spreadsheet");
  await priya.page.keyboard.press("Enter");
  await expect(grid(priya.oc)).toBeVisible({ timeout: 15_000 });
  for (const [r, v] of [[0, "1"], [1, "2"], [2, "=SUM(A1:A2)"]] as const) await enter(priya, r, 0, v);
  await expect(cell(priya.oc, 2, 0)).toHaveText("3");
  await expect(pill(priya)).toHaveAttribute("aria-label", /^Saved/, { timeout: 15_000 });

  const owner = await person(browser, "u_priya");
  await setAccess(owner, fileId, "u_sam", "edit", H);
  const sam = await person(browser, "u_sam");
  await openFile(sam, fileId, H);
  await expect(cell(sam.oc, 2, 0)).toHaveText("3", { timeout: 15_000 });

  // Keep it on this device, then lose the network.
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await priya.oc.getByRole("menuitemcheckbox", { name: /Available offline on this device/ }).click();
  await priya.oc.getByRole("dialog", { name: /^Keep “.+” on this device\?$/ }).getByRole("button", { name: "Keep offline" }).click();
  await expect(priya.oc.getByText(/available offline on this device/i).first()).toBeVisible();
  await priya.ctx.setOffline(true);
  await expect(pill(priya)).toHaveAttribute("aria-label", /^Offline/, { timeout: 25_000 });

  // Offline: Priya's edits compute on the device.
  await enter(priya, 0, 0, "10");
  await enter(priya, 0, 1, "Typed offline in the sheet");
  await expect(cell(priya.oc, 2, 0)).toHaveText("12");
  await expect(pill(priya)).toHaveAttribute("aria-label", /^Offline · \d+ changes? on this device$/);

  // Meanwhile Sam edits other cells online.
  await enter(sam, 1, 0, "5");
  await enter(sam, 0, 2, "Sam online");
  await expect(cell(sam.oc, 2, 0)).toHaveText("6");
  await expect(cell(priya.oc, 0, 2)).toHaveText("");
  expect(storedDocumentHas(fileId, "Typed offline in the sheet", H)).toBe(false);

  // Reconnect: both edits merge, and the formula sees both.
  await priya.ctx.setOffline(false);
  await expect(pill(priya)).toHaveAttribute("aria-label", /^(Saved|Saving|Unsaved)/, { timeout: 40_000 });
  for (const p of [priya, sam]) {
    await expect(cell(p.oc, 0, 0)).toHaveText("10", { timeout: 20_000 });
    await expect(cell(p.oc, 1, 0)).toHaveText("5", { timeout: 20_000 });
    await expect(cell(p.oc, 2, 0)).toHaveText("15");
    await expect(cell(p.oc, 0, 1)).toHaveText("Typed offline in the sheet");
    await expect(cell(p.oc, 0, 2)).toHaveText("Sam online");
  }
  await expect(editor(priya)).toBeVisible();
  await expect.poll(() => storedDocumentHas(fileId, "Typed offline in the sheet", H), { timeout: 30_000 }).toBe(true);
  for (const p of [priya, sam, owner]) await p.ctx.close();
});
