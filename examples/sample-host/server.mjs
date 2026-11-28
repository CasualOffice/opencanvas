// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// OpenCanvas sample host: a stand-in for your app (or any app embedding OpenCanvas).
// It owns users, per-file roles and the file store, signs launch tokens and
// implements the callbacks from docs/05-INTEGRATION-GUIDE.md §5 (load, save, copies, assets,
// the canvas member list, @mention notifications). Zero dependencies.
//
// People (docs/21 revision 2): the access table on the files page IS the member list. It goes
// into the launch token (`members`) and is served at `GET /files/:id/members`. Everyone with
// access sees real names; e-mail is never sent. There are two people called Asha Rao.
//
//   node server.mjs            # http://localhost:4000
//   OC_SERVER=http://localhost:8080 OC_SECRET=dev-secret-change-me node server.mjs
//   OC_SERVER_INTERNAL  where this process reaches OpenCanvas (default OC_SERVER; compose: http://opencanvas:8080)
//   OC_API_KEY          the host api_key from opencanvas.hosts.toml (server-to-server role API)
//   SAMPLE_HOST_TEST=1  enables POST /__test/files/:id/bump (e2e only: an out-of-band save that
//                       bumps the version, so the next autosave from OpenCanvas gets a 409),
//                       POST /__test/files/:id/members {source: "both"|"token"|"callback"|"none"}
//                       (where the member list comes from) and
//                       POST /__test/users/:id {name?} (rename someone in the host)

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const PORT = Number(process.env.PORT || 4000);
const OC_SERVER = process.env.OC_SERVER || "http://localhost:8080";
const SECRET = process.env.OC_SECRET || "dev-secret-change-me";
const HOST_ID = process.env.OC_HOST_ID || "sample";
const OC_INTERNAL = process.env.OC_SERVER_INTERNAL || OC_SERVER;
const API_KEY = process.env.OC_API_KEY || "dev-api-key-change-me";
const DATA = path.resolve(process.env.DATA_DIR || "./data");
const SELF = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const TEST_HOOKS = process.env.SAMPLE_HOST_TEST === "1";
// docs/05 §2d: offline copies. The host's `[host.offline]` must be on too; `perms.offline` is
// this host's per-launch decision (here: always, a real app says no for shared sessions).
const OFFLINE = process.env.OC_HOST_OFFLINE === "1";
fs.mkdirSync(path.join(DATA, "files"), { recursive: true });
fs.mkdirSync(path.join(DATA, "assets"), { recursive: true });

// `detail` is the second line OpenCanvas shows to tell people apart (docs/21).
const USERS = {
  u_priya: { id: "u_priya", name: "Priya Shah", detail: "Product · Mumbai" },
  u_asha: { id: "u_asha", name: "Asha Rao", detail: "Design · Bengaluru" },
  u_asha2: { id: "u_asha2", name: "Asha Rao", detail: "Finance · Pune" },
  u_ravi: { id: "u_ravi", name: "Ravi Menon", detail: "Engineering · Kochi" },
  u_sam: { id: "u_sam", name: "Sam Ortiz", detail: "Partner agency · Lisbon" },
};
// A member as OpenCanvas sees them: id, name, second line. Never an e-mail.
const memberOf = id => ({ id, name: USERS[id].name, detail: USERS[id].detail });
const membersOf = f => Object.keys(f.acl).filter(id => USERS[id] && f.acl[id] !== "none").map(memberOf);
const fold = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// ---------- tiny persistent "database" for file metadata + ACL ----------
const metaPath = path.join(DATA, "meta.json");
let meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : { files: {} };
meta.index ??= {}; // fileId -> search.json of its last save (SRCH-05)
meta.mentions ??= {}; // fileId -> newest first: {key, by, mentioned, blockId, threadId, excerpt, at}
const saveMeta = () => fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
if (!Object.keys(meta.files).length) {
  meta.files.doc_welcome = { id: "doc_welcome", name: "Sprint 42 planning", version: 0, updatedAt: null,
    acl: { u_priya: "edit", u_asha: "edit", u_asha2: "comment", u_ravi: "comment", u_sam: "view" } };
  saveMeta();
}
// Where the member list comes from (e2e switch; default both the token and the callback).
const sourceOf = f => f?.memberSource ?? "both";
const filePath = id => path.join(DATA, "files", id.replace(/[^\w-]/g, "") + ".ocanvas");
const versionPath = (id, v) => path.join(DATA, "versions", id.replace(/[^\w-]/g, ""), String(v).replace(/\D/g, "") + ".ocanvas");

// Every save is a version (docs/30 §4). The headers say what it is: X-OpenCanvas-Autosave 0 =
// named or restore (X-OpenCanvas-Commit-Message is its name), X-OpenCanvas-Checkpoint 1 = worth
// keeping. Like a real host, we prune: automatic non-checkpoint saves beyond the newest 20 go.
function keepVersion(f, body, h) {
  const dec = v => { try { return v ? decodeURIComponent(String(v)) : undefined; } catch { return undefined; } };
  const name = dec(h["x-opencanvas-commit-message"]);
  const restoredFrom = dec(h["x-opencanvas-restored-from"]);
  const kind = h["x-opencanvas-autosave"] === "0" ? (restoredFrom ? "restore" : "named") : "auto";
  const v = { version: String(f.version), at: new Date().toISOString(), authors: f.authors || [], kind, size: body.length,
    ...(name ? { name: name.slice(0, 120) } : {}), ...(restoredFrom ? { restoredFrom } : {}),
    checkpoint: h["x-opencanvas-checkpoint"] === "1" };
  fs.mkdirSync(path.dirname(versionPath(f.id, v.version)), { recursive: true });
  fs.writeFileSync(versionPath(f.id, v.version), body);
  f.versions = [...(f.versions || []), v];
  const loose = f.versions.filter(x => x.kind === "auto" && !x.checkpoint);
  for (const x of loose.slice(0, Math.max(0, loose.length - 20))) {
    fs.rmSync(versionPath(f.id, x.version), { force: true });
    f.versions = f.versions.filter(y => y !== x);
  }
}

// ---------- crypto helpers ----------
const b64u = b => Buffer.from(b).toString("base64url");
function signJwt(claims) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(claims));
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
// The callback token is opaque to OpenCanvas; here it is an HMAC binding user + file.
const callbackToken = (fileId, userId) => `${userId}.${crypto.createHmac("sha256", SECRET).update(`cb:${fileId}:${userId}`).digest("hex").slice(0, 32)}`;
function checkCallback(req, fileId, body) {
  const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
  // Scheduled automation runs (AUTO-03) load and save with no bearer: the v2 signature is the
  // proof, and the call acts as the host's own service (docs/05 §5).
  if (!auth) return checkSigned(req, body) ? { ok: true, userId: null, service: true } : { ok: false, why: "bad signature" };
  const [userId] = auth.split(".");
  if (!userId || auth !== callbackToken(fileId, userId)) return { ok: false, why: "bad callback token" };
  const sigHdr = req.headers["x-opencanvas-signature"] || "";
  const t = /t=(\d+)/.exec(sigHdr)?.[1], v1 = /v1=([0-9a-f]+)/.exec(sigHdr)?.[1];
  if (!t || !v1) return { ok: false, why: "missing signature" };
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return { ok: false, why: "stale signature" };
  // v2 also binds the method and path (docs/05 §5); prefer it, fall back to v1 for old servers.
  const v2 = /v2=([0-9a-f]+)/.exec(sigHdr)?.[1];
  const signed = v2 ? `${t}.${req.method}.${req.url}.` : `${t}.`;
  const want = crypto.createHmac("sha256", SECRET).update(Buffer.concat([Buffer.from(signed), body || Buffer.alloc(0)])).digest("hex");
  const got = v2 || v1;
  if (want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) return { ok: false, why: "bad signature" };
  return { ok: true, userId };
}

function launchToken(fileId, userId) {
  const f = meta.files[fileId], role = f.acl[userId], u = USERS[userId];
  const now = Math.floor(Date.now() / 1000);
  // The access table is the member list (docs/21 revision 2).
  const members = ["both", "token"].includes(sourceOf(f)) ? membersOf(f) : undefined;
  return signJwt({
    iss: HOST_ID, aud: "opencanvas", iat: now, exp: now + 600, jti: crypto.randomUUID(),
    file: { id: f.id, name: f.name, version: String(f.version) },
    user: { id: userId, name: u.name, detail: u.detail },
    ...(members ? { members } : {}),
    role, mode: role === "view" ? "view" : "edit",
    // perms.automate (AUTO-01): editors may create automation rules (Sam, the partner, may not).
    perms: { export: true, download: true, comment: role !== "view", mention: true, live: true, ...(OFFLINE ? { offline: true } : {}), automate: role === "edit" && userId !== "u_sam" },
    callbackToken: callbackToken(fileId, userId),
  });
}

// ---------- server-to-server: host → OpenCanvas (docs/05 §7) ----------
async function pushRole(fileId, userId, role) {
  try {
    const r = await fetch(`${OC_INTERNAL}/v1/files/${encodeURIComponent(fileId)}/role`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencanvas-host": HOST_ID, "x-opencanvas-key": API_KEY },
      body: JSON.stringify({ userId, role }),
    });
    console.log(`role ${fileId} ${userId}=${role} -> ${r.status} ${await r.text()}`);
  } catch (e) { console.warn(`role API unreachable: ${e.message}`); }
}
async function invalidateMembers(fileId) {
  try {
    await fetch(`${OC_INTERNAL}/v1/files/${encodeURIComponent(fileId)}/members/invalidate`, {
      method: "POST",
      headers: { "x-opencanvas-host": HOST_ID, "x-opencanvas-key": API_KEY },
    });
  } catch (e) { console.warn(`members invalidate unreachable: ${e.message}`); }
}

// ---------- http plumbing ----------
const readBody = req => new Promise((res, rej) => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => res(Buffer.concat(c))); req.on("error", rej); });
const send = (res, code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function parseMultipart(buf, ctype) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype || "");
  if (!boundary) return null;
  const sep = Buffer.from("--" + (boundary[1] || boundary[2]));
  let start = buf.indexOf(sep);
  while (start !== -1) {
    const next = buf.indexOf(sep, start + sep.length);
    if (next === -1) break;
    const part = buf.subarray(start + sep.length + 2, next - 2);
    const headEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, headEnd).toString();
    if (/name="file"/.test(head)) {
      return { name: /filename="([^"]*)"/.exec(head)?.[1] || "upload", mime: /content-type:\s*(\S+)/i.exec(head)?.[1] || "application/octet-stream", data: part.subarray(headEnd + 4) };
    }
    start = next;
  }
  return null;
}

// Team templates (TPL-01, docs/05 §5): the gallery's "From your team" section. A real host
// would keep these per team (and may answer `.ocanvas` files); these are Markdown.
const TEAM_TEMPLATES = [
  {
    id: "acme-weekly", name: "Acme weekly sync", description: "Our Monday agenda: wins, metrics, risks and owners.",
    category: "Meetings", icon: "calendar", tone: "blue", updatedAt: "2026-11-20T09:00:00Z",
    body: "# Acme weekly sync\n\n> Keep it to 30 minutes. Long topics go to their own canvas.\n\n## Wins\n\n- \n\n## Metrics\n\n| Metric | Last week | This week |\n| --- | --- | --- |\n| Active teams | | |\n| Tickets closed | | |\n\n## Risks\n\n- [ ] \n\n## Owners and next steps\n\n- [ ] \n",
  },
  {
    id: "acme-incident", name: "Acme incident review", description: "Timeline, impact, root cause and follow-ups, the Acme way.",
    category: "Engineering", icon: "siren", tone: "red", updatedAt: "2026-11-18T14:30:00Z",
    body: "# Incident review\n\n## Impact\n\nWho was affected, for how long, and was any data lost?\n\n## Timeline (UTC)\n\n| Time | Event |\n| --- | --- |\n| | |\n\n## Root cause\n\n## Follow-ups\n\n- [ ] \n",
  },
];

/** Like checkCallback, for calls that are not about one file: the bearer must be a callback
 *  token we issued to this user for any file. */
/** A signed callback without a bearer (`POST /access`): the signature is the proof. */

// Live blocks (docs/05 §2c, LIVE-01/03): `/access` answers for any file and person; `POST /files`
// creates a live block's file next to its canvas, with the canvas's people.
async function accessCallback(req, res) {
  const body = await readBody(req);
  if (!checkSigned(req, body)) return send(res, 401, { error: "bad signature" });
  let q; try { q = JSON.parse(body.toString("utf8")); } catch { return send(res, 400, { error: "expected JSON" }); }
  if (meta.deleted?.[q.fileId]) return send(res, 410, { error: "deleted" });
  const f = meta.files[q.fileId];
  const role = f?.acl[q.userId] || "none";
  if (role === "none") return send(res, 200, { role: "none" });
  // `path` (optional, ≤ 200 characters, shown as text): where the file lives, for the live
  // block's header ("from Acme Docs › Sprint planning"). Ours: the canvas a live file was made in.
  const where = f.path || (f.parent && meta.files[f.parent] ? `Acme Docs › ${meta.files[f.parent].name}` : "");
  return send(res, 200, { role, name: f.name, ...(where ? { path: where.slice(0, 200) } : {}), callbackToken: callbackToken(f.id, q.userId) });
}

// Links (docs/05 §2d-bis, LINK-03): many `/access` answers in one call, for "Linked from" and
// the graph. A deleted file is `{fileId, gone: true}`; a file someone cannot open is `none`.
function accessAnswer(fileId, userId) {
  if (meta.deleted?.[fileId]) return { fileId, gone: true };
  const f = meta.files[fileId];
  const role = f?.acl[userId] || "none";
  if (role === "none") return { fileId, role: "none" };
  const where = f.path || (f.parent && meta.files[f.parent] ? `Acme Docs › ${meta.files[f.parent].name}` : "");
  return { fileId, role, name: f.name, ...(where ? { path: where.slice(0, 200) } : {}), ...(f.updatedAt ? { updatedAt: f.updatedAt } : {}), callbackToken: callbackToken(f.id, userId) };
}

async function accessBatchCallback(req, res) {
  const body = await readBody(req);
  if (!checkSigned(req, body)) return send(res, 401, { error: "bad signature" });
  let q; try { q = JSON.parse(body.toString("utf8")); } catch { return send(res, 400, { error: "expected JSON" }); }
  const ids = Array.isArray(q.fileIds) ? q.fileIds.slice(0, 200).map(String) : [];
  return send(res, 200, { items: ids.map((id) => accessAnswer(id, String(q.userId || ""))) });
}

async function createFileCallback(req, res) {
  const body = await readBody(req);
  let q; try { q = JSON.parse(body.toString("utf8")); } catch { return send(res, 400, { error: "expected JSON" }); }
  const parent = meta.files[q.parentFileId];
  if (!parent) return send(res, 404, { error: "no such canvas" });
  const auth = checkCallback(req, parent.id, body);
  if (!auth.ok) return send(res, 401, { error: auth.why });
  if (parent.acl[auth.userId] !== "edit") return send(res, 403, { error: "read only" });
  const key = req.headers["idempotency-key"];
  meta.created ??= {};
  if (key && meta.created[key]) return send(res, 201, { fileId: meta.created[key] });
  const id = "doc_" + crypto.randomBytes(4).toString("hex");
  meta.files[id] = { id, name: String(q.name || "Live block").slice(0, 200), version: 0, updatedAt: null, acl: { ...parent.acl }, live: true, parent: parent.id };
  if (key) meta.created[key] = id;
  saveMeta();
  console.log(`live block file ${id} for ${parent.id}`);
  return send(res, 201, { fileId: id });
}

function checkUserCallback(req) {
  const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
  const fileId = Object.keys(meta.files).find(id => auth === callbackToken(id, auth.split(".")[0]));
  return fileId ? checkCallback(req, fileId, Buffer.alloc(0)) : { ok: false, why: "bad callback token" };
}

// ---------- search (SRCH-05, ADR-065): we index search.json from each save ----------
// One entry of a zip (stored or deflated), from its central directory. Enough for .ocanvas.
function zipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    if (buf.toString("utf8", p + 46, p + 46 + nlen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: 4 * 1024 * 1024 });
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}
// The searchable lines of one canvas: text blocks with their heading trail, database rows, board text.
function indexFile(fileId, body) {
  try {
    const sj = JSON.parse(zipEntry(body, "search.json")?.toString("utf8") || "null");
    if (!sj || sj.v !== 1) return;
    const lines = [];
    for (const b of sj.blocks || []) lines.push({ blockId: b.id, trail: (b.path || []).join(" › "), text: b.text });
    for (const d of sj.databases || []) for (const r of d.rows || []) lines.push({ trail: d.title, text: r.text });
    for (const bd of sj.boards || []) for (const t of [].concat(bd.text || [])) lines.push({ trail: "Board", text: t });
    meta.index[fileId] = { title: sj.title || "", lines };
  } catch (e) { console.warn("could not index", fileId, e.message); }
}
// Signed like every callback (v2 binds method, path and query, so `userId` can be trusted).
function checkSigned(req, body) {
  const sig = req.headers["x-opencanvas-signature"] || "";
  const t = /t=(\d+)/.exec(sig)?.[1], v2 = /v2=([0-9a-f]+)/.exec(sig)?.[1];
  if (!t || !v2 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const want = crypto.createHmac("sha256", SECRET).update(Buffer.concat([Buffer.from(`${t}.${req.method}.${req.url}.`), body || Buffer.alloc(0)])).digest("hex");
  return want.length === v2.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(v2));
}
function search(userId, q, limit = 20) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const items = [];
  for (const f of Object.values(meta.files)) {
    const role = f.acl[userId];
    if (!role || role === "none") continue; // our ACL decides
    const ix = meta.index[f.id];
    if (!ix) continue;
    const hay = l => fold(`${ix.title} ${l.trail} ${l.text}`);
    const hits = ix.lines.filter(l => words.every(w => hay(l).includes(w))).slice(0, 3);
    for (const l of hits) items.push({ fileId: f.id, title: ix.title || f.name, path: l.trail || "", blockId: l.blockId, snippet: l.text.slice(0, 300), updatedAt: f.updatedAt });
  }
  return items.slice(0, limit);
}

// ---------- callbacks: OpenCanvas → host ----------
async function callbacks(req, res, url) {
  if (url.pathname === "/api/opencanvas/templates" && req.method === "GET") {
    const auth = checkUserCallback(req);
    if (!auth.ok) return send(res, 401, { error: auth.why });
    return send(res, 200, TEAM_TEMPLATES.map(({ body, ...t }) => t));
  }
  const tpl = url.pathname.match(/^\/api\/opencanvas\/templates\/([\w.-]+)$/);
  if (tpl && req.method === "GET") {
    const auth = checkUserCallback(req);
    if (!auth.ok) return send(res, 401, { error: auth.why });
    const t = TEAM_TEMPLATES.find(x => x.id === tpl[1]);
    if (!t) return send(res, 404, { error: "no such template" });
    return send(res, 200, t.body, { "content-type": "text/markdown; charset=utf-8" });
  }
  if (url.pathname === "/api/opencanvas/mentions" && req.method === "POST") return mentionCallback(req, res);
  if (url.pathname === "/api/opencanvas/search" && req.method === "GET") {
    if (!checkSigned(req)) return send(res, 401, { error: "bad signature" });
    const userId = url.searchParams.get("userId") || "";
    const items = search(userId, url.searchParams.get("q") || "", Math.min(50, Number(url.searchParams.get("limit")) || 20));
    return send(res, 200, { items, scopes: [{ id: "all", label: "All canvases" }], partial: false, next: null });
  }
  if (url.pathname === "/api/opencanvas/access" && req.method === "POST") return accessCallback(req, res);
  if (url.pathname === "/api/opencanvas/access/batch" && req.method === "POST") return accessBatchCallback(req, res);
  if (url.pathname === "/api/opencanvas/files" && req.method === "POST") return createFileCallback(req, res);
  // The member list (docs/21 revision 2): everyone with access to this file, filtered by `q`.
  const mem = url.pathname.match(/^\/api\/opencanvas\/files\/([\w-]+)\/members$/);
  if (mem && req.method === "GET") {
    const f = meta.files[mem[1]];
    if (!f) return send(res, 404, { error: "no such file" });
    if (!["both", "callback"].includes(sourceOf(f))) return send(res, 404, { error: "members callback off (e2e)" });
    const auth = checkCallback(req, f.id, Buffer.alloc(0));
    if (!auth.ok) return send(res, 401, { error: auth.why });
    const q = fold(url.searchParams.get("q") || "");
    const limit = Math.min(500, Number(url.searchParams.get("limit")) || 500);
    return send(res, 200, membersOf(f).filter(p => fold(p.name).includes(q) || fold(p.detail || "").includes(q)).slice(0, limit));
  }
  // Version history (docs/05 §5, docs/30 §3.1): the list, newest first, and one version's bytes.
  const vl = url.pathname.match(/^\/api\/opencanvas\/files\/([\w-]+)\/versions(?:\/(\d+))?$/);
  if (vl && req.method === "GET") {
    const f = meta.files[vl[1]];
    if (!f) return send(res, 404, { error: "no such file" });
    const auth = checkCallback(req, f.id, Buffer.alloc(0));
    if (!auth.ok) return send(res, 401, { error: auth.why });
    const all = [...(f.versions || [])].reverse();
    if (vl[2]) {
      const v = all.find(x => x.version === vl[2]);
      const p = versionPath(f.id, vl[2]);
      if (!v || !fs.existsSync(p)) return send(res, 410, { error: "version expired" });
      return send(res, 200, fs.readFileSync(p), { "content-type": "application/vnd.opencanvas+zip" });
    }
    const limit = Math.min(100, Number(url.searchParams.get("limit")) || 50);
    const from = Number(url.searchParams.get("cursor")) || 0;
    const page = all.slice(from, from + limit);
    return send(res, 200, { versions: page, ...(from + limit < all.length ? { next: String(from + limit) } : {}) });
  }
  const m = url.pathname.match(/^\/api\/opencanvas\/files\/([\w-]+)(\/assets|\/copies)?$/);
  const body = req.method === "GET" ? Buffer.alloc(0) : await readBody(req);
  if (m) {
    const [, fileId, sub] = m;
    const assets = sub === "/assets", copies = sub === "/copies";
    const f = meta.files[fileId];
    if (!f) return send(res, 404, { error: "no such file" });
    const auth = checkCallback(req, fileId, body);
    if (!auth.ok) { console.warn("callback rejected:", auth.why); return send(res, 401, { error: auth.why }); }
    if (!assets && req.method === "GET") {
      if (!fs.existsSync(filePath(fileId))) return send(res, 404, { error: "empty" });
      return send(res, 200, fs.readFileSync(filePath(fileId)), { "content-type": "application/vnd.opencanvas+zip", etag: `"${f.version}"` });
    }
    if (!assets && req.method === "PUT") {
      if (!auth.service && f.acl[auth.userId] !== "edit" && f.acl[auth.userId] !== "comment") return send(res, 403, { error: "read only" });
      const ifMatch = (req.headers["if-match"] || "").replace(/"/g, "");
      if (ifMatch && ifMatch !== String(f.version)) return send(res, 409, { version: String(f.version) });
      fs.writeFileSync(filePath(fileId), body);
      f.version += 1; f.updatedAt = new Date().toISOString();
      f.authors = JSON.parse(req.headers["x-opencanvas-authors"] || "[]");
      keepVersion(f, body, req.headers);
      indexFile(fileId, body);
      saveMeta();
      console.log(`saved ${fileId} v${f.version} (${body.length} bytes, autosave=${req.headers["x-opencanvas-autosave"] || 0})`);
      return send(res, 200, { version: String(f.version) });
    }
    if (copies && req.method === "POST") {
      // Conflict policy "copy": keep the session's version as a new file with the same ACL.
      if (f.acl[auth.userId] !== "edit" && f.acl[auth.userId] !== "comment") return send(res, 403, { error: "read only" });
      const id = "doc_" + crypto.randomBytes(4).toString("hex");
      meta.files[id] = { id, name: `${f.name} (copy)`, version: 1, updatedAt: new Date().toISOString(), acl: { ...f.acl } };
      fs.writeFileSync(filePath(id), body);
      saveMeta();
      console.log(`copied ${fileId} -> ${id} after a conflict (${body.length} bytes)`);
      return send(res, 201, { fileId: id, url: `${SELF}/files/${id}` });
    }
    if (assets && req.method === "POST") {
      const part = parseMultipart(body, req.headers["content-type"]);
      if (!part) return send(res, 400, { error: "expected multipart field 'file'" });
      const id = "a_" + crypto.randomBytes(8).toString("hex");
      fs.writeFileSync(path.join(DATA, "assets", id), part.data);
      fs.writeFileSync(path.join(DATA, "assets", id + ".json"), JSON.stringify({ mime: part.mime, name: part.name }));
      return send(res, 201, { assetId: id, url: `${SELF}/assets/${id}`, mime: part.mime, size: part.data.length });
    }
  }
  send(res, 404, { error: "not found" });
}

// @mentions (docs/05 §5): OpenCanvas tells us who was mentioned; notifying them (mail, inbox,
// push) is our job. Here they are logged and listed on the file page.
async function mentionCallback(req, res) {
  const body = await readBody(req);
  let n;
  try { n = JSON.parse(body.toString("utf8")); } catch { return send(res, 400, { error: "expected JSON" }); }
  const f = typeof n?.fileId === "string" && meta.files[n.fileId];
  if (!f) return send(res, 404, { error: "no such file" });
  const auth = checkCallback(req, n.fileId, body);
  if (!auth.ok) { console.warn("callback rejected:", auth.why); return send(res, 401, { error: auth.why }); }
  const key = String(req.headers["idempotency-key"] || "");
  const list = (meta.mentions[n.fileId] ??= []);
  if (key && list.some(x => x.key === key)) return send(res, 200, { duplicate: true });
  // Only people who can open the file are told (the editor lists only them, but check anyway).
  const mentioned = (Array.isArray(n.mentioned) ? n.mentioned : []).filter(id => USERS[id] && f.acl[id]);
  list.unshift({ key, by: String(n.by || ""), mentioned, blockId: n.blockId ?? null, threadId: n.threadId ?? null, excerpt: String(n.excerpt || "").slice(0, 280), at: new Date().toISOString() });
  list.splice(50);
  saveMeta();
  console.log(`mention in ${n.fileId}: ${n.by} -> ${mentioned.join(", ") || "(nobody with access)"}${n.threadId ? " (comment)" : ""}`);
  send(res, 204, "");
}

const userName = id => (USERS[id] ? label(USERS[id]) : String(id).startsWith("automation:") ? "Automation" : id);
const mentionsFor = id => (meta.mentions[id] || []).map(({ key, ...m }) => ({ ...m, byName: userName(m.by), names: m.mentioned.map(userName) }));

// ---------- host UI ----------
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap">
<style>
:root{--bg:#f4f4f2;--card:#fff;--fg:#18181b;--mut:#71717a;--line:rgba(0,0,0,.09);--acc:#18181b}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e10;--card:#17171a;--fg:#ececef;--mut:#9a9aa4;--line:rgba(255,255,255,.09);--acc:#ececef}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 Geist,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:12px;height:52px;padding:0 20px;border-bottom:1px solid var(--line);background:var(--card)}
header b{font-weight:600}header .sp{flex:1}a{color:inherit}
select,button,input{font:inherit;color:inherit}
.btn{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);cursor:pointer}
.btn.pri{background:var(--acc);color:var(--bg);border-color:var(--acc)}
main{max-width:920px;margin:28px auto;padding:0 16px}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--line)}
td,th{padding:10px 14px;border-bottom:1px solid var(--line);text-align:left;font-size:13.5px}th{color:var(--mut);font-weight:500}
.mut{color:var(--mut)}
.frame{position:fixed;inset:52px 0 0 0}.frame iframe{width:100%;height:100%;border:0}
.ic{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.btn.ib{display:inline-flex;align-items:center;gap:6px}
.cnt{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--acc);color:var(--bg);font-size:11.5px;font-weight:600;display:inline-grid;place-items:center}
.cnt[hidden]{display:none}
.panel{position:fixed;top:60px;right:16px;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 80px);overflow:auto;background:var(--card);border-radius:12px;box-shadow:0 0 0 1px var(--line),0 12px 32px rgba(0,0,0,.18);padding:6px;z-index:5}
.panel[hidden]{display:none}.panel h2{font-size:13px;font-weight:600;margin:8px 10px}
.panel ol{list-style:none;margin:0;padding:0}.panel li{padding:10px;border-radius:8px}.panel li+li{border-top:1px solid var(--line)}
.panel q{display:block;margin-top:4px;color:var(--mut);quotes:none}.panel .row{display:flex;gap:8px;align-items:baseline}.panel .row b{font-weight:600}
.panel .go{margin-top:6px;height:28px;font-size:12.5px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:10px 14px;border-radius:10px;font-size:13px;max-width:calc(100vw - 32px);overflow-wrap:anywhere;z-index:6}
.toast[hidden]{display:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.dir{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}.dir label{display:inline-flex;gap:4px;align-items:center}
</style></head><body>${body}</body></html>`;

function whoFrom(url, req) {
  const c = /(?:^|;\s*)as=(\w+)/.exec(req.headers.cookie || "")?.[1];
  return USERS[url.searchParams.get("as")] ? url.searchParams.get("as") : USERS[c] ? c : "u_priya";
}
// Two people share a name: lists show the second line too.
const label = u => Object.values(USERS).some(o => o.id !== u.id && o.name === u.name) ? `${u.name} · ${u.detail}` : u.name;
const userPicker = (me, back) => `<form method="get" action="${back}" style="display:flex;gap:8px;align-items:center"><label class="mut" for="as">Signed in as</label><select id="as" name="as" onchange="this.form.submit()">${Object.values(USERS).map(u => `<option value="${u.id}" ${u.id === me ? "selected" : ""}>${esc(label(u))}</option>`).join("")}</select></form>`;


function home(res, me) {
  const rows = Object.values(meta.files).map(f => `<tr><td><a href="/files/${f.id}"><b>${esc(f.name)}</b></a></td><td>${esc(f.acl[me] || "none")}</td><td class="mut">v${f.version}${f.updatedAt ? " · " + new Date(f.updatedAt).toLocaleString() : ""}</td>
    <td><form method="post" action="/files/${f.id}/acl" style="display:flex;gap:6px;flex-wrap:wrap">${Object.values(USERS).map(u => `<label class="mut" title="${esc(label(u))}">${esc(u.name.split(" ")[0])}${u.name !== label(u) ? ` <small>(${esc(u.detail.split(" ")[0])})</small>` : ""} <select name="${u.id}">${["edit", "comment", "view", "none"].map(r => `<option ${(f.acl[u.id] || "none") === r ? "selected" : ""}>${r}</option>`).join("")}</select></label>`).join("")}<button class="btn">Save access</button></form></td></tr>`).join("");
  send(res, 200, page("Sample host", `<header><b>Sample host</b><span class="mut">stands in for your app</span><span class="sp"></span><a class="btn" href="/search">Search</a>${userPicker(me, "/")}</header>
  <main><div style="display:flex;align-items:center;margin-bottom:14px"><h2 style="margin:0;font-weight:600">Files</h2><span class="sp" style="flex:1"></span>
  <form method="post" action="/files"><input name="name" placeholder="New canvas name" style="height:32px;border-radius:8px;border:1px solid var(--line);padding:0 10px;background:var(--card)"> <button class="btn pri">New canvas</button></form></div>
  <table><tr><th>Name</th><th>Your access</th><th>Version</th><th>Access control (owned by the host)</th></tr>${rows}</table>
  <p class="mut">Open a file as one person, then switch the user above in another tab to see live collaboration. The host decides roles and stores every saved version.</p>
  <p class="mut">The access table is the canvas's member list: it goes into the launch token and is served at <code>/files/:id/members</code>. Only people with access can be mentioned. Reopen the file after a change.</p></main>`), { "content-type": "text/html; charset=utf-8", "set-cookie": `as=${me}; Path=/; SameSite=Lax` });
}

// The host's own search page: canvases next to everything else, with links to the block.
function searchPage(res, me, q) {
  const items = search(me, q, 50);
  const rows = items.map(i => `<li><a href="/files/${esc(i.fileId)}${i.blockId ? "#block=" + esc(i.blockId) : ""}"><b>${esc(i.title)}</b></a> <span class="mut">Canvas${i.path ? " · " + esc(i.path) : ""}</span><br><span>${esc(i.snippet)}</span></li>`).join("");
  send(res, 200, page("Search", `<header><a href="/" class="mut" style="text-decoration:none">← Files</a><b>Search</b><span class="sp"></span>${userPicker(me, "/search")}</header>
  <main><form method="get" action="/search" role="search"><label for="q" class="mut">Search canvases</label> <input id="q" name="q" value="${esc(q)}" style="height:32px;border-radius:8px;border:1px solid var(--line);padding:0 10px;background:var(--card)"> <button class="btn pri">Search</button></form>
  ${q ? `<p class="mut">${items.length} result${items.length === 1 ? "" : "s"}</p><ol id="results">${rows}</ol>` : ""}</main>`), { "content-type": "text/html; charset=utf-8" });
}

function openFile(res, me, id) {
  const f = meta.files[id];
  if (!f) return send(res, 404, page("Not found", "<main>No such file.</main>"), { "content-type": "text/html" });
  const role = f.acl[me];
  if (!role || role === "none") return send(res, 403, page("No access", `<header><a href="/">← Files</a></header><main><h2>You don't have access</h2><p class="mut">${esc(USERS[me].name)} has no role on “${esc(f.name)}”. Change it on the files page.</p></main>`), { "content-type": "text/html; charset=utf-8" });
  const token = launchToken(id, me);
  // Lucide "at-sign" (ISC licence), inlined: this page has no build step.
  const at = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>`;
  const ocOrigin = new URL(OC_SERVER).origin;
  send(res, 200, page(f.name, `<header><a href="/" class="mut" style="text-decoration:none">← Files</a><b>${esc(f.name)}</b><span class="mut">${esc(role)}</span><span class="sp"></span>
  <button class="btn ib" id="mbtn" aria-expanded="false" aria-controls="mpanel">${at}Mentions <span class="cnt" id="mcnt" hidden></span></button>
  ${userPicker(me, "/files/" + id)}</header>
  <section class="panel" id="mpanel" hidden aria-label="Mentions"><h2>Mentions in this canvas</h2><ol id="mlist"></ol></section>
  <div class="toast" id="toast" role="status" hidden></div>
  <dialog id="livepick" aria-label="Insert a live block"><h2>Insert a live block</h2><ul style="list-style:none;padding:0;display:grid;gap:6px"></ul><button class="btn" data-cancel>Cancel</button></dialog>
  <form id="oc" method="post" target="oc" action="${OC_SERVER}/v1/launch"><input type="hidden" name="token" value="${token}"><input type="hidden" name="block" id="block">${OFFLINE ? '<input type="hidden" name="offline" value="1">' : ""}</form>
  <div class="frame"><iframe name="oc" title="Canvas" allow="clipboard-read; clipboard-write; fullscreen"></iframe></div>
  <script>
  const OC = ${JSON.stringify(ocOrigin)}, FILE = ${JSON.stringify(id)}, frame = document.querySelector('iframe[name=oc]');
  // A link to a block (#block=b_…) opens the canvas there: the launch passes it on.
  const linked = new URLSearchParams(location.hash.slice(1)).get('block');
  if (linked) document.getElementById('block').value = linked;
  document.getElementById('oc').submit();
  const post = (MessageId, Values = {}) => frame.contentWindow.postMessage({ MessageId, SendTime: Date.now(), Values }, OC);
  const toast = document.getElementById('toast'); let tt;
  // A fresh token; no access any more answers {access: "none"} (docs/05 §4c, the offline reconnect).
  window.ocRenew = () => fetch('/files/' + FILE + '/token', { method: 'POST' }).then(r => r.status === 403 ? post('Action_RefreshToken', { access: 'none' }) : r.json().then(j => post('Action_RefreshToken', { token: j.token })));
  const say = t => { toast.textContent = t; toast.hidden = false; clearTimeout(tt); tt = setTimeout(() => toast.hidden = true, 4000); };
  addEventListener('message', e => {
    if (e.origin !== OC || e.source !== frame.contentWindow) return;
    const { MessageId, Values = {} } = e.data || {};
    console.log('[opencanvas]', MessageId, Values);
    if (MessageId === 'App_LoadingStatus' && Values.Status === 'Frame_Ready') post('Host_PostmessageReady');
    // Access running out: renew it quietly with a fresh token (docs/05 §4, PERM-07).
    // window.ocHoldRefresh (tests) holds the answer back, like a slow or unwilling host.
    if (MessageId === 'Token_Expiring') {
      document.body.dataset.tokenExpiring = String((Number(document.body.dataset.tokenExpiring) || 0) + 1);
      if (!window.ocHoldRefresh) window.ocRenew();
    }
    // "Search all canvases" opened a result in another canvas (docs/05 §4, SRCH-04).
    if (MessageId === 'UI_OpenFile' && /^[A-Za-z0-9_-]{1,64}$/.test(Values.fileId || '')) {
      const b = /^[A-Za-z0-9_-]{1,64}$/.test(Values.blockId || '') ? '#block=' + Values.blockId : '';
      const href = '/files/' + Values.fileId + b;
      if (Values.newTab) window.open(href, '_blank', 'noopener'); else location.href = href;
    }
    // "Copy link to block": we own the URLs, so we build the link (docs/05 §4).
    // Live blocks (docs/05 §4): our own picker lists the live blocks this person can open.
    if (MessageId === 'UI_PickLiveBlock') { post('Action_LiveBlockPicker', { state: 'open' }); pickLive(); }
    if (MessageId === 'UI_LiveBlockOpen') { document.body.dataset.liveOpen = Values.fileId + (Values.blockId ? '#' + Values.blockId : '') + (Values.reason ? ':' + Values.reason : ''); say('Opening ' + Values.fileId); }
    if (MessageId === 'UI_BlockLink' && Values.fileId === FILE && /^[A-Za-z0-9_-]{1,64}$/.test(Values.blockId || '')) {
      const url = location.origin + '/files/' + FILE + '#block=' + Values.blockId;
      navigator.clipboard?.writeText(url).catch(() => {});
      document.body.dataset.blockLink = url;
      say('Link copied: ' + url);
    }
  });
  const dlg = document.getElementById('livepick');
  async function pickLive() {
    const r = await fetch('/files/live.json', { cache: 'no-store' }); const files = await r.json();
    dlg.querySelector('ul').innerHTML = files.map(f => '<li><button class="btn" data-id="' + escH(f.id) + '" data-name="' + escH(f.name) + '">' + escH(f.name) + '</button></li>').join('') || '<li class="mut">No live blocks yet.</li>';
    dlg.showModal();
  }
  dlg.addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (b) { dlg.close(); post('Action_InsertLiveBlock', { fileId: b.dataset.id, title: b.dataset.name }); }
    if (e.target.closest('button[data-cancel]')) { dlg.close(); post('Action_LiveBlockPicker', { state: 'cancel' }); }
  });
  // Mentions list (our callback stores them; a real app would notify people).
  const btn = document.getElementById('mbtn'), panel = document.getElementById('mpanel'), list = document.getElementById('mlist'), cnt = document.getElementById('mcnt');
  const escH = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const when = s => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let seen = -1;
  async function refresh() {
    try {
      const r = await fetch('/files/' + FILE + '/mentions.json', { cache: 'no-store' });
      if (!r.ok) return;
      const items = await r.json();
      cnt.hidden = !items.length; cnt.textContent = items.length;
      btn.setAttribute('aria-label', 'Mentions, ' + items.length);
      if (items.length === seen) return;
      seen = items.length;
      list.innerHTML = items.length ? items.map(m => '<li><div class="row"><b>' + escH(m.byName) + '</b><span class="mut">mentioned ' + escH(m.names.join(', ') || 'nobody with access') + (m.threadId ? ' in a comment' : '') + ' · ' + when(m.at) + '</span></div><q>' + escH(m.excerpt) + '</q>' + (m.blockId ? '<button class="btn go" data-block="' + escH(m.blockId) + '">Show in canvas</button>' : '') + '</li>').join('') : '<li class="mut">Nobody has been mentioned yet. Type @ in the canvas or a comment.</li>';
    } catch {}
  }
  btn.onclick = () => { const open = panel.hidden; panel.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) refresh(); };
  list.onclick = e => { const b = e.target.closest('[data-block]'); if (b) post('Action_ScrollToBlock', { blockId: b.dataset.block }); };
  addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
  refresh(); setInterval(refresh, 3000);
  </script>`), { "content-type": "text/html; charset=utf-8", "set-cookie": `as=${me}; Path=/; SameSite=Lax` });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, SELF);
  try {
    if (url.pathname.startsWith("/api/opencanvas/")) return await callbacks(req, res, url);
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    // e2e: where a file's member list comes from, or rename someone in the host.
    const tsrc = TEST_HOOKS && req.method === "POST" && url.pathname.match(/^\/__test\/files\/([\w-]+)\/members$/);
    if (tsrc && meta.files[tsrc[1]]) {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      meta.files[tsrc[1]].memberSource = ["both", "token", "callback", "none"].includes(b.source) ? b.source : "both"; saveMeta();
      await invalidateMembers(tsrc[1]);
      return send(res, 200, { source: sourceOf(meta.files[tsrc[1]]) });
    }
    const tuser = TEST_HOOKS && req.method === "POST" && url.pathname.match(/^\/__test\/users\/(\w+)$/);
    if (tuser && USERS[tuser[1]]) {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      if (typeof b.name === "string" && b.name.trim()) USERS[tuser[1]].name = b.name.trim().slice(0, 80);
      return send(res, 200, USERS[tuser[1]]);
    }
    const bump = TEST_HOOKS && req.method === "POST" && url.pathname.match(/^\/__test\/files\/([\w-]+)\/bump$/);
    if (bump) {
      // Someone saved the file outside OpenCanvas: same bytes, newer version.
      const f = meta.files[bump[1]];
      if (!f) return send(res, 404, { error: "no such file" });
      f.version += 1; f.updatedAt = new Date().toISOString(); saveMeta();
      console.log(`test: bumped ${f.id} to v${f.version}`);
      return send(res, 200, { version: String(f.version) });
    }
    const asset = url.pathname.match(/^\/assets\/(a_[0-9a-f]+)$/);
    if (asset && fs.existsSync(path.join(DATA, "assets", asset[1]))) {
      const m = JSON.parse(fs.readFileSync(path.join(DATA, "assets", asset[1] + ".json"), "utf8"));
      return send(res, 200, fs.readFileSync(path.join(DATA, "assets", asset[1])), { "content-type": m.mime, "cache-control": "private, max-age=86400" });
    }
    const me = whoFrom(url, req);
    if (req.method === "POST" && url.pathname === "/files") {
      const name = new URLSearchParams((await readBody(req)).toString()).get("name")?.trim() || "Untitled canvas";
      const id = "doc_" + crypto.randomBytes(4).toString("hex");
      meta.files[id] = { id, name, version: 0, updatedAt: null, acl: { [me]: "edit" } }; saveMeta();
      res.writeHead(303, { location: `/files/${id}` }); return res.end();
    }
    const acl = url.pathname.match(/^\/files\/([\w-]+)\/acl$/);
    if (req.method === "POST" && acl && meta.files[acl[1]]) {
      const form = new URLSearchParams((await readBody(req)).toString());
      const file = meta.files[acl[1]], changed = [];
      for (const u of Object.keys(USERS)) {
        const r = form.get(u), before = file.acl[u] || "none";
        if (!r || r === before) continue;
        if (r === "none") delete file.acl[u]; else file.acl[u] = r;
        changed.push([u, r]);
      }
      saveMeta();
      // Tell OpenCanvas about live role changes (docs/05 §7): open sessions switch at once.
      await Promise.all(changed.map(([userId, role]) => pushRole(file.id, userId, role)));
      // The member list changed (docs/21 revision 2): drop OpenCanvas's cached copy.
      if (changed.length) await invalidateMembers(file.id);
      res.writeHead(303, { location: "/" }); return res.end();
    }
    // The live blocks this person can open, for our picker (LIVE-03, 1e).
    if (url.pathname === "/files/live.json") return send(res, 200, Object.values(meta.files).filter(f => f.live && f.acl[me] && f.acl[me] !== "none").map(f => ({ id: f.id, name: f.name })), { "cache-control": "no-store" });
    // e2e only: the host deletes a file (its /access answers 410 from now on).
    const del = TEST_HOOKS && req.method === "POST" && url.pathname.match(/^\/__test\/files\/([\w-]+)\/delete$/);
    if (del) { meta.deleted ??= {}; meta.deleted[del[1]] = true; delete meta.files[del[1]]; saveMeta(); return send(res, 200, { ok: true }); }
    const ml = url.pathname.match(/^\/files\/([\w-]+)\/mentions\.json$/);
    if (ml && meta.files[ml[1]]?.acl[me]) return send(res, 200, mentionsFor(ml[1]), { "cache-control": "no-store" });
    // docs/05 §4 Token_Expiring: a fresh launch token for the same person and file (PERM-07).
    const tk = req.method === "POST" && url.pathname.match(/^\/files\/([\w-]+)\/token$/);
    if (tk && meta.files[tk[1]]?.acl[me]) return send(res, 200, { token: launchToken(tk[1], me) }, { "cache-control": "no-store" });
    if (tk && meta.files[tk[1]]) return send(res, 403, { access: "none" }, { "cache-control": "no-store" });
    const fm = url.pathname.match(/^\/files\/([\w-]+)$/);
    if (fm) return openFile(res, me, fm[1]);
    if (url.pathname === "/search") return searchPage(res, me, url.searchParams.get("q") || "");
    if (url.pathname === "/signout") return send(res, 200, page("Signed out", `<main><h2 id="out">Signing out…</h2><p class="mut" id="what"></p>
  <iframe hidden src="${OC_SERVER}/v1/offline/clear?host=${encodeURIComponent(HOST_ID)}&user=${encodeURIComponent(me)}"></iframe>
  <script>addEventListener('message', e => { if (e.origin !== ${JSON.stringify(new URL(OC_SERVER).origin)} || !e.data || e.data.type !== 'OC_OfflineCleared') return;
    document.getElementById('out').textContent = 'You’re signed out';
    document.getElementById('what').textContent = e.data.removed ? 'Offline canvases were removed from this browser: ' + e.data.removed + '.' : 'Nothing was kept offline in this browser.';
    document.body.dataset.cleared = String(e.data.removed); });</script></main>`), { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/") return home(res, me);
    send(res, 404, { error: "not found" });
  } catch (e) { console.error(e); send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, () => console.log(`sample host on ${SELF} → OpenCanvas at ${OC_SERVER}`));
