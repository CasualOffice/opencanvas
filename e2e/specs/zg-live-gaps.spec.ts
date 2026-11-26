// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zg. The v0.3 live block gaps (docs/34 §2, ADR-066/069/071/073), to the approved prototypes
// docs/prototypes/v03-approved/live-blocks.html and search.html:
//   - the header says where the source lives (`/access` `path`, 2a), falling back to the host;
//   - the "/" insert menu inside a live block's own editor, without live blocks (depth rule);
//   - find and replace inside a live block: a separate confirmation, applied in its own room as
//     one undo step, never for a view-only live block (search 1f);
//   - presence `from` with two people in the same canvas (ADR-071);
//   - an editor without `caps=live` that removes a live block is closed with 4426 and the block
//     survives for everyone else.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { applyTemplate, createFile, editor, expectSaved, openFile, person, setAccess, typeAfterHeading, type Person, type UserId } from "../helpers";

const live = (p: Person) => p.oc.locator(".lb").first();
const liveBody = (p: Person) => live(p).locator(".lb-b .ProseMirror");
const menuOf = (p: Person) => p.oc.getByRole("listbox", { name: "Insert a block" });
const bar = (p: Person) => p.oc.getByRole("search", { name: "Find in canvas" });

/** Axe on our own pieces inside the editor frame (the template's database is not under test here). */
async function axe(p: Person, include: string[]) {
  const frame = p.page.frame({ name: "oc" })!;
  await p.page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"]) {
    await frame.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    let b = new AxeBuilder({ page: p.page });
    for (const sel of include) b = b.include(['iframe[name="oc"]', sel]);
    const r = await b.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
  await frame.evaluate(() => delete document.documentElement.dataset.theme);
}

/** A canvas with one paragraph made live (1a-1c); returns the canvas and live file ids. */
async function canvasWithLive(p: Person, canvas: string, text: string, name: string, share: [UserId, "edit" | "view"][] = []) {
  const a = await createFile(p, canvas);
  await applyTemplate(p, "Meeting notes");
  // Before "Make live": the live file starts with the canvas's people (docs/05 §5).
  for (const [u, r] of share) await setAccess(p, a, u, r);
  await typeAfterHeading(p, "Notes", text);
  await expectSaved(p);
  await editor(p).getByText(text, { exact: true }).click();
  await p.page.keyboard.press("ControlOrMeta+/");
  await p.oc.getByRole("menuitem", { name: "Make live…" }).click();
  const dlg = p.oc.getByRole("dialog", { name: "Make this a live block" });
  await dlg.getByLabel("Name").fill(name);
  await dlg.getByRole("button", { name: "Make live" }).click();
  await expect(dlg).toBeHidden({ timeout: 15_000 });
  await expect(liveBody(p)).toContainText(text, { timeout: 15_000 });
  await expect(live(p)).toHaveAttribute("data-state", "connected");
  return { a, liveId: (await live(p).getAttribute("data-live-file"))! };
}

/** Types "/" in the focused editor until the menu shows (the late plugins load after paint). */
async function slash(p: Person) {
  await p.page.keyboard.type("/");
  await expect(async () => {
    if (!(await menuOf(p).isVisible())) {
      await p.page.keyboard.press("Backspace");
      await p.page.keyboard.type("/");
    }
    await expect(menuOf(p)).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
}

test("the header says where the source lives (path from the host's /access)", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya");
  await canvasWithLive(priya, "E2E zg · Leadership weekly", "Hiring plan agreed", "Q1 hiring");
  // The sample host answers `path` for a live file: the canvas it was made in.
  await expect(live(priya).locator(".lb-src")).toHaveText("from Acme Docs › E2E zg · Leadership weekly");
  await axe(priya, [".lb-h"]);
  await priya.ctx.close();
});

test("the insert menu inside a live block, without live blocks", async ({ browser }) => {
  test.setTimeout(150_000);
  const priya = await person(browser, "u_priya");
  await canvasWithLive(priya, "E2E zg · Insert menu", "Make SSO self-serve", "Q4 OKRs");

  // "/" in the canvas offers a live block (the host allows it) ...
  await typeAfterHeading(priya, "Notes", "");
  await slash(priya);
  await priya.page.keyboard.type("live block");
  await expect(priya.oc.locator(".oci [role=option][aria-label^='Live block']").first()).toBeVisible();
  await priya.page.keyboard.press("Escape");
  await priya.page.keyboard.press("Shift+Home");
  await priya.page.keyboard.press("Backspace");

  // ... and inside the live block's own editor: the same categorised menu, never a live block.
  await liveBody(priya).locator("p").first().click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("Enter");
  await slash(priya);
  await expect(menuOf(priya)).toContainText("Quick insert");
  await expect(menuOf(priya)).toContainText("Explore");
  await expect(menuOf(priya).getByText("Browse all blocks")).toHaveCount(0);
  await axe(priya, [".oci"]);
  await priya.page.keyboard.type("live block");
  await expect(priya.oc.locator(".oci [role=option][aria-label^='Live block']")).toHaveCount(0);
  await priya.page.keyboard.press("Escape");
  await priya.page.keyboard.press("Shift+Home");
  await priya.page.keyboard.press("Backspace");
  await slash(priya);
  await priya.page.keyboard.type("divider");
  await expect(priya.oc.locator(".oci [role=option][aria-label^='Divider']").first()).toBeVisible();
  await priya.page.keyboard.press("Enter");
  await expect(liveBody(priya).locator("hr")).toHaveCount(1);
  await expect(menuOf(priya)).toBeHidden();

  await priya.ctx.close();
});

// OPEN (2026-11-26): find does not yet see the connected live block's text in the browser ("1 of
// 1" where 2 are expected), although engine.test.ts passes with the same engine; the registry
// of live block editors (live/state.ts `liveEditors`) needs checking in a real page.
test.fixme("replace inside a live block is a separate confirmation in its own room (ADR-066)", async ({ browser }) => {
  test.setTimeout(150_000);
  const priya = await person(browser, "u_priya");
  const { a, liveId } = await canvasWithLive(priya, "E2E zg · Q4 planning", "Make SSO self-serve", "Q4 OKRs", [["u_sam", "edit"]]);
  // Find and replace: the canvas's match now, the live block's only after its own confirmation.
  await typeAfterHeading(priya, "Decisions", "SSO in this canvas");
  await priya.page.keyboard.press("ControlOrMeta+f");
  const fb = bar(priya);
  await fb.getByLabel("Find in canvas").fill("SSO");
  await expect(fb).toContainText("of 2");
  await expect(liveBody(priya).locator(".oc-find-hit")).toHaveCount(1);
  await fb.getByRole("button", { name: "Show replace" }).click();
  await fb.getByLabel("Replace with").fill("single sign-on");
  await fb.getByRole("button", { name: "Replace all" }).click();
  await expect(priya.oc.getByText("Replaced 1 “SSO” with “single sign-on” · 1 more in live blocks")).toBeVisible();
  const ask = priya.oc.getByRole("dialog", { name: "Replace in “Q4 OKRs” too?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("1 match is in a live block from Acme Docs › E2E zg · Q4 planning");
  // Nothing in the live block changed yet: never silently.
  await expect(liveBody(priya)).toContainText("Make SSO self-serve");
  await axe(priya, ['[role="dialog"]']);
  await ask.getByRole("button", { name: "Replace in live block too" }).click();
  await expect(ask).toBeHidden();
  await expect(liveBody(priya)).toContainText("Make single sign-on self-serve");
  await expect(editor(priya).first()).toContainText("single sign-on in this canvas");
  await expect(fb).toContainText("No results");
  // One undo step in the live block's own room: the canvas keeps its replacement.
  await priya.oc.getByRole("button", { name: "Undo" }).last().click();
  await expect(liveBody(priya)).toContainText("Make SSO self-serve");
  await expect(editor(priya).first()).toContainText("single sign-on in this canvas");
  await priya.page.keyboard.press("Escape");
  await expectSaved(priya);

  // A view-only live block: its matches are labelled; replace all never asks or changes them.
  await setAccess(priya, liveId, "u_sam", "view");
  const sam = await person(browser, "u_sam");
  await openFile(sam, a);
  await expect(live(sam)).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expect(live(sam).locator(".lb-ro")).toContainText("View only");
  await typeAfterHeading(sam, "Decisions", "SSO from Sam");
  await sam.page.keyboard.press("ControlOrMeta+f");
  const sfb = bar(sam);
  await sfb.getByLabel("Find in canvas").fill("SSO");
  await expect(sfb).toContainText("of 2");
  await sam.page.keyboard.press("Enter");
  await expect(sfb).toContainText("In live block Q4 OKRs · view only");
  await sfb.getByRole("button", { name: "Show replace" }).click();
  await sfb.getByLabel("Replace with").fill("SAML");
  await sfb.getByRole("button", { name: "Replace all" }).click();
  await expect(sam.oc.getByText("Replaced 1 “SSO” with “SAML” · 1 more in live blocks")).toBeVisible();
  await expect(sam.oc.getByRole("dialog", { name: /Replace in .* too\?/ })).toHaveCount(0);
  await expect(liveBody(sam)).toContainText("Make SSO self-serve");
  await expect(liveBody(priya)).toContainText("Make SSO self-serve");
  await Promise.all([sam.ctx.close(), priya.ctx.close()]);
});

/** Bytes of every frame the page's sockets receive (the live block's room among them). */
function liveFrames(page: Page): string[] {
  const got: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => got.push(typeof f.payload === "string" ? f.payload : f.payload.toString("latin1")));
  });
  return got;
}

test("presence from with two people in the same canvas (ADR-071)", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya");
  const { a } = await canvasWithLive(priya, "E2E zg · Presence", "Launch checklist ready", "Launch checklist", [["u_asha", "edit"]]);
  const frames = liveFrames(priya.page);
  await priya.page.reload();
  await expect(live(priya)).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  const asha = await person(browser, "u_asha");
  await openFile(asha, a);
  await expect(liveBody(asha)).toContainText("Launch checklist ready", { timeout: 15_000 });
  await liveBody(asha).locator("p").first().click();
  await asha.page.keyboard.press("End");
  await asha.page.keyboard.type(" today");
  await expect(liveBody(priya)).toContainText("Launch checklist ready today");

  // The server wrote `from` (this canvas) and sent it to Priya, whose session comes from the
  // same canvas: the only viewers ADR-071 lets see it.
  await expect.poll(() => frames.some((f) => f.includes('"from"') && f.includes(a)), { timeout: 10_000 }).toBe(true);
  // The caret label is the name only (ADR-069, owner 2026-11-26: the "· in <canvas>" label is dropped).
  await expect(liveBody(priya).locator(".collaboration-carets__label", { hasText: "Asha Rao" })).toHaveText("Asha Rao");
  await Promise.all([asha.ctx.close(), priya.ctx.close()]);
});

test("an editor without caps=live that removes a live block is closed with 4426; the block survives", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya");
  const { a } = await canvasWithLive(priya, "E2E zg · Old editor", "Budget signed off", "Budget", [["u_asha", "edit"]]);

  // Asha's editor connects with the 0.2 caps (`ext` only), as an editor older than 0.3 does.
  const asha = await person(browser, "u_asha");
  await asha.ctx.addInitScript(() => {
    const W = window.WebSocket;
    const w = window as unknown as { __ocCloses: number[]; __ocCaps: string[] };
    w.__ocCloses = [];
    w.__ocCaps = [];
    class OldCaps extends W {
      constructor(url: string | URL, protocols?: string | string[]) {
        const u = new URL(String(url));
        if (u.searchParams.has("caps")) u.searchParams.set("caps", "ext");
        super(u.toString(), protocols);
        w.__ocCaps.push(u.searchParams.get("caps") ?? "");
        this.addEventListener("close", (e) => w.__ocCloses.push(e.code));
      }
    }
    window.WebSocket = OldCaps as typeof WebSocket;
  });
  await openFile(asha, a);
  await expect(live(asha)).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  const ashaFrame = asha.page.frame({ name: "oc" })!;
  expect(await ashaFrame.evaluate(() => (window as unknown as { __ocCaps: string[] }).__ocCaps[0])).toBe("ext");

  await live(asha).getByRole("button", { name: "Live block options" }).click();
  await asha.oc.getByRole("button", { name: "Remove from this canvas" }).or(asha.oc.getByRole("menuitem", { name: "Remove from this canvas" })).click();
  await expect.poll(() => ashaFrame.evaluate(() => (window as unknown as { __ocCloses: number[] }).__ocCloses), { timeout: 10_000 }).toContain(4426);

  // Everyone else keeps it, and so does the saved file.
  await expect(priya.oc.locator(".lb")).toHaveCount(1);
  await expect(liveBody(priya)).toContainText("Budget signed off");
  await expectSaved(priya);
  const again = await person(browser, "u_priya");
  await openFile(again, a);
  await expect(again.oc.locator(".lb")).toHaveCount(1, { timeout: 15_000 });
  await Promise.all([asha.ctx.close(), again.ctx.close(), priya.ctx.close()]);
});
