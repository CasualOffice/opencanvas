// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zf (2). Offline-first editing, OFF-08 (docs/34 §3.7): the expiry lock driven by an injected
// clock (Playwright `clock`, no waiting and no test-only grant), queued uploads end to end, and
// the unsent-changes pause, against the "sample-offline" host (prototype
// docs/prototypes/v03-approved/offline.html, frames 5c and 5d).
import { expect, test, type Frame } from "@playwright/test";
import { HOST_OFFLINE as H } from "../env";
import { applyTemplate, createFile, editor, openFile, person, setAccess, storedDocumentHas, type Person } from "../helpers";
import { storedDocument } from "../ocanvas";

const DAY = 86_400_000;
const pill = (p: Person) => p.oc.locator(".top .status");
const frame = (p: Person): Frame => p.page.frame({ name: "oc" })!;

async function newCanvas(p: Person, name: string) {
  const id = await createFile(p, name, H);
  await applyTemplate(p, "Meeting notes");
  await expect(pill(p)).toHaveAttribute("aria-label", /^Saved/, { timeout: 15_000 });
  return id;
}

async function keepOffline(p: Person) {
  await p.oc.getByRole("button", { name: "More options" }).click();
  await p.oc.getByRole("menuitemcheckbox", { name: /Available offline on this device/ }).click();
  await p.oc.getByRole("dialog", { name: /^Keep “.+” on this device\?$/ }).getByRole("button", { name: "Keep offline" }).click();
  await expect(p.oc.getByText(/available offline on this device/i).first()).toBeVisible();
}

async function goOffline(p: Person) {
  // The editor code must be cached before the network goes: the service worker installs in the
  // background, and on a slow CI runner the reload offline came before it (ERR_INTERNET_DISCONNECTED
  // for /app/, no locked copy). zf-offline checks the same before it goes offline.
  await expect.poll(() => frame(p).evaluate(async () => (await navigator.serviceWorker.ready).active?.state), { timeout: 20_000 }).toBe("activated");
  await p.ctx.setOffline(true);
  await expect(pill(p)).toHaveAttribute("aria-label", /^Offline/, { timeout: 25_000 });
}

/** Records in one of the device's stores for this file (they are sealed; only counted). */
const stored = (p: Person, fileId: string, store: string) =>
  frame(p).evaluate(
    async ({ fileId, store }) => {
      const name = (await indexedDB.databases()).map((d) => d.name ?? "").find((n) => n.endsWith("/" + fileId));
      if (!name) return -1;
      const db = await new Promise<IDBDatabase>((ok, ko) => Object.assign(indexedDB.open(name), { onsuccess: (e: Event) => ok((e.target as IDBOpenDBRequest).result), onerror: ko }));
      const n = await new Promise<number>((ok) => (db.transaction(store).objectStore(store).count().onsuccess = (e) => ok((e.target as IDBRequest<number>).result)));
      db.close();
      return n;
    },
    { fileId, store },
  );

/** Everything in the editor frame a script or a screen reader could read. */
const pageText = async (p: Person) => {
  const f = frame(p);
  return (await f.content()) + (await f.evaluate(() => document.body.innerText));
};

test("an expired copy opens locked to its title, then unlocks and merges on reconnect (5c)", async ({ browser }) => {
  test.setTimeout(150_000);
  const priya = await person(browser, "u_priya");
  const title = "E2E zf2 · expiry";
  const fileId = await newCanvas(priya, title);
  await keepOffline(priya);
  await goOffline(priya);
  await editor(priya).locator("p").last().click();
  await priya.page.keyboard.type("Cobalt runway plan");
  await expect(pill(priya)).toHaveAttribute("aria-label", /^Offline · \d+ changes on this device$/);
  // Every keystroke is on the device before the tab goes away.
  const typed = Number((await pill(priya).getAttribute("aria-label"))!.match(/(\d+) changes/)![1]);
  await expect.poll(() => stored(priya, fileId, "pending"), { timeout: 10_000 }).toBe(typed);

  // Eight days later (the grant lasts 7): the browser clock moves, nothing waits.
  await priya.page.clock.setSystemTime(new Date(Date.now() + 8 * DAY));
  await frame(priya).evaluate(() => location.reload());
  const locked = priya.oc.getByRole("region", { name: "Locked offline copy" });
  await expect(locked).toBeVisible({ timeout: 20_000 });
  await expect(locked.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(locked).toContainText("Locked until you’re back online");
  const banner = priya.oc.locator(".off-banner");
  await expect(banner).toContainText(/This offline copy expired on .+\. Connect to .+ to open it again\./);
  await expect(banner).toContainText(/Your \d+ changes? not sent yet (is|are) kept on this device\./);
  await expect(banner.getByRole("button", { name: "Try again" })).toBeVisible();
  // Title only: nothing of the canvas is in the page, not even hidden.
  const text = await pageText(priya);
  for (const s of ["Cobalt runway", "Attendees", "Action items"]) expect(text).not.toContain(s);
  await expect(priya.oc.locator(".ProseMirror")).toHaveCount(0);

  // Back to today and online: a fresh launch unlocks it and the offline edit is merged.
  await priya.page.clock.setSystemTime(new Date());
  await priya.ctx.setOffline(false);
  await expect(locked).toHaveCount(0, { timeout: 40_000 });
  await expect(editor(priya)).toContainText("Cobalt runway plan", { timeout: 20_000 });
  await expect.poll(() => storedDocumentHas(fileId, "Cobalt runway plan", H), { timeout: 30_000 }).toBe(true);
  await priya.ctx.close();
});

test("an expiry while the canvas is open offline locks it without leaving content in the page (5c)", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya");
  await newCanvas(priya, "E2E zf2 · expiry open");
  await editor(priya).locator("p").last().click();
  await priya.page.keyboard.type("Cobalt runway plan");
  await expect(pill(priya)).toHaveAttribute("aria-label", /^Saved/, { timeout: 15_000 });
  await keepOffline(priya);
  // The copy is past its grant when the connection goes.
  await priya.page.clock.setSystemTime(new Date(Date.now() + 8 * DAY));
  await goOffline(priya);
  await expect(priya.oc.getByRole("region", { name: "Locked offline copy" })).toBeVisible({ timeout: 20_000 });
  await expect(priya.oc.locator(".off-banner")).toContainText("This offline copy expired on");
  const text = await pageText(priya);
  for (const s of ["Cobalt runway", "Attendees", "Action items"]) expect(text).not.toContain(s);
  await priya.ctx.close();
});

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("an image added offline waits on the device, uploads first on reconnect, and the other person sees it", async ({ browser }) => {
  test.setTimeout(150_000);
  const priya = await person(browser, "u_priya");
  const fileId = await newCanvas(priya, "E2E zf2 · upload");
  const owner = await person(browser, "u_priya");
  await setAccess(owner, fileId, "u_sam", "edit", H);
  const sam = await person(browser, "u_sam");
  await openFile(sam, fileId, H);
  // Sam must never see the image before its bytes are on the host (uploads go first).
  await frame(sam).evaluate(() => {
    const seen: string[] = ((window as unknown as { __srcs: string[] }).__srcs = []);
    new MutationObserver(() => document.querySelectorAll(".ProseMirror img").forEach((i) => seen.push(i.getAttribute("src") ?? ""))).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  });

  await keepOffline(priya);
  await goOffline(priya);
  await editor(priya).locator("p").last().click();
  await frame(priya).evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "whiteboard.png", { type: "image/png" }));
    document.querySelector(".ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG);
  // Pending: this device shows its own copy, captioned as waiting (prototype 1b/4a figure).
  const fig = editor(priya).locator("figure").last();
  await expect(fig.locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 10_000 });
  await expect(fig).toContainText("Waiting to upload · 70 B · kept on this device");
  await pill(priya).click();
  await expect(priya.oc.locator(".off-pop")).toContainText(/Waiting to upload\s*1 file · /);
  await priya.page.keyboard.press("Escape");
  // The bytes wait in the device's upload queue (sealed), the host has nothing yet.
  const queued = await frame(priya).evaluate(async () => {
    const name = (await indexedDB.databases()).map((d) => d.name ?? "").find((n) => n.endsWith("/u_priya/uploads"));
    if (!name) return -1;
    const db = await new Promise<IDBDatabase>((ok, ko) => Object.assign(indexedDB.open(name), { onsuccess: (e: Event) => ok((e.target as IDBOpenDBRequest).result), onerror: ko }));
    return new Promise<number>((ok) => (db.transaction("files").objectStore("files").count().onsuccess = (e) => ok((e.target as IDBRequest<number>).result)));
  });
  expect(queued).toBe(1);
  expect(storedDocumentHas(fileId, "oc-pending:", H)).toBe(false);

  await priya.ctx.setOffline(false);
  await expect(priya.oc.getByText(/offline changes? (is|are) saved/)).toBeVisible({ timeout: 40_000 });
  // The block points to the real asset everywhere, and Sam sees the image.
  await expect(fig.locator("img")).not.toHaveAttribute("src", /^blob:|pending\.svg/, { timeout: 15_000 });
  await expect(fig).not.toContainText("Waiting to upload");
  const samImg = editor(sam).locator("figure img").last();
  await expect(samImg).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => samImg.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), { timeout: 15_000 }).toBe(1);
  const srcs = await frame(sam).evaluate(() => (window as unknown as { __srcs: string[] }).__srcs);
  expect(srcs.length).toBeGreaterThan(0);
  expect(srcs.filter((s) => /pending\.svg|oc-pending:|^blob:/.test(s))).toEqual([]);
  await expect.poll(() => storedDocument(fileId, H)?.includes("oc-pending:"), { timeout: 30_000 }).toBe(false);
  await expect.poll(() => /<img|"image"|image/.test(storedDocument(fileId, H) ?? ""), { timeout: 30_000 }).toBe(true);
  for (const p of [priya, sam, owner]) await p.ctx.close();
});

test("past 5 MB of unsent changes, editing pauses until the connection is back (5d)", async ({ browser }) => {
  test.setTimeout(180_000);
  const priya = await person(browser, "u_priya");
  await newCanvas(priya, "E2E zf2 · paused");
  await keepOffline(priya);
  await goOffline(priya);
  const ed = editor(priya);
  await ed.locator("p").last().click();
  // 14 pastes of 400 KB: 5.6 MB waiting, over the session's `unsentMb` (5).
  const chunk = "lorem ipsum ".repeat(34_000);
  const banner = priya.oc.locator(".off-banner");
  for (let i = 0; i < 14 && !(await banner.count()); i++) {
    await priya.page.keyboard.insertText(chunk);
    await priya.page.keyboard.press("Enter");
  }
  await expect(banner).toContainText("Editing is paused. 5 MB of changes are waiting on this device, the most one canvas can hold offline. Connect to send them and keep editing.");
  await expect(banner.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(ed).toHaveAttribute("contenteditable", "false");
  await priya.ctx.close();
});
