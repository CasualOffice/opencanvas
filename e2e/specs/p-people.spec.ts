// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// p. Users and identity (docs/21 revision 2, ADR-026), one test per acceptance bullet: the
//    mention list is exactly the canvas's members, everyone sees real names, two people called
//    Asha Rao are told apart everywhere, no e-mail anywhere, removing access marks mentions
//    "No longer has access", and with no members source the list is who opened the canvas.
import { expect, test, type FrameLocator, type Locator } from "@playwright/test";
import { applyTemplate, createFile, editor, openFile, person, setAccess, setMemberSource, typeAfterHeading, type Person } from "../helpers";

const picker = (p: Person) => p.oc.locator(".pop").filter({ hasText: "People" });

/** Everything the OpenCanvas frame renders: text, attributes (titles, labels) and all. */
async function frameHtml(p: Person): Promise<string> {
  const frame = p.page.frame({ name: "oc" });
  if (!frame) throw new Error("no OpenCanvas frame");
  return frame.content();
}

/** A `/v1/…` GET from inside the OpenCanvas frame with its session ticket. */
async function fromFrame(p: Person, path: string): Promise<string> {
  const frame = p.page.frame({ name: "oc" });
  if (!frame) throw new Error("no OpenCanvas frame");
  const t = new URLSearchParams(new URL(frame.url()).hash.slice(1)).get("t") ?? "";
  return frame.evaluate(async ([path, t]) => (await fetch(`${path}${path.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(t)}`)).text(), [path, t] as const);
}

async function caretIn(p: Person, heading: string) {
  await editor(p).locator("h1, h2, h3").filter({ hasText: heading }).first().click();
  await p.page.keyboard.press("End");
}

const label = (oc: FrameLocator | Locator, text: string | RegExp) => oc.locator(".collaboration-carets__label", { hasText: text });

test("the mention list is exactly the members: a member who never opened it is there, a non-member never is", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · members");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_ravi", "edit");
  // Sam has no access to this file.
  await openFile(priya, fileId);
  await typeAfterHeading(priya, "Notes", "Ask @");
  // The member list is fetched from the host when the picker opens; a slow CI runner took over 5 s.
  await expect(picker(priya).getByRole("option", { name: /Ravi Menon/ })).toBeVisible({ timeout: 15_000 });
  await expect(picker(priya).getByRole("option", { name: /Sam/ })).toHaveCount(0);
  await priya.page.keyboard.type("Sam");
  await expect(picker(priya).getByRole("option", { name: /Sam/ })).toHaveCount(0);
  await priya.page.keyboard.press("Escape");
  const members = await fromFrame(priya, "/v1/members");
  expect(members).toContain("u_ravi");
  expect(members).not.toContain("u_sam");
  await priya.ctx.close();
});

test("everyone with access sees real names, never Someone or Unknown", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · real names");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_sam", "edit");
  await setAccess(priya, fileId, "u_ravi", "edit");
  await openFile(priya, fileId);
  const sam = await person(browser, "u_sam");
  await openFile(sam, fileId);
  await caretIn(priya, "Agenda");
  await expect(label(editor(sam), "Priya Shah")).toBeVisible();
  await expect(sam.oc.locator('.avs .av[title^="Priya Shah"]')).toBeVisible();
  await typeAfterHeading(sam, "Notes", "@Ravi");
  await expect(picker(sam).getByRole("option", { name: /Ravi Menon/ })).toBeVisible();
  await sam.page.keyboard.press("Enter");
  await expect(editor(priya).locator('.mention[data-id="u_ravi"]')).toHaveText(/Ravi Menon$/);
  const html = await frameHtml(sam);
  expect(html).not.toContain("Someone");
  expect(html).not.toContain("Unknown");
  for (const p of [priya, sam]) await p.ctx.close();
});

test("two people called Asha Rao are distinguishable in the picker, avatars, cursors and hover cards", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · duplicates");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_asha", "edit");
  await setAccess(priya, fileId, "u_asha2", "edit");
  const asha = await person(browser, "u_asha");
  const asha2 = await person(browser, "u_asha2");
  await openFile(asha, fileId);
  await openFile(asha2, fileId);

  // Avatars: the tooltip carries the second line, initials get a subscript.
  const design = priya.oc.locator('.avs .av[title^="Asha Rao · Design · Bengaluru"]');
  const finance = priya.oc.locator('.avs .av[title^="Asha Rao · Finance · Pune"]');
  await expect(design).toBeVisible();
  await expect(finance).toBeVisible();
  const ini = [await design.innerText(), await finance.innerText()].sort();
  expect(ini).toEqual(["AR", "AR₂"]);

  // Cursor labels.
  await caretIn(asha, "Agenda");
  await caretIn(asha2, "Notes");
  await expect(label(editor(priya), "Asha Rao · Design · Bengaluru")).toBeVisible();
  await expect(label(editor(priya), "Asha Rao · Finance · Pune")).toBeVisible();

  // Picker: both rows, next to each other, each with its own second line.
  await typeAfterHeading(priya, "Decisions", "Over to @asha");
  const opts = picker(priya).getByRole("option");
  await expect(opts.filter({ hasText: "Asha Rao" })).toHaveCount(2);
  const texts = await opts.allInnerTexts();
  const rows = texts.map((t, i) => [t, i] as const).filter(([t]) => t.includes("Asha Rao"));
  expect(rows[1][1] - rows[0][1]).toBe(1);
  expect(rows.map(([t]) => t).join("|")).toMatch(/Design · Bengaluru[\s\S]*\|[\s\S]*Finance · Pune/);
  await opts.filter({ hasText: "Finance · Pune" }).click();
  const chip = editor(priya).locator('.mention[data-id="u_asha2"]');
  await expect(chip).toHaveText(/Asha Rao/);

  // Hover card on the chip: name and second line.
  await chip.hover();
  const card = priya.oc.getByRole("tooltip");
  await expect(card).toContainText("Asha Rao");
  await expect(card).toContainText("Finance · Pune");
  await priya.page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  for (const p of [priya, asha, asha2]) await p.ctx.close();
});

test("no e-mail appears in the DOM, exports, the session or the .ocanvas", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · no email");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_ravi", "edit");
  const ravi = await person(browser, "u_ravi");
  await openFile(ravi, fileId);
  await openFile(priya, fileId);
  await caretIn(ravi, "Agenda");
  await typeAfterHeading(priya, "Notes", "Owner @Ravi");
  await expect(picker(priya).getByRole("option", { name: /Ravi Menon/ })).toBeVisible();
  await priya.page.keyboard.press("Enter");
  await expect(editor(priya).locator('.mention[data-id="u_ravi"]')).toHaveText(/Ravi Menon/);
  await editor(priya).locator('.mention[data-id="u_ravi"]').hover();
  await expect(priya.oc.getByRole("tooltip")).toContainText("Engineering · Kochi");
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/;
  expect(await frameHtml(priya)).not.toMatch(email);
  for (const path of ["/v1/members", "/v1/export/md", "/v1/export/html", "/v1/export/json"]) {
    expect(await fromFrame(priya, path), path).not.toMatch(email);
  }
  await expect(priya.oc.locator(".top .status")).toHaveAttribute("aria-label", /^Saved/, { timeout: 10_000 });
  // The .ocanvas is a zip; its document.json is deflated, so check the server's JSON of it.
  expect(await fromFrame(priya, "/v1/export/json")).toContain("u_ravi");
  const ocanvas = await fromFrame(priya, "/v1/export/ocanvas");
  expect(ocanvas).not.toMatch(email);
  for (const p of [priya, ravi]) await p.ctx.close();
});

test("removing someone's access marks their existing mentions 'No longer has access' after reload", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · access removed");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_ravi", "edit");
  await openFile(priya, fileId);
  await typeAfterHeading(priya, "Notes", "Owner @Ravi");
  await expect(picker(priya).getByRole("option", { name: /Ravi Menon/ })).toBeVisible();
  await priya.page.keyboard.press("Enter");
  const chip = editor(priya).locator('.mention[data-id="u_ravi"]');
  await expect(chip).toHaveText(/Ravi Menon$/);
  await expect(priya.oc.locator(".top .status")).toHaveAttribute("aria-label", /^Saved/, { timeout: 10_000 });
  await setAccess(priya, fileId, "u_ravi", "none");
  await openFile(priya, fileId);
  await expect(chip).toHaveText(/Ravi Menon\s*No longer has access/);
  await expect(chip).toHaveClass(/former/);
  await typeAfterHeading(priya, "Agenda", "@Ravi");
  await expect(priya.oc.locator(".pop").getByRole("option", { name: /Ravi/ })).toHaveCount(0);
  await priya.ctx.close();
});

test("with no members source at all, the list is the people who have opened the canvas", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · no source");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_asha", "edit");
  await setAccess(priya, fileId, "u_ravi", "edit");
  await setMemberSource(fileId, "none");
  const asha = await person(browser, "u_asha");
  await openFile(asha, fileId);
  await openFile(priya, fileId);
  await expect(priya.oc.getByRole("button", { name: /Follow Asha Rao/ })).toBeVisible();
  await asha.ctx.close();
  await openFile(priya, fileId);
  const members = await fromFrame(priya, "/v1/members");
  expect(members).toContain("u_asha");
  expect(members).not.toContain("u_ravi");
  await typeAfterHeading(priya, "Notes", "Ask @");
  await expect(picker(priya).getByRole("option", { name: /Asha Rao/ })).toBeVisible();
  await expect(picker(priya).getByRole("option", { name: /Asha Rao/ })).toContainText("Design · Bengaluru");
  // Ravi has access but never opened it: without a host source OpenCanvas can't know him.
  await expect(picker(priya).getByRole("option", { name: /Ravi/ })).toHaveCount(0);
  await priya.ctx.close();
});

test("revoking Sam while Priya's canvas is open: he leaves her mention list at once, his socket closes, his chips say so after reload", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · revoke live");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_sam", "edit");
  await openFile(priya, fileId);
  const sam = await person(browser, "u_sam");
  await openFile(sam, fileId);
  await expect(priya.oc.getByRole("button", { name: /Follow Sam Ortiz/ })).toBeVisible();
  // Priya mentions Sam, and the members list is warm (cached) before the revoke.
  await typeAfterHeading(priya, "Notes", "Ask @Sam");
  await expect(picker(priya).getByRole("option", { name: /Sam Ortiz/ })).toBeVisible();
  await priya.page.keyboard.press("Enter");
  const chip = editor(priya).locator('.mention[data-id="u_sam"]');
  await expect(chip).toHaveText(/Sam Ortiz$/);
  await expect(priya.oc.locator(".top .status")).toHaveAttribute("aria-label", /^Saved/, { timeout: 10_000 });

  await setAccess(priya, fileId, "u_sam", "none");
  // Sam's socket is closed by the server (1008 access revoked).
  await expect(sam.oc.getByText("Your access to this canvas changed")).toBeVisible({ timeout: 10_000 });
  // Without a reload, Sam is gone from Priya's mention list.
  await typeAfterHeading(priya, "Agenda", "@Sam");
  await expect(priya.oc.locator(".pop").getByRole("option", { name: /Sam/ })).toHaveCount(0);
  await priya.page.keyboard.press("Escape");
  // After a reload, the existing chip keeps its label and says he no longer has access.
  await openFile(priya, fileId);
  await expect(chip).toHaveText(/Sam Ortiz\s*No longer has access/);
  for (const p of [priya, sam]) await p.ctx.close();
});
