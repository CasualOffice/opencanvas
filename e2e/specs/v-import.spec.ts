// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// v. docs/23 FC-10, prototype docs/prototypes/fixes-approved/Import.dc.html: "Import…" from the
//    slash menu and the "…" menu; a drop zone; a CSV preview with detected, changeable column
//    types and where to insert; a done state. Hidden when the host's `import_formats` is off
//    (the "reload" host here). `#demo` parses in the browser; real sessions POST /v1/import.
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { HOST_RELOAD, OC, ROOT } from "../env";
import { applyTemplate, createFile, editor, openFile, person, shots, blocksReady } from "../helpers";

const CSV = "Task,Owner,Due,Done\nFinish embed SDK docs,Ravi,2026-12-04,false\nReview mention list,Priya,2026-12-06,true\nFix PDF zoom on iPhone,Sam,,false\n";
const csvFile = { name: "tasks-export.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) };
const mdFile = { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Imported heading\n\nImported paragraph text.\n\n- one\n- two\n") };

async function axe(page: Page, frame?: string) {
  const f = frame ? page.frame({ name: frame })! : page.mainFrame();
  for (const theme of ["light", "dark"]) {
    await f.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    // Let the dialog's entrance animation finish: axe reads colours mid-fade otherwise.
    await f.evaluate(() => Promise.all(document.getAnimations().filter((x) => x.playState === "running" && x.effect?.getComputedTiming().iterations !== Infinity).map((x) => x.finished.catch(() => undefined))));
    const r = await new AxeBuilder({ page }).include(frame ? `iframe[name=${frame}]` : ".imp").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const bad = r.violations.flatMap((v) => v.nodes.filter((n) => !frame || JSON.stringify(n.target).includes("imp")).map((n) => `${theme}: ${v.id} ${JSON.stringify(n.target)}`));
    expect(bad).toEqual([]);
  }
  await f.evaluate(() => delete document.documentElement.dataset.theme);
}

export async function slashImport(page: Page | FrameLocator, keyboard: Page["keyboard"]) {
  await blocksReady(page);
  const last = page.locator(".ProseMirror > p").last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await keyboard.type("/import");
  const opt = page.getByRole("listbox", { name: "Insert" }).getByRole("option", { name: /Import…/ });
  await expect(opt).toBeVisible();
  await opt.click();
}

test("FC-10 demo: /import → CSV preview with changeable types → done; axe light and dark", async ({ page }) => {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await expect(page.locator(".ProseMirror p").first()).toBeVisible();
  await slashImport(page, page.keyboard);
  const dlg = page.getByRole("dialog", { name: "Import into this canvas" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("Demo: parsed in this browser, no import server");
  await expect(dlg.getByRole("button", { name: /Drop a file here, or choose one/ })).toBeVisible();
  // Prototype: a 640 px dialog, its content filling it (no empty strip beside it).
  await expect.poll(async () => Math.round((await dlg.boundingBox())!.width)).toBe(640);
  expect(Math.round((await dlg.locator(".imp").boundingBox())!.width)).toBe(640);
  await shots(page, "4-import-pick");
  await axe(page);
  await dlg.getByLabel("Choose a file to import").setInputFiles(csvFile);
  await expect(dlg).toContainText("tasks-export.csv");
  await expect(dlg).toContainText("· 3 rows · 4 columns");
  await expect(dlg.getByLabel("Type of Due")).toHaveValue("date");
  await expect(dlg.getByLabel("Type of Done")).toHaveValue("checkbox");
  await expect(dlg.getByLabel("Where to insert")).toBeVisible();
  await page.screenshot({ path: path.join(ROOT, "target/fix-shots/import-csv-preview.png") });
  await shots(page, "4-import-csv");
  await axe(page);
  await dlg.getByLabel("Type of Due").selectOption("text");
  await dlg.getByRole("button", { name: "Import 3 rows" }).click();
  await expect(dlg.getByRole("status")).toContainText("Imported a database with 3 rows");
  await expect(dlg).toContainText("like any edit.");
  await page.screenshot({ path: path.join(ROOT, "target/fix-shots/import-done.png") });
  await shots(page, "4-import-done");
  await axe(page);
  await dlg.getByRole("button", { name: "Close" }).click();
  // Inserted at the end (the caret's paragraph held only "/import"): scroll there as a reader would.
  const db = page.locator(".ProseMirror div.ocdb[data-db]").filter({ has: page.locator("input[value=\"Review mention list\"]") });
  await expect
    .poll(async () => {
      await page.locator(".ProseMirror > *").last().evaluate((el) => el.scrollIntoView({ block: "end" }));
      return db.count();
    }, { timeout: 10_000 })
    .toBe(1);
});

test("FC-10 real server: '…' menu → Markdown lands after the caret block", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "Import md");
  await openFile(priya, fileId);
  await applyTemplate(priya, "Meeting notes");
  await editor(priya).locator("h2").filter({ hasText: "Agenda" }).click();
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await priya.oc.locator(".mi", { hasText: "Import…" }).click();
  const dlg = priya.oc.getByRole("dialog", { name: "Import into this canvas" });
  await expect(dlg).not.toContainText("Demo:");
  await dlg.getByLabel("Choose a file to import").setInputFiles(mdFile);
  await expect(dlg.getByRole("status")).toContainText(/Imported \d+ blocks?/);
  await expect(editor(priya).locator("h1, h2").filter({ hasText: "Imported heading" })).toBeVisible({ timeout: 5_000 });
  await expect(editor(priya)).toContainText("Imported paragraph text.");
  // A server import isn't in this browser's undo history, so the dialog offers "Undo import"
  // (it removes exactly the imported blocks) instead of promising ⌘Z.
  await expect(dlg).not.toContainText(/⌘Z|Ctrl\+Z/);
  await dlg.getByRole("button", { name: "Undo import" }).click();
  await expect(editor(priya)).not.toContainText("Imported paragraph text.");
  await expect(editor(priya).locator("h1, h2").filter({ hasText: "Imported heading" })).toHaveCount(0);
  await expect(editor(priya).locator("h2").filter({ hasText: "Agenda" })).toBeVisible();
  await priya.ctx.close();
});

test("SHEET-08 real server: an .xlsx becomes a Spreadsheet block with its formats and styles", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "Import xlsx");
  await openFile(priya, fileId);
  await applyTemplate(priya, "Meeting notes");
  let seen: URL | null = null;
  priya.page.on("request", (r) => {
    if (r.url().includes("/v1/import?")) seen = new URL(r.url());
  });
  await editor(priya).locator("h2").filter({ hasText: "Agenda" }).click();
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await priya.oc.locator(".mi", { hasText: "Import…" }).click();
  const dlg = priya.oc.getByRole("dialog", { name: "Import into this canvas" });
  await expect(dlg).toContainText("Excel (.xlsx)");
  await dlg.getByLabel("Choose a file to import").setInputFiles(path.join(ROOT, "e2e/fixtures/sheets/budget.xlsx"));
  await expect(dlg.getByRole("status")).toContainText("Imported a spreadsheet with 1 sheet");
  expect((seen as unknown as URL).searchParams.get("format")).toBe("xlsx");
  await dlg.getByRole("button", { name: "Close" }).click();
  const sheet = editor(priya).locator(".ocsh").filter({ hasText: "Venue" });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  // The bold header and the currency format came with the file; the SUM computed.
  await expect(sheet.locator(".ocsh-c.b", { hasText: "Item" })).toBeVisible();
  await expect(sheet.locator(".ocsh-c", { hasText: /4,200\.00/ })).toBeVisible();
  await expect(sheet.locator(".ocsh-c", { hasText: /5,000\.00/ })).toBeVisible();
  await priya.ctx.close();
});

test("FC-10 mocked: the request carries format, ticket, blockId and the chosen types", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "Import mocked");
  await openFile(priya, fileId);
  await applyTemplate(priya, "Meeting notes");
  let seen: URL | null = null;
  let body = "";
  await priya.page.route("**/v1/import?**", async (r) => {
    seen = new URL(r.request().url());
    body = r.request().postData() ?? "";
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ format: "csv", rows: 3, dbId: "db_x", blockIds: ["b_x"] }) });
  });
  await editor(priya).locator("h2").filter({ hasText: "Agenda" }).click();
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await priya.oc.locator(".mi", { hasText: "Import…" }).click();
  const dlg = priya.oc.getByRole("dialog", { name: "Import into this canvas" });
  await dlg.getByLabel("Choose a file to import").setInputFiles(csvFile);
  await expect(dlg.getByLabel("Where to insert")).toHaveValue("after");
  await dlg.getByLabel("Type of Owner").selectOption("text");
  await dlg.getByRole("button", { name: "Import 3 rows" }).click();
  await expect(dlg.getByRole("status")).toContainText("Imported a database with 3 rows");
  const u = seen as unknown as URL;
  expect(u.searchParams.get("format")).toBe("csv");
  expect(u.searchParams.get("ticket")).toBeTruthy();
  expect(u.searchParams.get("blockId")).toMatch(/^[A-Za-z0-9_-]+$/);
  const types = JSON.parse(u.searchParams.get("types")!);
  expect(types).toHaveLength(4);
  expect(types[1]).toBe("text");
  expect(types[2]).toBe("date");
  expect(body).toContain("Finish embed SDK docs");
  await axe(priya.page, "oc");
  await priya.ctx.close();
});

test("FC-10: hidden when the host's import_formats is off", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "No import", HOST_RELOAD);
  await openFile(priya, fileId, HOST_RELOAD);
  await applyTemplate(priya, "Meeting notes");
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await expect(priya.oc.locator(".mi").first()).toBeVisible();
  await expect(priya.oc.locator(".mi", { hasText: "Import…" })).toHaveCount(0);
  await priya.page.keyboard.press("Escape");
  const last = priya.oc.locator(".ProseMirror > p").last();
  await last.click();
  await priya.page.keyboard.type("/import");
  await expect(priya.oc.getByRole("listbox", { name: "Insert" }).getByRole("option", { name: /Import…/ })).toHaveCount(0);
  await priya.ctx.close();
});
