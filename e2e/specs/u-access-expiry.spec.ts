// u. docs/23 PERM-07, prototype docs/prototypes/fixes-approved/Main.dc.html: access running out.
//    A minute before the session's `exp` the canvas posts Token_Expiring; a host that renews does
//    so quietly. If it doesn't, an amber bar ("Renew now", "Let it end"); at expiry a red
//    read-only bar with "Reconnect", local edits kept; a toast once access is renewed.
//    The sample host's tokens live 600 s; the page clock is fast-forwarded.
import path from "node:path";
import { ROOT } from "../env";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { applyTemplate, createFile, editor, person, openFile } from "../helpers";

const TTL = 600_000;
const expiring = (page: Page) => page.evaluate(() => Number(document.body.dataset.tokenExpiring || 0));

async function axe(page: Page) {
  const f = page.frame({ name: "oc" })!;
  for (const theme of ["light", "dark"]) {
    await f.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page }).include("iframe[name=oc]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.passes.some((v) => v.id === "color-contrast" && v.nodes.some((n) => /Renew now|Reconnect|Let it end|Your access/.test(n.html + JSON.stringify(n.target)))), `${theme}: contrast was checked on the bar`).toBe(true);
    // Only the access bars are under test here.
    const bad = r.violations.flatMap((v) => v.nodes.filter((n) => /Renew now|Reconnect|Let it end|Your access/.test(n.html + JSON.stringify(n.target))).map((n) => `${theme}: ${v.id} ${JSON.stringify(n.target)}`));
    expect(bad).toEqual([]);
  }
  await f.evaluate(() => delete document.documentElement.dataset.theme);
}

test("PERM-07: Token_Expiring a minute before expiry; a host that renews shows nothing", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  await priya.page.clock.install();
  const fileId = await createFile(priya, "Expiry quiet");
  await openFile(priya, fileId);
  await applyTemplate(priya, "Meeting notes");
  // The host's fresh token is minted on real time, so the page clock comes back to real time
  // before the host answers (it holds the answer until then, then renews as it always does).
  await priya.page.evaluate(() => ((window as unknown as { ocHoldRefresh: boolean }).ocHoldRefresh = true));
  await priya.page.clock.fastForward(TTL - 60_000 + 500);
  await expect.poll(() => expiring(priya.page)).toBe(1);
  await priya.page.clock.setSystemTime(new Date());
  const renewed = priya.page.waitForResponse((r) => /\/v1\/sessions\//.test(r.url()));
  await priya.page.evaluate(() => (window as unknown as { ocRenew(): void }).ocRenew());
  await renewed;
  await priya.page.waitForTimeout(300);
  // Past the old grace and the old expiry: no bar at all, still editable, no new warning.
  await priya.page.clock.fastForward(70_000);
  await expect(priya.oc.locator(".banner.access")).toHaveCount(0);
  await expect(priya.oc.locator(".toast", { hasText: "Access renewed" })).toHaveCount(0);
  await expect(editor(priya)).toHaveAttribute("contenteditable", "true");
  expect(await expiring(priya.page)).toBe(1);
  await priya.ctx.close();
});

test("PERM-07: no renewal → amber bar, then the red read-only bar; edits kept; Reconnect renews", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  await priya.page.clock.install();
  const fileId = await createFile(priya, "Expiry ends");
  await openFile(priya, fileId);
  await applyTemplate(priya, "Meeting notes");
  await priya.page.evaluate(() => ((window as unknown as { ocHoldRefresh: boolean }).ocHoldRefresh = true));
  await editor(priya).locator("p").first().click();
  await priya.page.keyboard.type("Kept through expiry");
  await priya.page.clock.fastForward(TTL - 60_000 + 500);
  await expect.poll(() => expiring(priya.page)).toBe(1);
  await priya.page.clock.fastForward(6_000);
  const warn = priya.oc.getByRole("status").filter({ hasText: "Your access to this canvas ends in 1 minute." });
  await expect(warn).toBeVisible();
  await expect(warn).toContainText("We asked Sample host to renew it. Nothing you type is lost either way.");
  await axe(priya.page);
  await priya.page.screenshot({ path: path.join(ROOT, "target/fix-shots/perm07-ending-soon.png") });
  await warn.getByRole("button", { name: "Renew now" }).click();
  await expect.poll(() => expiring(priya.page)).toBe(2);

  await priya.page.clock.fastForward(60_000);
  const ended = priya.oc.getByRole("alert").filter({ hasText: "Your access ended, so the canvas is read only." });
  await expect(ended).toBeVisible();
  await expect(ended).toContainText("Reconnect to keep editing.");
  await expect(editor(priya)).toHaveAttribute("contenteditable", "false");
  await expect(editor(priya)).toContainText("Kept through expiry");
  await expect(warn).toHaveCount(0);
  // The header's save status becomes a lock and "Read only" (prototype Main.dc.html).
  await expect(priya.oc.locator(".top .status .lbl")).toHaveText("Read only");
  await expect(priya.oc.locator(".top .status .lbl")).toBeVisible();
  await expect(priya.oc.locator(".top .status", { hasText: "Saved" })).toHaveCount(0);
  // Reconnect is the solid accent button (contrast checked by axe below, light and dark).
  await expect(ended.getByRole("button", { name: "Reconnect" })).toHaveCSS("background-color", "rgb(42, 90, 215)");
  await expect(ended.getByRole("button", { name: "Reconnect" })).toHaveCSS("color", "rgb(255, 255, 255)");
  await axe(priya.page);
  await priya.page.screenshot({ path: path.join(ROOT, "target/fix-shots/perm07-ended.png") });

  await priya.page.evaluate(() => ((window as unknown as { ocHoldRefresh: boolean }).ocHoldRefresh = false));
  await ended.getByRole("button", { name: "Reconnect" }).click();
  await expect(priya.oc.locator(".toast", { hasText: "Access renewed. You can keep editing." })).toBeVisible();
  await expect(ended).toHaveCount(0);
  await expect(editor(priya)).toHaveAttribute("contenteditable", "true");
  await expect(editor(priya)).toContainText("Kept through expiry");
  await priya.ctx.close();
});
