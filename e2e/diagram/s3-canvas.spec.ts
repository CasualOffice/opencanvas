// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14 S3: the diagram canvas in the production build (demo document).
import { expect, test } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

test("S3: grid, rulers, ports on hover and a port-to-port connector that avoids shapes", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  await board.getByRole("button", { name: "Diagram", exact: true }).click();
  const dg = page.getByRole("dialog", { name: /^Diagram: / });
  await expect(dg).toBeVisible();
  await expect(dg.locator("[data-grid]")).toHaveCount(1);
  await expect(dg.locator(".ocdg-rulers text").first()).toBeVisible();
  await dg.getByRole("radio", { name: "Avoid shapes" }).click();

  const count = async () => Number(/(\d+) shapes?/.exec((await dg.locator(".ocbd").getAttribute("aria-label")) ?? "")?.[1] ?? -1);
  const before = await count();
  // Two boxy shapes that don't overlap.
  const boxes = await dg.locator("g[data-s]").evaluateAll((els) =>
    els
      .filter((e) => e.querySelector("rect,ellipse,polygon") && !e.querySelector("path[marker-end],path[marker-start]"))
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { id: e.getAttribute("data-s")!, x: r.x, y: r.y, w: r.width, h: r.height };
      })
      .filter((b) => b.w > 30 && b.h > 20 && b.x > 300 && b.x + b.w < 980 && b.y > 80 && b.y + b.h < 860),
  );
  expect(boxes.length).toBeGreaterThan(1);
  const a = boxes[0];
  const b = boxes.find((q) => Math.abs(q.x - a.x) > a.w + 20 || Math.abs(q.y - a.y) > a.h + 20)!;
  await page.mouse.move(a.x + a.w / 2, a.y + a.h / 2);
  const ports = dg.locator(`[data-port-of="${a.id}"]`);
  await expect(ports).toHaveCount(4);
  const pb = (await dg.locator(`[data-port-of="${a.id}"][data-port="right"]`).boundingBox())!;
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(pb.x + ((b.x + 4 - pb.x) * i) / 8, pb.y + ((b.y + b.h / 2 - pb.y) * i) / 8);
  await page.mouse.up();
  await expect.poll(count).toBe(before + 1);
  if (process.env.DGM_SHOT) await page.screenshot({ path: process.env.DGM_SHOT });
});
