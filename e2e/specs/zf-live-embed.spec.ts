// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// LIVE-06 (frames 4a, 4b): `<open-canvas view="block">` on a host page of its own origin renders
// one live file with compact chrome (no top bar, no document header), its height follows the
// content (UI_Resize), and edits there reach the canvas that embeds the same live block.
import http from "node:http";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { HOST, OC, SDK_HOST } from "../env";
import { applyTemplate, createFile, editor, expectSaved, person, typeAfterHeading } from "../helpers";

const pages = new Map<string, string>();
let server: http.Server;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = pages.get(req.url ?? "");
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(body ?? "Not found");
  });
  await new Promise<void>((ok) => server.listen(Number(new URL(SDK_HOST).port), ok));
});
test.afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

test("the compact view of a live block in a chat-like host page", async ({ browser }) => {
  test.setTimeout(120_000);
  const priya = await person(browser, "u_priya");
  await createFile(priya, "E2E zf · sprint");
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "Go/no-go booked");
  await expectSaved(priya);
  await editor(priya).getByText("Go/no-go booked", { exact: true }).click();
  await priya.page.keyboard.press("ControlOrMeta+/");
  await priya.oc.getByRole("menuitem", { name: "Make live…" }).click();
  await priya.oc.getByRole("dialog", { name: "Make this a live block" }).getByLabel("Name").fill("Release checklist");
  await priya.oc.getByRole("button", { name: "Make live", exact: true }).click();
  const lb = priya.oc.locator(".lb").first();
  await expect(lb.locator(".lb-b .ProseMirror")).toContainText("Go/no-go booked", { timeout: 15_000 });
  const liveId = (await lb.getAttribute("data-live-file"))!;

  // The host signs a launch token for the live file itself (the sample host's file page has one).
  const html = await (await priya.ctx.request.get(`${HOST}/files/${liveId}?as=u_priya`)).text();
  const token = html.match(/name="token" value="([^"]+)"/)![1];
  pages.set("/chat", `<!doctype html><meta charset="utf-8"><title>Chat</title><main style="width:35rem;font:16px sans-serif"><p>Amara: here is the checklist</p>
<script>window.sizes = []; document.addEventListener("oc:resize", (e) => window.sizes.push(e.detail.height));</script>
<script type="module" src="${OC}/sdk/embed.js"></script>
<open-canvas server="${OC}" token="${token}" view="block" theme="light"></open-canvas></main>`);
  const chat = await priya.ctx.newPage();
  await chat.goto(SDK_HOST + "/chat");
  const frame = chat.frameLocator("open-canvas iframe");
  await expect(frame.locator(".lb.embed .lb-t")).toHaveText("Release checklist", { timeout: 15_000 });
  await expect(frame.locator(".lb.embed .ProseMirror")).toContainText("Go/no-go booked");
  await expect(frame.locator(".top, .dochead, .tgrid")).toHaveCount(0);
  await expect.poll(() => chat.evaluate(() => (window as unknown as { sizes: number[] }).sizes.length)).toBeGreaterThan(0);
  const h = await chat.locator("open-canvas").evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThan(48);
  expect(h).toBeLessThan(400);

  // Ticked in the chat, seen in the canvas.
  await frame.locator(".lb.embed .ProseMirror p").first().click();
  await chat.keyboard.press("End");
  await chat.keyboard.type(" (from chat)");
  await expect(lb.locator(".lb-b .ProseMirror")).toContainText("Go/no-go booked (from chat)", { timeout: 5_000 });

  await chat.emulateMedia({ reducedMotion: "reduce" });
  const r = await new AxeBuilder({ page: chat }).include("open-canvas").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await priya.ctx.close();
});
