// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// Real-host end-to-end: a stock Nextcloud (Docker) with this app, a real OpenCanvas server and
// real browsers. Steps: open an .ocanvas from Nextcloud, edit, the save lands as a Nextcloud
// version, a read-only share opens view-only, a second user co-edits live, and revoking a share
// takes access away from the open session. Setup and commands: integrations/nextcloud/README.md.
//
//   PLAYWRIGHT=/path/to/node_modules/playwright NC=http://localhost:8090 OC=http://localhost:8480 \
//   NC_PASS_ALICE=… NC_PASS_BOB=… NC_PASS_CAROL=… node tests/browser/nextcloud.e2e.mjs
//
// Test-only: the app's editor page is an unstyled placeholder (ADR-011), so the test sizes the
// iframe itself; nothing here ships.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");
const NC = process.env.NC ?? "http://localhost:8090";
const pass = (u) => process.env[`NC_PASS_${u.toUpperCase()}`];
const auth = (u) => "Basic " + Buffer.from(`${u}:${pass(u)}`).toString("base64");
const results = [];
const ok = (m) => { results.push(`ok - ${m}`); console.log(`ok - ${m}`); };
const fail = (m) => { console.log(`FAIL - ${m}`); process.exitCode = 1; };

async function api(user, method, path, body, type = "application/json") {
  const res = await fetch(NC + path, {
    method,
    headers: { authorization: auth(user), "OCS-APIREQUEST": "true", accept: "application/json", ...(body ? { "content-type": type } : {}) },
    body: body ? (type === "application/json" ? JSON.stringify(body) : body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
}

const versions = async (fileId) => {
  const r = await api("alice", "PROPFIND", `/remote.php/dav/versions/alice/versions/${fileId}`, undefined);
  return (r.text.match(/<d:response>/g) ?? []).length - 1; // minus the collection itself
};

async function person(browser, user) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${NC}/login`);
  await page.fill("#user", user);
  await page.fill("#password", pass(user));
  await Promise.all([page.waitForURL(/\/apps\//, { timeout: 30_000 }), page.press("#password", "Enter")]);
  return { user, ctx, page, oc: page.frameLocator('iframe[name="opencanvas-frame"]') };
}

async function open(p, fileId) {
  await p.page.goto(`${NC}/index.php/apps/opencanvas/open/${fileId}`);
  await p.page.addStyleTag({ content: 'iframe[name="opencanvas-frame"]{width:1200px;height:800px;border:0}' });
  await p.oc.locator(".ProseMirror, .tgrid").first().waitFor({ timeout: 20_000 });
}

const editor = (p) => p.oc.locator(".ProseMirror").first();
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

const browser = await chromium.launch();
try {
  // Alice creates a blank canvas through the app API (the New menu entry's backend).
  const created = await api("alice", "POST", "/index.php/apps/opencanvas/api/v1/create", { dir: "/", name: `E2E ${Date.now()}`, kind: "blank" });
  if (created.status !== 201) throw new Error(`create: ${created.status} ${created.text}`);
  const fileId = created.json().fileId;
  ok(`created ${created.json().name} (file ${fileId}) in Nextcloud`);

  // 1. Open in Nextcloud, start from a template (OpenCanvas's own start screen), edit.
  const alice = await person(browser, "alice");
  await open(alice, fileId);
  ok("opened from Nextcloud: CheckFileInfo and GetFile with proof keys, editor loaded");
  await alice.oc.getByLabel("Search templates").fill("Meeting notes");
  await alice.oc.locator(".tcard").filter({ hasText: "Meeting notes" }).first().click();
  await alice.oc.getByRole("button", { name: "Use template" }).click();
  await editor(alice).waitFor();
  if ((await editor(alice).getAttribute("contenteditable")) !== "true") fail("owner should edit");
  await editor(alice).locator("p").last().click();
  await alice.page.keyboard.type("Typed by Alice in Nextcloud");
  ok("owner (all permissions) edits");

  // 2. The save lands in Nextcloud as the file and as a version.
  await until(async () => {
    const r = await api("alice", "GET", `/remote.php/dav/files/alice/${encodeURIComponent(created.json().name)}`);
    return r.status === 200 && r.text.length > 0 ? true : undefined;
  }, 20_000, "file saved");
  const saved = await until(async () => {
    const r = await fetch(`${NC}/remote.php/dav/files/alice/${encodeURIComponent(created.json().name)}`, { headers: { authorization: auth("alice") } });
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.includes(Buffer.from("Typed by Alice in Nextcloud")) || (await unzipHas(buf, "Typed by Alice in Nextcloud")) ? buf : undefined;
  }, 30_000, "edit in the Nextcloud file");
  ok(`autosave wrote the .ocanvas into Nextcloud (${saved.length} bytes, edit present)`);
  // Nextcloud keeps no version of the empty file it replaced, so count from here: the next
  // save must add one.
  const v0 = await versions(fileId);
  await alice.page.keyboard.type(", second save");
  const v1 = await until(async () => { const n = await versions(fileId); return n > v0 ? n : undefined; }, 30_000, "a new version");
  ok(`the next autosave added a Nextcloud version (versions listed: ${v0} -> ${v1})`);

  // 3. Read-only share: Bob opens view-only.
  const share = async (to, permissions) => {
    const r = await api("alice", "POST", "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json",
      { path: `/${created.json().name}`, shareType: 0, shareWith: to, permissions });
    if (r.status !== 200) throw new Error(`share to ${to}: ${r.status} ${r.text}`);
    return r.json().ocs.data.id;
  };
  await share("bob", 1);
  const bob = await person(browser, "bob");
  await open(bob, fileId);
  await editor(bob).waitFor();
  const bobEditable = await editor(bob).getAttribute("contenteditable");
  if (bobEditable !== "false") fail(`read-only share should be view-only, contenteditable=${bobEditable}`);
  else ok("read-only share (permissions 1) opens view-only (contenteditable=false)");

  // 4. Edit share: Carol co-edits live with Alice.
  const carolShare = await share("carol", 19);
  const carol = await person(browser, "carol");
  await open(carol, fileId);
  await editor(carol).waitFor();
  await editor(carol).locator("p", { hasText: "Typed by Alice in Nextcloud" }).waitFor({ timeout: 10_000 });
  await editor(carol).locator("p").last().click();
  await carol.page.keyboard.type(" Carol was here");
  const t0 = Date.now();
  await editor(alice).getByText("Carol was here").waitFor({ timeout: 5_000 });
  await editor(bob).getByText("Carol was here").waitFor({ timeout: 5_000 });
  ok(`second user co-edits live: Carol's text reached Alice and Bob in ${Date.now() - t0} ms`);

  // 5. Downgrade Carol to read-only while her canvas is open.
  const upd = await api("alice", "PUT", `/ocs/v2.php/apps/files_sharing/api/v1/shares/${carolShare}?format=json`, { permissions: 1 });
  if (upd.status !== 200) throw new Error(`update share: ${upd.status} ${upd.text}`);
  try {
    await until(async () => (await editor(carol).getAttribute("contenteditable")) === "false" ? true : undefined, 10_000, "Carol read-only");
    ok("downgrading the share to read-only switches Carol's open editor to read-only");
  } catch (e) {
    fail(`Carol's open editor still editable 10 s after the downgrade (${e.message})`);
  }

  // 6. Revoke Carol's share while her canvas is open.
  const del = await api("alice", "DELETE", `/ocs/v2.php/apps/files_sharing/api/v1/shares/${carolShare}?format=json`);
  if (del.status !== 200) throw new Error(`unshare: ${del.status}`);
  const reopen = await api("carol", "POST", `/index.php/apps/opencanvas/api/v1/token/${fileId}`);
  if (reopen.status === 404) ok("after the revoke Carol cannot open the canvas again (token endpoint 404)");
  else fail(`after the revoke the token endpoint answered ${reopen.status}`);
  try {
    await until(async () => (await editor(carol).getAttribute("contenteditable")) === "false"
      || (await carol.oc.getByRole("dialog").count()) > 0 ? true : undefined, 10_000, "Carol's open editor loses access");
    ok("revoking the share takes access away from Carol's open editor");
  } catch (e) {
    fail(`Carol's open editor still editable 10 s after the revoke (${e.message})`);
  }
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  await browser.close();
  console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
}

async function unzipHas(buf, needle) {
  // .ocanvas is a zip with deflated entries: inflate each local file entry and search it.
  const zlib = await import("node:zlib");
  let i = 0;
  while ((i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i)) >= 0) {
    const method = buf.readUInt16LE(i + 8), csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26), xlen = buf.readUInt16LE(i + 28);
    const start = i + 30 + nlen + xlen, data = buf.subarray(start, start + csize);
    try {
      const out = method === 8 ? zlib.inflateRawSync(data) : data;
      if (out.includes(Buffer.from(needle))) return true;
    } catch { /* not this entry */ }
    i = start;
  }
  return false;
}
