// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import fs from "node:fs";
import path from "node:path";
import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type FrameLocator, type Page } from "@playwright/test";
import { HOST, HOST_LINKS, HOST_OFFLINE, HOST_PSYNC, HOST_RELOAD } from "./env";
import { storedDocument } from "./ocanvas";

export type UserId = "u_priya" | "u_asha" | "u_asha2" | "u_ravi" | "u_sam";
export const NAMES: Record<UserId, string> = { u_priya: "Priya Shah", u_asha: "Asha Rao", u_asha2: "Asha Rao", u_ravi: "Ravi Menon", u_sam: "Sam Ortiz" };

/** docs/21 revision 2: where the sample host's member list for a file comes from (token,
 *  members callback, both, or none). Takes effect on the next open. */
export async function setMemberSource(fileId: string, source: "both" | "token" | "callback" | "none", host = HOST) {
  const r = await fetch(`${host}/__test/files/${fileId}/members`, { method: "POST", body: JSON.stringify({ source }) });
  expect(r.ok).toBe(true);
}

/** Renames someone in the sample host, as the host's own admin would. */
export async function updateHostUser(id: UserId, change: { name?: string }, host = HOST) {
  const r = await fetch(`${host}/__test/users/${id}`, { method: "POST", body: JSON.stringify(change) });
  expect(r.ok).toBe(true);
}

export interface HostFile {
  id: string;
  name: string;
  version: number;
  acl: Record<string, string>;
}

/** The sample host's metadata (written to its data dir on every change). */
export function hostFiles(host = HOST): Record<string, HostFile> {
  const tmp = process.env.E2E_TMP;
  if (!tmp) throw new Error("E2E_TMP is not set: run through playwright (global setup)");
  const dir = host === HOST_RELOAD ? "host-reload" : host === HOST_OFFLINE ? "host-offline" : host === HOST_PSYNC ? "host-psync" : host === HOST_LINKS ? "host-links" : "host";
  return JSON.parse(fs.readFileSync(path.join(tmp, dir, "meta.json"), "utf8")).files;
}
export const hostVersion = (fileId: string, host = HOST) => hostFiles(host)[fileId]?.version ?? -1;

/** A separate browser context per person, like two people on two machines. */
export async function personContext(browser: Browser, opts: BrowserContextOptions = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext(opts);
  // The host page links Google Fonts; keep the suite offline-safe and fast.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  return ctx;
}

export interface Person {
  ctx: BrowserContext;
  page: Page;
  user: UserId;
  /** The OpenCanvas editor inside the host's iframe. */
  oc: FrameLocator;
}

export async function person(browser: Browser, user: UserId, opts: BrowserContextOptions = {}): Promise<Person> {
  const ctx = await personContext(browser, opts);
  const page = await ctx.newPage();
  return { ctx, page, user, oc: page.frameLocator('iframe[name="oc"]') };
}

/** "New canvas" on the host's files page; returns the new file id (the creator gets edit). */
export async function createFile(p: Person, name: string, host = HOST): Promise<string> {
  await p.page.goto(`${host}/?as=${p.user}`);
  await p.page.getByPlaceholder("New canvas name").fill(name);
  await p.page.getByRole("button", { name: "New canvas" }).click();
  await p.page.waitForURL(/\/files\/doc_[0-9a-f]+$/);
  return p.page.url().split("/").pop()!;
}

/**
 * The owner changes someone's role on the host's files page ("Save access" → role API).
 * Runs in a second tab of the owner's context, so the owner's editor stays open.
 */
export async function setAccess(owner: Person, fileId: string, user: UserId, role: "edit" | "comment" | "view" | "none", host = HOST) {
  const page = await owner.ctx.newPage();
  // The sample host's admin table is not under test and is not laid out for phones: on a
  // 360 px viewport its cells can cover the "Save access" button. Use a desktop width here.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${host}/?as=${owner.user}`);
  const row = page.locator("tr").filter({ has: page.locator(`a[href="/files/${fileId}"]`) });
  await row.locator(`select[name="${user}"]`).selectOption(role);
  await Promise.all([page.waitForURL(`${host}/`), row.getByRole("button", { name: "Save access" }).click()]);
  await page.close();
  expect(hostFiles(host)[fileId]?.acl[user] ?? "none").toBe(role);
}

const EDITOR_READY_TIMEOUT = 15_000;

/** Opens the file in the host page and waits until the editor is connected and rendered. */
export async function openFile(p: Person, fileId: string, host = HOST) {
  await p.page.goto(`${host}/files/${fileId}?as=${p.user}`);
  await expect(p.oc.locator(".ProseMirror, .tgrid").first()).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
  // A reopened canvas gives its blocks their ids in a second render (VH-00); text typed before
  // that lands in replaced nodes, and an "@" typed there never keeps its picker (p-people on CI).
  if (await p.oc.locator(".ProseMirror").first().isVisible()) await blocksReady(p.oc);
}

export const editor = (p: Person) => p.oc.locator(".ProseMirror");

/** Creator path: the template gallery opens for a new file; pick a template by name. */
export async function applyTemplate(p: Person, name: string) {
  await expect(p.oc.locator(".tgrid")).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
  await p.oc.getByLabel("Search templates").fill(name);
  await p.oc.locator(".tcard").filter({ hasText: name }).first().click();
  await p.oc.getByRole("button", { name: "Use template" }).click();
  await expect(editor(p)).toBeVisible();
  // The template's blocks get their ids in a second render (VH-00); typing before that lands in
  // nodes that are replaced and is lost (zc-editor-profile, ze-live-blocks.phone flaked on it).
  await blocksReady(p.oc);
}

/** Puts the caret at the end of the block that contains `text` (or the empty paragraph after a heading). */
export async function clickEndOf(p: Person, text: string) {
  const el = editor(p).locator("p, h1, h2, h3, li").filter({ hasText: text }).first();
  await el.click();
  await p.page.keyboard.press("End");
}

/** Saved, per the editor's status button. */
export async function expectSaved(p: Person) {
  await expect(p.oc.locator(".top .status")).toHaveAttribute("aria-label", /^Saved/, { timeout: 10_000 });
}

/**
 * Priya creates a file on the host, starts it from a template, gives Sam `samRole`,
 * and Sam opens it in his own browser context.
 */
export async function sharedFile(
  browser: Browser,
  o: { name: string; samRole: "edit" | "comment" | "view"; template?: string; host?: string; ctx?: BrowserContextOptions },
) {
  const host = o.host ?? HOST;
  const priya = await person(browser, "u_priya", o.ctx);
  const fileId = await createFile(priya, o.name, host);
  await applyTemplate(priya, o.template ?? "Meeting notes");
  await setAccess(priya, fileId, "u_sam", o.samRole, host);
  const sam = await person(browser, "u_sam", o.ctx);
  await openFile(sam, fileId, host);
  await expect(editor(sam)).toBeVisible();
  return { priya, sam, fileId };
}

/** Types at the start of a new paragraph right after the heading `heading`. */
export async function typeAfterHeading(p: Person, heading: string, text: string) {
  await editor(p).locator("h1, h2, h3").filter({ hasText: heading }).first().click();
  await p.page.keyboard.press("End");
  await p.page.keyboard.press("Enter");
  await p.page.keyboard.type(text);
}

export const storedDocumentHas = (fileId: string, text: string, host = HOST) => storedDocument(fileId, host)?.includes(text) ?? false;

/** 1×1 PNG, for paste tests. */
export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Review screenshots in light and dark: `<OC_SHOTS or target/fix-shots>/<name>-light.png` and
 *  `-dark.png`. The theme is forced on the editor's document (the iframe, when there is one). */
export async function shots(page: Page, name: string, opts: { frame?: string } = {}) {
  const dir = process.env.OC_SHOTS || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "target", "fix-shots");
  fs.mkdirSync(dir, { recursive: true });
  const f = opts.frame ? page.frame({ name: opts.frame })! : page.mainFrame();
  for (const theme of ["light", "dark"]) {
    await f.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(150);
    const file = path.join(dir, `${name}-${theme}.png`);
    if (opts.frame) await page.locator(`iframe[name="${opts.frame}"]`).screenshot({ path: file });
    else await page.screenshot({ path: file });
  }
  await f.evaluate(() => delete document.documentElement.dataset.theme);
}

/**
 * VH-00: right after a document loads, the editor stamps an id on every top-level block that
 * lacks one, which re-renders those blocks once. Wait for that before grabbing a block, or the
 * element can be detached under the test (seen on CI: "Element is not attached to the DOM").
 */
export async function blocksReady(page: Page | FrameLocator) {
  const pm = page.locator(".ProseMirror").first();
  await pm.waitFor();
  await expect
    .poll(
      () => pm.evaluate((el) => [...el.querySelectorAll(":scope > p, :scope > h1, :scope > h2, :scope > h3")].every((c) => (c as HTMLElement).dataset.blockId)),
      { timeout: 20_000 },
    )
    .toBe(true);
}
