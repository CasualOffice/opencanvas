// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// End to end in a real Element Web against a real Synapse and OpenCanvas (README "Verified").
// Three people in three browser contexts: Asha Rao (room owner), Ravi Menon (member) and
// Lena Ortiz (not in the room). The bridge and its bot loop run in this process.
//
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
//   HS=http://127.0.0.1:8008 ELEMENT=http://localhost:8081 OC=http://localhost:18080 \
//   REG_SECRET=<synapse registration_shared_secret> OC_JWT_SECRET=<host jwt_secret> \
//   OC_API_KEY=<host api_key> SHOTS=/tmp/shots node e2e/element-e2e.mjs
//
// OpenCanvas host: storage = "ephemeral", allowed_origins = ["http://localhost:8090"],
// frame_ancestors = [ELEMENT]. Element config.json: default_server_config base_url = HS.

import http from "node:http";
import fs from "node:fs";
import { loadConfig } from "../bridge/src/config.mjs";
import { createHandler } from "../bridge/src/server.mjs";
import { startBot } from "../bridge/src/bot.mjs";
import { mx, register, roomWithWidget } from "./setup.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const HS = process.env.HS || "http://127.0.0.1:8008";
const ELEMENT = process.env.ELEMENT || "http://localhost:8081";
const OC = process.env.OC || "http://localhost:18080";
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8090);
const BRIDGE = `http://localhost:${BRIDGE_PORT}`;
const SHOTS = process.env.SHOTS || "";
const { REG_SECRET, OC_JWT_SECRET, OC_API_KEY } = process.env;
if (!REG_SECRET || !OC_JWT_SECRET || !OC_API_KEY) throw new Error("set REG_SECRET, OC_JWT_SECRET and OC_API_KEY");
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

// ---- Matrix fixtures ----
const sfx = Date.now().toString(36);
const asha = await register(HS, REG_SECRET, `asha${sfx}`, "Asha Rao");
const ravi = await register(HS, REG_SECRET, `ravi${sfx}`, "Ravi Menon");
const lena = await register(HS, REG_SECRET, `lena${sfx}`, "Lena Ortiz");
const bot = await register(HS, REG_SECRET, `canvasbot${sfx}`, "Canvas");
const serverName = asha.id.split(":").slice(1).join(":");

// ---- Bridge + bot loop ----
const { cfg, errors } = loadConfig({
  PORT: String(BRIDGE_PORT),
  MX_PUBLIC_URL: BRIDGE,
  OC_URL: OC,
  OC_HOST_ID: "acme-matrix",
  OC_JWT_SECRET,
  OC_API_KEY,
  MX_BOT_HOMESERVER_URL: HS,
  MX_BOT_ACCESS_TOKEN: bot.token,
  MX_ALLOWED_SERVERS: serverName,
  MX_FEDERATION_OVERRIDES: JSON.stringify({ [serverName]: HS }),
});
if (errors.length) throw new Error(errors.join("; "));
const bridge = http.createServer(createHandler(cfg));
await new Promise((r) => bridge.listen(BRIDGE_PORT, "127.0.0.1", r));
const stopBot = new AbortController();
const revokes = [];
startBot(cfg, { signal: stopBot.signal, onRevoke: (r) => revokes.push(r) });

const { roomId, widgetId } = await roomWithWidget(HS, { owner: asha, members: [ravi], bot, bridgeUrl: BRIDGE });
// Lena's own room with a widget that names Asha's room and widget: a forged URL, the attack
// the bridge must refuse (template variables are not authentication).
const { room_id: lenaRoom } = await mx(HS, "POST", "/_matrix/client/v3/createRoom", lena.token, { preset: "private_chat", name: "Lena's room" });
const forgedId = `opencanvas_forged${sfx}`;
await mx(HS, "PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(lenaRoom)}/state/im.vector.modular.widgets/${forgedId}`, lena.token, {
  type: "m.custom", name: "Canvas", data: {}, waitForIframeLoad: true,
  url: `${BRIDGE}/widget?roomId=${encodeURIComponent(roomId)}&wid=${encodeURIComponent(widgetId)}`,
});
await mx(HS, "PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(lenaRoom)}/state/io.element.widgets.layout/`, lena.token, {
  widgets: { [forgedId]: { container: "top", index: 0, width: 100, height: 80 } },
});
console.log("fixtures ready");

// ---- Browser helpers ----
const browser = await chromium.launch();

async function signIn(user) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  if (process.env.DEBUG_CONSOLE) page.on("console", (m) => console.log(`  [${user.name}] ${m.text().slice(0, 200)}`));
  await page.goto(`${ELEMENT}/#/login`);
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Home", { exact: true }).first().waitFor({ timeout: 30000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  return page;
}

/** Open a room, accept Element's widget prompts, return the widget frame. */
async function openWidget(page, room, label) {
  await page.goto(`${ELEMENT}/#/room/${room}`);
  const deadline = Date.now() + 45000;
  let sawConsent = false, sawOpenId = false;
  while (Date.now() < deadline) {
    // Element's "widget added by someone else" consent (AppPermission).
    const cont = page.locator(".mx_AppPermission").getByRole("button", { name: "Continue" });
    if (await cont.isVisible().catch(() => false)) {
      sawConsent = true;
      await shot(page, `${label}-1-consent`);
      await cont.click();
    }
    // Element's OpenID prompt (WidgetOpenIDPermissionsDialog).
    const dlg = page.getByRole("dialog").filter({ hasText: /verify your identity|identity/i });
    if (await dlg.isVisible().catch(() => false)) {
      sawOpenId = true;
      await shot(page, `${label}-2-openid-prompt`);
      const remember = dlg.getByRole("checkbox");
      if (await remember.count()) await remember.first().check().catch(() => {});
      await dlg.getByRole("button", { name: "Continue" }).click();
    }
    const frame = page.frames().find((f) => f.url().startsWith(`${BRIDGE}/widget`));
    if (frame) {
      const st = await frame.locator("#status").getAttribute("data-state").catch(() => null);
      if (st === "open" || st === "error" || st === "denied") return { frame, sawConsent, sawOpenId, state: st };
    }
    await page.waitForTimeout(300);
  }
  await shot(page, `${label}-timeout`);
  for (const f of page.frames()) {
    const st = await f.locator("#status").innerText().catch(() => "");
    console.log(`  frame ${f.url().slice(0, 120)} ${st ? `status="${st}"` : ""}`);
  }
  return { frame: null, sawConsent, sawOpenId, state: "timeout" };
}

async function editorOf(page) {
  for (let i = 0; i < 100; i++) {
    const f = page.frames().find((x) => x.url().startsWith(`${OC}/app/`));
    if (f && (await f.locator(".ProseMirror").count().catch(() => 0)) > 0) return f;
    await page.waitForTimeout(300);
  }
  return null;
}

let pageA, pageB, pageC;
try {
  // 1. Asha opens the canvas in Element.
  pageA = await signIn(asha);
  const a = await openWidget(pageA, roomId, "asha");
  check("Asha: Element OpenID prompt shown and accepted", a.sawOpenId);
  check("Asha: bridge verified her OpenID token and launched the canvas", a.state === "open", a.state);
  const edA = await editorOf(pageA);
  check("Asha: OpenCanvas editor loaded inside the Element widget (frame-ancestors per host)", Boolean(edA));
  // MX-02: room wording (host flag temporary_wording = "room", OpenCanvas ADR-049).
  const noteA = edA ? await edA.locator(".banner.temp").innerText().catch(() => "") : "";
  check("Asha: temporary note in room wording (MX S5)", noteA.includes("It's deleted after everyone has closed it"), noteA);
  await shot(pageA, "asha-3-canvas");

  // 2. Ravi, a member, opens the same canvas.
  pageB = await signIn(ravi);
  const b = await openWidget(pageB, roomId, "ravi");
  check("Ravi: Element consent for a widget added by someone else", b.sawConsent);
  check("Ravi: member launched the canvas", b.state === "open", b.state);
  const edB = await editorOf(pageB);
  check("Ravi: editor loaded", Boolean(edB));

  // 3. Live co-editing both ways.
  if (edA && edB) {
    await edA.locator(".ProseMirror").first().click();
    await edA.locator(".ProseMirror").first().pressSequentially("Hello from Asha", { delay: 20 });
    await edB.getByText("Hello from Asha").first().waitFor({ timeout: 15000 }).then(
      () => check("Ravi sees Asha's text live", true),
      () => check("Ravi sees Asha's text live", false),
    );
    await edB.locator(".ProseMirror").first().click();
    await pageB.keyboard.press("End");
    await pageB.keyboard.press("Enter");
    await edB.locator(".ProseMirror").first().pressSequentially("Reply from Ravi", { delay: 20 });
    await edA.getByText("Reply from Ravi").first().waitFor({ timeout: 15000 }).then(
      () => check("Asha sees Ravi's text live", true),
      () => check("Asha sees Ravi's text live", false),
    );
    // 4. Names come from Matrix display names (presence, carets).
    await pageA.waitForTimeout(1500);
    const htmlA = await edA.content();
    const htmlB = await edB.content();
    check("Asha's editor shows Ravi's Matrix display name", htmlA.includes("Ravi Menon"));
    check("Ravi's editor shows Asha's Matrix display name", htmlB.includes("Asha Rao"));
    check("Matrix user ids are not used as display names", !htmlA.includes(`>${ravi.id}<`));
    await shot(pageA, "asha-4-coedit");
    await shot(pageB, "ravi-4-coedit");
  }

  // 5. Lena (not in the room) opens a forged widget in her own room that names Asha's room.
  pageC = await signIn(lena);
  const c = await openWidget(pageC, lenaRoom, "lena");
  const textC = c.frame ? await c.frame.locator("#status").innerText() : "";
  check("Lena (non-member) is refused by the bridge", c.state === "error" && /Join the room to open this canvas/.test(textC), textC);
  check("Lena gets no canvas frame", !pageC.frames().some((f) => f.url().startsWith(`${OC}/app/`)));
  await shot(pageC, "lena-5-refused");

  // 6. Ravi leaves the room: the bot sees it and closes his open canvas at once.
  await mx(HS, "POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, ravi.token, {});
  // Element drops the widget from the room view at once; a popped-out or still-open editor
  // is closed by the bridge's bot through the OpenCanvas role API.
  for (let i = 0; i < 60 && !revokes.some((r) => r.userId === ravi.id); i++) await pageB.waitForTimeout(250);
  const rv = revokes.find((r) => r.userId === ravi.id);
  check("Ravi leaves: the bot revoked him and closed his live canvas connection", Boolean(rv && rv.connections >= 1), JSON.stringify(rv || {}));
  check("Ravi leaves: Element no longer shows the canvas", !pageB.frames().some((f) => f.url().startsWith(`${OC}/app/`)));
  await shot(pageB, "ravi-6-left");
  // And a new launch from his (real) OpenID token is refused.
  const o = await mx(HS, "POST", `/_matrix/client/v3/user/${encodeURIComponent(ravi.id)}/openid/request_token`, ravi.token, {});
  const r = await fetch(`${BRIDGE}/api/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, widgetId, openid: { access_token: o.access_token, matrix_server_name: o.matrix_server_name } }),
  });
  check("Ravi cannot launch again after leaving", r.status === 403 && (await r.json()).error === "NOT_MEMBER");
  // Asha keeps editing.
  if (edA) {
    const still = await edA.getByText("Your access to this canvas changed").count();
    check("Asha's canvas stays open", still === 0);
  }
} finally {
  await browser.close();
  stopBot.abort();
  bridge.close();
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
