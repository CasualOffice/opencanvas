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


def sample_group(blocks: list[tuple[str, str]], label: str = "Example") -> str:
    """One code sample with a language switch: blocks are (language key, code)."""
    _SAMPLE_SEQ[0] += 1
    n = _SAMPLE_SEQ[0]
    labels = dict(LANGS)
    tabs, panels = [], []
    for i, (lang, code) in enumerate(blocks):
        tid, pid = f"s{n}-{lang}-tab", f"s{n}-{lang}"
        sel = "true" if i == 0 else "false"
        tabs.append(f'<button type="button" role="tab" id="{tid}" aria-controls="{pid}" aria-selected="{sel}" '
                    f'tabindex="{0 if i == 0 else -1}" data-lang="{lang}">{_esc(labels.get(lang, lang))}</button>')
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
        out.append((lang, m.group(2).rstrip("\n")))
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


BLOCKS = {
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
                 "createDatabase": "Create a database"}
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


# The resource pages are generated from commit API-DOCS-01 part 2 on.
REFERENCE_ON = False


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


# ---- Pages -------------------------------------------------------------------------------

def render() -> dict[str, str]:
    """Every page of the API section, relative to site/."""
    spec = apilib.load()
    _SAMPLE_SEQ[0] = 0
    pages: dict[str, str] = {}
    order = _order()
    for slug, _label in available_guides():
        if slug == "changelog":
            title, desc, article = changelog(spec)
        else:
            title, desc, article = render_guide(slug, spec)
        pages[f"api/{slug}.html"] = api_page(spec, f"api/{slug}.html", title, desc, article, current=slug, order=order)
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
    """The API section as text for llms-full.txt: the guides as rendered text."""
    parts = []
    for slug, _label in available_guides():
        rel = f"api/{slug}.html"
        parts.append(f"\n\n# {sitelib.page_title(pages[rel], rel)}\n\nURL: {sitelib.BASE_URL}{rel}\n\n{sitelib.main_text(pages[rel])}\n")
    return "".join(parts)
