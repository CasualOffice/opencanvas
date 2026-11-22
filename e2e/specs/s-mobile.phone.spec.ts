// s. Acceptance (docs/23 Mobile) on the demo canvas: typing and IME commits, selecting and
//    formatting from the mobile toolbar, comments, tap targets, no sideways page scroll,
//    the safe area and an orientation change. Runs on WebKit (iPhone) and Chromium (Pixel).
import { expect, test, type Page } from "@playwright/test";
import { OC } from "../env";

async function demo(page: Page) {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await expect(page.locator(".ProseMirror p").first()).toBeVisible();
  await expect(page.locator(".app.compact")).toBeVisible();
}
const para = (page: Page) => page.locator(".ProseMirror p").filter({ hasText: "The file stays" });
const noSideScroll = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1);

test("MOB-01: typing and an IME commit land in the text", async ({ page }) => {
  await demo(page);
  await para(page).tap();
  await page.keyboard.press("End");
  await page.keyboard.type(" typed on a phone");
  // insertText is what a CJK IME delivers on commit.
  await page.keyboard.insertText(" 日本語の入力");
  await expect(para(page)).toContainText("typed on a phone 日本語の入力");
  await expect(page.getByRole("toolbar", { name: "Editing tools" })).toBeVisible();
});

test("MOB-03: select a word and format it from the mobile toolbar", async ({ page }) => {
  await demo(page);
  await para(page).dblclick();
  const bar = page.getByRole("toolbar", { name: "Editing tools" });
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Bold" }).tap();
  await expect(para(page).locator("strong")).toHaveCount(1);
  await bar.getByRole("button", { name: "Italic" }).tap();
  await expect(para(page).locator("em")).toHaveCount(1);
});

test("MOB-07: comments open full width on a phone", async ({ page }) => {
  await demo(page);
  await page.getByRole("button", { name: /^Comments/ }).first().tap();
  const side = page.locator("aside.side[aria-label=Comments]");
  await expect(side).toBeVisible();
  const box = (await side.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(vw + 1);
  expect(await noSideScroll(page)).toBe(true);
});

test("MOB-09: tap targets in the top bar and mobile toolbar are at least 24 px (WCAG 2.2 2.5.8)", async ({ page }) => {
  await demo(page);
  await para(page).tap();
  await expect(page.getByRole("toolbar", { name: "Editing tools" })).toBeVisible();
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".top button, .top a, .mbar button")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 24 || r.height < 24))
      .map(({ el, r }) => `${el.getAttribute("aria-label") ?? el.textContent?.trim()} ${Math.round(r.width)}×${Math.round(r.height)}`),
  );
  expect(small).toEqual([]);
});

// Known FAIL (docs/23 MOB-11b): the mobile toolbar ignores safe-area-inset-bottom, so with the
// keyboard closed it can sit under the iPhone home indicator. Placement needs design.
test("MOB-11b: the mobile toolbar keeps clear of the home indicator", async ({ page }) => {
  test.fail();
  await demo(page);
  const css = await page.evaluate(() =>
    [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules].map((r) => r.cssText);
      } catch {
        return [];
      }
    }).join("\n"),
  );
  expect(css).toMatch(/\.mbar[^{]*\{[^}]*safe-area-inset/);
});

test("MOB-10/11/12: no sideways page scroll, safe area on the bottom sheet, rotation", async ({ page }) => {
  await demo(page);
  expect(await noSideScroll(page)).toBe(true);
  const css = await page.evaluate(() =>
    [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules].map((r) => r.cssText);
      } catch {
        return [];
      }
    }).join("\n"),
  );
  expect(css).toMatch(/\.sheet\{?[^}]*safe-area-inset-bottom|\.sheet \{[^}]*safe-area-inset-bottom/);

  const { width, height } = page.viewportSize()!;
  await page.setViewportSize({ width: height, height: width });
  await expect(page.locator(".ProseMirror")).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await page.setViewportSize({ width, height });
  await expect(page.locator(".app.compact")).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
});
