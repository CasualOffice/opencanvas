// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14 S1: entering and leaving diagram mode, in the production build (demo document).
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

test("S1: the Diagram button opens the board full screen; Back to document returns focus and scroll", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  const scroller = await page.evaluate(() => {
    const el = document.querySelector(".ocbd")!;
    for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight + 4 && getComputedStyle(p).overflowY !== "visible") return p.className;
    return "";
  });
  const scrollTop = () => page.evaluate((c) => (c ? document.getElementsByClassName(c.split(" ")[0])[0]?.scrollTop : scrollY) ?? 0, scroller);
  const top0 = await scrollTop();
  const button = board.getByRole("button", { name: "Diagram", exact: true });
  await expect(button).toBeVisible();
  await button.click();
  const dialog = page.getByRole("dialog", { name: /^Diagram: / });
  await expect(dialog).toBeVisible();
  // It covers the window: top bar, canvas and the properties panel.
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBe(1280);
  expect(box.height).toBe(900);
  await expect(dialog.getByRole("button", { name: "Back to document" })).toBeVisible();
  // The bar names the board after the heading above it (the demo board has no name).
  await expect(dialog.locator(".ocdg-name")).not.toHaveText("Board");
  await expect(dialog.locator(".ocbd svg.ocbd-svg")).toBeVisible();
  await expect(dialog.getByRole("complementary", { name: "Properties" })).toBeVisible();

  // Accessibility of the diagram window (WCAG 2.2 AA rules).
  // Let the open transition finish (wait for it, not a fixed time).
  await page.evaluate(() => Promise.all(document.querySelector(".ocdg")!.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
  const r = await new AxeBuilder({ page }).include(".ocdg").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  await dialog.getByRole("button", { name: "Back to document" }).click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  expect(Math.abs((await scrollTop()) - top0)).toBeLessThan(4);
});

test("S1: Shift+D and Esc; the transition runs, and not with reduced motion", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  // Count animations started with the Web Animations API instead of asking which are running:
  // on a loaded CI runner the 220 ms transition can finish before the check.
  await page.evaluate(() => {
    const w = window as unknown as { __anims: number };
    w.__anims = 0;
    const orig = Element.prototype.animate;
    Element.prototype.animate = function (...a: Parameters<Element["animate"]>) {
      if ((this as Element).closest(".ocdg")) w.__anims++;
      return orig.apply(this, a);
    };
  });
  const started = () => page.evaluate(() => (window as unknown as { __anims: number }).__anims);
  await board.click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+D");
  const dialog = page.getByRole("dialog", { name: /^Diagram: / });
  await expect(dialog).toBeVisible();
  expect(await started()).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => void ((window as unknown as { __anims: number }).__anims = 0));
  await board.getByRole("button", { name: "Diagram", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await started()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
