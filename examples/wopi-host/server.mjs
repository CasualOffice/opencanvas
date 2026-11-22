// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// OpenCanvas reference WOPI host: a stand-in for Nextcloud / ownCloud / Seafile, which open
// editors through WOPI (docs/05-INTEGRATION-GUIDE.md §6). Zero dependencies.
//
// It is the WOPI *host* (the storage); OpenCanvas is the WOPI *client* (the editor):
//   - reads OpenCanvas' discovery XML to find the launch URL (urlsrc),
//   - renders a page that form-POSTs access_token + access_token_ttl into an iframe at
//     urlsrc + WOPISrc=<this host>/wopi/files/<id>,
//   - answers CheckFileInfo, GetFile, PutFile (LastModifiedTime conflict check → 409 with
//     COOLStatusCode 1010) and PutRelativeFile (conflict copies).
//
//   node server.mjs                                  # http://localhost:4300
//   OC_SERVER=http://localhost:8080 node server.mjs  # where browsers reach OpenCanvas
//   OC_SERVER_INTERNAL   where this process reaches OpenCanvas (default OC_SERVER)
//   WOPI_SECRET          HMAC key for access tokens (default dev-wopi-secret)
//   WOPI_HOST_TEST=1     enables POST /__test/files/:id/bump (e2e only: an out-of-band save,
//                        so OpenCanvas' next PutFile gets a 409 / 1010)
//   WOPI_PROOF=off       opt-out: do not verify X-WOPI-Proof (for OpenCanvas servers without
//                        proof keys; default on: every /wopi call must carry a valid proof)
//
// opencanvas.hosts.toml needs: [[host]] id="wopi-sample" mode="wopi"
//                               wopi_allowlist=["http://localhost:4300"]

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 4300);
const OC_SERVER = process.env.OC_SERVER || "http://localhost:8080";
const OC_INTERNAL = process.env.OC_SERVER_INTERNAL || OC_SERVER;
const SECRET = process.env.WOPI_SECRET || "dev-wopi-secret";
const SELF = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const DATA = path.resolve(process.env.DATA_DIR || "./data-wopi");
const TEST_HOOKS = process.env.WOPI_HOST_TEST === "1";
const TOKEN_TTL_MS = 10 * 3600 * 1000;
const PROOF_CHECK = process.env.WOPI_PROOF !== "off";
fs.mkdirSync(path.join(DATA, "files"), { recursive: true });

const USERS = {
  u_priya: { name: "Priya Shah", role: "edit" },
  u_asha: { name: "Asha Rao", role: "edit" },
  u_ravi: { name: "Ravi Menon", role: "comment" },
  u_sam: { name: "Sam Ortiz", role: "view" },
};

// ---------- file metadata ----------
const metaPath = path.join(DATA, "meta.json");
let meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : { files: {} };
const saveMeta = () => fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
const nowStamp = prev => {
  // ISO 8601 with ms; strictly increasing so every save gets a new LastModifiedTime.
  let t = Date.now();
  if (prev && Date.parse(prev) >= t) t = Date.parse(prev) + 1;
  return new Date(t).toISOString();
};
if (!Object.keys(meta.files).length) {
  meta.files.board_1 = { name: "Team board.ocanvas", version: 0, lastModified: nowStamp() };
  meta.files.notes_1 = { name: "Meeting notes.md", version: 0, lastModified: nowStamp() };
  fs.writeFileSync(path.join(DATA, "files", "notes_1"), "# Meeting notes\n\n- Agenda\n");
  saveMeta();
}
const fileOf = id => path.join(DATA, "files", id.replace(/[^\w-]/g, ""));
const readFile = id => (fs.existsSync(fileOf(id)) ? fs.readFileSync(fileOf(id)) : Buffer.alloc(0));

// ---------- access tokens: opaque to OpenCanvas; here userId.expiry.hmac(file:user:expiry) ----------
const mac = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url").slice(0, 32);
const issueToken = (fileId, userId, exp = Date.now() + TOKEN_TTL_MS) => ({
  token: `${userId}.${exp}.${mac(`${fileId}:${userId}:${exp}`)}`,
  ttl: exp,
});
function checkToken(fileId, token) {
  const [userId, exp, sig] = String(token || "").split(".");
  if (!USERS[userId] || !sig || Number(exp) < Date.now()) return null;
  const want = mac(`${fileId}:${userId}:${exp}`);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  return userId;
}

// ---------- discovery: find OpenCanvas' urlsrc for an extension ----------
let discovery = null;
async function actionUrl(ext) {
  if (!discovery) {
    try {
      discovery = await (await fetch(`${OC_INTERNAL}/hosting/discovery`)).text();
    } catch {
      discovery = "";
    }
  }
  const re = new RegExp(`<action name="edit" ext="${ext}"[^>]*urlsrc="([^"]+)"`);
  const m = discovery.match(re);
  // The browser-facing OpenCanvas origin, whatever origin the discovery document names.
  const src = m ? m[1].replace(/&amp;/g, "&") : `${OC_SERVER}/v1/launch?`;
  return src.replace(/^https?:\/\/[^/]+/, OC_SERVER);
}

// ---------- proof keys: is this request really from OpenCanvas? (docs/05 §6.4) ----------
// Signed bytes: be32 len ‖ access_token ‖ be32 len ‖ UPPERCASE(full URL) ‖ be32 8 ‖ be64 ticks.
// Accepted: X-WOPI-Proof with the current key, X-WOPI-ProofOld with the current key, or
// X-WOPI-Proof with the old key (rotation). Timestamps older than 20 minutes are refused.
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const MAX_PROOF_AGE_MS = 20 * 60 * 1000;
const b64url = s => Buffer.from(s, "base64").toString("base64url");
function proofKeys(xml) {
  const tag = (xml.match(/<proof-key [^>]*\/>/) || [])[0];
  if (!tag) return null;
  const attr = name => (tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];
  const key = (n, e) => crypto.createPublicKey({ key: { kty: "RSA", n: b64url(n), e: b64url(e) }, format: "jwk" });
  return { current: key(attr("modulus"), attr("exponent")), old: key(attr("oldmodulus"), attr("oldexponent")) };
}
function proofBytes(token, url, ticks) {
  const t = Buffer.from(token, "utf8");
  const u = Buffer.from(url.toUpperCase(), "utf8");
  const out = Buffer.alloc(4 + t.length + 4 + u.length + 4 + 8);
  let o = out.writeUInt32BE(t.length, 0);
  o += t.copy(out, o);
  o = out.writeUInt32BE(u.length, o);
  o += u.copy(out, o);
  o = out.writeUInt32BE(8, o);
  out.writeBigInt64BE(ticks, o);
  return out;
}
const verifyOne = (key, msg, sig) => {
  try {
    return !!sig && crypto.verify("sha256", msg, key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
};
// null when the proof holds, else why it does not.
async function checkProof(req, token) {
  if (!PROOF_CHECK) return null;
  const stamp = String(req.headers["x-wopi-timestamp"] || "");
  if (!/^\d+$/.test(stamp)) return "no X-WOPI-TimeStamp";
  const ticks = BigInt(stamp);
  const ms = Number((ticks - TICKS_AT_UNIX_EPOCH) / 10000n);
  if (Date.now() - ms > MAX_PROOF_AGE_MS) return "X-WOPI-TimeStamp older than 20 minutes";
  const msg = proofBytes(String(token || ""), `${SELF}${req.url}`, ticks);
  const proof = req.headers["x-wopi-proof"];
  const old = req.headers["x-wopi-proofold"];
  for (const refresh of [false, true]) {
    // A miss may be a key rotation: fetch discovery again once.
    const keys = await discoveryKeys(refresh);
    if (!keys) return "no proof-key in OpenCanvas discovery";
    if (verifyOne(keys.current, msg, proof) || verifyOne(keys.current, msg, old) || verifyOne(keys.old, msg, proof)) {
      return null;
    }
  }
  return "X-WOPI-Proof does not verify";
}
async function discoveryKeys(refresh) {
  if (refresh || !discovery || !proofKeys(discovery)) discovery = null;
  await actionUrl("ocanvas");
  return proofKeys(discovery);
}

// ---------- UTF-7 (X-WOPI-SuggestedTarget) ----------
function utf7Decode(s) {
  return s.replace(/\+([A-Za-z0-9+/]*)-?/g, (_, b64) => {
    if (!b64) return "+";
    const bytes = Buffer.from(b64, "base64");
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}

// ---------- HTTP helpers ----------
const send = (res, status, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const isStr = typeof body === "string";
  res.writeHead(status, {
    "content-type": isBuf ? "application/octet-stream" : isStr ? "text/html; charset=utf-8" : "application/json",
    ...headers,
  });
  res.end(isBuf || isStr ? body : JSON.stringify(body));
};
const readBody = req =>
  new Promise((ok, fail) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Never log tokens: strip the query string.
const logPath = u => u.split("?")[0];

function checkFileInfo(id, userId) {
  const f = meta.files[id];
  const u = USERS[userId];
  return {
    BaseFileName: f.name,
    Size: readFile(id).length,
    Version: String(f.version),
    LastModifiedTime: f.lastModified,
    OwnerId: "u_priya",
    UserId: userId,
    UserFriendlyName: u.name,
    UserExtraInfo: { avatar: null },
    UserCanWrite: u.role === "edit",
    ReadOnly: u.role !== "edit",
    UserCanNotWriteRelative: u.role !== "edit",
    OpenCanvas_UserCanComment: u.role === "edit" || u.role === "comment",
    DisableExport: false,
    DisablePrint: false,
    HideExportOption: false,
    SupportsUpdate: true,
    SupportsLocks: false,
  };
}

function pageList() {
  const rows = Object.entries(meta.files)
    .map(([id, f]) => `<li><b>${esc(f.name)}</b> (v${f.version}) — open as ${Object.entries(USERS)
      .map(([uid, u]) => `<a href="/open/${esc(id)}?as=${uid}">${esc(u.name)} (${u.role})</a>`)
      .join(" · ")}</li>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>WOPI sample host</title>
<style>body{font:15px system-ui;margin:24px;max-width:860px}li{margin:8px 0}</style></head>
<body><h1>WOPI sample host</h1><p>OpenCanvas at ${esc(OC_SERVER)}</p><ul>${rows}</ul></body></html>`;
}

async function pageOpen(id, userId) {
  const f = meta.files[id];
  const ext = f.name.toLowerCase().endsWith(".md") ? "md" : "ocanvas";
  const wopiSrc = `${SELF}/wopi/files/${id}`;
  const action = `${await actionUrl(ext)}WOPISrc=${encodeURIComponent(wopiSrc)}`;
  const { token, ttl } = issueToken(id, userId);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(f.name)}</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style></head><body>
<form id="oc" target="oc-frame" method="post" action="${esc(action)}">
  <input type="hidden" name="access_token" value="${esc(token)}">
  <input type="hidden" name="access_token_ttl" value="${ttl}">
</form>
<iframe name="oc-frame" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<script>document.getElementById("oc").submit()</script>
</body></html>`;
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, SELF);
      const override = String(req.headers["x-wopi-override"] || "").toUpperCase();
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname === "/") return send(res, 200, pageList());

      const open = url.pathname.match(/^\/open\/([\w-]+)$/);
      if (open && req.method === "GET") {
        const userId = url.searchParams.get("as") || "u_priya";
        if (!meta.files[open[1]] || !USERS[userId]) return send(res, 404, { error: "not found" });
        return send(res, 200, await pageOpen(open[1], userId));
      }

      const bump = TEST_HOOKS && req.method === "POST" && url.pathname.match(/^\/__test\/files\/([\w-]+)\/bump$/);
      if (bump && meta.files[bump[1]]) {
        const f = meta.files[bump[1]];
        f.version += 1;
        f.lastModified = nowStamp(f.lastModified);
        saveMeta();
        console.log(`bumped ${bump[1]} out of band`);
        return send(res, 200, { LastModifiedTime: f.lastModified });
      }

      const m = url.pathname.match(/^\/wopi\/files\/([\w-]+)(\/contents)?$/);
      if (!m) return send(res, 404, { error: "not found" });
      const [, id, contents] = m;
      const f = meta.files[id];
      const userId = checkToken(id, url.searchParams.get("access_token"));
      if (!f) return send(res, 404, {});
      if (!userId) {
        console.log(`401 ${req.method} ${logPath(req.url)}`);
        return send(res, 401, {});
      }
      // Proof keys: refuse anything not signed by OpenCanvas (500, as the WOPI spec says).
      const bad = await checkProof(req, url.searchParams.get("access_token"));
      if (bad) {
        console.log(`proof rejected ${req.method} ${logPath(req.url)}: ${bad}`);
        return send(res, 500, { error: "proof" });
      }
      // CheckFileInfo
      if (!contents && req.method === "GET") return send(res, 200, checkFileInfo(id, userId));

      // GetFile
      if (contents && req.method === "GET") {
        return send(res, 200, readFile(id), { "x-wopi-itemversion": String(f.version) });
      }

      // PutFile
      if (contents && req.method === "POST" && (override === "PUT" || !override)) {
        if (USERS[userId].role !== "edit") return send(res, 401, {});
        const body = await readBody(req);
        const sent = req.headers["x-cool-wopi-timestamp"];
        if (sent && sent !== f.lastModified) {
          console.log(`conflict ${id}: timestamp ${sent} != ${f.lastModified}`);
          return send(res, 409, { COOLStatusCode: 1010 });
        }
        fs.writeFileSync(fileOf(id), body);
        f.version += 1;
        f.lastModified = nowStamp(f.lastModified);
        saveMeta();
        const auto = req.headers["x-cool-wopi-isautosave"] === "true" ? " (autosave)" : "";
        console.log(`saved ${id} v${f.version} ${body.length} bytes by ${userId}${auto}`);
        return send(res, 200, { LastModifiedTime: f.lastModified }, { "x-wopi-itemversion": String(f.version) });
      }

      // PutRelativeFile (conflict copies)
      if (!contents && req.method === "POST" && override === "PUT_RELATIVE") {
        if (USERS[userId].role !== "edit") return send(res, 401, {});
        const body = await readBody(req);
        let name = utf7Decode(String(req.headers["x-wopi-suggestedtarget"] || req.headers["x-wopi-relativetarget"] || ""));
        if (name.startsWith(".")) name = f.name.replace(/\.[^.]*$/, "") + name;
        if (!name) return send(res, 400, {});
        let newId = `${id}_copy`;
        for (let n = 2; meta.files[newId]; n++) newId = `${id}_copy${n}`;
        fs.writeFileSync(fileOf(newId), body);
        meta.files[newId] = { name, version: 1, lastModified: nowStamp() };
        saveMeta();
        console.log(`copied ${id} -> ${newId} "${name}" ${body.length} bytes`);
        const { token } = issueToken(newId, userId);
        return send(res, 200, {
          Name: name,
          Url: `${SELF}/wopi/files/${newId}?access_token=${encodeURIComponent(token)}`,
          HostEditUrl: `${SELF}/open/${newId}?as=${userId}`,
          HostViewUrl: `${SELF}/open/${newId}?as=${userId}`,
        });
      }

      // LOCK / UNLOCK / REFRESH_LOCK / RENAME_FILE … are not used by OpenCanvas.
      return send(res, 501, { error: `unsupported ${override || req.method}` });
    } catch (e) {
      console.error(`error ${req.method} ${logPath(req.url)}: ${e.message}`);
      send(res, 500, { error: "internal" });
    }
  })
  .listen(PORT, () =>
    console.log(`WOPI sample host on ${SELF} (OpenCanvas ${OC_SERVER}; proof keys ${PROOF_CHECK ? "checked" : "NOT checked"})`),
  );
