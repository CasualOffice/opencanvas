// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14 S2: the shapes panel in the production build (demo document).
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

test("S2: search, click and drag shapes onto the canvas; the panel passes axe", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  await board.getByRole("button", { name: "Diagram", exact: true }).click();
  const dg = page.getByRole("dialog", { name: /^Diagram: / });
  await expect(dg).toBeVisible();
  const panel = dg.getByRole("complementary", { name: "Shapes" });
  await expect(panel.getByRole("button", { name: "Add Process" })).toBeVisible();
  const count = async () => Number(/(\d+) shapes?/.exec((await dg.locator(".ocbd").getAttribute("aria-label")) ?? "")?.[1] ?? -1);
  const n0 = await count();

  // "/" focuses search; the best match is first and Enter adds it.
  await dg.locator(".ocbd").focus();
  await page.keyboard.press("/");
  await expect(panel.getByRole("searchbox", { name: "Search shapes" })).toBeFocused();
  await page.keyboard.type("data");
  // The Database icon (DGM-17) matches as well as the Network shape, so the Icons group is first (1d).
  await expect(panel.locator(".ocdg-tile").first()).toHaveAttribute("data-icon", "database");
  await page.keyboard.press("Enter");
  await expect.poll(count).toBe(n0 + 1);
  await expect(dg.locator('g[data-kind="icon:node"]')).toHaveCount(1);
  await panel.locator('.ocdg-tile[data-kind="network:database"]').click();
  await expect.poll(count).toBe(n0 + 2);
  await expect(dg.locator('g[data-kind="network:database"] path')).toHaveCount(1);

  // Drag a tile onto the canvas.
  const svg = (await dg.locator("svg.ocbd-svg").boundingBox())!;
  await panel.locator('.ocdg-tile[data-kind="flowchart:stored-data"]').dragTo(dg.locator("svg.ocbd-svg"), { targetPosition: { x: svg.width - 160, y: 140 } });
  await expect.poll(count).toBe(n0 + 3);
  await expect(dg.locator('g[data-kind="flowchart:stored-data"]')).toHaveCount(1);

  await page.evaluate(() => Promise.all(document.querySelector(".ocdg")!.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
  const r = await new AxeBuilder({ page }).include(".ocdg-left").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`)).toEqual([]);
  if (process.env.DGM_SHOT) await page.screenshot({ path: process.env.DGM_SHOT });
});

test("S2: connector presets, the rail with flyouts, and the Shapes / Outline tabs; axe on each", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  await board.getByRole("button", { name: "Diagram", exact: true }).click();
  const dg = page.getByRole("dialog", { name: /^Diagram: / });
  await expect(dg).toBeVisible();
  const axe = async (sel: string) => {
    const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`)).toEqual([]);
  };
  const count = async () => Number(/(\d+) shapes?/.exec((await dg.locator(".ocbd").getAttribute("aria-label")) ?? "")?.[1] ?? -1);

  // UML relations are connector presets: one click arms the connector tool with that style.
  await dg.locator('[data-library="uml"] .ocdg-lh button').click();
  await dg.getByRole("button", { name: "Connector: Inheritance" }).click();
  await expect(dg.getByRole("button", { name: "Arrow", exact: true })).toHaveAttribute("aria-pressed", "true");
  const boxes = await dg.locator("g[data-s]").evaluateAll((els) =>
    els
      .filter((e) => e.querySelector("rect") && !e.querySelector("path[marker-end],path[marker-start]"))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 60 && r.height > 30 && r.x > 300 && r.right < 980 && r.y > 80 && r.bottom < 860)
      .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
  );
  const [a, b] = [boxes[0], boxes.find((q) => Math.abs(q.x - boxes[0].x) > boxes[0].w + 20)!];
  const n0 = await count();
  await page.mouse.move(a.x + a.w / 2, a.y + a.h / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.w / 2 + ((b.x + b.w / 2 - a.x - a.w / 2) * i) / 8, a.y + a.h / 2 + ((b.y + b.h / 2 - a.y - a.h / 2) * i) / 8);
  await page.mouse.up();
  await expect.poll(count).toBe(n0 + 1);
  await expect(dg.locator('path[marker-end$="-triangle)"]')).toHaveCount(1);

  // Tabs.
  await dg.getByRole("tab", { name: "Outline" }).click();
  await expect(dg.getByRole("complementary", { name: "Outline" }).getByRole("tree")).toBeVisible();
  await axe(".ocdg-left");
  await dg.getByRole("tab", { name: "Shapes" }).click();

  // The rail: a library as a flyout; adding closes it.
  await dg.getByRole("button", { name: "Collapse shapes panel" }).click();
  const rail = dg.locator("aside.ocdg-rail");
  await rail.getByRole("button", { name: "Network" }).click();
  const fly = dg.getByRole("dialog", { name: "Network" });
  await expect(fly).toBeVisible();
  await axe(".ocdg-left");
  await fly.getByRole("button", { name: "Add Cache" }).click();
  await expect(fly).toBeHidden();
  await expect.poll(count).toBe(n0 + 2);
  await rail.getByRole("button", { name: "Expand shapes panel" }).click();
  await expect(dg.getByRole("tab", { name: "Shapes" })).toHaveAttribute("aria-selected", "true");

  // The Libraries chooser: hide one, and it leaves the panel.
  await dg.getByRole("button", { name: /^Libraries/ }).click();
  const chooser = dg.getByRole("dialog", { name: "Libraries" });
  await expect(chooser).toBeVisible();
  await axe(".ocdg-left");
  if (process.env.DGM_SHOT) await page.screenshot({ path: process.env.DGM_SHOT });
  await chooser.getByRole("checkbox", { name: "UML" }).uncheck();
  await expect(dg.locator('[data-library="uml"]')).toHaveCount(0);
  await chooser.getByRole("checkbox", { name: "UML" }).check();
  await chooser.getByRole("button", { name: "Done" }).click();
  await expect(dg.locator('[data-library="uml"]')).toHaveCount(1);
});
