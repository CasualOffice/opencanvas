// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// TALK-01 scripted run (docs/prototypes/v04-approved/nextcloud-talk.html), started by
// integrations/nextcloud/test/e2e.sh with Talk (spreed) installed and the users alice and bob:
//   5a empty state; 1a access count and "share with the conversation"; 1b/5c the card with and
//   without access; 2a beside the chat; 3a a meeting canvas in a call; 4a moderator tools and
//   Follow me; 4b a guest read only; 3c/3d the call ends, participants read only, the moderator
//   saves into the Talk folder and the file is posted back; 6a/6b phone.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, request: pwRequest } = require(process.env.PLAYWRIGHT ?? "playwright");
const NC = process.env.NC ?? "http://localhost:8590";
const pass = (u) => process.env[`NC_PASS_${u.toUpperCase()}`];
const auth = (u) => "Basic " + Buffer.from(`${u}:${pass(u)}`).toString("base64");
let failures = 0;
const ok = (m) => console.log(`ok - ${m}`);
const fail = (m) => { failures++; console.log(`FAIL - ${m}`); };
const check = (cond, m) => (cond ? ok(m) : fail(m));
const step = async (m, fn) => {
  try {
    await fn();
  } catch (e) {
    fail(`${m}: ${String(e?.message ?? e).split("\n")[0]}`);
  }
};

async function api(user, method, path, body) {
  const res = await fetch(NC + path, {
    method,
    headers: { authorization: auth(user), "OCS-APIREQUEST": "true", accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}
const ocs = (r) => r.json?.ocs?.data;
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};
async function login(browser, user, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, userAgent: UA });
  const page = await ctx.newPage();
  await page.goto(`${NC}/login`);
  await page.fill("#user", user);
  await page.fill("#password", pass(user));
  await Promise.all([page.waitForURL(/\/apps\//, { timeout: 30_000 }), page.press("#password", "Enter")]);
  return page;
}
const loaded = (page, ms = 40_000) => page.locator('[data-oct-panel] [data-oc-frame][data-phase="loaded"]').waitFor({ timeout: ms });

const stamp = Date.now().toString(36);
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
let callCtx = null;
// Headless Chromium says "HeadlessChrome", which Talk calls unsupported and covers its top bar with
// a warning toast: present the same browser under its ordinary name.
const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
try {
  // Setup: a group conversation alice moderates with bob in it, open to guests, and a canvas only
  // alice can open.
  const room = ocs(await api("alice", "POST", "/ocs/v2.php/apps/spreed/api/v4/room", { roomType: 2, roomName: `Q1 launch team ${stamp}` }));
  const token = room?.token;
  if (!token) throw new Error("could not create the conversation");
  await api("alice", "POST", `/ocs/v2.php/apps/spreed/api/v4/room/${token}/participants`, { newParticipant: "bob", source: "users" });
  await api("alice", "POST", `/ocs/v2.php/apps/spreed/api/v4/room/${token}/public`);
  const made = await api("alice", "POST", "/index.php/apps/opencanvas/api/v1/create", { dir: "/", name: `Q1 launch plan ${stamp}`, kind: "blank" });
  const fileId = made.json?.fileId;
  check(made.status === 201 && fileId > 0, "setup: conversation and canvas created");

  const alice = await login(browser, "alice");
  const bob = await login(browser, "bob");
  const talk = (page) => page.goto(`${NC}/index.php/call/${token}`);

  // 5a: nothing shared, no call.
  await step("5a empty state", async () => {
    await talk(alice);
    await alice.locator("[data-oct-button]").click({ timeout: 30_000 });
    await alice.locator("[data-oct-empty]").waitFor({ timeout: 10_000 });
    check(await alice.getByText("No canvases here yet").isVisible(), "5a the Canvas panel says there are no canvases yet, with one next step");
    await alice.locator("[data-oct-close]").click();
  });

  // 1a: bob can't open it yet; the access count says so.
  const acc = await api("alice", "GET", `/index.php/apps/opencanvas/talk/${token}/access/${fileId}`);
  check(acc.status === 200 && acc.json.missing === 1 && acc.json.total === 2, `1a "1 of 2 participants can't open this canvas yet" (${acc.text.slice(0, 80)})`);
  const link = acc.json?.link;
  // Posting alone (Talk's chat API, as the dialog does) never grants access.
  await api("alice", "POST", `/ocs/v2.php/apps/spreed/api/v1/chat/${token}`, { message: `Shared the plan, have a look\n${link}` });

  // 5c: bob sees the card without preview, and can ask.
  await step("5c no-access card", async () => {
    await talk(bob);
    const card = bob.locator("[data-occ-card]").last();
    await card.waitFor({ timeout: 30_000 });
    check(await card.getAttribute("data-access") === "no", "5c bob's card has no access: no preview or path");
    check(await card.locator("[data-occ-ask]").isVisible(), "5c \"Ask … for access\" is offered");
  });

  // 1a "Share the file with the conversation", then the card has access.
  const sh = await api("alice", "POST", `/index.php/apps/opencanvas/talk/${token}/share/${fileId}`, { level: "edit" });
  check(sh.status === 200, "1a the file is shared with the conversation (Can edit)");
  await step("1b card and 2a beside the chat", async () => {
    await talk(bob);
    const card = bob.locator('[data-occ-card][data-access="yes"]').last();
    await card.waitFor({ timeout: 30_000 });
    check(await card.locator("[data-occ-beside]").isVisible() && await card.locator("[data-occ-full]").isVisible(), "1b the card offers Open beside chat and Full screen");
    await card.locator("[data-occ-beside]").click();
    await loaded(bob);
    const box = await bob.locator("[data-oct-panel]").boundingBox();
    // Nextcloud's root font is 15 px, so 38 rem is measured against it.
    const rem = await bob.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    check(box && Math.abs(box.width - 38 * rem) < 4, `2a the canvas opens beside the chat at 38 rem (${box?.width} px at ${rem} px)`);
    await bob.locator("[data-oct-full]").click();
    const full = await bob.locator("[data-oct-panel]").boundingBox();
    check(full && full.width >= 1270, "2b full screen");
    await bob.locator("[data-oct-close]").click();
  });

  // 3a: a call (joined through Talk's API in its own session), then a meeting canvas.
  callCtx = await pwRequest.newContext({ baseURL: NC, httpCredentials: { username: "alice", password: pass("alice") }, extraHTTPHeaders: { "OCS-APIREQUEST": "true", accept: "application/json" } });
  await callCtx.post(`/ocs/v2.php/apps/spreed/api/v4/room/${token}/participants/active`, { data: { force: true } });
  const joined = await callCtx.post(`/ocs/v2.php/apps/spreed/api/v4/call/${token}`, { data: { flags: 1 } });
  check(joined.ok(), `3a a call is running (${joined.status()})`);

  await step("3a/3b meeting canvas", async () => {
    await talk(alice);
    await alice.locator("[data-oct-button]").click({ timeout: 30_000 });
    await alice.locator("[data-oct-new]").click({ timeout: 15_000 });
    await loaded(alice);
    check((await alice.locator("[data-oct-pill]").textContent())?.trim() === "Temporary", "3b the meeting canvas says Temporary");
    check(await alice.locator("[data-oct-banner-save]").isVisible(), "3b the moderator sees Save to Files");
  });

  await step("3b participant joins the same meeting canvas", async () => {
    await talk(bob);
    await bob.locator("[data-oct-button]").click({ timeout: 30_000 });
    await loaded(bob);
    const st = await bob.evaluate(async (t) => (await fetch(`/index.php/apps/opencanvas/talk/${t}/state`, { headers: { requesttoken: OC.requestToken } })).json(), token);
    check(st.meeting?.role === "edit" && st.meeting?.canSave === false, "3b bob edits it but can't save it");
  });

  // 4b: a guest on the public conversation is read only.
  await step("4b guest", async () => {
    const g = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA })).newPage();
    await g.goto(`${NC}/index.php/call/${token}`);
    // Talk asks a guest for a name first.
    const name = g.locator(".modal-wrapper input[type=text]").first();
    if (await name.waitFor({ timeout: 8_000 }).then(() => true, () => false)) {
      await name.fill("Kim");
      await name.press("Enter");
      await g.locator(".modal-wrapper").first().waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    }
    await g.locator("[data-oct-button]").click({ timeout: 45_000 });
    await loaded(g);
    check((await g.locator("[data-oct-pill]").textContent())?.trim() === "View only", "4b a guest sees View only");
    check((await g.locator("[data-oct-banner]").textContent())?.includes("You're a guest"), "4b the guest banner says the moderator decides");
    await g.context().close();
  });

  // 4a: moderator tools: lock, then Follow me.
  await step("4a moderator tools", async () => {
    const id = (await api("alice", "GET", `/index.php/apps/opencanvas/talk/${token}/state`)).json.meeting.id;
    await api("alice", "POST", `/index.php/apps/opencanvas/talk/${token}/meeting/${id}/options`, { locked: true });
    let st = (await api("bob", "GET", `/index.php/apps/opencanvas/talk/${token}/state`)).json;
    check(st.meeting.role === "view" && st.meeting.locked === true, "4a Lock canvas makes bob read only");
    await api("alice", "POST", `/index.php/apps/opencanvas/talk/${token}/meeting/${id}/options`, { locked: false });
    await alice.locator("[data-oct-menu] button").first().click();
    await alice.locator("[data-oct-follow]").click();
    st = await until(async () => {
      const s = (await api("bob", "GET", `/index.php/apps/opencanvas/talk/${token}/state`)).json;
      return s.follow?.by === "alice" ? s : null;
    }, 10_000, "follow on");
    check(st.follow.canvas === `m:${id}`, "4a Follow me: bob's panel follows alice on the meeting canvas");
    await alice.keyboard.press("Escape");
  });

  // 3c/3d: the call ends for everyone.
  await callCtx.delete(`/ocs/v2.php/apps/spreed/api/v4/call/${token}`, { data: { all: true } });
  await step("3d participants read only, waiting", async () => {
    await bob.locator('[data-oct-banner][data-kind="wait"]').waitFor({ timeout: 20_000 });
    check((await bob.locator("[data-oct-pill]").textContent())?.includes("Call ended"), "3d bob's canvas is read only: Call ended");
  });
  await step("3c moderator saves", async () => {
    await alice.locator("[data-oct-decide]").first().waitFor({ timeout: 20_000 });
    await alice.locator("[data-oct-save-files]").click();
    const st = await until(async () => {
      const s = (await api("alice", "GET", `/index.php/apps/opencanvas/talk/${token}/state`)).json;
      return s.meeting?.state === "saved" ? s : null;
    }, 15_000, "saved");
    check(st.meeting.savedFileId > 0, "3c saved to Files");
    const dav = await fetch(`${NC}/remote.php/dav/files/alice/Talk/`, { method: "PROPFIND", headers: { authorization: auth("alice"), depth: "1" } });
    check((await dav.text()).includes("meeting%20canvas"), "3c the .ocanvas is in alice's Talk folder");
    const chat = ocs(await api("bob", "GET", `/ocs/v2.php/apps/spreed/api/v1/chat/${token}?lookIntoFuture=0&limit=50`)) ?? [];
    check(chat.some((m) => m.messageParameters?.file?.name?.includes("meeting canvas")), "3c the saved canvas is posted back to the conversation");
    await bob.locator('[data-oct-banner][data-kind="open"]').waitFor({ timeout: 15_000 });
    ok("3d bob's banner turns into Saved to Files");
  });

  // 6a/6b: phone.
  await step("6a phone card", async () => {
    const p = await login(browser, "bob", { width: 390, height: 844 });
    await talk(p);
    const card = p.locator('[data-occ-card][data-access="yes"]').first();
    await card.waitFor({ timeout: 30_000 });
    check((await card.locator("[data-occ-full]").textContent())?.trim() === "Open" && !(await card.locator("[data-occ-beside]").count()), "6a on a phone the card has one Open button");
    await card.locator("[data-occ-full]").click();
    await loaded(p);
    const box = await p.locator("[data-oct-panel]").boundingBox();
    check(box && box.width === 390, "6b the canvas is full screen on a phone");
    await p.context().close();
  });
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  await callCtx?.dispose().catch(() => {});
  await browser.close();
}
console.log(failures ? `RESULT: FAIL (${failures})` : "RESULT: PASS");
process.exit(failures ? 1 : 0);
