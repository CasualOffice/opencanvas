// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14 S5: outline, Commands, keyboard connector and shortcuts in the production build, with axe.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

const settle = (page: Page) => page.evaluate(() => Promise.all(document.querySelector(".ocdg")!.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).include(".ocdg").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("S5: outline, Commands with Go to, keyboard connector and shortcuts; axe on each", async ({ page }) => {
  const board = await openDemo(page, srv.url);
  await board.getByRole("button", { name: "Diagram", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Diagram: / });
  await expect(dialog).toBeVisible();
  const canvas = dialog.locator(".ocbd").first();
  await canvas.focus();

  // Outline (5a): Alt+O, arrows, Enter selects on the canvas; announcements in the live region.
  await page.keyboard.press("Alt+O");
  const tree = dialog.getByRole("complementary", { name: "Outline" }).getByRole("tree");
  await expect(tree).toBeVisible();
  await tree.getByRole("treeitem").first().focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(tree.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);
  await expect(dialog.locator(".ocdg-live")).toContainText("selected.");
  // The focus ring: 2.5 px (.15625rem) of the accent colour. Chrome snaps outline widths to device
  // pixels (2 px at DPR 1), so the declared value is checked as well as the drawn one.
  const ring = await page.evaluate(() => {
    const a = document.activeElement!;
    const cs = getComputedStyle(a);
    const probe = document.createElement("i");
    probe.style.color = "var(--accent)";
    a.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const rules = [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.startsWith(".ocdg :focus-visible"));
    return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), same: cs.outlineColor === accent, declared: rules.map((r) => r.cssText) };
  });
  expect(ring.style).toBe("solid");
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(ring.same).toBe(true);
  expect(ring.declared.join(" ")).toContain(".15625rem solid");
  await axe(page);

  // Commands (5b): typing a shape name puts it first; Enter selects it and moves the view to it.
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+K");
  const pal = page.getByRole("dialog", { name: "Commands" });
  await expect(pal).toBeVisible();
  await expect(pal.getByRole("combobox")).toBeFocused();
  await axe(page);
  const view = () => dialog.locator("svg.ocbd-svg > g[transform]").first().getAttribute("transform");
  const v0 = await view();
  const target = (await tree.getByRole("treeitem").last().textContent())!.trim().slice(0, 6);
  await page.keyboard.type(target);
  await expect(pal.getByRole("option", { selected: true })).toContainText(target);
  await page.keyboard.press("Enter");
  await expect(pal).toBeHidden();
  await expect.poll(view).not.toBe(v0);

  // Keyboard connector (5c): C, Tab, an arrow for the side, Enter.
  await tree.getByRole("treeitem").first().focus();
  await page.keyboard.press("Enter");
  await canvas.focus();
  const count = () => dialog.locator('[role="treeitem"]').count();
  const n0 = await count();
  await page.keyboard.press("c");
  await expect(dialog.locator(".ocdg-hintbar")).toContainText("Connecting from");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.locator(".ocdg-live")).toContainText("left side. Press Enter to connect.");
  await axe(page);
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".ocdg-hintbar")).toBeHidden();
  await expect.poll(count).toBe(n0 + 1);

  // Shortcuts (5d).
  await canvas.focus();
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Start a connector");
  await axe(page);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});
