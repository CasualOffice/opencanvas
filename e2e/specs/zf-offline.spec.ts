// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zf. Offline-first editing (OFF-02..07, ADR-063/064, approved prototype
// docs/prototypes/v03-approved/offline.html) against the "sample-offline" host
// (`[host.offline] enabled`, `perms.offline` in its tokens, max_canvases = 3):
// keep a canvas, edit offline, reload without a network, reconnect and merge (a checkpoint
// and the collaborator toast for a long session), access removed or view only while offline,
// sign-out clears the device, the device limit; axe in light and dark.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Frame } from "@playwright/test";
import { HOST_OFFLINE as H } from "../env";
import { applyTemplate, createFile, editor, openFile, person, setAccess, storedDocumentHas, type Person } from "../helpers";

const pill = (p: Person) => p.oc.locator(".top .status");
const frame = (p: Person): Frame => p.page.frame({ name: "oc" })!;
const dbs = (f: Frame) => f.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n.startsWith("oc-offline/")));

async function axe(p: Person, what: string, sel: string) {
  const f = frame(p);
  await p.page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"]) {
    await f.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page: p.page }).include(['iframe[name="oc"]', sel]).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${what} ${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
  await f.evaluate(() => delete document.documentElement.dataset.theme);
}

async function newCanvas(p: Person, name: string) {
  const id = await createFile(p, name, H);
  await applyTemplate(p, "Meeting notes");
  await expect(pill(p)).toHaveAttribute("aria-label", /^Saved/, { timeout: 15_000 });
  return id;
}

async function keepOffline(p: Person, first: boolean) {
  await p.oc.getByRole("button", { name: "More options" }).click();
  const item = p.oc.getByRole("menuitemcheckbox", { name: /Available offline on this device/ });
  await expect(item).toHaveAttribute("aria-checked", "false");
  await item.click();
  if (first) {
    const dlg = p.oc.getByRole("dialog", { name: /^Keep “.+” on this device\?$/ });
    await expect(dlg).toContainText("Works offline for 7 days");
    await expect(dlg).toContainText("Anyone who uses this browser as you can read it.");
    await axe(p, "2b explainer", ".modal");
    await dlg.getByRole("button", { name: "Keep offline" }).click();
  }
  await expect(p.oc.getByText(/available offline on this device/i).first()).toBeVisible();
}

async function goOffline(p: Person) {
  await p.ctx.setOffline(true);
  await expect(pill(p)).toHaveAttribute("aria-label", /^Offline/, { timeout: 25_000 });
}

test("keep, edit offline, reload without a network, reconnect and merge", async ({ browser }) => {
  test.setTimeout(150_000);
  const priya = await person(browser, "u_priya");
  const fileId = await newCanvas(priya, "E2E zf · offline");
  // Sam watches from his own browser: the collaborator toast (4e).
  const owner = await person(browser, "u_priya");
  await setAccess(owner, fileId, "u_sam", "edit", H);
  const sam = await person(browser, "u_sam");
  await openFile(sam, fileId, H);

  await keepOffline(priya, true);
  expect((await dbs(frame(priya))).some((n) => n.startsWith("oc-offline/sample-offline/u_priya/"))).toBe(true);
  // The editor code is cached for opening without a network (no content in it).
  expect(await frame(priya).evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe("activated");
  expect(await frame(priya).evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("oc-shell-")).length)).toBe(1);

  await goOffline(priya);
  await expect(pill(priya)).toHaveAttribute("aria-label", "Offline · saved on this device");
  // No banner for offline (1a): the pill is the indicator.
  await expect(priya.oc.locator(".banner.warn")).toHaveCount(0);
  await editor(priya).locator("p").last().click();
  const long = "Written on the train. " + "x".repeat(200);
  await priya.page.keyboard.type(long, { delay: 0 });
  await expect(pill(priya)).toHaveAttribute("aria-label", /^Offline · \d+ changes on this device$/);
  // 1b: the popover says where the changes are and how long the copy lasts.
  await pill(priya).click();
  const pop = priya.oc.locator(".off-pop");
  await expect(pop).toContainText("Your changes are saved on this device");
  await expect(pop).toContainText("Offline copy valid until");
  await axe(priya, "1b popover", ".off-pop");
  await priya.page.keyboard.press("Escape");
  // 3b: what needs the server says so.
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await expect(priya.oc.getByRole("menuitem", { name: /Version history.*Needs a connection/ })).toBeDisabled();
  await priya.page.keyboard.press("Escape");

  // Reload the editor without a network: it opens from the device.
  await frame(priya).evaluate(() => location.reload());
  await expect(editor(priya)).toContainText("Written on the train", { timeout: 20_000 });
  await expect(pill(priya)).toHaveAttribute("aria-label", /^Offline · \d+ changes on this device$/);
  expect(storedDocumentHas(fileId, "Written on the train", H)).toBe(false);

  // Back online: a fresh launch through the host, a checkpoint (over 200 changes), the merge.
  await priya.ctx.setOffline(false);
  await expect(priya.oc.getByText(/offline changes are saved/)).toBeVisible({ timeout: 40_000 });
  await expect(pill(priya)).toHaveAttribute("aria-label", /^(Saved|Saving|Unsaved)/, { timeout: 20_000 });
  await expect(sam.oc.getByText(/Priya was offline\. Their \d+ changes just arrived\./)).toBeVisible({ timeout: 20_000 });
  await expect(editor(sam)).toContainText("Written on the train", { timeout: 10_000 });
  await expect.poll(() => storedDocumentHas(fileId, "Written on the train", H), { timeout: 30_000 }).toBe(true);
  for (const p of [priya, sam, owner]) await p.ctx.close();
});

test("access removed while offline: the copy and its unsent changes go (5b)", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya");
  const fileId = await newCanvas(priya, "E2E zf · revoked");
  await keepOffline(priya, true);
  await goOffline(priya);
  await editor(priya).locator("p").last().click();
  await priya.page.keyboard.type("Secret plan");
  const admin = await person(browser, "u_sam");
  await setAccess(admin, fileId, "u_priya", "none", H);
  await priya.ctx.setOffline(false);
  const dlg = priya.oc.getByRole("dialog", { name: "You no longer have access to this canvas" });
  await expect(dlg).toBeVisible({ timeout: 40_000 });
  await expect(dlg).toContainText(/with \d+ changes you made offline that hadn’t been sent/);
  await expect(editor(priya)).toBeHidden();
  await expect.poll(async () => (await dbs(frame(priya))).filter((n) => n.endsWith("/" + fileId))).toEqual([]);
  await axe(priya, "5b revoked", ".modal");
  for (const p of [priya, admin]) await p.ctx.close();
});

test("view only while offline: changes held, download or discard (5a)", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya");
  const fileId = await newCanvas(priya, "E2E zf · view only");
  await keepOffline(priya, true);
  await goOffline(priya);
  await editor(priya).locator("p").last().click();
  await priya.page.keyboard.type("Held back");
  const admin = await person(browser, "u_sam");
  await setAccess(admin, fileId, "u_priya", "view", H);
  await priya.ctx.setOffline(false);
  const bar = priya.oc.locator(".off-banner");
  await expect(bar).toContainText("You can only view this canvas now.", { timeout: 40_000 });
  await expect(editor(priya)).not.toContainText("Held back");
  const dl = priya.page.waitForEvent("download");
  await bar.getByRole("button", { name: "Download my version" }).click();
  expect((await dl).suggestedFilename()).toMatch(/my offline version\)\.md$/);
  await axe(priya, "5a held", ".off-banner");
  await bar.getByRole("button", { name: "Discard" }).click();
  await expect(bar).toHaveCount(0);
  expect(storedDocumentHas(fileId, "Held back", H)).toBe(false);
  for (const p of [priya, admin]) await p.ctx.close();
});

test("the device limit, the list, and sign-out clears the device (2c, 2e, 7a)", async ({ browser }) => {
  test.setTimeout(150_000);
  const priya = await person(browser, "u_priya");
  for (let i = 0; i < 3; i++) {
    await newCanvas(priya, `E2E zf · kept ${i}`);
    await keepOffline(priya, i === 0);
  }
  await newCanvas(priya, "E2E zf · one too many");
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await priya.oc.getByRole("menuitemcheckbox", { name: /Available offline on this device/ }).click();
  const room = priya.oc.getByRole("dialog", { name: "Not enough room on this device" });
  await expect(room).toBeVisible();
  await axe(priya, "2e room", ".modal");
  await room.getByRole("button", { name: "Manage offline canvases" }).click();
  const list = priya.oc.getByRole("dialog", { name: "Offline on this device" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list).toContainText("3 of 3 canvases");
  await axe(priya, "2c list", ".modal");
  await list.getByRole("button", { name: "Close" }).click();

  // Sign out: the host's page loads the clear iframe; nothing of Priya's stays.
  await priya.page.goto(`${H}/signout?as=u_priya`);
  await expect(priya.page.locator("body")).toHaveAttribute("data-cleared", "3", { timeout: 15_000 });
  const clear = priya.page.frames().find((f) => f.url().includes("/v1/offline/clear"))!;
  expect((await dbs(clear)).filter((n) => n.includes("/u_priya/"))).toEqual([]);
  await priya.ctx.close();
});
