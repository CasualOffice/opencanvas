// OpenCanvas sample host: a stand-in for your app (or any app embedding OpenCanvas).
// It owns users, per-file roles and the file store, signs launch tokens and
// implements the callbacks from docs/05-INTEGRATION-GUIDE.md §5. Zero dependencies.
//
//   node server.mjs            # http://localhost:4000
//   OC_SERVER=http://localhost:8080 OC_SECRET=dev-secret-change-me node server.mjs
//   OC_SERVER_INTERNAL  where this process reaches OpenCanvas (default OC_SERVER; compose: http://opencanvas:8080)
//   OC_API_KEY          the host api_key from opencanvas.hosts.toml (server-to-server role API)
//   SAMPLE_HOST_TEST=1  enables POST /__test/files/:id/bump (e2e only: an out-of-band save that
//                       bumps the version, so the next autosave from OpenCanvas gets a 409)

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 4000);
const OC_SERVER = process.env.OC_SERVER || "http://localhost:8080";
const SECRET = process.env.OC_SECRET || "dev-secret-change-me";
const HOST_ID = process.env.OC_HOST_ID || "sample";
const OC_INTERNAL = process.env.OC_SERVER_INTERNAL || OC_SERVER;
const API_KEY = process.env.OC_API_KEY || "dev-api-key-change-me";
const DATA = path.resolve(process.env.DATA_DIR || "./data");
const SELF = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const TEST_HOOKS = process.env.SAMPLE_HOST_TEST === "1";
fs.mkdirSync(path.join(DATA, "files"), { recursive: true });
fs.mkdirSync(path.join(DATA, "assets"), { recursive: true });

const USERS = {
  u_priya: { id: "u_priya", name: "Priya Shah" },
  u_asha: { id: "u_asha", name: "Asha Rao" },
  u_ravi: { id: "u_ravi", name: "Ravi Menon" },
  u_sam: { id: "u_sam", name: "Sam Ortiz" },
};

// ---------- tiny persistent "database" for file metadata + ACL ----------
const metaPath = path.join(DATA, "meta.json");
let meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : { files: {} };
const saveMeta = () => fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
if (!Object.keys(meta.files).length) {
  meta.files.doc_welcome = { id: "doc_welcome", name: "Sprint 42 planning", version: 0, updatedAt: null,
    acl: { u_priya: "edit", u_asha: "edit", u_ravi: "comment", u_sam: "view" } };
  saveMeta();
}
const filePath = id => path.join(DATA, "files", id.replace(/[^\w-]/g, "") + ".ocanvas");

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
  const [userId] = auth.split(".");
  if (!userId || auth !== callbackToken(fileId, userId)) return { ok: false, why: "bad callback token" };
  const sigHdr = req.headers["x-opencanvas-signature"] || "";
  const t = /t=(\d+)/.exec(sigHdr)?.[1], v1 = /v1=([0-9a-f]+)/.exec(sigHdr)?.[1];
  if (!t || !v1) return { ok: false, why: "missing signature" };
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return { ok: false, why: "stale signature" };
  const want = crypto.createHmac("sha256", SECRET).update(Buffer.concat([Buffer.from(`${t}.`), body || Buffer.alloc(0)])).digest("hex");
  if (want.length !== v1.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(v1))) return { ok: false, why: "bad signature" };
  return { ok: true, userId };
}

function launchToken(fileId, userId) {
  const f = meta.files[fileId], role = f.acl[userId];
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: HOST_ID, aud: "opencanvas", iat: now, exp: now + 600, jti: crypto.randomUUID(),
    file: { id: f.id, name: f.name, version: String(f.version) },
    user: { id: userId, name: USERS[userId].name },
    role, mode: role === "view" ? "view" : "edit",
    perms: { export: true, download: true, comment: role !== "view", mention: true },
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

// ---------- callbacks: OpenCanvas → host ----------
async function callbacks(req, res, url) {
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
      if (f.acl[auth.userId] !== "edit" && f.acl[auth.userId] !== "comment") return send(res, 403, { error: "read only" });
      const ifMatch = (req.headers["if-match"] || "").replace(/"/g, "");
      if (ifMatch && ifMatch !== String(f.version)) return send(res, 409, { version: String(f.version) });
      fs.writeFileSync(filePath(fileId), body);
      f.version += 1; f.updatedAt = new Date().toISOString();
      f.authors = JSON.parse(req.headers["x-opencanvas-authors"] || "[]");
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
  if (url.pathname === "/api/opencanvas/users" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const fid = url.searchParams.get("fileId");
    const list = Object.values(USERS).filter(u => (!fid || meta.files[fid]?.acl[u.id]) && u.name.toLowerCase().includes(q));
    return send(res, 200, list.map(u => ({ id: u.id, name: u.name, avatar: null })));
  }
  send(res, 404, { error: "not found" });
}

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
</style></head><body>${body}</body></html>`;

function whoFrom(url, req) {
  const c = /(?:^|;\s*)as=(\w+)/.exec(req.headers.cookie || "")?.[1];
  return USERS[url.searchParams.get("as")] ? url.searchParams.get("as") : USERS[c] ? c : "u_priya";
}
const userPicker = (me, back) => `<form method="get" action="${back}" style="display:flex;gap:8px;align-items:center"><span class="mut">Signed in as</span><select name="as" onchange="this.form.submit()">${Object.values(USERS).map(u => `<option value="${u.id}" ${u.id === me ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></form>`;

function home(res, me) {
  const rows = Object.values(meta.files).map(f => `<tr><td><a href="/files/${f.id}"><b>${esc(f.name)}</b></a></td><td>${esc(f.acl[me] || "none")}</td><td class="mut">v${f.version}${f.updatedAt ? " · " + new Date(f.updatedAt).toLocaleString() : ""}</td>
    <td><form method="post" action="/files/${f.id}/acl" style="display:flex;gap:6px">${Object.values(USERS).map(u => `<label class="mut" title="${esc(u.name)}">${u.name.split(" ")[0]} <select name="${u.id}">${["edit", "comment", "view", "none"].map(r => `<option ${(f.acl[u.id] || "none") === r ? "selected" : ""}>${r}</option>`).join("")}</select></label>`).join("")}<button class="btn">Save access</button></form></td></tr>`).join("");
  send(res, 200, page("Sample host", `<header><b>Sample host</b><span class="mut">stands in for your app</span><span class="sp"></span>${userPicker(me, "/")}</header>
  <main><div style="display:flex;align-items:center;margin-bottom:14px"><h2 style="margin:0;font-weight:600">Files</h2><span class="sp" style="flex:1"></span>
  <form method="post" action="/files"><input name="name" placeholder="New canvas name" style="height:32px;border-radius:8px;border:1px solid var(--line);padding:0 10px;background:var(--card)"> <button class="btn pri">New canvas</button></form></div>
  <table><tr><th>Name</th><th>Your access</th><th>Version</th><th>Access control (owned by the host)</th></tr>${rows}</table>
  <p class="mut">Open a file as one person, then switch the user above in another tab to see live collaboration. The host decides roles and stores every saved version.</p></main>`), { "content-type": "text/html; charset=utf-8", "set-cookie": `as=${me}; Path=/; SameSite=Lax` });
}

function openFile(res, me, id) {
  const f = meta.files[id];
  if (!f) return send(res, 404, page("Not found", "<main>No such file.</main>"), { "content-type": "text/html" });
  const role = f.acl[me];
  if (!role || role === "none") return send(res, 403, page("No access", `<header><a href="/">← Files</a></header><main><h2>You don't have access</h2><p class="mut">${esc(USERS[me].name)} has no role on “${esc(f.name)}”. Change it on the files page.</p></main>`), { "content-type": "text/html; charset=utf-8" });
  const token = launchToken(id, me);
  send(res, 200, page(f.name, `<header><a href="/" class="mut" style="text-decoration:none">← Files</a><b>${esc(f.name)}</b><span class="mut">${esc(role)}</span><span class="sp"></span>${userPicker(me, "/files/" + id)}</header>
  <form id="oc" method="post" target="oc" action="${OC_SERVER}/v1/launch"><input type="hidden" name="token" value="${token}"></form>
  <div class="frame"><iframe name="oc" title="Canvas" allow="clipboard-read; clipboard-write; fullscreen"></iframe></div>
  <script>document.getElementById('oc').submit();
  addEventListener('message',e=>{ if(e.origin!==${JSON.stringify(new URL(OC_SERVER).origin)}) return; console.log('[opencanvas]',e.data); });</script>`), { "content-type": "text/html; charset=utf-8", "set-cookie": `as=${me}; Path=/; SameSite=Lax` });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, SELF);
  try {
    if (url.pathname.startsWith("/api/opencanvas/")) return await callbacks(req, res, url);
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
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
      res.writeHead(303, { location: "/" }); return res.end();
    }
    const fm = url.pathname.match(/^\/files\/([\w-]+)$/);
    if (fm) return openFile(res, me, fm[1]);
    if (url.pathname === "/") return home(res, me);
    send(res, 404, { error: "not found" });
  } catch (e) { console.error(e); send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, () => console.log(`sample host on ${SELF} → OpenCanvas at ${OC_SERVER}`));
