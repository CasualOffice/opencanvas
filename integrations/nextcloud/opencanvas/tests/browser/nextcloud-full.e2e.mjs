// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// Full Nextcloud run (NC-03), started by integrations/nextcloud/test/e2e.sh, which sets up a
// stock Nextcloud with this app, a real OpenCanvas and the users alice and bob:
//   create a canvas from Files' New menu, open it in the Viewer, edit, the save lands in the
//   Nextcloud file; unified search (SRCH-05) finds it for alice but not for bob until it is
//   shared read-only, and bob opens it view-only; clicking the search hit opens the full page at
//   the block; deleting the file takes it out of the search index; the app listing carries the
//   LEGAL-01 trademark line.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");
const NC = process.env.NC ?? "http://localhost:8490";
const CONTAINER = process.env.NC_CONTAINER ?? "oc-nc-e2e";
const pass = (u) => process.env[`NC_PASS_${u.toUpperCase()}`];
const auth = (u) => "Basic " + Buffer.from(`${u}:${pass(u)}`).toString("base64");
let failures = 0;
const ok = (m) => console.log(`ok - ${m}`);
const fail = (m) => { failures++; console.log(`FAIL - ${m}`); };
const check = (cond, m) => (cond ? ok(m) : fail(m));

async function api(user, method, path, body, headers = {}) {
  const json = body !== undefined && typeof body !== "string";
  const res = await fetch(NC + path, {
    method,
    headers: { authorization: auth(user), "OCS-APIREQUEST": "true", accept: "application/json", ...(json ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : json ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
}
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
/** Unified search through Nextcloud's OCS API, as the header search calls it. */
const search = async (user, term) => {
  const r = await api(user, "GET", `/ocs/v2.php/search/providers/opencanvas/search?term=${encodeURIComponent(term)}&format=json`);
  if (r.status !== 200) throw new Error(`search: ${r.status} ${r.text}`);
  return r.json().ocs.data.entries;
};
/** Rows of the app's search index for a file id, read from Nextcloud's SQLite database. */
const indexRows = (fileId) => Number(execFileSync("docker", ["exec", "-u", "www-data", CONTAINER, "php", "-r",
  `$d=new PDO("sqlite:/var/www/html/data/nextcloud.db"); echo $d->query("SELECT COUNT(*) FROM oc_opencanvas_search WHERE fileid=${Number(fileId)}")->fetchColumn();`]).toString().trim());

async function login(browser, user) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${NC}/login`);
  await page.fill("#user", user);
  await page.fill("#password", pass(user));
  await Promise.all([page.waitForURL(/\/apps\//, { timeout: 30_000 }), page.press("#password", "Enter")]);
  return page;
}
const frameOf = (page) => page.frameLocator("iframe.oc-frame__iframe");
const loaded = (page, ms = 30_000) => page.locator('[data-oc-frame][data-phase="loaded"]').waitFor({ timeout: ms });
const row = (page, name) => page.locator(`[data-cy-files-list-row-name="${name}"]`);

const stamp = Date.now().toString(36);
const NAME = `Release plan ${stamp}`;
const FILE = `${NAME}.ocanvas`;
const PHRASE = `Quarterly SSO rollout ${stamp}`;
const browser = await chromium.launch();
try {
  // LEGAL-01: the listing text Nextcloud shows for the app carries the trademark line.
  const info = await api("admin", "GET", "/ocs/v2.php/cloud/apps/opencanvas?format=json");
  const desc = info.status === 200 ? JSON.stringify(info.json().ocs.data.description ?? "") : info.text;
  check(desc.includes("Nextcloud is a registered trademark of Nextcloud GmbH.") && desc.includes("not affiliated with or endorsed by either company"),
    "LEGAL-01 the app's description in Nextcloud carries the trademark and not-affiliated line");

  // 1. Create from Files' New menu ("New canvas", Nextcloud's own name dialog); it opens in the Viewer.
  const alice = await login(browser, "alice");
  await alice.goto(`${NC}/index.php/apps/files/files`);
  await alice.getByRole("button", { name: "New", exact: true }).first().click();
  await alice.locator('[data-cy-upload-picker-menu-entry="opencanvas-new-canvas"]').click();
  const nameField = alice.getByRole("dialog").locator("input").first();
  await nameField.waitFor();
  await nameField.fill(FILE);
  await alice.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await loaded(alice);
  check((await alice.locator(".viewer .modal-header").innerText()).includes(NAME), `created "${FILE}" from the New menu; it opens in the Viewer`);
  const fileId = await until(async () => {
    const r = await api("alice", "PROPFIND", `/remote.php/dav/files/alice/${encodeURIComponent(FILE)}`,
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>',
      { depth: "0", "content-type": "application/xml" });
    return Number((r.text.match(/<oc:fileid>(\d+)</) ?? [])[1]) || undefined;
  }, 10_000, "file id");

  // 2. Edit: a blank canvas opens on the start screen; start from a template, add a heading and a line.
  const oc = frameOf(alice);
  await oc.getByLabel("Search templates").fill("Meeting notes");
  await oc.locator(".tcard").filter({ hasText: "Meeting notes" }).first().click();
  await oc.getByRole("button", { name: "Use template" }).click();
  const ed = oc.locator(".ProseMirror").first();
  await ed.waitFor({ timeout: 20_000 });
  check((await ed.getAttribute("contenteditable")) === "true", "the owner edits");
  // To the end of the document (End alone does not move the caret on macOS).
  await ed.locator("p").last().click();
  await alice.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("## Release 4.2");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type(PHRASE);

  // 3. Saved: the edit is in the Nextcloud file (autosave, WOPI PutFile).
  await until(async () => {
    const r = await fetch(`${NC}/remote.php/dav/files/alice/${encodeURIComponent(FILE)}`, { headers: { authorization: auth("alice") } });
    return (await unzipHas(Buffer.from(await r.arrayBuffer()), PHRASE)) || undefined;
  }, 30_000, "edit saved into Nextcloud");
  ok("the edit is saved into the Nextcloud file");

  // 4. Unified search: alice finds it with the heading trail; bob, without a share, does not.
  const hits = await until(async () => { const e = await search("alice", `sso rollout ${stamp}`); return e.length ? e : undefined; }, 20_000, "search hit");
  check(hits.length === 1 && hits[0].title === NAME, `unified search "Canvases" finds the canvas for alice (${JSON.stringify(hits.map((h) => h.title))})`);
  check(hits[0].subline.includes(PHRASE) && hits[0].subline.includes("Release 4.2"), `the hit shows the line and its heading (${hits[0].subline})`);
  check(/\/apps\/opencanvas\/open\/\d+#block=/.test(hits[0].resourceUrl), `the hit links to the block (${hits[0].resourceUrl})`);
  check(indexRows(fileId) === 1, "the app's search index has one row for the file");
  check((await search("bob", `sso rollout ${stamp}`)).length === 0, "bob (no share) finds nothing");

  // 5. Share read-only with bob: he finds it and opens it view-only.
  const share = await api("alice", "POST", "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json", { path: `/${FILE}`, shareType: 0, shareWith: "bob", permissions: 1 });
  if (share.status !== 200) throw new Error(`share: ${share.status} ${share.text}`);
  check((await search("bob", `sso rollout ${stamp}`)).length === 1, "shared read-only, bob finds it");
  const bob = await login(browser, "bob");
  await bob.goto(`${NC}/index.php/apps/opencanvas/open/${fileId}`);
  const bed = frameOf(bob).locator(".ProseMirror").first();
  await bed.getByText(PHRASE).waitFor({ timeout: 20_000 });
  check((await bed.getAttribute("contenteditable")) === "false", "bob opens it view-only");
  await bob.context().close();

  // 6. The header search in the browser: the hit opens the full page at the block.
  await alice.goto(`${NC}/index.php/apps/files/files`);
  await alice.locator(".unified-search__trigger, button[aria-label='Unified search'], button[aria-label='Search']").first().click();
  const box = alice.locator(".unified-search-modal input[type='text'], .unified-search-modal input").first();
  await box.waitFor({ timeout: 10_000 });
  await box.fill(`sso rollout ${stamp}`);
  const hit = alice.locator(".unified-search-modal").getByText(NAME, { exact: false }).first();
  await hit.waitFor({ timeout: 20_000 });
  await hit.click();
  await alice.waitForURL(/\/apps\/opencanvas\/open\/\d+/, { timeout: 20_000 });
  check(alice.url().includes(`/open/${fileId}`) && alice.url().includes("#block="), `the hit opens the full page at the block (${alice.url()})`);
  await loaded(alice);
  const target = frameOf(alice).locator(".ProseMirror").first().getByText(PHRASE);
  await target.waitFor({ timeout: 20_000 });
  const inView = await until(async () => {
    const b = await target.boundingBox();
    const vh = alice.viewportSize().height;
    return b && b.y >= 0 && b.y + b.height <= vh ? true : undefined;
  }, 10_000, "block in view").catch(() => false);
  check(inView, "the block is scrolled into view");

  // 7. Delete: the canvas leaves the search index.
  const del = await api("alice", "DELETE", `/remote.php/dav/files/alice/${encodeURIComponent(FILE)}`);
  check(del.status === 204, `deleted through WebDAV (${del.status})`);
  check((await search("alice", `sso rollout ${stamp}`)).length === 0, "after the delete, search finds nothing");
  const rows = await until(async () => (indexRows(fileId) === 0 ? true : undefined), 10_000, "index row removed").catch(() => false);
  check(rows, `the file's row left the search index (${indexRows(fileId)} left)`);
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  await browser.close();
  console.log(failures ? `RESULT: FAIL (${failures})` : "RESULT: PASS");
  process.exitCode = failures ? 1 : 0;
}

async function unzipHas(buf, needle) {
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
