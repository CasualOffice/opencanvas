// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// Real-host UI end-to-end (NC-02): a stock Nextcloud (Docker) with this app built (`npm run build`),
// a real OpenCanvas server and Playwright Chromium. Drives the approved screens from the Files
// list, in light and dark, and saves screenshots next to the prototype frames
// (docs/prototypes/nextcloud-approved/screenshots/<frame>-<theme>.png):
//   S2b list icon, S1a New menu, S1c-S1e name dialog, New canvas (stock dialog), S4a/S4b Viewer,
//   S6b "Open in full page", S5a/S5e full page, S5d not found, S8a sharing card, S8b "Can comment",
//   S4g unreachable, S4h/S4i not set up, S13f too large, S12a-S12h admin page and check,
//   S7a password link, S7b/S7c guest name + edit link, S7d view-only link, S7f links turned off.
// Setup and commands: integrations/nextcloud/README.md ("Verified").
//
//   PLAYWRIGHT=/path/to/node_modules/playwright NC=http://localhost:8090 \
//   NC_PASS_ADMIN=… NC_PASS_ALICE=… NC_PASS_BOB=… \
//   OC_PUBLIC=http://localhost:8480 OC_INTERNAL=http://host.docker.internal:8480 \
//   WOPI_BASE=http://localhost:8090/index.php/apps/opencanvas/wopi \
//   node tests/browser/nextcloud-ui.e2e.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");
const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS ?? join(here, "../../../../../docs/prototypes/nextcloud-approved/screenshots");
const NC = process.env.NC ?? "http://localhost:8090";
const OC_PUBLIC = process.env.OC_PUBLIC ?? "http://localhost:8480";
const OC_INTERNAL = process.env.OC_INTERNAL ?? "http://host.docker.internal:8480";
const WOPI_BASE = process.env.WOPI_BASE ?? `${NC}/index.php/apps/opencanvas/wopi`;
const THEMES = (process.env.THEMES ?? "light,dark").split(",");
const pass = (u) => process.env[`NC_PASS_${u.toUpperCase()}`];
const auth = (u) => "Basic " + Buffer.from(`${u}:${pass(u)}`).toString("base64");
let failures = 0;
const ok = (m) => console.log(`ok - ${m}`);
const fail = (m) => { failures++; console.log(`FAIL - ${m}`); };
const check = (cond, m) => (cond ? ok(m) : fail(m));
mkdirSync(SHOTS, { recursive: true });

async function api(user, method, path, body, headers = {}) {
  const json = body !== undefined && typeof body !== "string" && !(body instanceof Buffer);
  const res = await fetch(NC + path, {
    method,
    headers: { authorization: auth(user), "OCS-APIREQUEST": "true", accept: "application/json", ...(json ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : json ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
}
const settings = async (s) => {
  const r = await api("admin", "POST", "/index.php/apps/opencanvas/settings/admin", { settings: s });
  if (r.status !== 200) throw new Error(`settings ${JSON.stringify(s)}: ${r.status} ${r.text}`);
};
const restore = () => settings({
  opencanvas_url: OC_PUBLIC, opencanvas_internal_url: OC_INTERNAL, wopi_base: WOPI_BASE,
  allow_public_links: true, allow_comment_role: false,
});
const create = async (dir, name, kind = "blank") => {
  const r = await api("alice", "POST", "/index.php/apps/opencanvas/api/v1/create", { dir, name, kind });
  if (r.status !== 201) throw new Error(`create ${name}: ${r.status} ${r.text}`);
  return r.json();
};
const link = async (path, permissions, password) => {
  const body = { path, shareType: 3, permissions, ...(password ? { password } : {}) };
  const r = await api("alice", "POST", "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json", body);
  if (r.status !== 200) throw new Error(`link: ${r.status} ${r.text}`);
  return r.json().ocs.data;
};
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

async function login(browser, user, theme, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const page = await ctx.newPage();
  await page.goto(`${NC}/login`);
  await page.fill("#user", user);
  await page.fill("#password", pass(user));
  await Promise.all([page.waitForURL(/\/apps\//, { timeout: 30_000 }), page.press("#password", "Enter")]);
  return { ctx, page };
}
const shot = async (page, frame, theme, opts = {}) => {
  await page.waitForTimeout(opts.settle ?? 400);
  const path = join(SHOTS, `${frame}-${theme}.png`);
  if (opts.locator) await opts.locator.screenshot({ path });
  else await page.screenshot({ path, fullPage: !!opts.fullPage });
};
const frameOf = (page) => page.frameLocator("iframe.oc-frame__iframe");
const loaded = (page, ms = 30_000) => page.locator('[data-oc-frame][data-phase="loaded"]').waitFor({ timeout: ms });
const errorShown = (page, code, ms = 40_000) => page.locator(`[data-oc-error][data-code="${code}"]`).waitFor({ timeout: ms });
const row = (page, name) => page.locator(`[data-cy-files-list-row-name="${name}"]`);
const closeViewer = async (page) => {
  await page.locator(".viewer .modal-header button[aria-label='Close'], .modal-header button[aria-label='Close']").first().click();
  await page.locator(".viewer").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
};
async function openNewMenu(page) {
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.locator("[data-cy-upload-picker-menu-entry]").first().waitFor();
}

const browser = await chromium.launch();
let big = null;
try {
  await restore();
  // A 101 MB file for S13f, shared by both themes.
  big = `/Too large ${Date.now()}.ocanvas`;
  const put = await api("alice", "PUT", `/remote.php/dav/files/alice${encodeURI(big)}`, Buffer.alloc(101 * 1024 * 1024), { "content-type": "application/octet-stream" });
  if (put.status >= 300) throw new Error(`upload large: ${put.status}`);
  const bigId = await until(async () => {
    const r = await api("alice", "PROPFIND", `/remote.php/dav/files/alice${encodeURI(big)}`, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>', { depth: "0", "content-type": "application/xml" });
    return Number((r.text.match(/<oc:fileid>(\d+)</) ?? [])[1]) || undefined;
  }, 10_000, "large file id");

  for (const theme of THEMES) {
    console.log(`# theme: ${theme}`);
    const dir = `/Q1 launch ${theme} ${Date.now()}`;
    const mk = await api("alice", "MKCOL", `/remote.php/dav/files/alice${encodeURI(dir)}`);
    if (mk.status !== 201) throw new Error(`mkcol ${mk.status}`);
    const plan = await create(dir, "Q1 launch plan");
    await create(dir, "Customer interviews", "database");
    await create(dir, "Hiring tracker", "whiteboard");
    const filesUrl = `${NC}/index.php/apps/files/files?dir=${encodeURIComponent(dir)}`;

    const alice = await login(browser, "alice", theme);
    const p = alice.page;

    // S2b: canvases in the Files list carry the .ocanvas icon.
    await p.goto(filesUrl);
    await row(p, "Q1 launch plan.ocanvas").waitFor({ timeout: 20_000 });
    const iconSrc = await row(p, "Q1 launch plan.ocanvas").locator("img").first().getAttribute("src").catch(() => null);
    check(iconSrc?.includes("/opencanvas/img/ocanvas.svg"), `S2b list shows the .ocanvas icon (${iconSrc})`);
    await shot(p, "S2b", theme);

    // S1a: New menu, our three entries last, after a separator.
    await openNewMenu(p);
    const entries = await p.locator("[data-cy-upload-picker-menu-entry]").evaluateAll((els) => els.map((e) => e.textContent.trim()));
    check(JSON.stringify(entries.slice(-3)) === JSON.stringify(["New canvas", "New database canvas", "New whiteboard canvas"]), `S1a New menu ends with our three entries: ${JSON.stringify(entries)}`);
    // Ours are in the group after a separator, not among Nextcloud's "Create new" entries (other
    // apps' entries of that group, such as Text's "Add folder description", may share it).
    const grouped = await p.locator('[data-cy-upload-picker-menu-entry="opencanvas-new-canvas"]').evaluate((li) => {
      for (let n = li.previousElementSibling; n; n = n.previousElementSibling) {
        if (n.matches(".action-separator, [role='separator']")) return true;
        if (n.getAttribute("data-cy-upload-picker-menu-entry") === "template-new-text-0" || /New text file|New folder/.test(n.textContent)) return false;
      }
      return false;
    });
    check(grouped, "S1a a separator sits between Nextcloud's \"Create new\" entries and ours");
    await shot(p, "S1a", theme);

    // S1c-S1e: "New database canvas" name dialog.
    await p.locator('[data-cy-upload-picker-menu-entry="opencanvas-new-database"]').click();
    const field = p.locator("input[data-oc-name-field]");
    await field.waitFor();
    const sel = await field.evaluate((i) => [i.value, i.selectionStart, i.selectionEnd]);
    check(sel[0] === "New database.ocanvas" && sel[1] === 0 && sel[2] === "New database".length, `S1c default name with the base selected (${JSON.stringify(sel)})`);
    await shot(p, "S1c", theme);
    await field.fill("Q1 launch plan.ocanvas");
    await p.getByText('There\'s already a file called "Q1 launch plan.ocanvas" in this folder.').waitFor();
    check(await p.locator("[data-oc-name-create]").isDisabled(), "S1d a clash disables Create");
    await shot(p, "S1d", theme);
    await field.fill("Q1/Q2 roadmap.ocanvas");
    await p.getByText('Names can\'t contain "/". Try "Q1-Q2 roadmap".').waitFor();
    ok("S1e a slash is refused with a suggestion");
    await shot(p, "S1e", theme);
    await field.fill("Hiring pipeline.ocanvas");
    await p.locator("[data-oc-name-create]").click();
    await loaded(p);
    const vTitle = await p.locator(".viewer .modal-header").innerText();
    check(vTitle.includes("Hiring pipeline"), `S1 created "Hiring pipeline" opens in the Viewer (${vTitle.trim()})`);
    const exists = await api("alice", "PROPFIND", `/remote.php/dav/files/alice${encodeURI(dir)}/Hiring%20pipeline.ocanvas`, undefined, { depth: "0" });
    check(exists.status === 207, "S1 the database canvas exists in Nextcloud");
    await closeViewer(p);

    // "New canvas": Nextcloud's own name dialog (template creator), then the Viewer.
    await openNewMenu(p);
    await p.locator('[data-cy-upload-picker-menu-entry="opencanvas-new-canvas"]').click();
    const stock = p.getByRole("dialog").locator("input").first();
    await stock.waitFor();
    await stock.fill("Retro notes.ocanvas");
    await p.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await loaded(p);
    check((await p.locator(".viewer .modal-header").innerText()).includes("Retro notes"), "New canvas (stock dialog) creates and opens in the Viewer");
    await closeViewer(p);

    // S4a/S4b: clicking a canvas opens it in the Viewer; edits save into Nextcloud.
    await p.goto(filesUrl);
    await row(p, "Q1 launch plan.ocanvas").locator("[data-cy-files-list-row-name-link]").click();
    await p.locator("[data-oc-loading]").waitFor({ timeout: 5_000 }).then(() => shot(p, "S4a", theme, { settle: 0 })).catch(() => {});
    await loaded(p);
    // A new blank canvas opens on OpenCanvas's start screen: start from "Meeting notes".
    await frameOf(p).getByLabel("Search templates").fill("Meeting notes");
    await frameOf(p).locator(".tcard").filter({ hasText: "Meeting notes" }).first().click();
    await frameOf(p).getByRole("button", { name: "Use template" }).click();
    const ed = frameOf(p).locator(".ProseMirror").first();
    await ed.waitFor({ timeout: 20_000 });
    check((await ed.getAttribute("contenteditable")) === "true", "S4b the owner edits in the Viewer");
    await ed.locator("p").last().click();
    await p.keyboard.type(`Typed in the Viewer (${theme})`);
    await shot(p, "S4b", theme, { settle: 1200 });
    await until(async () => {
      const r = await fetch(`${NC}/remote.php/dav/files/alice${encodeURI(dir)}/Q1%20launch%20plan.ocanvas`, { headers: { authorization: auth("alice") } });
      return (await unzipHas(Buffer.from(await r.arrayBuffer()), `Typed in the Viewer (${theme})`)) || undefined;
    }, 30_000, "Viewer edit saved");
    ok("S4b an edit made in the Viewer lands in the Nextcloud file");
    await closeViewer(p);

    // S6b: "Open in full page" in the row's menu, then S5a.
    await row(p, "Q1 launch plan.ocanvas").locator("[data-cy-files-list-row-actions] .action-item__menutoggle").first().click();
    const full = p.locator('[data-cy-files-list-row-action="opencanvas-open-full-page"]');
    await full.waitFor();
    await shot(p, "S6b", theme);
    await full.click();
    await p.waitForURL(/\/apps\/opencanvas\/open\//);
    await loaded(p);
    check((await p.title()).startsWith("Q1 launch plan - OpenCanvas - "), `S5a tab title (${await p.title()})`);
    check((await p.locator("[data-oc-name]").innerText()).includes("Q1 launch plan"), "S5a bar shows the name");
    const back = await p.locator("[data-oc-back]").getAttribute("href");
    check(back?.includes(encodeURIComponent(dir)) || back?.includes(dir), `S5a "Files" goes back to the canvas's folder (${back})`);
    await shot(p, "S5a", theme, { settle: 1000 });

    // S5d: a link to a canvas that isn't there.
    await p.goto(`${NC}/index.php/apps/opencanvas/open/99999999`);
    await errorShown(p, "NOT_FOUND", 15_000);
    check((await p.title()).startsWith("Canvas not found - OpenCanvas"), `S5d tab title (${await p.title()})`);
    await shot(p, "S5d", theme);

    // S8a: the sharing card in the Files sidebar, reached from the full page's "Share" (S5c).
    await p.goto(`${NC}/index.php/apps/opencanvas/open/${plan.fileId}`);
    await p.locator("[data-oc-share]").click();
    await p.waitForURL(/opendetails=true/);
    await p.locator("[data-oc-share-card]").waitFor({ timeout: 20_000 });
    ok("S5c/S8a \"Share\" on the full page opens the Files sidebar; \"What this means in a canvas\" shows under the shares");
    await shot(p, "S8a", theme);

    // S5e: the full page on a phone.
    const phone = await login(browser, "alice", theme, { width: 390, height: 844 });
    await phone.page.goto(`${NC}/index.php/apps/opencanvas/open/${plan.fileId}`);
    await loaded(phone.page);
    check(!(await phone.page.locator("[data-oc-share]").isVisible()), "S5e on a phone Share moves into the \"…\" menu");
    await shot(phone.page, "S5e", theme, { settle: 1000 });
    await phone.ctx.close();

    // S13f: too large.
    await p.goto(`${NC}/index.php/apps/opencanvas/open/${bigId}`);
    await errorShown(p, "TOO_LARGE", 15_000);
    check((await p.locator("[data-oc-error]").innerText()).includes("this one is 101 MB"), "S13f too large names the size");
    await shot(p, "S13f", theme);

    // S4g: OpenCanvas unreachable (browsers get a dead address).
    await settings({ opencanvas_url: "http://localhost:9" });
    await p.goto(filesUrl);
    await row(p, "Q1 launch plan.ocanvas").locator("[data-cy-files-list-row-name-link]").click();
    await errorShown(p, "UNREACHABLE");
    check(await p.locator('[data-oc-action="retry"]').isVisible(), "S4g unreachable offers Try again");
    await shot(p, "S4g", theme);
    await closeViewer(p);

    // S4h/S4i: not set up, user vs. admin.
    await settings({ opencanvas_url: "" });
    await row(p, "Q1 launch plan.ocanvas").locator("[data-cy-files-list-row-name-link]").click();
    await errorShown(p, "NOT_CONFIGURED", 15_000);
    check(!(await p.locator('[data-oc-action="admin"]').count()), "S4h users get no admin link");
    await shot(p, "S4h", theme);
    await closeViewer(p);
    const admin = await login(browser, "admin", theme);
    const adminFile = await api("admin", "POST", "/index.php/apps/opencanvas/api/v1/create", { dir: "/", name: `Admin ${theme} ${Date.now()}`, kind: "blank" });
    await admin.page.goto(`${NC}/index.php/apps/files/`);
    await row(admin.page, adminFile.json().name).locator("[data-cy-files-list-row-name-link]").click();
    await errorShown(admin.page, "NOT_CONFIGURED", 20_000);
    check(await admin.page.locator('[data-oc-action="admin"]').isVisible(), "S4i admins get \"Open admin settings\"");
    await shot(admin.page, "S4i", theme);

    // S12a: the admin page, not set up.
    const ap = admin.page;
    await ap.goto(`${NC}/index.php/settings/admin/opencanvas`);
    await ap.locator("[data-oc-not-connected]").waitFor({ timeout: 15_000 });
    check((await ap.locator("[data-oc-check-title]").innerText()).includes("Save an address to run the check"), "S12a the check waits for an address");
    await shot(ap, "S12a", theme, { fullPage: true });

    // S12h: validation before saving.
    await ap.locator("input[data-oc-url]").fill("canvas.northwind");
    await ap.locator("input[data-oc-internal]").click();
    await ap.getByText("Enter a full address that starts with https://, for example https://canvas.example.com").waitFor();
    check(await ap.locator("[data-oc-save]").isDisabled(), "S12h an address without a scheme is caught before saving");
    await ap.locator("input[data-oc-internal]").fill("http://opencanvas:8080");
    await shot(ap, "S12h", theme, { locator: ap.locator(".oc-admin__form").first() });

    // S12i -> S12b: save through the page, the check runs and passes.
    await ap.locator("input[data-oc-url]").fill(OC_PUBLIC);
    await ap.locator("input[data-oc-internal]").fill(OC_INTERNAL);
    await ap.locator("[data-oc-save]").click();
    await ap.getByText("Settings saved. Checking the connection…").waitFor({ timeout: 10_000 });
    await ap.locator('[data-oc-check][data-status="ok"]').waitFor({ timeout: 40_000 });
    const steps = await ap.locator(".oc-check__step").evaluateAll((els) => els.map((e) => `${e.dataset.step}:${e.dataset.status}`));
    check(steps.join() === "answers:ok,action:ok,proofKey:ok,accepts:ok", `S12b all four steps pass (${steps})`);
    await shot(ap, "S12b", theme, { fullPage: true });

    // S12f: allow-list mismatch (a WOPI base OpenCanvas does not list).
    await settings({ wopi_base: WOPI_BASE.replace("localhost", "127.0.0.1") });
    await ap.reload();
    await ap.locator('.oc-check__step[data-step="accepts"][data-status="fail"]').waitFor({ timeout: 40_000 });
    const fix = await ap.locator('.oc-check__step[data-step="accepts"] code').innerText();
    check(fix.startsWith("wopi_allowlist = [") && (await ap.locator("[data-oc-check-title]").innerText()).includes("doesn't accept this Nextcloud"), `S12f allow-list mismatch, with the line to paste (${fix})`);
    await shot(ap, "S12f", theme, { locator: ap.locator("[data-oc-check]") });
    await settings({ wopi_base: WOPI_BASE });

    // S12c: OpenCanvas unreachable from Nextcloud.
    await settings({ opencanvas_internal_url: "http://host.docker.internal:9" });
    await ap.reload();
    await ap.locator('.oc-check__step[data-step="answers"][data-status="fail"]').waitFor({ timeout: 40_000 });
    const skipped = await ap.locator('.oc-check__step[data-status="skipped"]').count();
    check(skipped === 3, `S12c later steps are skipped (${skipped})`);
    await shot(ap, "S12c", theme, { locator: ap.locator("[data-oc-check]") });
    await settings({ opencanvas_internal_url: OC_INTERNAL });

    // S12g: "End all open sessions" asks first.
    await ap.reload();
    await ap.locator("[data-oc-end-sessions]").click();
    await ap.getByText("End all open canvas sessions?").waitFor();
    await shot(ap, "S12g", theme);
    await ap.getByRole("button", { name: "Cancel" }).click();
    ok("S12g ending sessions asks for confirmation");
    await admin.ctx.close();
    await restore();

    // S8b: "Can comment in OpenCanvas" with the admin switch on.
    await settings({ allow_comment_role: true });
    const bobShare = await api("alice", "POST", "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json",
      { path: `${dir}/Q1 launch plan.ocanvas`, shareType: 0, shareWith: "bob", permissions: 1 });
    const shareId = bobShare.json().ocs.data.id;
    await p.goto(`${NC}/index.php/apps/files/files/${plan.fileId}?dir=${encodeURIComponent(dir)}&opendetails=true`);
    await p.locator("[data-oc-share-card]").waitFor({ timeout: 20_000 });
    const bobEntry = p.locator(".sharing-entry").filter({ hasText: "bob" }).first();
    await bobEntry.waitFor({ timeout: 20_000 });
    await bobEntry.locator("[data-cy-files-sharing-share-actions]").click();
    await p.locator("#advancedSectionAccordionAdvancedControl").click();
    const opt = p.locator("[data-oc-comment-option]");
    await opt.waitFor({ timeout: 10_000 });
    await opt.locator("input").check({ force: true });
    await shot(p, "S8b", theme);
    await p.getByRole("button", { name: /Save share|Update share/ }).click();
    const attrs = await until(async () => {
      const r = await api("alice", "GET", `/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}?format=json`);
      const a = r.json().ocs.data[0]?.attributes;
      return a && a.includes('"opencanvas"') && a.includes('"comment"') && a.includes("true") ? a : undefined;
    }, 15_000, "comment attribute saved");
    ok(`S8b the share now carries opencanvas/comment (${attrs})`);
    await settings({ allow_comment_role: false });

    // S7b/S7c: a guest on an edit link gives a name first, then edits.
    const edit = await link(`${dir}/Q1 launch plan.ocanvas`, 3);
    const g1 = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const gp = await g1.newPage();
    await gp.goto(`${NC}/index.php/s/${edit.token}`);
    const gname = gp.locator("input[data-oc-guest-name]");
    await gname.waitFor({ timeout: 20_000 });
    await shot(gp, "S7b", theme);
    await gname.fill("Sam Carter");
    await gp.locator("[data-oc-guest-continue]").click();
    await loaded(gp);
    const ged = frameOf(gp).locator(".ProseMirror").first();
    await ged.waitFor({ timeout: 20_000 });
    check((await ged.getAttribute("contenteditable")) === "true", "S7c the guest edits on an edit link");
    await shot(gp, "S7c", theme, { settle: 1200 });
    await gp.reload();
    await loaded(gp);
    check(!(await gp.locator("input[data-oc-guest-name]").count()), "S7b the name is remembered in this browser");
    await g1.close();

    // S7d: a view-only link opens at once, read only.
    const view = await link(`${dir}/Customer interviews.ocanvas`, 1);
    const g2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const gp2 = await g2.newPage();
    await gp2.goto(`${NC}/index.php/s/${view.token}`);
    await loaded(gp2);
    check(!(await gp2.locator("input[data-oc-guest-name]").count()), "S7d view-only links skip the name prompt");
    await shot(gp2, "S7d", theme, { settle: 1200 });
    await g2.close();

    // S7a: a password-protected link: Nextcloud's password page, then the canvas.
    const pw = await link(`${dir}/Hiring tracker.ocanvas`, 1, "Guest-pass-4242x");
    const g3 = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const gp3 = await g3.newPage();
    await gp3.goto(`${NC}/index.php/s/${pw.token}`);
    const pwField = gp3.locator("input[type=password]").first();
    await pwField.waitFor({ timeout: 20_000 });
    await shot(gp3, "S7a", theme);
    await pwField.fill("Guest-pass-4242x");
    await pwField.press("Enter");
    await loaded(gp3, 40_000);
    ok("S7a after Nextcloud's password page the canvas opens");
    await g3.close();

    // S7f: canvases from links turned off by the admin.
    await settings({ allow_public_links: false });
    const g4 = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const gp4 = await g4.newPage();
    await gp4.goto(`${NC}/index.php/s/${edit.token}`);
    await errorShown(gp4, "LINKS_DISABLED", 20_000);
    check((await gp4.locator("[data-oc-error]").innerText()).includes("Ask alice to share it"), "S7f links turned off: explains and names the owner");
    await shot(gp4, "S7f", theme);
    await g4.close();
    await restore();

    await alice.ctx.close();
  }
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  await restore().catch(() => {});
  if (big) await api("alice", "DELETE", `/remote.php/dav/files/alice${encodeURI(big)}`).catch(() => {});
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
