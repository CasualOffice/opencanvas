// i. The canvas menu's exports: Markdown, .ocanvas and Word download from the server;
//    PDF asks the server first and, when it has no renderer (501), opens the print dialog.
import fs from "node:fs";
import { expect, test, type Download } from "@playwright/test";
import { createFile, editor, person, applyTemplate, type Person } from "../helpers";
import { unzip } from "../ocanvas";

async function exportVia(p: Person, item: RegExp): Promise<Download> {
  await p.oc.getByRole("button", { name: "More options" }).click();
  const [dl] = await Promise.all([p.page.waitForEvent("download"), p.oc.getByRole("menuitem", { name: item }).click()]);
  return dl;
}

const bytes = async (d: Download) => fs.readFileSync((await d.path())!);

test("Markdown, .ocanvas and Word download; PDF falls back to print on 501", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  // Count print() calls instead of opening the dialog (init scripts run in the editor iframe too).
  await priya.ctx.addInitScript(() => {
    const w = window as unknown as { __printed: number };
    w.__printed = 0;
    window.print = () => void w.__printed++;
  });
  // PDF: the real server's answer when it says 501; a server without the route yet is
  // answered with the 501 a server with no renderer gives.
  const pdfStatus: number[] = [];
  await priya.ctx.route(/\/v1\/export\/pdf\?/, async (route) => {
    const real = await route.fetch();
    pdfStatus.push(real.status());
    if (real.status() === 501) return route.fulfill({ response: real });
    return route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: { code: "PDF_RENDERER_NOT_CONFIGURED", message: "No PDF renderer" } }) });
  });

  await createFile(priya, "E2E i · exports");
  await applyTemplate(priya, "Meeting notes");
  await expect(editor(priya).locator("h2", { hasText: "Notes" })).toBeVisible();

  const md = await exportVia(priya, /^Markdown/);
  expect(md.suggestedFilename()).toMatch(/\.md$/);
  expect((await bytes(md)).toString("utf8")).toMatch(/^## Notes$/m);

  const oc = await exportVia(priya, /^OpenCanvas file/);
  expect(oc.suggestedFilename()).toMatch(/\.ocanvas$/);
  const ocZip = await bytes(oc);
  expect(ocZip.subarray(0, 2).toString("latin1")).toBe("PK");
  expect(unzip(ocZip).get("document.json")?.toString("utf8")).toContain("Notes");

  const docx = await exportVia(priya, /^Word/);
  expect(docx.suggestedFilename()).toMatch(/\.docx$/);
  const docxZip = await bytes(docx);
  expect(docxZip.subarray(0, 2).toString("latin1")).toBe("PK");
  const parts = unzip(docxZip);
  expect(parts.has("word/document.xml")).toBe(true);
  expect(parts.get("word/document.xml")!.toString("utf8")).toContain("Notes");

  // PDF: no download, the print dialog instead.
  let downloads = 0;
  priya.page.on("download", () => downloads++);
  const frame = priya.page.frame({ name: "oc" })!;
  expect(await frame.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(0);
  await priya.oc.getByRole("button", { name: "More options" }).click();
  await priya.oc.getByRole("menuitem", { name: /^PDF/ }).click();
  await expect.poll(() => frame.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  expect(pdfStatus.length).toBe(1);
  expect(downloads).toBe(0);

  await priya.ctx.close();
});
