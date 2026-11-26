#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""The website's API reference (API-DOCS-01): site/api/*.html, generated at site-build
time from the OpenAPI document (crates/oc-server/api/openapi.json) and the guides in
site/_src/api/*.md. Loaded by tools/build-site.py; standard library only.

- Guides (site/_src/api/<slug>.md, Markdown with a `<!--meta {...} -->` first line): the
  Markdown the documentation pages use, plus
      {{api:NAME}}        on a line of its own: a generated block (scopes, errors, ...)
      :::samples          fenced code blocks up to a line `:::`, shown as one sample with a
      ```bash ...```      language switch (bash/curl, ts, rust, python)
      :::
- Reference pages (site/api/reference/<tag>.html): one per OpenAPI tag, one section per
  operation (anchor = operationId) with its method and path, scope and role, parameters,
  request body, responses, error codes and code samples in curl, TypeScript
  (@opencanvas/client), Rust (opencanvas-client) and Python (requests).

The language switch and copy buttons are site/assets/site.js; the chosen language is kept
in localStorage per reader. Wide screens show navigation, content and samples side by side.
"""

from __future__ import annotations

import html
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import apilib  # noqa: E402
import sitelib  # noqa: E402

ROOT = sitelib.ROOT
GUIDE_SRC = sitelib.SRC / "api"
BASE = "https://canvas.example.com"
HOST_ID = "acme"

# (slug, title in the navigation). The page's own title comes from its meta header.
GUIDES = [
    ("index", "Overview"),
    ("authentication", "Authentication"),
    ("errors", "Errors"),
    ("pagination", "Pagination"),
    ("idempotency", "Idempotency"),
    ("rate-limits", "Rate limits"),
    ("events", "Events"),
    ("webhooks", "Webhooks"),
    ("sdks", "SDKs"),
    ("changelog", "Changelog"),
]

LANGS = [("curl", "curl"), ("ts", "TypeScript"), ("rust", "Rust"), ("python", "Python")]
FENCE_LANG = {"bash": "curl", "sh": "curl", "shell": "curl", "curl": "curl", "ts": "ts", "typescript": "ts",
              "rust": "rust", "rs": "rust", "python": "python", "py": "python"}


def _esc(s) -> str:
    return html.escape(str(s), quote=True)


# ---- Guides ----------------------------------------------------------------------------

def available_guides() -> list[tuple[str, str]]:
    return [g for g in GUIDES if g[0] == "changelog" or (GUIDE_SRC / f"{g[0]}.md").exists()]


def read_guide(slug: str) -> tuple[dict, str]:
    text = (GUIDE_SRC / f"{slug}.md").read_text(encoding="utf8")
    m = sitelib.META.match(text)
    if not m:
        raise SystemExit(f"build-api: site/_src/api/{slug}.md has no <!--meta {{...}} --> header")
    return json.loads(m.group(1)), text[m.end():]


_SAMPLE_SEQ = [0]


def sample_group(blocks: list[tuple], label: str = "Example") -> str:
    """One code sample with a language switch: blocks are (language key, code[, tab name]).
    The key is what the reader's choice remembers; the tab name defaults to the language's."""
    _SAMPLE_SEQ[0] += 1
    n = _SAMPLE_SEQ[0]
    labels = dict(LANGS)
    tabs, panels = [], []
    for i, (lang, code, *name) in enumerate(blocks):
        tid, pid = f"s{n}-{lang}-tab", f"s{n}-{lang}"
        sel = "true" if i == 0 else "false"
        tabs.append(f'<button type="button" role="tab" id="{tid}" aria-controls="{pid}" aria-selected="{sel}" '
                    f'tabindex="{0 if i == 0 else -1}" data-lang="{lang}">{_esc(name[0] if name else labels.get(lang, lang))}</button>')
        hidden = "" if i == 0 else " hidden"
        panels.append(f'<div role="tabpanel" id="{pid}" aria-labelledby="{tid}" data-lang="{lang}"{hidden}>'
                      f'<pre><code class="language-{lang}">{html.escape(code)}</code></pre></div>')
    return (f'<div class="sample" data-sample><div class="sample-bar"><span class="sample-label">{_esc(label)}</span>'
            f'<div class="sample-tabs" role="tablist" aria-label="{_esc(label)}: language">{"".join(tabs)}</div></div>'
            f'{"".join(panels)}</div>')


def _samples_blocks(body: str) -> list[tuple[str, str]]:
    out = []
    for m in re.finditer(r"^```(\w+)[^\n]*\n(.*?)^```\s*$", body, flags=re.S | re.M):
        lang = FENCE_LANG.get(m.group(1).lower())
        if not lang:
            raise SystemExit(f"build-api: unknown sample language {m.group(1)!r}")
        name = "Shell" if m.group(1).lower() in ("sh", "shell") else None
        out.append((lang, m.group(2).rstrip("\n")) + ((name,) if name else ()))
    return out


def render_guide(slug: str, spec: dict) -> tuple[str, str, str]:
    """(title, description, article HTML) of a Markdown guide."""
    meta, text = read_guide(slug)
    held: list[str] = []

    def hold(fragment: str) -> str:
        held.append(fragment)
        return f"\n\n@@API-HELD-{len(held) - 1}@@\n\n"

    def samples(m: re.Match) -> str:
        return hold(sample_group(_samples_blocks(m.group(2)), m.group(1).strip() or "Example"))
    text = re.sub(r"^:::samples ?(.*?)\n(.*?)^:::\s*$", samples, text, flags=re.S | re.M)
    text = re.sub(r"^\{\{api:([a-z-]+)\}\}\s*$", lambda m: hold(BLOCKS[m.group(1)](spec)), text, flags=re.M)
    body = sitelib.markdown(text, from_file=f"site/_src/api/{slug}.md", root="../")
    body = body.replace(f'href="{sitelib.BLOB}site/_src/', 'href="../')
    body = re.sub(r"<p>@@API-HELD-(\d+)@@</p>", lambda m: held[int(m.group(1))], body)
    # A guide may name an API page before it exists: the name stays, the link waits for it.
    pages = {f"{s}.html" for s, _ in available_guides()}
    pages |= {f"reference/{slug}.html" for _t, slug, _ti, _l in RESOURCES} if REFERENCE_ON else set()
    body = re.sub(r'<a href="\.\./api/([^"#]+)(#[^"]*)?">(.*?)</a>',
                  lambda m: m.group(0) if m.group(1) in pages else m.group(3), body)
    lede = f'<p class="lede">{sitelib.md_inline(meta["lede"], "", "../")}</p>' if meta.get("lede") else ""
    return meta["title"], meta["description"], f"<h1>{_esc(meta['title'])}</h1>\n{lede}\n{body}"


# ---- Generated blocks used by the guides -----------------------------------------------

def _table(head: list[str], rows: list[list[str]], label: str, cls: str = "",
           row_cls: list[str] | None = None) -> str:
    """A table that becomes one card per row on phones. The explicit ARIA roles keep it a
    table for screen readers when CSS changes its display; data-label names each cell there."""
    th = "".join(f'<th scope="col" role="columnheader">{h}</th>' for h in head)
    labels = [_esc(re.sub(r"<[^>]+>", "", h)) for h in head]
    trs = []
    for n, r in enumerate(rows):
        rc = f' class="{row_cls[n]}"' if row_cls and row_cls[n] else ""
        cells = "".join(f'<td role="cell" data-label="{labels[i] if i < len(labels) else ""}">{c}</td>' for i, c in enumerate(r))
        trs.append(f'<tr role="row"{rc}>{cells}</tr>')
    c = f' class="{cls}"' if cls else ""
    return (f'<div class="table-scroll" tabindex="0" role="region" aria-label="{_esc(label)}"><table role="table"{c}>'
            f'<thead role="rowgroup"><tr role="row">{th}</tr></thead><tbody role="rowgroup">{"".join(trs)}</tbody></table></div>')


def _inl(s: str, root: str = "../") -> str:
    return sitelib.md_inline(s or "", "", root)


SCOPE_ROLE = {"canvas:read": "view", "canvas:comment": "comment", "canvas:write": "edit", "canvas:admin": "host key"}


def block_scopes(spec: dict) -> str:
    """The scopes table: what each scope allows and which operations need it."""
    by: dict[str, list[str]] = {}
    for o in apilib.operations(spec):
        s = o["op"].get("x-opencanvas-scope")
        if s:
            by.setdefault(s, []).append(o["id"])
    what = {
        "canvas:read": "Read canvases, blocks, databases, boards, comments and members; export; stream events; a sync ticket with the view role.",
        "canvas:comment": "Everything `canvas:read` allows, and start or reply to comment threads.",
        "canvas:write": "Everything `canvas:comment` allows, and change blocks, databases and boards, and import. `canvas:write:direct` counts as `canvas:write`.",
        "canvas:admin": "Save now, change a user's role, close the session, drop cached members. Counts for tokens only when the host sets `[host.api] token_admin = true`; otherwise these are the host key's.",
    }
    rows = []
    for s in ("canvas:read", "canvas:comment", "canvas:write", "canvas:admin"):
        ops = ", ".join(op_ref(spec, i, "../") for i in by.get(s, []))
        role = SCOPE_ROLE[s]
        rows.append([f"<code>{s}</code>", _inl(what[s]), f"<code>{role}</code>" if role != "host key" else "host key, or a token with <code>canvas:admin</code>", ops])
    return _table(["Scope", "Allows", "Least role", "Operations"], rows, "Scopes", "api-table")


def block_errors(spec: dict) -> str:
    """Every error code, grouped: common, operation-specific, router fallbacks, 0.1 only."""
    cat = spec.get("x-opencanvas-error-codes", [])
    users: dict[str, list[str]] = {}
    for o in apilib.operations(spec):
        for c in o["op"].get("x-opencanvas-errors", []):
            users.setdefault(c, []).append(o["id"])
    groups = [
        ("common", "Any operation on a file", "Authentication, the API switch, rate limits and availability: every `/api/v1` operation on a file can answer these."),
        (None, "Operation-specific", "Each operation's section in the reference lists the ones it can answer."),
        ("general", "Router fallbacks", "Answers the router gives before an operation runs."),
        ("legacy", "0.1 routes only", "The deprecated `/v1/...` routes answer `{\"error\": {\"code\", \"message\"}}` with these and the codes above."),
    ]
    out = []
    for kind, title, intro in groups:
        rows = []
        for e in sorted((x for x in cat if x.get("kind") == kind), key=lambda x: (x["status"][:1] or [999], x["code"])):
            status = ", ".join(str(s) for s in e["status"]) or "other"
            ops = users.get(e["code"], [])
            used = ""
            if kind is None and ops:
                used = '<br><span class="err-ops">' + ", ".join(op_ref(spec, i, "../") for i in ops) + "</span>"
            rows.append([f'<code id="{e["code"]}">{e["code"]}</code>', status, _inl(e["description"]) + used])
        out.append(f"<h3>{title}</h3>\n<p>{_inl(intro)}</p>\n" + _table(["Code", "Status", "Meaning"], rows, title, "api-table"))
    return "\n".join(out)


def block_problem(spec: dict) -> str:
    cat = apilib.catalogue(spec)
    return f'<pre><code class="language-json">{html.escape(json.dumps(apilib.problem_example(cat["STALE_BLOCK"]), indent=2))}</code></pre>'


def block_operations(spec: dict) -> str:
    """Every operation, by resource, linked to its reference section."""
    rows = []
    for tag, slug, title, _lede in RESOURCES:
        for o in apilib.operations(spec):
            if o["tag"] != tag:
                continue
            summary = _esc(o["op"].get("summary", o["id"]))
            res = _esc(title)
            if REFERENCE_ON:
                res = f'<a href="reference/{slug}.html">{res}</a>'
                summary = f'<a href="reference/{slug}.html#{o["id"]}">{summary}</a>'
            rows.append([res, f'{method_badge(o["method"])} <code class="op-path-s">{_esc(o["path"])}</code>', summary])
    return _table(["Resource", "Operation", "Summary"], rows, "Operations", "api-table")


# A webhook delivery to check a verifier against, signed here at build time (so the page and
# the signature cannot disagree; tools/check-openapi.py signs it again independently).
VECTOR = {
    "secret": "whsec_test_example",
    "ts": 1795550974,
    "pathQuery": "/opencanvas/hooks",
    "body": ('{"at":1795550974787,"data":{"added":1,"blockId":"b_01m87jv4rtkdxymn93jwtx35sk","by":["u_42"],'
             '"threadId":"t_01m87jv4sqj5z6jz5q2n5zdtdw"},"fileId":"doc_1","id":"ev_01m87jv4t3ggvh8n6d6nh38xc0","type":"commented"}'),
}


def vector_signature() -> str:
    import hashlib
    import hmac
    msg = f"{VECTOR['ts']}.POST.{VECTOR['pathQuery']}.{VECTOR['body']}".encode()
    v2 = hmac.new(VECTOR["secret"].encode(), msg, hashlib.sha256).hexdigest()
    v1 = hmac.new(VECTOR["secret"].encode(), f"{VECTOR['ts']}.{VECTOR['body']}".encode(), hashlib.sha256).hexdigest()
    return f"t={VECTOR['ts']},v1={v1},v2={v2}"


def block_webhook_request(spec: dict) -> str:
    sig = vector_signature()
    text = (f"POST {VECTOR['pathQuery']} HTTP/1.1\nContent-Type: application/json\nX-OpenCanvas-Event: commented\n"
            f"X-OpenCanvas-Event-Id: ev_01m87jv4t3ggvh8n6d6nh38xc0\nIdempotency-Key: ev_01m87jv4t3ggvh8n6d6nh38xc0\n"
            f"X-OpenCanvas-Delivery-Attempt: 1\nX-OpenCanvas-Signature: {sig}\n\n{VECTOR['body']}")
    return _pre(text, "http")


def block_webhook_vector(spec: dict) -> str:
    sig = vector_signature()
    rows = [["Secret", f"<code>{VECTOR['secret']}</code>"], ["Time (Unix seconds, also <code>t</code>)", f"<code>{VECTOR['ts']}</code>"],
            ["Path and query", f"<code>{VECTOR['pathQuery']}</code>"], ["Body (exact bytes)", f"<code>{_esc(VECTOR['body'])}</code>"],
            ["<code>X-OpenCanvas-Signature</code>", f"<code>{sig}</code>"]]
    return _table(["Input", "Value"], rows, "Webhook test vector", "api-table vector")


def block_webhook_verify(spec: dict) -> str:
    sig = vector_signature()
    v2 = sig.split("v2=")[1]
    body = VECTOR["body"]
    bash = f"""# A sketch of the check: compare the hex in constant time in real code.
secret='{VECTOR['secret']}'
signature='{sig}'
path_query='{VECTOR['pathQuery']}'
body='{body}'

t=$(printf '%s' "$signature" | tr ',' '\\n' | sed -n 's/^t=//p')
v2=$(printf '%s' "$signature" | tr ',' '\\n' | sed -n 's/^v2=//p')
expected=$(printf '%s.POST.%s.%s' "$t" "$path_query" "$body" \\
  | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.*= //')
[ "$expected" = "$v2" ] && echo "signature ok" || echo "signature WRONG"
# Then reject it if t is more than 300 seconds from now:
# [ $(( $(date +%s) - t )) -le 300 ] && [ $(( t - $(date +%s) )) -le 300 ]"""
    ts = f"""import {{ verifyWebhook }} from "@opencanvas/client";

// In your receiver: the raw body (before JSON parsing) and the path and query as received.
const ok = await verifyWebhook({{
  secret: process.env.OC_WEBHOOK_SECRET!,      // "{VECTOR['secret']}" for the test vector
  signature: req.headers["x-opencanvas-signature"] as string,
  body: rawBody,                                // string or Uint8Array, exactly as received
  pathQuery: req.originalUrl,                   // "{VECTOR['pathQuery']}"
  // nowSecs: {VECTOR['ts']},                         // pin the clock to check the test vector
}});
if (!ok) return res.status(401).end();
res.status(204).end();                          // answer fast, then do the work
const event = JSON.parse(rawBody);"""
    rust = f"""use opencanvas_client::{{verify_webhook, WebhookRequest}};

let ok = verify_webhook(
    secret.as_bytes(),                          // b"{VECTOR['secret']}" for the test vector
    WebhookRequest {{
        signature: &signature_header,           // X-OpenCanvas-Signature
        method: "POST",
        path_query: &path_and_query,            // "{VECTOR['pathQuery']}"
        body: &raw_body,                        // the bytes as received
    }},
    now_secs,                                   // {VECTOR['ts']} for the test vector
);
if !ok {{
    return StatusCode::UNAUTHORIZED;
}}"""
    py = f"""import hashlib
import hmac
import time


def verify_webhook(secret: bytes, signature: str, path_query: str, body: bytes,
                   now=None, tolerance=300) -> bool:
    parts = {{}}
    for item in signature.split(","):
        k, _, v = item.strip().partition("=")
        parts.setdefault(k, v)
    try:
        t = int(parts["t"])
        v2 = parts["v2"]
    except (KeyError, ValueError):
        return False
    if abs((time.time() if now is None else now) - t) > tolerance:
        return False
    mac = hmac.new(secret, f"{{t}}.POST.{{path_query}}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, v2)


# The test vector:
assert verify_webhook(
    b"{VECTOR['secret']}",
    "{sig}",
    "{VECTOR['pathQuery']}",
    {json.dumps(body)}.encode(),
    now={VECTOR['ts']},
)"""
    assert v2 in py
    return sample_group([("curl", bash, "openssl"), ("ts", ts), ("rust", rust), ("python", py)], "Verify a delivery")


BLOCKS = {
    "webhook-request": block_webhook_request,
    "webhook-vector": block_webhook_vector,
    "webhook-verify": block_webhook_verify,
    "scopes": block_scopes,
    "errors": block_errors,
    "problem": block_problem,
    "operations": block_operations,
}


# ---- Reference: resources ----------------------------------------------------------------

# (OpenAPI tag, page slug, title, lede)
RESOURCES = [
    ("canvas", "canvas", "Canvas", "Read a whole canvas as JSON blocks, Markdown or a heading outline."),
    ("blocks", "blocks", "Blocks", "List, read and find blocks, and change them in one atomic batch."),
    ("databases", "databases", "Databases", "Describe databases, query rows with filters and sorts, create databases and fields, and create or update rows."),
    ("boards", "boards", "Boards", "Read a board's shapes and add shapes to a board."),
    ("comments", "comments", "Comments", "List comment threads, start a thread on a block or reply to one."),
    ("members", "members", "Members", "The people with access to a canvas: id, name and detail, never an e-mail address."),
    ("files", "files", "Export and import", "Export a canvas, import Markdown, HTML or CSV into it, and convert files without a canvas."),
    ("search", "search", "Search", "Search across the canvases a person can open, through the host's own index, and extract a canvas's search text."),
    ("events", "streams", "Events and sync", "Stream a file's change events, and get a ticket to sync the CRDT document directly."),
    ("admin", "admin", "Admin", "Host operations: save now, change a user's role live, close the session, drop cached members."),
    ("meta", "meta", "OpenAPI document", "The OpenAPI 3.1 document this reference is generated from."),
    ("0.1 aliases", "legacy", "0.1 routes (deprecated)", "The 0.1 host routes, kept through 0.x with their old answers, and retired in v0.3. Use the `/api/v1` successor each one names."),
]


def ref_href(spec: dict, op_id: str, root: str) -> str:
    for o in apilib.operations(spec):
        if o["id"] == op_id:
            for tag, slug, _t, _l in RESOURCES:
                if tag == o["tag"]:
                    return f"{root}api/reference/{slug}.html#{op_id}"
    raise SystemExit(f"build-api: no reference page for {op_id}")


def op_ref(spec: dict, op_id: str, root: str) -> str:
    """An operation id, linked to its reference section once the reference pages exist."""
    if not REFERENCE_ON:
        return f"<code>{_esc(op_id)}</code>"
    return f'<a href="{ref_href(spec, op_id, root)}"><code>{_esc(op_id)}</code></a>'


def method_badge(method: str) -> str:
    m = method.upper()
    return f'<span class="method method-{method.lower()}">{m}</span>'


def nav_title(o: dict) -> str:
    overrides = {"getOpenApi": "OpenAPI document", "createSyncToken": "Sync ticket", "streamEvents": "Stream events",
                 "readFile": "Read a canvas", "batchBlocks": "Change blocks", "invalidateMembers": "Members changed",
                 "commitFile": "Save now", "setRole": "Change a role", "closeSession": "Close the session",
                 "exportFile": "Export", "importFile": "Import", "convert": "Convert", "findBlocks": "Find blocks",
                 "getBlock": "Read a block", "getDatabase": "Describe a database", "queryRows": "Query rows",
                 "upsertRows": "Create or update rows", "addField": "Add a field", "readBoard": "Read shapes",
                 "addShapes": "Add shapes", "addComment": "Add a comment", "listComments": "List threads",
                 "listMembers": "List members", "listBlocks": "List blocks", "listDatabases": "List databases",
                 "createDatabase": "Create a database",
                 "extract": "Extract search text", "search": "Search across canvases"}
    if o["id"] in overrides:
        return overrides[o["id"]]
    if o["id"].startswith("legacy"):
        return o["op"].get("summary", o["id"]).replace(" (0.1)", "")
    return o["id"]


def sidebar(spec: dict, root: str, current: str) -> str:
    """The API navigation. `current` is a guide slug or `reference/<slug>`."""
    guides = []
    for slug, label in available_guides():
        cur = ' aria-current="page"' if current == slug else ""
        guides.append(f'<li><a href="{root}api/{slug}.html"{cur}>{_esc(label)}</a></li>')
    refs = []
    ops = apilib.operations(spec)
    for tag, slug, title, _lede in RESOURCES if REFERENCE_ON else []:
        here = current == f"reference/{slug}"
        cur = ' aria-current="page"' if here else ""
        sub = ""
        if here:
            items = "".join(
                f'<li><a href="#{o["id"]}" class="nav-op">{method_badge(o["method"])}<span>{_esc(nav_title(o))}</span></a></li>'
                for o in ops if o["tag"] == tag)
            sub = f'<ul class="api-nav-ops">{items}</ul>'
        refs.append(f'<li><a href="{root}api/reference/{slug}.html"{cur}>{_esc(title)}</a>{sub}</li>')
    out = f'<h2>Guides</h2><ul>{"".join(guides)}</ul>'
    if refs:
        out += f'<h2>Reference</h2><ul>{"".join(refs)}</ul>'
    return out


# The resource pages (one per OpenAPI tag, RESOURCES).
REFERENCE_ON = True


def api_page(spec: dict, rel: str, title: str, description: str, article: str, *, current: str,
             kind: str = "guide", order: list[tuple[str, str]] | None = None) -> str:
    """A page of the API section: navigation, the article, and (guides) on this page."""
    depth = rel.count("/")
    root = "../" * depth
    article = sitelib.add_heading_ids(article)
    nav = sidebar(spec, root, current)
    toc = ""
    if kind == "guide":
        items = re.findall(r'<h2[^>]*id="([^"]+)"[^>]*>(.*?)</h2>', article, flags=re.S)
        if len(items) >= 2:
            lis = "".join(f'<li><a href="#{i}">{re.sub(r"<[^>]+>", "", t)}</a></li>' for i, t in items)
            toc = f'<nav class="toc" aria-label="On this page"><h2>On this page</h2><ul>{lis}</ul></nav>'
    pn = ""
    if order:
        keys = [k for k, _ in order]
        i = keys.index(current)
        links = []
        if i > 0:
            k, t = order[i - 1]
            links.append(f'<a class="pn pn-prev" href="{root}api/{k}.html"><span class="pn-dir">{sitelib.icon("chevron-left", 16)}Previous</span><span class="pn-title">{_esc(t)}</span></a>')
        if i + 1 < len(order):
            k, t = order[i + 1]
            links.append(f'<a class="pn pn-next" href="{root}api/{k}.html"><span class="pn-dir">Next{sitelib.icon("chevron-right", 16)}</span><span class="pn-title">{_esc(t)}</span></a>')
        pn = f'<nav class="prevnext" aria-label="Previous and next">{"".join(links)}</nav>'
    body = f"""<div class="api-layout api-layout--{kind}">
  <aside class="api-side docs-side">
    <details class="docs-nav-toggle"><summary>{sitelib.icon("list-tree", 16)}API menu</summary><nav class="docs-nav api-nav" aria-label="API reference (menu)">{nav}</nav></details>
    <nav class="docs-nav api-nav docs-nav--wide" aria-label="API reference">{nav}</nav>
  </aside>
  <article class="api-article prose">
{article}
{pn}
  </article>
  {toc}
</div>"""
    return sitelib.page(title=title, description=description, body=body, root=root, path=rel,
                        current="api", main_class="docs-main api-main")


def _order() -> list[tuple[str, str]]:
    order = list(available_guides())
    if REFERENCE_ON:
        order += [(f"reference/{slug}", title) for _tag, slug, title, _l in RESOURCES]
    return order


# ---- Changelog: API entries from CHANGELOG.md -------------------------------------------

API_WORDS = re.compile(r"\b(API|api/v1|OpenAPI|REST|webhooks?|events? stream|tokens?|role API|SDK|client|Idempotency|/v1/)", re.I)


def changelog(spec: dict) -> tuple[str, str, str]:
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf8")
    parts = []
    for m in re.finditer(r"^## \[([^\]]+)\](?: - (\S+))?\n(.*?)(?=^## \[|\Z)", text, flags=re.S | re.M):
        version, date, sec = m.group(1), m.group(2), m.group(3)
        items = []
        for bm in re.finditer(r"^### (\w+)\n(.*?)(?=^### |\Z)", sec, flags=re.S | re.M):
            kind = bm.group(1)
            bullets = re.findall(r"^- (.*?)(?=^- |\Z)", bm.group(2), flags=re.S | re.M)
            for b in bullets:
                b = " ".join(b.split())
                if API_WORDS.search(b):
                    items.append(f'<li><span class="cl-kind cl-{kind.lower()}">{_esc(kind)}</span> {sitelib.md_inline(b, "CHANGELOG.md", "../")}</li>')
        if items:
            head = f"{version}" + (f" ({date})" if date else "")
            parts.append(f"<h2>{_esc(head)}</h2>\n<ul class=\"cl-list\">{''.join(items)}</ul>")
    info = spec["info"]
    article = (f"<h1>API changelog</h1>\n<p class=\"lede\">The API-relevant entries of "
               f"<a href=\"{sitelib.BLOB}CHANGELOG.md\">CHANGELOG.md</a>, newest first. The OpenAPI document is version "
               f"<code>{_esc(info['version'])}</code>; within <code>/api/v1</code> changes are additive, and a breaking change "
               f"gets a new path major.</p>\n" + "\n".join(parts))
    return "API changelog", "What changed in the OpenCanvas API, release by release, from the project's CHANGELOG.md.", article


# ---- Reference: one operation ------------------------------------------------------------

PATH_DEFAULTS = {"fileId": "doc_1", "blockId": "b_01m87jv4rtkdxymn93jwtx35sk", "dbId": "db_01m87jv4sc2twxjhzzxzh7mene",
                 "boardId": "bd_01m87jv4t0h5kq8r2x9w3c4d5e", "format": "md"}
FILE_FOR = {"md": "notes.md", "markdown": "notes.md", "html": "page.html", "csv": "contacts.csv", "ocanvas": "canvas.ocanvas",
            "json": "canvas.json", "docx": "canvas.docx", "pdf": "canvas.pdf"}


def type_label(spec: dict, schema) -> str:
    s, ref = apilib.deref(spec, schema)
    if ref and ref not in ("fileId", "IdempotencyKey"):
        return ref
    if not isinstance(s, dict):
        return "any"
    t = s.get("type")
    types = [t] if isinstance(t, str) else list(t or [])
    out = []
    for x in types:
        if x == "array":
            item = s.get("items")
            out.append(f"array of {type_label(spec, item)}" if isinstance(item, dict) and item else "array")
        elif x == "string" and s.get("format") == "binary":
            out.append("binary")
        else:
            out.append(x)
    return " | ".join(out) or ("object" if "properties" in s else "any")


def _constraints(s: dict) -> list[str]:
    out = []
    if "enum" in s:
        out.append("One of " + ", ".join(f"<code>{_esc(json.dumps(v) if not isinstance(v, str) else v)}</code>" for v in s["enum"]) + ".")
    lo, hi = s.get("minimum"), s.get("maximum")
    if lo is not None and hi is not None:
        out.append(f"{lo} to {hi}.")
    elif hi is not None:
        out.append(f"At most {hi}.")
    lo, hi = s.get("minLength"), s.get("maxLength")
    if lo is not None and hi is not None:
        out.append(f"{lo} to {hi} characters.")
    elif hi is not None:
        out.append(f"At most {hi} characters.")
    lo, hi = s.get("minItems"), s.get("maxItems")
    if lo is not None and hi is not None:
        out.append(f"{lo} to {hi} items.")
    elif lo is not None:
        out.append(f"At least {lo} item{'s' if lo != 1 else ''}.")
    elif hi is not None:
        out.append(f"At most {hi} items.")
    if s.get("format") and s.get("format") not in ("binary",):
        out.append(f"Format <code>{_esc(s['format'])}</code>.")
    return out


def schema_rows(spec: dict, schema, name: str, required: bool, depth: int, rows: list, classes: list, seen: tuple = ()) -> None:
    s, ref = apilib.deref(spec, schema)
    if not isinstance(s, dict):
        return
    desc = " ".join([_inl(s.get("description", ""), "../../")] + _constraints(s)).strip()
    req = '<span class="req">required</span>' if required else ""
    rows.append([f"<code>{_esc(name)}</code>{req}", f'<span class="ty">{_esc(type_label(spec, schema))}</span>', desc or '<span class="muted">-</span>'])
    classes.append(f"d{min(depth, 4)}" if depth else "")
    if ref and ref in seen:
        return
    seen = seen + ((ref,) if ref else ())
    target = s
    if "array" in ([s.get("type")] if isinstance(s.get("type"), str) else (s.get("type") or [])) and isinstance(s.get("items"), dict):
        target, _ = apilib.deref(spec, s["items"])
    props = (target or {}).get("properties") or {}
    reqs = set((target or {}).get("required") or [])
    for k, v in props.items():
        schema_rows(spec, v, k, k in reqs, depth + 1, rows, classes, seen)


def schema_table(spec: dict, schema, label: str) -> str:
    s, _ = apilib.deref(spec, schema)
    rows: list = []
    classes: list = []
    props = s.get("properties") if isinstance(s, dict) else None
    if props:
        reqs = set(s.get("required") or [])
        for k, v in props.items():
            schema_rows(spec, v, k, k in reqs, 0, rows, classes)
    else:
        schema_rows(spec, schema, "(body)", True, 0, rows, classes)
    extra = ""
    if isinstance(s, dict) and s.get("additionalProperties") is True and props:
        extra = '<p class="note">Other members may appear; ignore the ones you do not know.</p>'
    return _table(["Field", "Type", "Description"], rows, label, "api-table schema", classes) + extra


def _example_text(ctype: str, value) -> str:
    if isinstance(value, str) and not ctype.endswith("json"):
        return value
    return json.dumps(value, indent=2, ensure_ascii=False)


def _pre(text: str, lang: str = "json") -> str:
    return f'<pre><code class="language-{lang}">{html.escape(text)}</code></pre>'


def request_example(spec: dict, o: dict) -> dict:
    """The request the samples send: path, query and header values, and the body."""
    op = o["op"]
    out = {"path": {}, "query": {}, "headers": {}, "body": None, "ctype": None}
    for p in apilib.params(spec, op):
        s = p.get("schema") or {}
        has = "example" in p or "example" in s
        val = p.get("example", s.get("example"))
        if p["in"] == "path":
            out["path"][p["name"]] = val if has else PATH_DEFAULTS.get(p["name"], p["name"])
        elif p["in"] == "query" and (has or p.get("required")):
            out["query"][p["name"]] = val if has else apilib.synth(s, spec)
        elif p["in"] == "header" and has:
            out["headers"][p["name"]] = val
    ctype, media, _req = apilib.request_media(spec, op)
    if media is not None:
        has, val = apilib.media_example(media)
        out["body"] = val if has else apilib.synth(media.get("schema") or {}, spec)
        out["ctype"] = ctype
    return out


def _response_kind(spec: dict, op: dict) -> tuple[str, str | None]:
    """('json' | 'binary' | 'stream' | 'none', content type) of the success answer."""
    _code, res = apilib.success(spec, op)
    content = (res or {}).get("content") or {}
    if "text/event-stream" in content:
        return "stream", "text/event-stream"
    for ct in content:
        return ("json" if ct.endswith("json") else "binary"), ct
    return "none", None


def _url(o: dict, ex: dict) -> str:
    path = o["path"]
    for k, v in ex["path"].items():
        path = path.replace("{" + k + "}", str(v))
    return BASE + path


def _q(s: str) -> str:
    """A shell word in single quotes."""
    return "'" + s.replace("'", "'\\''") + "'"


def _jsonish(v) -> object:
    """A string query value that holds JSON (filter, sort) as the JSON itself, else None."""
    if isinstance(v, str) and v[:1] in "[{":
        try:
            return json.loads(v)
        except ValueError:
            return None
    return None


def _successor(spec: dict, o: dict) -> dict | None:
    m = re.search(r"Successor: `([^`]+)`", o["op"].get("description", ""))
    if not m:
        return None
    for x in apilib.operations(spec):
        if x["path"] == m.group(1) and x["method"] == o["method"]:
            return x
    return None


def sample_curl(spec: dict, o: dict, ex: dict) -> str:
    kind, _ct = _response_kind(spec, o["op"])
    method = o["method"].upper()
    url = _url(o, ex)
    lines = []
    get_query = method == "GET" and any(_jsonish(v) is not None for v in ex["query"].values())
    if ex["query"] and not get_query:
        from urllib.parse import urlencode
        url += "?" + urlencode({k: (v if isinstance(v, str) else json.dumps(v)) for k, v in ex["query"].items()}, safe=",:")
    first = "curl -s" + (" -N" if kind == "stream" else "") + ("" if method == "GET" else f" -X {method}") + (" -G" if get_query else "") + f' "{url}"'
    lines.append(first)
    if get_query:
        for k, v in ex["query"].items():
            lines.append(f"--data-urlencode {_q(f'{k}=' + (v if isinstance(v, str) else json.dumps(v)))}")
    if o["path"] != "/api/v1/openapi.json":
        lines += ['-H "X-OpenCanvas-Host: acme"', '-H "X-OpenCanvas-Key: $OC_API_KEY"']
    if kind == "stream":
        lines.append('-H "Accept: text/event-stream"')
    for k, v in ex["headers"].items():
        lines.append(f"-H {_q(f'{k}: {v}')}")
    if ex["ctype"] and ex["ctype"].endswith("json"):
        lines.append('-H "Content-Type: application/json"')
        one = json.dumps(ex["body"], ensure_ascii=False)
        body = one if len(one) <= 64 else json.dumps(ex["body"], indent=2, ensure_ascii=False).replace("\n", "\n  ")
        lines.append(f"-d {_q(body)}")
    elif ex["ctype"]:
        fmt = ex["query"].get("format") or ex["query"].get("from") or "md"
        lines.append(f"--data-binary @{FILE_FOR.get(fmt, 'file.bin')}")
    if kind == "binary":
        fmt = ex["path"].get("format") or ex["query"].get("to") or "bin"
        lines.append(f"-o {FILE_FOR.get(fmt, 'out.' + fmt).replace('notes', 'canvas').replace('page', 'canvas').replace('contacts', 'canvas')}")
    return " \\\n  ".join(lines)


def _lit(v, lang: str, indent: int = 0) -> str:
    """A literal in TypeScript, Rust (inside json!) or Python, on one line when short."""
    pad = "  " * indent if lang != "rust" else "    " * indent
    step = "  " if lang != "rust" else "    "

    def key(k: str) -> str:
        if lang == "ts" and re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", k):
            return k
        return json.dumps(k, ensure_ascii=False)

    def scalar(x) -> str:
        if lang == "python":
            return {True: "True", False: "False", None: "None"}.get(x, json.dumps(x, ensure_ascii=False)) if x is None or isinstance(x, bool) else json.dumps(x, ensure_ascii=False)
        return json.dumps(x, ensure_ascii=False)
    if isinstance(v, dict):
        if not v:
            return "{}"
        parts = [f"{key(k)}: {_lit(x, lang, indent + 1)}" for k, x in v.items()]
        one = "{ " + ", ".join(parts) + " }" if lang == "ts" else "{" + ", ".join(parts) + "}"
        if len(one) + len(pad) <= 88 and "\n" not in one:
            return one
        return "{\n" + "".join(f"{pad}{step}{p},\n" for p in parts) + pad + "}"
    if isinstance(v, list):
        if not v:
            return "[]"
        parts = [_lit(x, lang, indent + 1) for x in v]
        one = "[" + ", ".join(parts) + "]"
        if len(one) + len(pad) <= 88 and "\n" not in one:
            return one
        return "[\n" + "".join(f"{pad}{step}{p},\n" for p in parts) + pad + "]"
    return scalar(v)


TS_HEAD = """import { OpenCanvas } from "@opencanvas/client";

const oc = new OpenCanvas({
  baseUrl: "https://canvas.example.com",
  auth: { hostId: "acme", key: process.env.OC_API_KEY! },
});
"""

RUST_HEAD = """use opencanvas_client::{{{uses}}};
{extra}
let oc = Client::builder("https://canvas.example.com")
    .auth(Auth::host_key("acme", std::env::var("OC_API_KEY").expect("OC_API_KEY")))
    .build();
"""


def sample_ts(spec: dict, o: dict, ex: dict) -> str:
    if o["tag"] == "0.1 aliases":
        nxt = _successor(spec, o)
        return f"// The client covers /api/v1 only. Use {nxt['id'] if nxt else 'the successor'} instead:\n// await oc.{nxt['id'] if nxt else 'call'}(...);"
    kind, _ct = _response_kind(spec, o["op"])
    if kind == "stream":
        types = (ex["query"].get("types") or "edited,commented").split(",")
        return TS_HEAD + f"""
for await (const event of oc.events({{ fileId: {json.dumps(ex["path"].get("fileId", "doc_1"))}, types: {_lit(types, "ts")} }})) {{
  console.log(event.id, event.type, event.data);
}}"""
    params = dict(ex["path"])
    head = TS_HEAD
    q = {}
    for k, v in ex["query"].items():
        q[k] = v
    parts = [f"{k}: {json.dumps(v)}" for k, v in params.items()]
    if q:
        qparts = []
        for k, v in q.items():
            j = _jsonish(v)
            qparts.append(f"{k}: " + (f"JSON.stringify({_lit(j, 'ts', 2)})" if j is not None else _lit(v, "ts", 2)))
        parts.append("query: { " + ", ".join(qparts) + " }")
    if ex["ctype"] and ex["ctype"].endswith("json"):
        parts.append("body: " + _lit(ex["body"], "ts", 1))
    elif ex["ctype"]:
        fmt = ex["query"].get("format") or ex["query"].get("from") or "md"
        head = 'import { readFile } from "node:fs/promises";\n' + head
        parts.append(f'body: await readFile("{FILE_FOR.get(fmt, "file.bin")}")')
    opts = {}
    for k, v in ex["headers"].items():
        if k == "If-Match":
            opts["ifMatch"] = v.strip('"')
        elif k == "Idempotency-Key":
            opts["idempotencyKey"] = v
    arg = "{ " + ", ".join(parts) + " }" if parts else ""
    if len(arg) > 70 or "\n" in arg:
        arg = "{\n" + "".join(f"  {p.replace(chr(10), chr(10) + '  ')},\n" for p in parts) + "}"
    call_args = arg
    if opts:
        call_args = (arg or "{}") + ", " + _lit(opts, "ts")
    var = "bytes" if kind == "binary" else "result"
    call = f"const {var} = await oc.{o['id']}({call_args});"
    if kind == "binary":
        fmt = ex["path"].get("format") or ex["query"].get("to") or "bin"
        head = 'import { writeFile } from "node:fs/promises";\n' + head
        return head + f"\n{call}\nawait writeFile(\"canvas.{fmt}\", bytes);"
    return head + f"\n{call}\nconsole.log(result);"


def sample_rust(spec: dict, o: dict, ex: dict) -> str:
    if o["tag"] == "0.1 aliases":
        nxt = _successor(spec, o)
        return f"// The client covers /api/v1 only. Use \"{nxt['id'] if nxt else 'the successor'}\" instead:\n// oc.call(\"{nxt['id'] if nxt else ''}\", &params, &CallOptions::default()).await?;"
    kind, _ct = _response_kind(spec, o["op"])
    if kind == "stream":
        types = (ex["query"].get("types") or "edited,commented").split(",")
        return RUST_HEAD.format(uses="Auth, Client, EventsOptions", extra="") + f"""
let mut opts = EventsOptions::new({json.dumps(ex["path"].get("fileId", "doc_1"))});
opts.types = vec![{", ".join(f'{json.dumps(t)}.into()' for t in types)}];
let mut stream = oc.events(opts);
while let Some(event) = stream.next().await {{
    let event = event?;
    println!("{{}} {{}} {{:?}}", event.id, event.type_, event.data);
}}"""
    uses = ["Auth", "CallOptions", "Client", "Params"]
    extra = ""
    chain = []
    path = dict(ex["path"])
    if "fileId" in path:
        start = f"Params::file({json.dumps(path.pop('fileId'))})"
    else:
        start = "Params::new()"
    for k, v in path.items():
        chain.append(f".path({json.dumps(k)}, {json.dumps(v)})")
    for k, v in ex["query"].items():
        j = _jsonish(v)
        if j is not None:
            chain.append(f".query({json.dumps(k)}, json!({_lit(j, 'rust', 3)}).to_string())")
            extra = "use serde_json::json;\n"
        else:
            chain.append(f".query({json.dumps(k)}, {json.dumps(v)})")
    if ex["ctype"] and ex["ctype"].endswith("json"):
        chain.append(f".json(json!({_lit(ex['body'], 'rust', 3)}))")
        extra = "use serde_json::json;\n"
    elif ex["ctype"]:
        fmt = ex["query"].get("format") or ex["query"].get("from") or "md"
        name = FILE_FOR.get(fmt, "file.bin")
        chain.append(f'.binary(std::fs::read("{name}").expect("{name}"))')
    hdr = {k: v for k, v in ex["headers"].items()}
    im, key = hdr.get("If-Match"), hdr.get("Idempotency-Key")
    if im and key:
        opts = ("CallOptions {\n            if_match: Some(" + json.dumps(im.strip('"')) + ".into()),\n            idempotency_key: Some("
                + json.dumps(key) + ".into()),\n            ..Default::default()\n        }")
    elif im:
        opts = f"CallOptions::if_match({json.dumps(im.strip(chr(34)))})"
    elif key:
        opts = f"CallOptions::key({json.dumps(key)})"
    else:
        opts = "CallOptions::default()"
    params = start + "".join(f"\n            {c}" for c in chain)
    body = f"""
let res = oc
    .call(
        {json.dumps(o['id'])},
        &{params},
        &{opts},
    )
    .await?;
"""
    if kind == "binary":
        fmt = ex["path"].get("format") or ex["query"].get("to") or "bin"
        body += f'std::fs::write("canvas.{fmt}", &res.body).expect("written");'
    else:
        body += "let answer: serde_json::Value = res.value()?;\nprintln!(\"{answer:#}\");"
    return RUST_HEAD.format(uses=", ".join(uses), extra=extra) + body


def sample_python(spec: dict, o: dict, ex: dict) -> str:
    kind, _ct = _response_kind(spec, o["op"])
    method = o["method"]
    url = _url(o, ex)
    head = "import os\n\nimport requests\n\n"
    headers = {}
    if o["path"] != "/api/v1/openapi.json":
        headers = {"X-OpenCanvas-Host": "acme", "X-OpenCanvas-Key": "@@KEY@@"}
    headers.update(ex["headers"])
    if kind == "stream":
        headers["Accept"] = "text/event-stream"
    args = [json.dumps(url)]
    if headers:
        args.append("headers=" + _lit(headers, "python", 1).replace('"@@KEY@@"', 'os.environ["OC_API_KEY"]'))
    else:
        head = "import requests\n\n"
    if ex["query"]:
        q = {}
        jsonq = False
        for k, v in ex["query"].items():
            j = _jsonish(v)
            q[k] = ("@@JSON@@" + json.dumps(j)) if j is not None else v
            jsonq = jsonq or j is not None
        lit = _lit(q, "python", 1)
        lit = re.sub(r'"@@JSON@@((?:[^"\\]|\\.)*)"', lambda m: "json.dumps(" + _lit(json.loads(json.loads('"' + m.group(1) + '"')), "python", 2) + ")", lit)
        args.append("params=" + lit)
        if jsonq:
            head = "import json\n" + head
    if ex["ctype"] and ex["ctype"].endswith("json"):
        args.append("json=" + _lit(ex["body"], "python", 1))
    elif ex["ctype"]:
        fmt = ex["query"].get("format") or ex["query"].get("from") or "md"
        args.append(f'data=open("{FILE_FOR.get(fmt, "file.bin")}", "rb")')
    if kind == "stream":
        args.append("stream=True")
        args.append("timeout=(10, 60)")
    else:
        args.append("timeout=30")
    call = f"r = requests.{method}(\n" + "".join(f"    {a},\n" for a in args) + ")\nr.raise_for_status()\n"
    if kind == "stream":
        call += """for line in r.iter_lines(decode_unicode=True):
    if line.startswith("data:"):
        event = json.loads(line[5:])
        print(event["id"], event["type"], event["data"])"""
        if not head.startswith("import json"):
            head = "import json\n" + head
    elif kind == "binary":
        fmt = ex["path"].get("format") or ex["query"].get("to") or "bin"
        call += f'with open("canvas.{fmt}", "wb") as f:\n    f.write(r.content)'
    else:
        call += "print(r.json())"
    return head + call


def operation_section(spec: dict, o: dict, root: str) -> str:
    op = o["op"]
    oid = o["id"]
    cat = apilib.catalogue(spec)
    legacy = o["tag"] == "0.1 aliases"
    parts = [f'<h2 id="{oid}" class="op-title">{_esc(op.get("summary", oid))}</h2>',
             f'<p class="op-line">{method_badge(o["method"])}<code>{_esc(o["path"])}</code></p>']
    scope = op.get("x-opencanvas-scope")
    meta = []
    if o["path"] == "/api/v1/openapi.json":
        meta.append(("Credentials", "None: the document is public."))
    elif legacy:
        meta.append(("Credentials", "Host key (<code>X-OpenCanvas-Host</code> and <code>X-OpenCanvas-Key</code>)."))
    else:
        role = SCOPE_ROLE.get(scope or "", "")
        if scope == "canvas:admin":
            cred = 'Host key, or a user token with <code>canvas:admin</code> when the host sets <code>[host.api] token_admin</code>.'
        else:
            cred = f'Host key, or a user token with <a href="{root}api/authentication.html#scopes"><code>{_esc(scope)}</code></a>.'
        meta.append(("Credentials", cred))
        if scope and scope != "canvas:admin":
            meta.append(("Least role", f"<code>{role}</code> on the file (effective permission <code>min(scope, role)</code>)."))
    if any(p.get("name") == "Idempotency-Key" for p in apilib.params(spec, op)):
        meta.append(("Idempotent", f'Send an <a href="{root}api/idempotency.html"><code>Idempotency-Key</code></a> to retry safely.'))
    if legacy:
        nxt = _successor(spec, o)
        if nxt:
            meta.append(("Deprecated", f'<span class="op-deprecated">Retired in v0.3.</span> Use <a href="{ref_href(spec, nxt["id"], root)}"><code>{nxt["id"]}</code></a>.'))
    meta.append(("Operation id", f"<code>{_esc(oid)}</code>"))
    for para in (op.get("description") or "").split("\n\n"):
        if para.strip():
            parts.append(f"<p>{_inl(para.strip(), root)}</p>")
    parts.append('<dl class="op-meta">' + "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in meta) + "</dl>")

    ps = apilib.params(spec, op)
    if ps:
        rows = []
        for p in ps:
            s = p.get("schema") or {}
            desc = " ".join([_inl(p.get("description", ""), root)] + _constraints(s)).strip()
            req = '<span class="req">required</span>' if p.get("required") else ""
            rows.append([f"<code>{_esc(p['name'])}</code>{req}", p["in"], f'<span class="ty">{_esc(type_label(spec, s))}</span>', desc])
        parts.append('<h3 data-index="no">Parameters</h3>' + _table(["Name", "In", "Type", "Description"], rows, f"{oid} parameters", "api-table schema"))

    ex = request_example(spec, o)
    ctype, media, required = apilib.request_media(spec, op)
    if media is not None:
        sch = media.get("schema") or {}
        lead = f'<p>{"Required" if required else "Optional"}, <code>{_esc(ctype)}</code>.</p>'
        if ctype.endswith("json"):
            body = lead + schema_table(spec, sch, f"{oid} request body")
        else:
            body = lead + f"<p>{_inl(media.get('description', '') or 'The file itself, as the raw body.', root)}</p>"
        body += '<h4 data-index="no">Example</h4>' + _pre(_example_text(ctype, ex["body"]), "json" if ctype.endswith("json") else "text")
        parts.append('<h3 data-index="no">Request body</h3>' + body)

    resp = []
    errors = op.get("x-opencanvas-errors") or []
    for code, res, comp in apilib.responses(spec, op):
        st = int(code) if code.isdigit() else 0
        reason = apilib.REASONS.get(st, "")
        desc = res.get("description", "")
        inner = []
        hdrs = res.get("headers") or {}
        if hdrs:
            hr = [[f"<code>{_esc(h)}</code>", _inl(apilib.deref(spec, hv)[0].get("description", ""), root)] for h, hv in hdrs.items()]
            inner.append('<h4 data-index="no">Headers</h4>' + _table(["Header", "Description"], hr, f"{oid} {code} headers", "api-table"))
        for ct, m in (res.get("content") or {}).items():
            sch = m.get("schema") or {}
            s, _ = apilib.deref(spec, sch)
            if ct.endswith("json") and isinstance(s, dict) and (s.get("properties") or s.get("$ref")):
                inner.append(f'<h4 data-index="no">Body <code>{_esc(ct)}</code></h4>' + schema_table(spec, sch, f"{oid} {code} body"))
            else:
                inner.append(f'<h4 data-index="no">Body <code>{_esc(ct)}</code></h4><p>{_esc(type_label(spec, sch))}</p>')
            has, val = apilib.media_example(m)
            if not has and st >= 400:
                codes = [c for c in errors if c in cat and st in cat[c]["status"]]
                if codes:
                    e = cat[codes[0]]
                    has, val = True, (apilib.legacy_example(e) if legacy else apilib.problem_example(e, st))
            if not has:
                has, val = True, apilib.synth(sch, spec)
            inner.append('<h4 data-index="no">Example</h4>' + _pre(_example_text(ct, val), "json" if ct.endswith("json") else "text"))
        codes_here = [c for c in errors if c in cat and st in cat[c]["status"]]
        if codes_here:
            inner.append(f'<p class="muted">Codes: {", ".join(f"<code>{c}</code>" for c in codes_here)}.</p>')
        open_ = " open" if code.startswith("2") or code == "101" else ""
        resp.append(f'<details class="resp"{open_}><summary><span class="status status-{code[0]}">{code}</span>'
                    f'<span>{_esc(reason)}{": " if reason and desc and desc != reason else ""}{_inl(desc, root) if desc != reason else ""}</span>'
                    f'{sitelib.icon("chevron-down", 16)}</summary><div class="resp-body">{"".join(inner)}</div></details>')
    parts.append('<h3 data-index="no">Responses</h3>' + "".join(resp))

    if errors:
        common = [c for c in errors if cat.get(c, {}).get("kind") == "common"]
        own = [c for c in errors if c not in common]
        er = []
        for c in own:
            e = cat[c]
            er.append([", ".join(str(s) for s in e["status"]), f'<a href="{root}api/errors.html#{c}"><code>{c}</code></a>', _inl(e["description"], root)])
        block = '<h3 data-index="no">Errors</h3>'
        if er:
            block += _table(["Status", "Code", "When"], er, f"{oid} errors", "api-table")
        if common:
            block += (f'<p class="err-ops">Also, like every operation on a file: '
                      + ", ".join(f'<a href="{root}api/errors.html#{c}"><code>{c}</code></a>' for c in common) + ".</p>")
        parts.append(block)

    blocks = [("curl", sample_curl(spec, o, ex)), ("ts", sample_ts(spec, o, ex)), ("rust", sample_rust(spec, o, ex)),
              ("python", sample_python(spec, o, ex))]
    code, res = apilib.success(spec, op)
    side = sample_group(blocks, "Request")
    if code:
        for ct, m in ((res or {}).get("content") or {}).items():
            has, val = apilib.media_example(m)
            if not has:
                val = apilib.synth(m.get("schema") or {}, spec)
            side += (f'<div class="sample sample-res"><span class="sample-label">Response {code}</span>'
                     f'{_pre(_example_text(ct, val), "json" if ct.endswith("json") else "text")}</div>')
            break
    return (f'<section class="op" aria-labelledby="{oid}"><div class="op-doc">{"".join(parts)}</div>'
            f'<aside class="op-code" aria-label="{_esc(op.get("summary", oid))}: examples">{side}</aside></section>')


def reference_pages(spec: dict, order: list) -> dict[str, str]:
    pages = {}
    ops = apilib.operations(spec)
    tags = {t for t, _s, _ti, _l in RESOURCES}
    missing = sorted({o["tag"] for o in ops} - tags)
    if missing:
        raise SystemExit(f"build-api: no reference page for the tag(s) {missing}; add them to RESOURCES")
    descs = {t["name"]: t.get("description", "") for t in spec.get("tags", [])}
    for tag, slug, title, lede in RESOURCES:
        rel = f"api/reference/{slug}.html"
        root = "../../"
        mine = [o for o in ops if o["tag"] == tag]
        intro = f'<p class="lede">{_inl(lede, root)}</p>'
        if descs.get(tag) and descs[tag] != lede:
            intro += f"<p>{_inl(descs[tag], root)}</p>"
        listing = "".join(f'<li><a href="#{o["id"]}">{method_badge(o["method"])} <code class="op-path-s">{_esc(o["path"])}</code></a></li>' for o in mine)
        article = (f"<h1>{_esc(title)}</h1>\n{intro}\n<ul class=\"op-index\">{listing}</ul>\n"
                   + "\n".join(operation_section(spec, o, root) for o in mine))
        desc = f"OpenCanvas API reference, {title}: " + "; ".join(o["op"].get("summary", o["id"]) for o in mine) + "."
        pages[rel] = api_page(spec, rel, f"{title} API", desc[:300], article, current=f"reference/{slug}", kind="ref", order=order)
    return pages


def reference_text(spec: dict) -> str:
    """The reference as plain text for llms-full.txt: every operation with its parameters,
    body, answers, errors and a curl example."""
    out = []
    cat = apilib.catalogue(spec)
    for tag, slug, title, lede in RESOURCES:
        out.append(f"\n\n# API reference: {title}\n\nURL: {sitelib.BASE_URL}api/reference/{slug}.html\n\n{lede}\n")
        for o in apilib.operations(spec):
            if o["tag"] != tag:
                continue
            op = o["op"]
            out.append(f"\n## {op.get('summary', o['id'])}\n\n{o['method'].upper()} {o['path']} (operationId {o['id']}"
                       + (f", scope {op['x-opencanvas-scope']}" if op.get("x-opencanvas-scope") else "") + ")\n")
            if op.get("description"):
                out.append(f"\n{op['description']}\n")
            ps = apilib.params(spec, op)
            if ps:
                out.append("\nParameters:\n" + "".join(
                    f"- {p['name']} ({p['in']}, {type_label(spec, p.get('schema') or {})}{', required' if p.get('required') else ''}): {p.get('description', '')}\n"
                    for p in ps))
            ex = request_example(spec, o)
            ctype, media, _r = apilib.request_media(spec, op)
            if media is not None:
                out.append(f"\nRequest body ({ctype}), example:\n{_example_text(ctype, ex['body'])}\n")
            code, res = apilib.success(spec, op)
            for ct, m in ((res or {}).get("content") or {}).items():
                has, val = apilib.media_example(m)
                if has:
                    out.append(f"\nResponse {code} ({ct}), example:\n{_example_text(ct, val)}\n")
                break
            errs = op.get("x-opencanvas-errors") or []
            if errs:
                out.append("\nErrors: " + ", ".join(f"{c} ({'/'.join(str(s) for s in cat[c]['status'])})" for c in errs if c in cat) + "\n")
            out.append(f"\nExample:\n{sample_curl(spec, o, ex)}\n")
    return "".join(out)


# ---- Pages -------------------------------------------------------------------------------

def render() -> dict[str, str]:
    """Every page of the API section, relative to site/."""
    spec = apilib.load()
    bad = apilib.check_examples(spec)
    if bad:
        raise SystemExit("build-api: examples that do not match their schema:\n  " + "\n  ".join(bad))
    _SAMPLE_SEQ[0] = 0
    pages: dict[str, str] = {}
    order = _order()
    for slug, _label in available_guides():
        if slug == "changelog":
            title, desc, article = changelog(spec)
        else:
            title, desc, article = render_guide(slug, spec)
        pages[f"api/{slug}.html"] = api_page(spec, f"api/{slug}.html", title, desc, article, current=slug, order=order)
    if REFERENCE_ON:
        pages.update(reference_pages(spec, order))
    return pages


def llms_index(pages: dict[str, str]) -> list[str]:
    """llms.txt lines for the API section."""
    out = []
    for rel in sorted(p for p in pages if p.startswith("api/")):
        m = re.search(r'<meta name="description" content="([^"]*)"', pages[rel])
        desc = html.unescape(m.group(1)) if m else ""
        out.append(f"- [{sitelib.page_title(pages[rel], rel)}]({sitelib.BASE_URL}{rel}): {desc}")
    return out


def llms_full(pages: dict[str, str]) -> str:
    """The API section as text for llms-full.txt: the guides as rendered text, then every
    operation from the OpenAPI document."""
    parts = []
    for slug, _label in available_guides():
        rel = f"api/{slug}.html"
        parts.append(f"\n\n# {sitelib.page_title(pages[rel], rel)}\n\nURL: {sitelib.BASE_URL}{rel}\n\n{sitelib.main_text(pages[rel])}\n")
    if REFERENCE_ON:
        parts.append(reference_text(apilib.load()))
    return "".join(parts)
