// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// q. The web-component SDK, embedded the way a host would: a host page on its own origin loads
//    `${OC}/sdk/embed.js`, renders <open-canvas>, listens to oc:* events and drives the canvas
//    with commit() and setReadOnly(). An origin the host didn't register can't frame the canvas.
import http from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { HOST, OC, SDK_HOST } from "../env";
import { applyTemplate, createFile, editor, hostVersion, person, typeAfterHeading } from "../helpers";

const EVENTS = ["oc:loading", "oc:ready", "oc:modified", "oc:saved", "oc:presence", "oc:error"];

// A real second web server, like a host's own app: its pages are set per test. (A page faked with
// page.route counts as a public origin, and Chrome then blocks its requests to localhost.)
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

/** The host's page on `origin`, embedding the canvas exactly as docs/05 §4 Option B shows. */
async function hostPage(page: Page, origin: string, token: string) {
  const path = `/embed-${pages.size}`;
  pages.set(path, `<!doctype html><meta charset="utf-8"><title>SDK host</title>
<script>window.ev = []; for (const t of ${JSON.stringify(EVENTS)}) document.addEventListener(t, (e) => window.ev.push({ t, d: e.detail }));</script>
<script type="module" src="${OC}/sdk/embed.js"></script>
<open-canvas server="${OC}" token="${token}" theme="light" style="display:block;height:760px"></open-canvas>`);
  const sdk = page.waitForResponse(`${OC}/sdk/embed.js`);
  await page.goto(origin + path);
  return sdk;
}

/** A fresh launch token for `user` on `fileId`, as the sample host signs it for its own page. */
async function launchToken(p: { ctx: { request: { get: (u: string) => Promise<{ text: () => Promise<string> }> } } }, fileId: string, user: string) {
  const html = await (await p.ctx.request.get(`${HOST}/files/${fileId}?as=${user}`)).text();
  const m = html.match(/name="token" value="([^"]+)"/);
  expect(m, "the sample host's file page carries a launch token").not.toBeNull();
  return m![1];
}

const events = (page: Page) => page.evaluate(() => (window as unknown as { ev: { t: string; d: unknown }[] }).ev);

test("a host page on another origin embeds the canvas with <open-canvas> and drives it", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E q · SDK");
  await applyTemplate(priya, "Meeting notes");
  await priya.page.goto("about:blank");

  const host = await person(browser, "u_priya");
  const sdk = await hostPage(host.page, SDK_HOST, await launchToken(priya, fileId, "u_priya"));
  expect(new URL(SDK_HOST).origin).not.toBe(new URL(OC).origin);
  expect((await sdk).status()).toBe(200);
  expect((await sdk).headers()["content-type"]).toMatch(/javascript/);

  // The iframe lives in the element's shadow root; Playwright's locators pierce open shadow DOM.
  const oc = host.page.frameLocator("open-canvas iframe");
  await expect(oc.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await events(host.page)).some((e) => e.t === "oc:ready")).toBe(true);
  await expect.poll(async () => (await events(host.page)).some((e) => e.t === "oc:presence")).toBe(true);

  // Typing raises oc:modified; commit() saves at once and resolves with the oc:saved detail.
  const before = hostVersion(fileId);
  await typeAfterHeading({ ...host, oc } as never, "Notes", "Typed inside the SDK embed");
  await expect.poll(async () => (await events(host.page)).some((e) => e.t === "oc:modified")).toBe(true);
  const saved = await host.page.evaluate(() =>
    (document.querySelector("open-canvas") as unknown as { commit: (o: { message: string }) => Promise<unknown> }).commit({ message: "From the SDK" }),
  );
  expect(saved).toBeTruthy();
  await expect.poll(() => hostVersion(fileId), { timeout: 10_000 }).toBeGreaterThan(before);

  // setReadOnly(true) locks the editor; false unlocks it.
  await host.page.evaluate(() => (document.querySelector("open-canvas") as unknown as { setReadOnly: (b: boolean) => void }).setReadOnly(true));
  await expect(oc.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
  await host.page.evaluate(() => (document.querySelector("open-canvas") as unknown as { setReadOnly: (b: boolean) => void }).setReadOnly(false));
  await expect(oc.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");

  expect((await events(host.page)).filter((e) => e.t === "oc:error")).toEqual([]);
  await expect(editor(priya)).toHaveCount(0);
});

test("an origin the host didn't register gets neither the SDK nor a framed canvas", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E q · SDK foreign origin");
  await applyTemplate(priya, "Meeting notes");
  // Same server, same page, but 127.0.0.1 is not one of the host's allowed origins.
  const foreignOrigin = SDK_HOST.replace("localhost", "127.0.0.1");

  // The SDK script is served with CORS for registered hosts only.
  const ok = await priya.ctx.request.get(`${OC}/sdk/embed.js`, { headers: { Origin: SDK_HOST } });
  expect(ok.headers()["access-control-allow-origin"]).toBe(SDK_HOST);
  const no = await priya.ctx.request.get(`${OC}/sdk/embed.js`, { headers: { Origin: foreignOrigin } });
  expect(no.headers()["access-control-allow-origin"]).toBeUndefined();

  // Without the SDK, a plain form launch into an iframe (Option A) is refused by frame-ancestors.
  const path = "/embed-foreign";
  pages.set(path, `<!doctype html><meta charset="utf-8"><title>Foreign host</title>
<form id="f" method="post" target="oc" action="${OC}/v1/launch"><input type="hidden" name="token" value="${await launchToken(priya, fileId, "u_priya")}"></form>
<iframe name="oc" style="width:100%;height:700px;border:0"></iframe><script>document.getElementById("f").submit()</script>`);
  const foreign = await person(browser, "u_priya");
  const app = foreign.page.waitForResponse((r) => r.url().startsWith(`${OC}/app/`));
  await foreign.page.goto(foreignOrigin + path);
  const csp = (await app).headers()["content-security-policy"] ?? "";
  const ancestors = csp.split(";").find((directive) => directive.trim().startsWith("frame-ancestors "));
  const origins = ancestors?.trim().split(/\s+/).slice(1);
  expect(origins).toContain(SDK_HOST);
  expect(origins).not.toContain(foreignOrigin);
  await foreign.page.waitForTimeout(2_000);
  await expect(foreign.page.frameLocator('iframe[name="oc"]').locator(".ProseMirror")).toHaveCount(0);
});
