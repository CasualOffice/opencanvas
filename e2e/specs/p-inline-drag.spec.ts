// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// p. Dragging inside an inline whiteboard moves the shape. It used to start a native drag of
//    the whole block, so drags only worked in full screen.
import { expect, test } from "@playwright/test";
import { OC } from "../env";

test("a sticky note on an inline board follows the pointer", async ({ page }) => {
  await page.goto(`${OC}/app/#demo`);
  const board = page.locator(".ocbd").first();
  await board.scrollIntoViewIfNeeded();
  await expect(board.locator("svg g[data-s]").first()).toBeVisible();

  let blockDrags = 0;
  await page.exposeFunction("ocBlockDrag", () => blockDrags++);
  await page.evaluate(() => document.addEventListener("dragstart", () => (window as unknown as { ocBlockDrag: () => void }).ocBlockDrag(), true));

  // The smallest shape on the board is a sticky note, safely hit at its centre.
  const shapes = board.locator("svg g[data-s]");
  let pick: { id: string; x: number; y: number; w: number; h: number } | null = null;
  for (let i = 0; i < (await shapes.count()); i++) {
    const bb = await shapes.nth(i).boundingBox();
    const id = await shapes.nth(i).getAttribute("data-s");
    if (bb && id && bb.width > 40 && bb.width < 200 && (!pick || bb.width * bb.height < pick.w * pick.h)) pick = { id, x: bb.x, y: bb.y, w: bb.width, h: bb.height };
  }
  expect(pick).not.toBeNull();
  const { id, x, y, w, h } = pick!;
  const sx = x + w / 2;
  const sy = y + h / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) await page.mouse.move(sx + k * 10, sy + k * 5, { steps: 2 });
  await page.mouse.up();

  const after = await board.locator(`svg g[data-s="${id}"]`).boundingBox();
  expect(blockDrags).toBe(0);
  expect(Math.round(after!.x - x)).toBeGreaterThan(100);
  expect(Math.round(after!.y - y)).toBeGreaterThan(45);
});
