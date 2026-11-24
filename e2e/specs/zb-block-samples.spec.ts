// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zb. The sample blocks built with @opencanvas/block-sdk (BSDK-04): acme.okr (third party,
// installed from OC_BLOCKS_DIR, with a preview.png) and oc.progress (first party, compiled in).
// Insert from the / menu, edit, a second person sees it; the gallery shows the preview; axe in
// light and dark on both.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator } from "@playwright/test";
import { editor, sharedFile, type Person } from "../helpers";
import { storedDocument } from "../ocanvas";

const block = (p: Person, type: string) => p.oc.locator(`.oc-ext[data-ext-type="${type}"]`);
const frameOf = (p: Person, type: string): FrameLocator => block(p, type).frameLocator("iframe.oc-ext-iframe");

async function slash(p: Person, query: string) {
  await editor(p).getByRole("heading", { name: "Notes" }).click();
  await p.page.keyboard.press("End");
  await p.page.keyboard.press("Enter");
  await p.page.keyboard.type("/" + query);
}

test("acme.okr: insert, add a key result with an owner, a second person sees it", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E zb · okr", samRole: "edit" });
  await slash(priya, "okr");
  await expect(priya.oc.getByRole("listbox", { name: "Insert" }).getByText("Acme Corp · Objective and key results")).toBeVisible();
  await priya.page.keyboard.press("Enter");
  const f = frameOf(priya, "acme.okr");
  await expect(f.getByLabel("Objective")).toHaveValue("New objective", { timeout: 10_000 });
  await f.getByLabel("Objective").fill("Make admin sign-in fast and self-serve");
  await f.getByLabel("Objective").press("Enter");
  await f.getByRole("button", { name: "Add key result" }).click();
  await expect(f.getByLabel("Key result 1", { exact: true })).toHaveValue("New key result");
  await f.getByLabel("Owner of key result 1").selectOption({ label: "Sam Ortiz" });

  const g = frameOf(sam, "acme.okr");
  await expect(g.getByLabel("Objective")).toHaveValue("Make admin sign-in fast and self-serve", { timeout: 10_000 });
  await expect(g.getByLabel("Key result 1", { exact: true })).toHaveValue("New key result");
  await expect(g.getByLabel("Owner of key result 1")).toHaveValue("u_sam");
  await expect.poll(() => storedDocument(fileId) ?? "", { timeout: 20_000 }).toContain("- New key result: 0%");
});

test("oc.progress: the first-party block on the contract", async ({ browser }) => {
  const { priya, sam } = await sharedFile(browser, { name: "E2E zb · progress", samRole: "view" });
  await slash(priya, "percent");
  await priya.page.keyboard.press("Enter");
  const f = frameOf(priya, "oc.progress");
  await expect(f.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0", { timeout: 10_000 });
  await f.getByLabel("Progress value").fill("40");
  await f.getByLabel("Progress value").dispatchEvent("change");
  await expect(f.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  // The viewer sees it, without the slider.
  const g = frameOf(sam, "oc.progress");
  await expect(g.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40", { timeout: 10_000 });
  await expect(g.getByLabel("Progress value")).toBeHidden();
});

test("the gallery shows the package's preview.png, and axe passes on the samples", async ({ browser }) => {
  const { priya } = await sharedFile(browser, { name: "E2E zb · gallery", samRole: "view" });
  await slash(priya, "");
  await priya.oc.getByRole("option", { name: "Browse all blocks" }).click();
  const gallery = priya.oc.getByRole("dialog", { name: "Insert a block" });
  const card = gallery.getByRole("option").filter({ hasText: "Acme Corp" });
  await expect(card.locator("img.oc-gal-img")).toHaveAttribute("src", /\/blocks\/acme\.okr\/1\.2\.0\/preview\.png$/);
  await expect.poll(() => card.locator("img.oc-gal-img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320);
  await card.click();
  await expect(gallery).toContainText("by Acme Corp · acme.okr 1.2.0");
  await card.press("Enter");
  await slash(priya, "percent");
  await priya.page.keyboard.press("Enter");
  await expect(frameOf(priya, "acme.okr").getByLabel("Objective")).toBeVisible({ timeout: 10_000 });
  await expect(frameOf(priya, "oc.progress").getByRole("progressbar")).toBeVisible({ timeout: 10_000 });
  const frame = priya.page.frame({ name: "oc" })!;
  for (const theme of ["light", "dark"]) {
    await frame.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await expect(frameOf(priya, "acme.okr").locator("html")).toHaveAttribute("data-theme", theme);
    await expect(frameOf(priya, "oc.progress").locator("html")).toHaveAttribute("data-theme", theme);
    const r = await new AxeBuilder({ page: priya.page }).include(['iframe[name="oc"]', ".oc-ext"]).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
});
