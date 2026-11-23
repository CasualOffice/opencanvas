# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Shared pieces of the website build: page layout, icons, screenshots, a Markdown
renderer for the repository's documents, SEO metadata, and the search index. Used by
tools/build-site.py and tools/build-roadmap.py; standard library only.

Ported from OpenSeal's tools/sitelib.py (CasualOffice, Apache-2.0, same owner), so the
two sites share one structure; only the brand, the navigation, the documents and the
SEO tags differ. The site is static files in site/. Hand-written page bodies live in
site/_src/pages/ and site/_src/docs/, each starting with a metadata comment:

    <!--meta {"title": "...", "description": "...", "nav": "docs"} -->

and may use these placeholders, expanded here:

    {{root}}                 the relative path to the site root ("" or "../")
    {{icon:NAME}}            a Lucide icon, 20 px, decorative ({{icon:NAME:24}} for a size)
    {{shot:NAME|ALT}}        a product screenshot, light and dark, lazy-loaded
    {{shot:NAME|ALT|eager}}  the same, loaded at once (above the fold)
    {{claim:tested|WHAT|PATH}}     a claim's marking: tested, by WHAT, linked to PATH in
                                   the repository (a test file, script or CI workflow)
    {{claim:source|QUOTE|PATH}}    a claim's marking: its numbers are quoted from PATH
                                   (the tracker's integration log, a document); QUOTE must
                                   appear in PATH word for word
    {{claim:deployment|WHAT}}      a claim's marking: it depends on the deployment, and
                                   WHAT says what the operator configures

A claim block is an element with `data-claim` (and every item of a `ul.facts` list);
tools/check-site-claims.py fails on one without exactly one marking, and on a number in
a claim that its marking does not quote.
"""

from __future__ import annotations

import html
import json
import pathlib
import re
import struct
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
SRC = SITE / "_src"
REPO = "https://github.com/CasualOffice/opencanvas"
BLOB = REPO + "/blob/main/"
TREE = REPO + "/tree/main/"
BASE_URL = "https://canvas.casualoffice.org/"
NAME = "OpenCanvas"
LICENCE = "Apache-2.0"
DEMO = "app/#demo"

# ---- Icons -------------------------------------------------------------------------

_ICONS: dict[str, str] | None = None
_SVG_NS = "{http://www.w3.org/2000/svg}"


def _load_icons() -> dict[str, str]:
    """The inner markup of every vendored Lucide icon (site/_src/lucide, ISC)."""
    out: dict[str, str] = {}
    for path in sorted((SRC / "lucide").glob("*.svg")):
        text = re.sub(r"<!--.*?-->", "", path.read_text(encoding="utf8"), flags=re.S)
        root = ET.fromstring(text)
        parts = []
        for child in root:
            tag = child.tag.replace(_SVG_NS, "")
            attrs = " ".join(f'{k}="{html.escape(v, quote=True)}"' for k, v in child.attrib.items())
            parts.append(f"<{tag} {attrs}/>")
        out[path.stem] = "".join(parts)
    return out


def icon(name: str, size: int = 20, cls: str = "") -> str:
    """A decorative Lucide icon as inline SVG (stroke 2, or 1.75 at 24 px and above)."""
    global _ICONS
    if _ICONS is None:
        _ICONS = _load_icons()
    if name not in _ICONS:
        raise SystemExit(f"site: icon {name!r} is not vendored in site/_src/lucide")
    stroke = "1.75" if size >= 24 else "2"
    klass = f"i {cls}".strip()
    return (f'<svg class="{klass}" viewBox="0 0 24 24" width="{size}" height="{size}" fill="none" stroke="currentColor" '
            f'stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
            f"{_ICONS[name]}</svg>")


# ---- Screenshots ---------------------------------------------------------------------

SCREENS = SITE / "assets/screens"


def png_size(path: pathlib.Path) -> tuple[int, int]:
    """Width and height from a PNG's IHDR chunk."""
    with path.open("rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"site: {path} is not a PNG")
    return struct.unpack(">II", head[16:24])


def shot(name: str, alt: str, root: str, eager: bool = False) -> str:
    """A screenshot in both themes. The theme not shown is display:none, so a lazy image
    for it is never fetched; each has WebP with a smaller PNG fallback, and its size set."""
    if not (SCREENS / f"{name}-light.png").exists():
        raise SystemExit(f"site: screenshot site/assets/screens/{name}-light.png is missing; run "
                         "tools/capture-site-screens.mjs, then tools/build-site.py --screens")
    loading = "eager" if eager else "lazy"
    parts = []
    themed = (SCREENS / f"{name}-dark.png").exists()
    for scheme in ("light", "dark") if themed else ("light",):
        png = SCREENS / f"{name}-{scheme}.png"
        w, h = png_size(png)
        cls = f"shot__{scheme}" if themed else "shot__any"
        prio = ' fetchpriority="high"' if eager and scheme == "light" else ""
        parts.append(
            f'<picture class="{cls}"><source type="image/webp" srcset="{root}assets/screens/{name}-{scheme}.webp">'
            f'<img src="{root}assets/screens/{name}-{scheme}.png" width="{w}" height="{h}" alt="{html.escape(alt)}" '
            f'loading="{loading}" decoding="async"{prio}></picture>')
    return f'<span class="shot" data-shot="{name}">{"".join(parts)}</span>'


# ---- Navigation ----------------------------------------------------------------------

NAV = [
    ("features", "Product", "index.html#product"),
    ("integrate", "Integrate", "docs/integration.html"),
    ("docs", "Docs", "docs/index.html"),
    ("roadmap", "Roadmap", "roadmap.html"),
    ("changelog", "Changelog", "changelog.html"),
]

# The documentation, in reading order: (slug, title, group, source). The source is a
# Markdown file in the repository (rendered here, so the page cannot drift from it), or
# None for a hand-written page in site/_src/docs/.
DOCS = [
    ("index", "Documentation", "Start", None),
    ("getting-started", "Getting started", "Start", "README.md"),
    ("release", "Release notes 0.1.0", "Start", "docs/28-RELEASE-v0.1.0.md"),
    ("faq", "FAQ", "Start", None),
    ("integration", "Integration guide", "Integrate", "docs/05-INTEGRATION-GUIDE.md"),
    ("wopi", "WOPI mode", "Integrate", "docs/05-INTEGRATION-GUIDE.md#6"),
    ("jitsi", "Jitsi Meet", "Integrate", "integrations/jitsi/README.md"),
    ("protocol", "Protocol and build contract", "Integrate", "docs/15-BUILD-CONTRACT.md"),
    ("operations", "Operations and deployment", "Operate", "docs/13-OPERATIONS-AND-DEPLOYMENT.md"),
    ("security", "Security and limits", "Operate", "docs/07-SECURITY-AND-LIMITS.md"),
    ("capacity", "Capacity and sizing", "Operate", "docs/22-CAPACITY-AND-SIZING.md"),
    ("ai", "AI and MCP", "Operate", "docs/24-AI-AND-MCP.md"),
    ("architecture", "Architecture", "Understand", "docs/03-HLD-ARCHITECTURE.md"),
    ("collaboration", "Collaboration and presence", "Understand", "docs/06-COLLABORATION-AND-PRESENCE.md"),
    ("product", "Product requirements", "Understand", "docs/02-PRD.md"),
    ("glossary", "Glossary", "Understand", "docs/12-GLOSSARY.md"),
]

# Repository documents that have a page here: links to them in rendered Markdown go to
# the page, everything else to GitHub.
DOC_PAGES = {
    "README.md": "getting-started",
    "docs/28-RELEASE-v0.1.0.md": "release",
    "docs/05-INTEGRATION-GUIDE.md": "integration",
    "docs/15-BUILD-CONTRACT.md": "protocol",
    "docs/13-OPERATIONS-AND-DEPLOYMENT.md": "operations",
    "docs/07-SECURITY-AND-LIMITS.md": "security",
    "docs/22-CAPACITY-AND-SIZING.md": "capacity",
    "docs/24-AI-AND-MCP.md": "ai",
    "docs/03-HLD-ARCHITECTURE.md": "architecture",
    "docs/06-COLLABORATION-AND-PRESENCE.md": "collaboration",
    "docs/02-PRD.md": "product",
    "docs/12-GLOSSARY.md": "glossary",
    "docs/00-README.md": "index",
}

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'")


def _esc(s: str) -> str:
    return html.escape(s, quote=True)


def header(root: str, current: str) -> str:
    links = []
    for key, label, href in NAV:
        cur = ' aria-current="page"' if key == current else ""
        links.append(f'<a href="{root}{href}"{cur}>{label}</a>')
    nav = "".join(links)
    gh = f'<a href="{REPO}" class="nav-gh">GitHub{icon("arrow-up-right", 14)}</a>'
    # The header's action is the strong (ink) button: the accent is kept for the one
    # primary call to action in each page's body, as on the OpenSeal site.
    return f"""<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="{root}index.html" aria-label="OpenCanvas home">
      <img class="logo-light" src="{root}assets/logo.svg" alt="" width="136" height="24">
      <img class="logo-dark" src="{root}assets/logo-dark.svg" alt="" width="136" height="24">
    </a>
    <nav class="nav-links" aria-label="Main">{nav}</nav>
    <div class="header-actions">
      <button type="button" class="search-open" aria-label="Search the site" aria-keyshortcuts="/">{icon("search", 16)}<span class="search-open__label">Search</span><span class="kbd" aria-hidden="true">/</span></button>
      <button type="button" class="icon-btn theme-toggle" aria-label="Use the dark theme">{icon("moon", 18, cls="when-light")}{icon("sun", 18, cls="when-dark")}</button>
      <a class="header-gh" href="{REPO}">GitHub</a>
      <a class="btn btn-strong btn-sm header-cta" href="{root}{DEMO}">Try the demo</a>
      <details class="menu">
        <summary aria-label="Menu">{icon("menu", cls="when-closed")}{icon("x", cls="when-open")}</summary>
        <nav class="menu-panel" aria-label="Main (mobile)">{nav}{gh}<a class="menu-cta" href="{root}{DEMO}">Try the demo{icon("arrow-right", 16)}</a></nav>
      </details>
    </div>
  </div>
</header>"""


def footer(root: str) -> str:
    def col(title: str, items: list[tuple[str, str]]) -> str:
        lis = "".join(f'<li><a href="{h if h.startswith("http") else root + h}">{t}</a></li>' for t, h in items)
        return f'<div class="foot-col"><h2>{title}</h2><ul>{lis}</ul></div>'
    return f"""<footer class="site-footer">
  <div class="wrap foot-grid">
    <div class="foot-brand">
      <img class="logo-light" src="{root}assets/logo.svg" alt="OpenCanvas" width="136" height="24" loading="lazy">
      <img class="logo-dark" src="{root}assets/logo-dark.svg" alt="OpenCanvas" width="136" height="24" loading="lazy">
      <p>An open-source collaborative canvas you embed, under <span class="nowrap">{LICENCE}</span>. Part of <a href="https://github.com/CasualOffice">CasualOffice</a>.</p>
      <p class="foot-legal">Your application keeps the users, the permissions and the file. OpenCanvas does the editing.</p>
    </div>
    {col("Product", [("Overview", "index.html#product"), ("Try the demo", DEMO), ("Roadmap", "roadmap.html"), ("Changelog", "changelog.html")])}
    {col("Documentation", [("Getting started", "docs/getting-started.html"), ("Integration guide", "docs/integration.html"), ("WOPI mode", "docs/wopi.html"), ("Jitsi Meet", "docs/jitsi.html"), ("Operations", "docs/operations.html")])}
    {col("Trust", [("Security and limits", "docs/security.html"), ("Architecture", "docs/architecture.html"), ("Protocol", "docs/protocol.html"), ("FAQ", "docs/faq.html")])}
    {col("Project", [("GitHub", REPO), ("Licence (Apache-2.0)", BLOB + "LICENSE"), ("Contributing", BLOB + "AGENTS.md"), ("Brand", "brand.html")])}
  </div>
  <div class="wrap foot-base"><p>Open source under the Apache License 2.0. Keep the NOTICE file when you redistribute it. Bundled fonts are under the SIL Open Font License.</p><p>Pre-release software: P1 alpha, for evaluation, not yet for production.</p></div>
</footer>"""


SEARCH_DIALOG = """<dialog class="search-dialog" aria-label="Search the site">
  <form method="dialog" class="search-form" role="search">
    <label class="sr-only" for="search-q">Search</label>
    {icon}
    <input id="search-q" class="search-input" type="search" placeholder="Search docs and pages" autocomplete="off" spellcheck="false">
    <button type="submit" class="icon-btn search-close" aria-label="Close search">{x}</button>
  </form>
  <p class="search-status" role="status" aria-live="polite"></p>
  <ul class="search-results"></ul>
</dialog>"""

OG_IMAGE = "assets/screens/canvas-light.png"


def page(*, title: str, description: str, body: str, root: str, path: str, current: str = "",
         main_class: str = "", jsonld: dict | None = None, noindex: bool = False) -> str:
    """A whole page around `body` (the contents of <main>). `path` is the page's path
    under the site root ("index.html", "docs/faq.html"), for its canonical URL."""
    full_title = "OpenCanvas: a collaborative canvas you embed" if title == NAME else f"{title} | OpenCanvas"
    search = SEARCH_DIALOG.format(icon=icon("search", cls="search-icon"), x=icon("x"))
    mc = f' class="{main_class}"' if main_class else ""
    canonical = BASE_URL + ("" if path == "index.html" else path)
    ld = ""
    if jsonld:
        ld = '\n<script type="application/ld+json">' + json.dumps(jsonld, ensure_ascii=False).replace("</", "<\\/") + "</script>"
    robots = '\n<meta name="robots" content="noindex">' if noindex else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<meta name="referrer" content="no-referrer">
<title>{_esc(full_title)}</title>
<meta name="description" content="{_esc(description)}">{robots}
<link rel="canonical" href="{canonical}">
<meta name="theme-color" content="#f4f3f0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f0f11" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OpenCanvas">
<meta property="og:title" content="{_esc(full_title)}">
<meta property="og:description" content="{_esc(description)}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{BASE_URL}{OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{root}assets/mark.svg" type="image/svg+xml">
<link rel="preload" href="{root}assets/fonts/ui/geist-1.3.1-variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="{root}assets/tokens.css">
<link rel="stylesheet" href="{root}assets/site.css">
<script src="{root}assets/theme-init.js"></script>
<script type="module" src="{root}assets/site.js"></script>{ld}
</head>
<body data-root="{root}">
<a class="skip" href="#main">Skip to content</a>
{header(root, current)}
<main id="main" tabindex="-1"{mc}>
{body}
</main>
{footer(root)}
{search}
</body>
</html>
"""


# ---- Fragments -----------------------------------------------------------------------

META = re.compile(r"^\s*<!--meta\s+(\{.*?\})\s*-->\s*", re.S)


def read_fragment(path: pathlib.Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf8")
    m = META.match(text)
    if not m:
        raise SystemExit(f"site: {path.relative_to(ROOT)} has no <!--meta {{...}} --> header")
    return json.loads(m.group(1)), text[m.end():]


def norm_space(s: str) -> str:
    return " ".join(s.split())


def claim(arg: str, root: str) -> str:
    """A claim's marking: "tested|WHAT|PATH", "source|QUOTE|PATH" or "deployment|WHAT"."""
    bits = arg.split("|")
    if bits[0] == "tested" and len(bits) == 3 and bits[1] and bits[2]:
        what, path = bits[1], bits[2]
        if not (ROOT / path).exists():
            raise SystemExit(f"site: claim marking names {path!r}, which is not in the repository")
        return (f'<a class="claim-mark claim-mark--tested" data-claim-mark="tested" href="{BLOB}{_esc(path)}">'
                f'{icon("circle-check", 14)}<span>Tested: {_esc(what)}</span></a>')
    if bits[0] == "source" and len(bits) == 3 and bits[1] and bits[2]:
        quote, path = bits[1], bits[2]
        if not (ROOT / path).exists():
            raise SystemExit(f"site: claim marking names {path!r}, which is not in the repository")
        if norm_space(quote) not in norm_space((ROOT / path).read_text(encoding="utf8")):
            raise SystemExit(f"site: claim quote {quote!r} is not in {path}")
        label = path.split("/")[-1].split("-")[0] if path.startswith("docs/") else path
        label = f"docs/{label}" if path.startswith("docs/") else label
        return (f'<a class="claim-mark claim-mark--tested" data-claim-mark="source" data-quote="{_esc(quote)}" '
                f'href="{BLOB}{_esc(path)}">{icon("scroll-text", 14)}<span>Source: {_esc(label)}, “{_esc(quote)}”</span></a>')
    if bits[0] == "deployment" and len(bits) == 2 and bits[1]:
        return (f'<span class="claim-mark claim-mark--deploy" data-claim-mark="deployment">'
                f'{icon("server", 14)}<span>Depends on your deployment: {_esc(bits[1])}</span></span>')
    raise SystemExit(f"site: bad claim marking {{{{claim:{arg}}}}}")


def expand(text: str, root: str) -> str:
    """Expand {{root}}, {{icon:...}}, {{shot:...}} and {{claim:...}}."""
    def sub(m: re.Match) -> str:
        kind, _, arg = m.group(1).partition(":")
        if kind == "root":
            return root
        if kind == "claim":
            return claim(arg, root)
        if kind == "icon":
            name, _, size = arg.partition(":")
            return icon(name, int(size) if size else 20)
        if kind == "shot":
            bits = arg.split("|")
            return shot(bits[0], bits[1] if len(bits) > 1 else "", root, eager=len(bits) > 2 and bits[2] == "eager")
        raise SystemExit(f"site: unknown placeholder {{{{{m.group(1)}}}}}")
    return re.sub(r"\{\{([a-z]+(?::[^}]*)?)\}\}", sub, text)


def slugify(text: str) -> str:
    """GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, so
    links written for GitHub (`05-INTEGRATION-GUIDE.md#6-wopi-mode`) work here too."""
    s = re.sub(r"<[^>]+>", "", text)
    s = html.unescape(s).lower().strip()
    s = re.sub(r"[^\w\- ]", "", s)
    s = s.replace(" ", "-")
    return s or "section"


def add_heading_ids(body: str) -> str:
    """Give every h2 and h3 without an id one made from its text (unique in the page)."""
    seen: set[str] = set(re.findall(r'\bid="([^"]+)"', body))

    def sub(m: re.Match) -> str:
        tag, attrs, inner = m.group(1), m.group(2), m.group(3)
        if "id=" in attrs:
            return m.group(0)
        base = slugify(inner)
        sid, n = base, 1
        while sid in seen:
            sid, n = f"{base}-{n}", n + 1
        seen.add(sid)
        return f'<{tag}{attrs} id="{sid}">{inner}</{tag}>'
    return re.sub(r"<(h[2-4])([^>]*)>(.*?)</\1>", sub, body, flags=re.S)


def available_docs() -> list[tuple[str, str, str, str | None]]:
    return [d for d in DOCS if d[3] is not None or (SRC / "docs" / f"{d[0]}.html").exists()]


def docs_page(slug: str, title: str, description: str, article: str, source: str | None = None) -> str:
    """A documentation page: left nav, the article, on-this-page links, previous and next."""
    root = "../"
    article = add_heading_ids(article)
    docs = available_docs()
    groups: dict[str, list[str]] = {}
    for s, t, g, _src in docs:
        cur = ' aria-current="page"' if s == slug else ""
        groups.setdefault(g, []).append(f'<li><a href="{s}.html"{cur}>{_esc(t)}</a></li>')
    side = "".join(f'<h2>{g}</h2><ul>{"".join(items)}</ul>' for g, items in groups.items())
    toc_items = re.findall(r'<h2[^>]*id="([^"]+)"[^>]*>(.*?)</h2>', article, flags=re.S)
    toc = ""
    if len(toc_items) >= 2:
        lis = "".join(f'<li><a href="#{i}">{re.sub(r"<[^>]+>", "", t)}</a></li>' for i, t in toc_items)
        toc = f'<nav class="toc" aria-label="On this page"><h2>On this page</h2><ul>{lis}</ul></nav>'
    order = [d[0] for d in docs]
    i = order.index(slug)
    pn = []
    if i > 0:
        ps, pt = docs[i - 1][0], docs[i - 1][1]
        pn.append(f'<a class="pn pn-prev" href="{ps}.html"><span class="pn-dir">{icon("chevron-left", 16)}Previous</span><span class="pn-title">{_esc(pt)}</span></a>')
    if i + 1 < len(docs):
        ns, nt = docs[i + 1][0], docs[i + 1][1]
        pn.append(f'<a class="pn pn-next" href="{ns}.html"><span class="pn-dir">Next{icon("chevron-right", 16)}</span><span class="pn-title">{_esc(nt)}</span></a>')
    src_note = ""
    if source:
        file = source.split("#")[0]
        src_note = (f'<p class="note doc-source">{icon("file-text", 14)}Generated from <a href="{BLOB}{file}">{file}</a> '
                    f'in the repository; edit it there.</p>')
    body = f"""<div class="wrap docs-layout">
  <aside class="docs-side">
    <details class="docs-nav-toggle"><summary>{icon("list-tree", 16)}Documentation menu</summary><nav class="docs-nav" aria-label="Documentation (menu)">{side}</nav></details>
    <nav class="docs-nav docs-nav--wide" aria-label="Documentation">{side}</nav>
  </aside>
  <article class="docs-article prose">
{article}
{src_note}
    <nav class="prevnext" aria-label="Previous and next">{"".join(pn)}</nav>
  </article>
  {toc}
</div>"""
    current = "integrate" if slug == "integration" else "docs"
    return page(title=title, description=description, body=body, root=root, path=f"docs/{slug}.html",
                current=current, main_class="docs-main")


# ---- Markdown (what the repository's documents use) ------------------------------------

def _link_target(href: str, from_file: str, link_base_root: str) -> str:
    """A Markdown link from `from_file` (repository path) as a site or GitHub URL."""
    if re.match(r"[a-z]+:", href) or href.startswith("#"):
        return href
    path, _, frag = href.partition("#")
    if path.startswith("<") or not path:
        return href
    target = (pathlib.PurePosixPath(from_file).parent / path).as_posix()
    parts: list[str] = []
    for seg in target.split("/"):
        if seg == "..":
            if parts:
                parts.pop()
        elif seg not in ("", "."):
            parts.append(seg)
    target = "/".join(parts)
    if target in DOC_PAGES:
        return f"{link_base_root}docs/{DOC_PAGES[target]}.html" + (f"#{frag}" if frag else "")
    full = ROOT / target
    base = TREE if full.is_dir() else BLOB
    return base + target + (f"#{frag}" if frag else "")


def md_inline(s: str, from_file: str = "", root: str = "../") -> str:
    out = []
    pos = 0
    for m in re.finditer(r"(`+)(.+?)\1", s):
        out.append(_md_text(s[pos:m.start()], from_file, root))
        out.append(f"<code>{html.escape(m.group(2).strip())}</code>")
        pos = m.end()
    out.append(_md_text(s[pos:], from_file, root))
    return "".join(out)


def _md_text(s: str, from_file: str, root: str) -> str:
    s = html.escape(s, quote=False)
    s = s.replace("&lt;br&gt;", "<br>")

    def link(m: re.Match) -> str:
        text, href = m.group(1), html.unescape(m.group(2))
        if href.startswith("<"):
            return text  # a template URL in prose, not a link
        return f'<a href="{html.escape(_link_target(href, from_file, root), quote=True)}">{text}</a>'
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", s)
    s = re.sub(r"(?<![\w])_(?!\s)([^_]+?)(?<!\s)_(?![\w])", r"<em>\1</em>", s)
    s = re.sub(r"~~(.+?)~~", r"<del>\1</del>", s)
    return s


def _cells(line: str) -> list[str]:
    return [c.strip() for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]


def markdown(text: str, shift: int = 0, from_file: str = "", root: str = "../") -> str:
    """Headings, paragraphs, nested '-' and numbered lists, task boxes, tables, block
    quotes and fenced code: what README.md and docs/*.md use."""
    out: list[str] = []
    lines = text.splitlines()
    i = 0
    inl = lambda x: md_inline(x, from_file, root)  # noqa: E731

    def is_list(line: str) -> re.Match | None:
        return re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", line)

    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            lang = line[3:].strip()
            j = i + 1
            code = []
            while j < len(lines) and not lines[j].startswith("```"):
                code.append(lines[j])
                j += 1
            cls = f' class="language-{_esc(lang)}"' if lang else ""
            out.append(f"<pre><code{cls}>{html.escape(chr(10).join(code))}</code></pre>")
            i = j + 1
            continue
        m = re.match(r"(#{1,6})\s+(.*)", line)
        if m:
            level = min(6, len(m.group(1)) + shift)
            out.append(f"<h{level}>{inl(m.group(2).strip())}</h{level}>")
            i += 1
            continue
        if re.match(r"^\s*(-{3,}|\*{3,})\s*$", line):
            out.append("<hr>")
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|?\s*:?-{2,}", lines[i + 1]):
            head = _cells(line)
            j = i + 2
            body_rows = []
            while j < len(lines) and lines[j].startswith("|"):
                body_rows.append(_cells(lines[j]))
                j += 1
            th = "".join(f'<th scope="col">{inl(c.replace(chr(92) + "|", "|"))}</th>' for c in head)
            trs = []
            for r in body_rows:
                r = (r + [""] * len(head))[: max(len(head), len(r))]
                trs.append("<tr>" + "".join(f"<td>{inl(c.replace(chr(92) + '|', '|'))}</td>" for c in r) + "</tr>")
            out.append(f'<div class="table-scroll" tabindex="0" role="region" aria-label="Table"><table><thead><tr>{th}</tr></thead>'
                       f'<tbody>{"".join(trs)}</tbody></table></div>')
            i = j
            continue
        if line.startswith(">"):
            j = i
            quote = []
            while j < len(lines) and lines[j].startswith(">"):
                quote.append(lines[j][1:].lstrip() if len(lines[j]) > 1 else "")
                j += 1
            out.append(f"<blockquote>{markdown(chr(10).join(quote), shift, from_file, root)}</blockquote>")
            i = j
            continue
        if is_list(line):
            # Collect the list block: list lines and their indented continuations.
            items: list[tuple[int, str, str]] = []  # (indent, marker, text)
            j = i
            while j < len(lines):
                lm = is_list(lines[j])
                if lm:
                    items.append((len(lm.group(1)), lm.group(2), lm.group(3)))
                elif lines[j].startswith("  ") and lines[j].strip() and items:
                    ind, mk, tx = items[-1]
                    items[-1] = (ind, mk, tx + " " + lines[j].strip())
                else:
                    break
                j += 1
            out.append(_render_list(items, inl))
            i = j
            continue
        if not line.strip():
            i += 1
            continue
        para = [line.strip()]
        j = i + 1
        while j < len(lines) and lines[j].strip() and not (
                lines[j].startswith(("```", "#", "|", ">")) or is_list(lines[j])):
            para.append(lines[j].strip())
            j += 1
        out.append(f"<p>{inl(' '.join(para))}</p>")
        i = j
    return "\n".join(out)


def _render_list(items: list[tuple[int, str, str]], inl) -> str:
    def build(start: int, indent: int) -> tuple[str, int]:
        ordered = items[start][1][0].isdigit()
        tag = "ol" if ordered else "ul"
        parts = []
        k = start
        while k < len(items) and items[k][0] >= indent:
            ind, _mk, tx = items[k]
            if ind > indent:
                sub, k = build(k, ind)
                if parts:
                    parts[-1] = parts[-1][:-5] + sub + "</li>"
                continue
            box = re.match(r"^\[( |x|X)\]\s+(.*)$", tx)
            if box:
                mark = icon("square-check", 16) if box.group(1).lower() == "x" else '<span class="task-box" aria-hidden="true"></span>'
                state = "done" if box.group(1).lower() == "x" else "open"
                parts.append(f'<li class="task task-{state}">{mark}<span>{inl(box.group(2))}</span></li>')
            else:
                parts.append(f"<li>{inl(tx)}</li>")
            k += 1
        return f"<{tag}>{''.join(parts)}</{tag}>", k
    html_, _ = build(0, items[0][0])
    return html_


# ---- Search index --------------------------------------------------------------------

class _Text(HTMLParser):
    """Sections of <main>: (heading id, heading text, body text)."""

    SKIP = {"script", "style", "svg", "nav", "aside", "dialog"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_main = 0
        self.skip = 0
        self.sections: list[list[str]] = [["", "", ""]]
        self.head: str | None = None
        self.head_id = ""

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "main":
            self.in_main += 1
        if not self.in_main:
            return
        if tag in self.SKIP:
            self.skip += 1
        elif tag in ("h1", "h2", "h3") and not self.skip:
            self.head = ""
            self.head_id = a.get("id", "") or ""

    def handle_endtag(self, tag):
        if tag == "main":
            self.in_main -= 1
        if not self.in_main:
            return
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in ("h1", "h2", "h3") and self.head is not None:
            self.sections.append([self.head_id, self.head.strip(), ""])
            self.head = None

    def handle_data(self, data):
        if not self.in_main or self.skip:
            return
        if self.head is not None:
            self.head += data
        else:
            self.sections[-1][2] += " " + data


def page_title(page_html: str, rel: str) -> str:
    title = re.search(r"<title>(.*?)</title>", page_html, re.S)
    return html.unescape(title.group(1)).replace(" | OpenCanvas", "") if title else rel


def index_entries(rel: str, page_html: str) -> list[dict]:
    """Search entries for one page: one per heading, with up to 600 characters of text."""
    p = _Text()
    p.feed(page_html)
    title = page_title(page_html, rel)
    out = []
    for sid, head, text in p.sections:
        text = re.sub(r"\s+", " ", text).strip()
        if not head and not text:
            continue
        out.append({"u": rel + (f"#{sid}" if sid else ""), "p": title, "h": head or title, "t": text[:600]})
    return out


def main_text(page_html: str) -> str:
    """The readable text of <main>, for llms-full.txt."""
    p = _Text()
    p.feed(page_html)
    chunks = []
    for _sid, head, text in p.sections:
        text = re.sub(r"\s+", " ", text).strip()
        if head:
            chunks.append(f"## {head}")
        if text:
            chunks.append(text)
    return "\n\n".join(chunks)
