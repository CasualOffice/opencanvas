// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14.6 S6: auto-layout in the production build (demo document): ⇧L, options, preview over
// the canvas, Apply as one step (one Undo restores every position), axe in light and dark.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDemo, serve } from "./serve";

let srv: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => (srv = await serve()));
test.afterAll(() => srv.close());

for (const scheme of ["light", "dark"] as const) {
  test(`S6: preview, apply and one Undo (${scheme})`, async ({ page }) => {
    test.setTimeout(150_000); // heavy under background CPU priority (57 s seen at load 25)
    await page.emulateMedia({ colorScheme: scheme });
    const board = await openDemo(page, srv.url);
    await board.getByRole("button", { name: "Diagram", exact: true }).click();
    const dg = page.getByRole("dialog", { name: /^Diagram: / });
    await expect(dg).toBeVisible();
    // Positions of every shape, by id.
    const positions = () =>
      dg.locator("g[data-s]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-s"), Math.round(e.getBoundingClientRect().x), Math.round(e.getBoundingClientRect().y)].join(":")).sort().join("|"));
    const before = await positions();

    await page.keyboard.press("Shift+L");
    const pop = dg.getByRole("dialog", { name: "Auto-layout" });
    await expect(pop).toBeVisible();
    await expect(pop.getByRole("radio", { name: "Down" })).toHaveAttribute("aria-checked", "true");
    await expect(pop.getByRole("switch", { name: /Keep your bends/ })).toHaveAttribute("aria-checked", "false");
    await pop.getByRole("radio", { name: "Right" }).click();
    const axe = await new AxeBuilder({ page }).include(".ocdg-pop").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);

    await pop.getByRole("button", { name: "Preview" }).click();
    const bar = dg.getByRole("region", { name: "Layout preview" });
    await expect(bar).toContainText("Preview · left to right");
    await expect(page.getByTestId("layout-preview").locator("[data-to]").first()).toBeVisible();
    const axe2 = await new AxeBuilder({ page }).include(".ocdg-pbar").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe2.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
    // Nothing moved yet.
    expect(await positions()).toBe(before);

    await bar.getByRole("button", { name: "Apply" }).click();
    await expect(bar).toHaveCount(0);
    await expect.poll(positions).not.toBe(before);
    await expect(page.getByText(/Layout applied to \d+ shapes?\. Undo puts them all back\./)).toBeVisible();
    // One Undo restores every position.
    await dg.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(positions).toBe(before);
    if (process.env.DGM_SHOT) await page.screenshot({ path: process.env.DGM_SHOT.replace(".png", `-${scheme}.png`) });
  });
}
