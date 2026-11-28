// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// v. DGM-15, approved frames docs/prototypes/diagram-approved 7a-7e: draw.io and Excalidraw files
//    through the FC-10 import dialog. A dry-run report first (counts, then each item that won't
//    convert exactly), nothing added until Import; a refusal screen; the done state with
//    "Undo import". Real server: the converter lives in oc-model.
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect as baseExpect, test, type Page } from "@playwright/test";
import { ROOT } from "../env";
import { applyTemplate, createFile, editor, openFile, person, shots, type Person } from "../helpers";

// No timing assumptions (slow CI runners): every assertion polls for up to 20 s, each test has 2 min.
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 120_000 });

const FIX = path.join(ROOT, "crates/oc-model/tests/fixtures/import");
const file = (name: string, mimeType = "application/octet-stream") => ({ name, mimeType, buffer: fs.readFileSync(path.join(FIX, name)) });

async function axe(page: Page) {
  for (const theme of ["light", "dark"]) {
    const f = page.frame({ name: "oc" })!;
    await f.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await f.evaluate(() => Promise.all(document.getAnimations().filter((x) => x.playState === "running" && x.effect?.getComputedTiming().iterations !== Infinity).map((x) => x.finished.catch(() => undefined))));
    const r = await new AxeBuilder({ page }).include("iframe[name=oc]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const bad = r.violations.flatMap((v) => v.nodes.filter((n) => JSON.stringify(n.target).includes("imp")).map((n) => `${theme}: ${v.id} ${JSON.stringify(n.target)}`));
    expect(bad).toEqual([]);
  }
  await page.frame({ name: "oc" })!.evaluate(() => delete document.documentElement.dataset.theme);
}

async function openDialog(p: Person) {
  await p.oc.getByRole("button", { name: "More options" }).click();
  await p.oc.locator(".mi", { hasText: "Import…" }).click();
  const dlg = p.oc.getByRole("dialog", { name: "Import into this canvas" });
  await expect(dlg).toBeVisible();
  return dlg;
}

test("DGM-15: draw.io → dry-run report → import → board; Undo import removes it", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "Import drawio");
  await openFile(priya, fileId);
  await applyTemplate(priya, "Meeting notes");
  const dlg = await openDialog(priya);
  // 7a: the approved dialog lists the diagram formats, Excalidraw included.
  await expect(dlg).toContainText("Markdown, HTML, CSV, draw.io, Excalidraw, Excel (.xlsx) or OpenDocument (.ods), up to 5 MB");
  await expect(dlg).toContainText("draw.io and Excalidraw become a diagram board.");
  await expect(dlg).toContainText("scripts, links in diagram files and embedded entities are removed");
  await shots(priya.page, "dgm15-pick");
  await dlg.getByLabel("Choose a file to import").setInputFiles(file("architecture.drawio"));
  // 7b: counts, then each item that needs a look, most important first; nothing added yet.
  await expect(dlg).toContainText("architecture.drawio");
  await expect(dlg.locator(".imp-stat").nth(0)).toContainText("8shapes");
  await expect(dlg.locator(".imp-stat").nth(1)).toContainText("3connectors");
  const rows = dlg.getByRole("list", { name: "What changes on the way in" }).getByRole("listitem");
  await expect(rows.first()).toContainText("3 icons become plain boxes with their names");
  await expect(rows.first()).toContainText("Lambda: fraud-check");
  await expect(dlg).toContainText("1 linked image is not fetched");
  await expect(dlg).toContainText("1 link is not imported");
  await expect(dlg).toContainText("Nothing is added until you import.");
  await expect(editor(priya).locator(".ocbd")).toHaveCount(0);
  await shots(priya.page, "dgm15-report");
  await axe(priya.page);
  await dlg.getByRole("button", { name: "Import 8 shapes" }).click();
  // 7e: the done state.
  await expect(dlg.getByRole("status")).toContainText("Imported 8 shapes and 3 connectors");
  await expect(dlg.getByRole("status")).toContainText("4 became plain boxes.");
  await expect(dlg.getByRole("status")).toContainText("Undo import removes all of it in one step.");
  const board = editor(priya).locator(".ocbd");
  await expect(board).toHaveCount(1);
  await expect(board.locator("svg").first()).toContainText("fraud-check");
  await expect(board.locator("svg").first()).toContainText("orders-db");
  await shots(priya.page, "dgm15-done");
  await dlg.getByRole("button", { name: "Undo import" }).click();
  await expect(board).toHaveCount(0);
  await priya.ctx.close();
});

test("DGM-15: Excalidraw → report → board with labels, frame and image", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "Import excalidraw");
  await openFile(priya, fileId);
  await applyTemplate(priya, "Meeting notes");
  const dlg = await openDialog(priya);
  await dlg.getByLabel("Choose a file to import").setInputFiles(file("board.excalidraw", "application/json"));
  await expect(dlg).toContainText("board.excalidraw");
  await expect(dlg).toContainText("1 SVG image is left out");
  await expect(dlg).toContainText("The hand-drawn style is not kept");
  await expect(dlg).toContainText("Fonts become the board font");
  await dlg.getByRole("button", { name: /^Import \d+ shapes$/ }).click();
  await expect(dlg.getByRole("status")).toContainText(/Imported \d+ shapes and 1 connector/);
  const board = editor(priya).locator(".ocbd");
  await expect(board).toHaveCount(1);
  await expect(board.locator("svg").first()).toContainText("Plan sprint");
  await expect(board.locator("svg").first()).toContainText("then");
  await expect(board.locator("svg image")).toHaveCount(1);
  await priya.ctx.close();
});

test("DGM-15: multi-page draw.io picks a page; compressed pages decode", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "Import pages");
  await openFile(priya, fileId);
  await applyTemplate(priya, "Meeting notes");
  const dlg = await openDialog(priya);
  await dlg.getByLabel("Choose a file to import").setInputFiles(file("multipage.drawio"));
  await expect(dlg).toContainText("· 2 pages");
  await expect(dlg).toContainText("Page 2, “Sequence”, is not imported");
  await dlg.getByLabel("Page").selectOption("1");
  await expect(dlg).toContainText("Page 1, “Production”, is not imported");
  await expect(dlg.locator(".imp-stat").nth(1)).toContainText("1connector");
  await dlg.getByRole("button", { name: "Import 2 shapes" }).click();
  await expect(dlg.getByRole("status")).toContainText("Imported 2 shapes and 1 connector");
  await expect(editor(priya).locator(".ocbd svg").first()).toContainText("Sequence box");
  await dlg.getByRole("button", { name: "Import another" }).click();
  await dlg.getByLabel("Choose a file to import").setInputFiles(file("compressed.drawio"));
  await dlg.getByRole("button", { name: "Import 2 shapes" }).click();
  await expect(editor(priya).locator(".ocbd")).toHaveCount(2);
  await expect(editor(priya).locator(".ocbd", { hasText: "Compressed & fine" })).toHaveCount(1);
  await priya.ctx.close();
});

test("DGM-15: files that can't be imported get one reason and what to do", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "Import refused");
  await openFile(priya, fileId);
  await applyTemplate(priya, "Meeting notes");
  const dlg = await openDialog(priya);
  // 7d: too large, refused before upload.
  await dlg.getByLabel("Choose a file to import").setInputFiles({ name: "checkout-full.drawio", mimeType: "application/xml", buffer: Buffer.alloc(6 * 1024 * 1024, 32) });
  await expect(dlg.getByRole("alert")).toContainText("This file can’t be imported");
  await expect(dlg.getByRole("alert")).toContainText("checkout-full.drawio is 6.0 MB, and files can be up to 5 MB. In draw.io, export one page or remove large images, then try again.");
  await shots(priya.page, "dgm15-refused");
  await axe(priya.page);
  await dlg.getByRole("button", { name: "Choose another file" }).click();
  // Entities are refused by the server, with its reason.
  const laughs = `<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><mxfile><diagram name="x">&b;</diagram></mxfile>`;
  await dlg.getByLabel("Choose a file to import").setInputFiles({ name: "laughs.drawio", mimeType: "application/xml", buffer: Buffer.from(laughs) });
  await expect(dlg.getByRole("alert")).toContainText("It declares XML entities, which are never read.");
  await dlg.getByRole("button", { name: "Close" }).last().click();
  await expect(dlg).toHaveCount(0);
  await expect(editor(priya).locator(".ocbd")).toHaveCount(0);
  await priya.ctx.close();
});
