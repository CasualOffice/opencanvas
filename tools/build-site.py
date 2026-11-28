#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Build the website in site/ from site/_src/ and the repository's documents. The output
is committed; GitHub Pages publishes site/ without _src/, plus the editor's demo copy.

    python3 tools/build-site.py                  # write every generated file
    python3 tools/build-site.py --check          # fail, naming the file, if anything is stale
    python3 tools/build-site.py --screens DIR    # turn raw captures (tools/capture-site-screens.mjs)
                                                 # into site/assets/screens/*.webp and *.png (needs Pillow)
    python3 tools/build-site.py --publish OUT    # assemble the published tree in OUT: site/ without
                                                 # _src/, plus the built editor in OUT/app/

Ported from OpenSeal's tools/build-site.py (same structure, same commands). What it
generates:

- site/index.html and the other pages in site/_src/pages/ (hand-written bodies), including
  the comparison pages in alternatives/ and the use-case pages in solutions/;
- site/docs/*.html: README.md and docs/*.md rendered (tools/sitelib.py DOCS), so the
  documentation pages cannot drift from the repository, plus hand-written pages;
- site/roadmap.html from docs/09 and the tracker, docs/10 (tools/build-roadmap.py);
- site/api/: the API reference, from crates/oc-server/api/openapi.json and the guides in
  site/_src/api/ (tools/build-api.py);
- site/changelog.html from the tracker's integration log (docs/10);
- sitemap.xml, robots.txt, llms.txt (an index) and llms-full.txt (the docs as text);
- search-index.json for the site search.

The published tree is site/ plus web/packages/editor/dist at app/: the real editor, which
opens its demo canvas at app/#demo with no server. The copy is made at publish time, not
committed. Build the editor with OC_EDITOR_BASE=./ (relative paths) for GitHub Pages.
Standard library, except Pillow for --screens.
"""

from __future__ import annotations

import html
import importlib.util
import json
import pathlib
import re
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import sitelib  # noqa: E402

ROOT = sitelib.ROOT
SITE = sitelib.SITE
SRC = sitelib.SRC
TRACKER = ROOT / "docs/10-EXECUTION-TRACKER.md"
EDITOR_DIST = ROOT / "web/packages/editor/dist"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / "tools" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---- Screenshots -----------------------------------------------------------------------

# raw capture name -> target width of the WebP. Captures are at device scale 2 (2880 px
# for a 1440 px window, 780 px for a 390 px phone).
SHOTS = {
    "canvas": 2000, "database": 2000, "whiteboard": 2000, "templates": 2000, "comments": 2000,
    "phone": 780,
    "assistant-plan": 2000, "assistant-review": 2000,
    "assistant-phone-plan": 780, "assistant-phone-review": 780,
}
PNG_MAX = 1280


def screens(raw: pathlib.Path) -> None:
    """Convert every raw capture present in `raw`; a screen not captured keeps its files."""
    try:
        from PIL import Image
    except ImportError:
        raise SystemExit("build-site: --screens needs Pillow (pip install pillow)")
    out = SITE / "assets/screens"
    out.mkdir(parents=True, exist_ok=True)
    done = 0
    for name, width in SHOTS.items():
        for scheme in ("light", "dark"):
            path = raw / f"{scheme}-{name}.png"
            if not path.exists():
                continue
            img = Image.open(path).convert("RGB")
            if img.width > width:
                img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
            img.save(out / f"{name}-{scheme}.webp", "WEBP", quality=82, method=6)
            small = img
            limit = PNG_MAX if width > PNG_MAX else width
            if img.width > limit:
                small = img.resize((limit, round(img.height * limit / img.width)), Image.LANCZOS)
            small.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(
                out / f"{name}-{scheme}.png", optimize=True)
            done += 1
            print(f"build-site: {name}-{scheme} {img.width}x{img.height}")
    if not done:
        raise SystemExit(f"build-site: no captures in {raw}; run tools/capture-site-screens.mjs first")


# ---- Documentation from Markdown --------------------------------------------------------

# Each page's meta description and the summary under its title: 70-160 characters, so
# search engines show it whole (tools/check-site-seo.py).
DOC_DESCRIPTIONS = {
    "getting-started": "Run the OpenCanvas server, the editor and the sample host on your machine, try the demo without a backend, embed it, and run the tests.",
    "release-040": "OpenCanvas 0.4.0 release notes: spreadsheets, advanced databases, Timeline, charts, partial sync, performance, upgrade notes and limitations.",
    "release-030": "OpenCanvas 0.3.0 release notes: live blocks, search, automation and offline editing, the upgrade notes and known limitations.",
    "release-020": "OpenCanvas 0.2.0 release notes: the headless API, webhooks, the block SDK and editor profiles, upgrade notes, known limitations and the checklist.",
    "release-012": "OpenCanvas 0.1.2 release and upgrade notes for host integrations, diagramming, version history, and the headless API.",
    "release": "OpenCanvas 0.1.0 release notes: what is included, changes since the alpha, upgrade notes (WOPI proof keys, MCP public URL) and known limitations.",
    "integration": "The host contract: register your host, sign a JWT launch token, embed the editor, answer load and save callbacks, and use postMessage and REST.",
    "wopi": "Open OpenCanvas from an existing WOPI host such as Nextcloud: discovery, the WOPISrc allow-list, CheckFileInfo, GetFile, PutFile and PUT_RELATIVE.",
    "matrix": "Add a shared canvas to Matrix rooms as an Element widget: identity checked with the homeserver, room members only, roles from power levels.",
    "jitsi": "Add a shared canvas to Jitsi Meet with one Prosody plugin and config, no Docker changes: temporary canvases, blank or from a template.",
    "nextcloud": "Create and edit .ocanvas files in Nextcloud with the opencanvas app: Nextcloud keeps the files, shares and versions as the WOPI host.",
    "mattermost": "Canvases and meeting notes in Mattermost channels, in the right-hand panel: the plugin is the host, files stay in Mattermost, access follows the channel.",
    "protocol": "The exact interfaces between the OpenCanvas server, the editor and the host: routes, the WebSocket protocol, the Yjs layout and the save outbox.",
    "block-sdk": "Write, package and install your own OpenCanvas blocks: the sandboxed bridge, the block.json manifest, migrations, and how operators enable blocks.",
    "operations": "Run OpenCanvas: the Docker image, a single node on SQLite, a cluster on MySQL or MariaDB with Redis, Helm, PDF export with Gotenberg, health and metrics.",
    "security": "OpenCanvas trust boundaries, threats and controls, default limits and what personal data it holds.",
    "ai": "The OpenCanvas assistant and MCP endpoint: what they may do, what is sent to the model server, the threat model, limits and operator configuration.",
    "benchmarks": "Benchmark results for OpenCanvas with the hardware, store and load mix of every run: edit latency, memory and reconnect times per scenario.",
    "capacity": "Measured capacity of an OpenCanvas server: users per room and per node, memory per user and per room, and a sizing table for self-hosters.",
    "architecture": "How OpenCanvas is built: components, the launch and save flows, persistence, scaling with room owners, and the deployment shape.",
    "collaboration": "How edits merge, how cursors and presence work, undo, connectivity and comments in OpenCanvas.",
    "product": "What OpenCanvas is for, for whom, what is in scope, and its non-functional targets.",
    "glossary": "Terms used across the OpenCanvas documentation: host, canvas, block, room, owner node, launch token, session ticket, WAL, CRDT and WOPI.",
}


def _md_body(source: str) -> tuple[str, str]:
    """(file, markdown) for a DOCS source, with the title heading removed."""
    file, _, section = source.partition("#")
    text = (ROOT / file).read_text(encoding="utf8")
    # Leading HTML comments (the SPDX header) would show as text and hide the title heading.
    text = re.sub(r"\A(?:\s*<!--.*?-->)+\s*", "", text, flags=re.S)
    if file == "README.md":
        # The project page's own sections; the site has its own Documentation and Contributing.
        # The introduction before the first section (title, badges, tagline, link row, the
        # <picture>, which the site's Markdown would escape) is the GitHub landing view; the
        # home page says the same. So is the summary list, which Features repeats.
        m = re.search(r"^## ", text, flags=re.M)
        if not m:
            raise SystemExit("build-site: README.md has no ## sections")
        text = text[m.start():]
        text = re.sub(r"^## (A quick tour|What is in the canvas)\n.*?(?=^## |\Z)", "", text, flags=re.S | re.M)
        text = re.sub(r"^## (Documentation|Contributing|License)\n.*?(?=^## |\Z)", "", text, flags=re.S | re.M)
        return file, text
    if section:
        m = re.search(rf"^## {re.escape(section)}\. .*?\n(.*?)(?=^## |\Z)", text, flags=re.S | re.M)
        if not m:
            raise SystemExit(f"build-site: {file} has no section {section}")
        return file, m.group(1)
    text = re.sub(r"^# .*\n", "", text, count=1)
    if file == "docs/24-AI-AND-MCP.md":
        # The design without the market research (§2) and the owner's open questions (§12),
        # which stay in the repository; then the operator configuration from docs/13.
        text = re.sub(r"^## 2\. .*?(?=^## 3\. )", "", text, flags=re.S | re.M)
        text = re.sub(r"^## 12\. .*?(?=^## |\Z)", "", text, flags=re.S | re.M)
        ops = (ROOT / "docs/13-OPERATIONS-AND-DEPLOYMENT.md").read_text(encoding="utf8")
        m = re.search(r"^## AI and MCP .*?(?=^## Health)", ops, flags=re.S | re.M)
        if not m:
            raise SystemExit("build-site: docs/13 has no AI and MCP section")
        conf = re.sub(r"^## ", "### ", m.group(0), flags=re.M)
        text = (text.rstrip() + "\n\n## Operator configuration\n\nFrom the [operations guide](13-OPERATIONS-AND-DEPLOYMENT.md).\n\n"
                + conf)
    if file == "docs/05-INTEGRATION-GUIDE.md":
        text = re.sub(r"^(## 6\. .*?\n).*?(?=^## )",
                      r"\1\nWOPI mode has its own page: [WOPI mode](wopi.html).\n\n", text, flags=re.S | re.M)
    return file, text


def _sources(source: str) -> list[str]:
    """The repository files a Markdown page is made from, for its date."""
    file = source.split("#")[0]
    return [file, "docs/13-OPERATIONS-AND-DEPLOYMENT.md"] if file == "docs/24-AI-AND-MCP.md" else [file]


def howto_run_it() -> dict:
    """README.md's "Run it" steps as a HowTo: the prerequisites, each command of its first
    code block, and the paragraph after it, word for word."""
    text = (ROOT / "README.md").read_text(encoding="utf8")
    m = re.search(r"^## Run it\n(.*?)(?=^## |\Z)", text, flags=re.S | re.M)
    if not m:
        raise SystemExit("build-site: README.md has no Run it section")
    m2 = re.match(r"\s*(.*?)\n\n```\w*\n(.*?)\n```\n\n(.*?)(?:\n\n|\Z)", m.group(1), flags=re.S)
    if not m2:
        raise SystemExit("build-site: README.md's Run it section is not a paragraph, a code block and a paragraph")
    plain = lambda md: sitelib.norm_space(re.sub(r"[`*]", "", md))  # noqa: E731
    steps = [plain(m2.group(1))]
    for line in m2.group(2).splitlines():
        cmd, _, note = line.partition("  #")
        if cmd.strip():
            steps.append(f"Run {cmd.strip()}" + (f" (serves {note.strip()})" if note.strip().startswith("http") else ""))
    steps.append(plain(m2.group(3)))
    url = sitelib.BASE_URL + "docs/getting-started.html#run-it"
    return {"@type": "HowTo", "name": "Run OpenCanvas on your machine",
            "description": "Start the OpenCanvas server from the container image or the Linux install script (checksum verified); the rest of the page builds it from source.",
            "url": url, "inLanguage": "en",
            "step": [{"@type": "HowToStep", "position": i + 1, "text": t, "url": url} for i, t in enumerate(steps)]}


BENCH = ROOT / "bench" / "results"


def _num(v) -> str:
    if isinstance(v, float):
        return f"{v:,.1f}".rstrip("0").rstrip(".")
    if isinstance(v, int):
        return f"{v:,}"
    if isinstance(v, dict):
        return ", ".join(f"{k} {_num(x)}" for k, x in v.items())
    return str(v)


def _hardware(d: dict) -> str:
    h = d.get("hardware", {})
    return (f"{h.get('cpu', '?')}, {h.get('vcpu', '?')} vCPU, {h.get('ramGb', '?')} GB RAM, "
            f"{h.get('os', '?')}, {h.get('storage', '?')}; machine `{d.get('machine', '?')}`")


def benchmark_markdown() -> str:
    """BENCH-05: every result in bench/results/, newest first, each with its hardware and load
    mix beside its numbers. Results marked `local` ran on a developer machine, not the 4 vCPU /
    8 GB reference node."""
    out = [
        "Every number below comes from a result file in `bench/results/`, produced by "
        "`scripts/bench/run` (docs/36 §3). Each result names the machine it ran on, the hardware, "
        "the store and the load mix. **Results marked `local` ran on a developer laptop in short "
        "form, not on the reference machine (4 vCPU, 8 GB), and are not the published capacity.** "
        "The capacity page has the sizing guidance.",
        "",
    ]
    files = sorted(BENCH.glob("*.json"), key=lambda p: (_added(p), p.name), reverse=True)
    for f in files:
        d = json.loads(f.read_text(encoding="utf8"))
        name = d.get("scenario", f.stem)
        size = d.get("size", "")
        out += [f"## {name} {size} — {f.stem}".replace("  ", " "), ""]
        out.append(f"- **Run:** {d.get('date', '?')}, commit `{d.get('commit', '?')}`"
                   f"{' (uncommitted changes)' if d.get('dirty') else ''}; {_hardware(d)}; store `{d.get('store', '?')}`")
        if d.get("serverEnv"):
            out.append(f"- **Server settings:** " + ", ".join(f"`{k}={v}`" for k, v in d["serverEnv"].items()))
        if "mix" in d:
            load, mix = d.get("load", {}), d["mix"]
            st = mix.get("stated", {})
            out.append(f"- **Load mix:** {_num(load.get('connections', 0))} connections over "
                       f"{_num(load.get('rooms', 0))} rooms (docs {load.get('docs', '?')}); roles "
                       f"{_num(mix.get('roles', {}))}; presence {_num(st.get('presence_hz', 0))}/s, "
                       f"typing {_num(st.get('typing_hz', 0))} edits/s; {_num(d.get('minutes', 0))} min, "
                       f"{_num(d.get('bucketSecs', 0))} s buckets"
                       + (f"; faults: " + ", ".join(f"{x['kind']} at {_num(x['atSecs'])} s" for x in d.get("faults", [])) if d.get("faults") else ""))
        elif "profile" in d:
            p = d["profile"]
            out.append(f"- **Load:** {d.get('load', '')}; {d.get('browser', '')}, CPU throttle "
                       f"{p.get('cpuThrottle', '?')}×, {p.get('downMbit', '?')} Mbit/s, {p.get('rttMs', '?')} ms RTT")
        out.append("")
        if "pass" in d:
            out += [f"Verdict: **{'pass' if d.get('passed') else 'fail'}**.", "",
                    "| Rule | Measured | Verdict |", "|---|---|---|"]
            for r in d["pass"]:
                out.append(f"| {r['rule']} | {_num(r['value'])} | {'pass' if r['pass'] else 'fail'} |")
            out.append("")
        if d.get("buckets"):
            out += ["| t (s) | live | p50 ms | p99 ms | server RSS MB | fault |", "|---|---|---|---|---|---|"]
            for b in d["buckets"]:
                lat = b.get("latMs", {})
                out.append(f"| {b.get('tSecs')} | {_num(b.get('live', 0))} | {_num(lat.get('p50', 0))} | "
                           f"{_num(lat.get('p99', 0))} | {_num(b.get('server', {}).get('rssMb') or 0)} | {b.get('fault') or ''} |")
            out.append("")
        if d.get("fixtures"):
            out += ["| Fixture | First screen median ms | Worst ms | Heap MB |", "|---|---|---|---|"]
            for k, v in d["fixtures"].items():
                fs = v.get("firstScreenMs", {})
                out.append(f"| {k} | {_num(fs.get('median', 0))} | {_num(fs.get('worst', 0))} | {_num(v.get('heapMb', 0))} |")
            out.append("")
        if d.get("initialJs"):
            j = d["initialJs"]
            out += [f"Initial JavaScript: {_num(j.get('gzipBytes', 0))} bytes gzip (budget {_num(j.get('budgetKb', 0))} KB).", ""]
        for n in d.get("notMeasured", []):
            out.append(f"- Not measured: {n}")
        out.append("")
    out += _db_perf_markdown()
    return "\n".join(out)


PERF = ROOT / "e2e" / "perf" / "results"


def _added(p: pathlib.Path) -> int:
    """When a result was committed (newest first); not yet committed counts as newest. Never the
    file's mtime: a fresh checkout gives every file the same one."""
    import subprocess
    out = subprocess.run(["git", "log", "-1", "--format=%ct", "--", p.relative_to(ROOT).as_posix()],
                         cwd=ROOT, capture_output=True, text=True).stdout.strip()
    return int(out) if out else 1 << 62


def _db_perf_markdown() -> list[str]:
    """DB4-07: the large-database runs in e2e/perf/results/db100k-*.json (browser frame times)."""
    files = sorted(PERF.glob("db100k-*.json"), key=lambda p: (_added(p), p.name), reverse=True)
    if not files:
        return []
    out = ["## Large databases (DB100K)", "",
           "100,000 rows × 30 fields in one database, scrolled for 10 s per scenario with a cell edit "
           "every 500 ms. Frame times in ms; the gate is p95 at or under 16.7 ms (60 fps) with no long tasks.", ""]
    for f in files:
        d = json.loads(f.read_text(encoding="utf8"))
        m = d.get("machine", {})
        out += [f"### {d.get('label', f.stem)} — {f.stem}", "",
                f"- **Run:** {d.get('at', '?')[:10]}; {m.get('cpu', '?')}, {m.get('cores', '?')} cores, "
                f"{m.get('memGB', '?')} GB RAM, {m.get('os', '?')}; Chromium {m.get('chromium', '?')}, {m.get('viewport', '')}",
                f"- **Load mix:** {d.get('mix', '')}", "",
                "| Scenario | p50 | p95 | p99 | Long tasks |", "|---|---|---|---|---|"]
        for k, v in d.items():
            if isinstance(v, dict) and "p95" in v:
                out.append(f"| {k} | {_num(v.get('p50', 0))} | {_num(v.get('p95', 0))} | {_num(v.get('p99', 0))} | {_num(v.get('longTasks', 0))} |")
        out.append("")
    return out


def benchmarks_doc(slug: str, title: str) -> str:
    body = sitelib.markdown(benchmark_markdown(), root="../")
    lede = f'<p class="lede">{html.escape(DOC_DESCRIPTIONS[slug])}</p>'
    article = f"<h1>{html.escape(title)}</h1>\n{lede}\n{body}"
    files = [p.relative_to(ROOT).as_posix() for p in [*BENCH.glob("*.json"), *PERF.glob("db100k-*.json")]]
    return sitelib.docs_page(slug, title, DOC_DESCRIPTIONS[slug], article, source="bench/results",
                             modified=sitelib.git_date(*files))


def markdown_doc(slug: str, title: str, source: str) -> str:
    file, text = _md_body(source)
    body = sitelib.markdown(text, from_file=file, root="../")
    body = body.replace('href="https://github.com/CasualOffice/opencanvas/blob/main/docs/wopi.html"', 'href="wopi.html"')
    # The summary under the title is the page's description: one sentence that says what the
    # page answers, for readers and for answer engines.
    lede = f'<p class="lede">{html.escape(DOC_DESCRIPTIONS[slug])}</p>'
    graph = []
    if slug == "getting-started":
        lede = ('<p class="lede">The server, the editor and the sample host on your machine, from the project\'s README. '
                f'To look around first, <a href="../{sitelib.DEMO}">open the demo</a>: it runs in your browser with no server.</p>')
        graph = [howto_run_it()]
    article = f"<h1>{html.escape(title)}</h1>\n{lede}\n{body}"
    return sitelib.docs_page(slug, title, DOC_DESCRIPTIONS[slug], article, source=source,
                             modified=sitelib.git_date(*_sources(source)), graph=graph)


# ---- Pages --------------------------------------------------------------------------------

def software_node() -> dict:
    """OpenCanvas as a SoftwareApplication: only facts the repository states. The version is
    Cargo.toml's, and its date CHANGELOG.md's."""
    v = sitelib.version()
    return {
        "@type": "SoftwareApplication",
        "@id": sitelib.SOFTWARE_ID,
        "name": "OpenCanvas",
        "alternateName": sitelib.BRAND,
        "description": ("The open-source collaborative workspace engine applications embed: documents, spreadsheets, "
                        "databases, whiteboards and diagrams in one real-time canvas. The host application keeps "
                        "users, permissions and files; OpenCanvas does the editing and autosaves back to the host."),
        "url": sitelib.BASE_URL,
        "applicationCategory": "DeveloperApplication",
        "applicationSubCategory": "Collaborative editor",
        "operatingSystem": "Linux (Docker image); the editor runs in a web browser",
        "softwareVersion": v,
        "datePublished": sitelib.released(v),
        "releaseNotes": sitelib.BLOB + "CHANGELOG.md",
        "license": "https://www.apache.org/licenses/LICENSE-2.0",
        "isAccessibleForFree": True,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "author": {"@id": sitelib.ORG_ID},
        "publisher": {"@id": sitelib.ORG_ID},
        "codeRepository": sitelib.REPO,
        "programmingLanguage": ["Rust", "TypeScript"],
        "sameAs": [sitelib.REPO],
        "screenshot": sitelib.BASE_URL + sitelib.OG_IMAGE,
        "featureList": [
            "Rich text blocks, checklists, tables, images, files, link cards and sandboxed embeds",
            "Databases with table, board, calendar, gallery, Timeline (Gantt) and Workload views, formulas, relations and rollups",
            "A spreadsheet block with Excel-style editing, .xlsx and .ods import and .xlsx export",
            "Charts linked to a sheet range or a database field",
            "Whiteboard and diagrams with pen, sticky notes, shapes, attached arrows and draw.io and Excalidraw import",
            "Live co-editing with cursors, presence and comments",
            "Autosave to the host application through a durable outbox",
            "JWT and WOPI launch, an embed web component and a postMessage API",
            "A REST API under /api/v1 with TypeScript and Rust clients, and signed webhooks",
        ],
    }


# Hand-written pages: (schema.org type, breadcrumb name). The home page has none.
PAGE_TYPES = {"index.html": ("WebPage", ""), "brand.html": ("AboutPage", "Brand")}


def build() -> dict[str, bytes]:
    """Every generated file, relative to site/."""
    files: dict[str, bytes] = {}
    pages: dict[str, str] = {}
    for path in sorted((SRC / "pages").rglob("*.html")):
        meta, body = sitelib.read_fragment(path)
        rel = path.relative_to(SRC / "pages").as_posix()
        root = meta.get("root", "../" * rel.count("/"))
        body = sitelib.add_heading_ids(sitelib.expand(body, root))
        graph, trail, modified = [], None, ""
        if rel != "404.html":
            kind, crumb = PAGE_TYPES.get(rel, ("WebPage", meta["title"]))
            modified = sitelib.git_date(path.relative_to(ROOT).as_posix())
            graph.append(sitelib.webpage_node(kind, meta.get("seo_title") or meta["title"], meta["description"], rel, modified))
            if rel == "index.html":
                graph[0]["mainEntity"] = {"@id": sitelib.SOFTWARE_ID}
                graph += [software_node(), sitelib.faq_node(sitelib.faq_pairs(body))]
            else:
                trail = [(sitelib.NAME, "index.html"), (crumb, rel)]
                # Comparison and use-case pages answer questions: their FAQ as an FAQPage.
                faq = sitelib.faq_pairs(body)
                if faq:
                    graph.append(sitelib.faq_node(faq))
        pages[rel] = sitelib.page(title=meta["title"], description=meta["description"], body=body, root=root,
                                  path=rel, current=meta.get("nav", ""), main_class=meta.get("main", ""),
                                  graph=graph, trail=trail, modified=modified, seo_title=meta.get("seo_title", ""),
                                  noindex=rel == "404.html")
    for slug, title, _group, source in sitelib.available_docs():
        if source == "bench/results":
            pages[f"docs/{slug}.html"] = benchmarks_doc(slug, title)
        elif source:
            pages[f"docs/{slug}.html"] = markdown_doc(slug, title, source)
        else:
            src = SRC / "docs" / f"{slug}.html"
            meta, body = sitelib.read_fragment(src)
            body = sitelib.expand(body, "../")
            # The facts page states the release and its date, from Cargo.toml and CHANGELOG.md.
            deps = [src.relative_to(ROOT).as_posix()] + (["Cargo.toml", "CHANGELOG.md"] if slug == "facts" else [])
            faq = sitelib.faq_pairs(body)
            pages[f"docs/{slug}.html"] = sitelib.docs_page(slug, meta.get("title", title), meta["description"], body,
                                                           modified=sitelib.git_date(*deps),
                                                           graph=[sitelib.faq_node(faq)] if slug == "faq" else [])
    pages["changelog.html"] = changelog()
    pages["roadmap.html"] = _load("build-roadmap").render()
    pages.update(_load("build-api").render())

    index = []
    for rel, text in sorted(pages.items()):
        files[rel] = text.encode("utf8")
        if rel != "404.html":
            index.extend(sitelib.index_entries(rel, text))
    files["search-index.json"] = (json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf8")
    files.update(seo(pages))
    return files


# ---- Changelog: the tracker's integration log ---------------------------------------------

def changelog() -> str:
    text = TRACKER.read_text(encoding="utf8")
    m = re.search(r"^## Integration log\n(.*?)(?=^## |\Z)", text, flags=re.S | re.M)
    if not m:
        raise SystemExit("build-site: docs/10 has no Integration log")
    rows = []
    for line in m.group(1).splitlines():
        if not line.startswith("|") or line.startswith("|---") or line.startswith("| Date"):
            continue
        c = [x.strip() for x in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
        if len(c) >= 3 and re.fullmatch(r"\d{4}-\d\d-\d\d", c[0]):
            rows.append(c)
    if not rows:
        raise SystemExit("build-site: the integration log has no rows")
    by_date: dict[str, list[list[str]]] = {}
    for r in rows:
        by_date.setdefault(r[0], []).append(r)
    inl = lambda s: sitelib.md_inline(s, "docs/10-EXECUTION-TRACKER.md", "")  # noqa: E731
    parts = []
    for date in sorted(by_date, reverse=True):
        items = "".join(
            f'<li><strong>{inl(r[1])}</strong>{"" if r[2] in ("", "—") else "<br>" + inl(r[2])}</li>'
            for r in reversed(by_date[date]))
        parts.append(f"<h2>{date}</h2>\n<ul>{items}</ul>")
    body = f"""<section class="page-head"><div class="wrap narrow">
  <h1>Changelog</h1>
  <p class="lede">What was merged and verified, newest first, from the integration log in <a href="{sitelib.BLOB}docs/10-EXECUTION-TRACKER.md">the project's tracker</a>. Each entry says what changed and how it was checked.</p>
</div></section>
<section class="section-tight"><div class="wrap narrow prose changelog">
<h2>Release 0.4.1</h2>
<p>Released 2026-11-28. Spreadsheet cell comments and collaborative undo, floating linked charts, Timeline and Workload finishing touches, faster large-sheet edits, a smaller first load and SBOMs on every release. See <a href="{sitelib.BLOB}CHANGELOG.md">CHANGELOG.md</a>.</p>
<h2>Release 0.4.0</h2>
<p>Released 2026-11-28. A Spreadsheet block on opencalc's engine with Excel import and export, linked charts, database formulas, relations and rollups, Timeline and Workload views, partial sync on by default, and performance and reliability work. See the <a href="docs/release-040.html">release and upgrade notes</a>.</p>
<h2>Release 0.3.0</h2>
<p>Released 2026-11-26. Live blocks shown and edited in several canvases, find and replace and search across canvases, automation rules and offline editing, all off until the host turns them on. See the <a href="docs/release-030.html">release and upgrade notes</a>.</p>
<h2>Release 0.2.1</h2>
<p>Released 2026-11-26. A new insert menu: Quick insert, Recent, goals like "track tasks", and five categories, with heading, list, callout, column, database-view and diagram-type variants in one place. Shortcuts like <code>/h2</code> still work. See <a href="{sitelib.BLOB}CHANGELOG.md">CHANGELOG.md</a>.</p>
<h2>Release 0.2.0</h2>
<p>Released 2026-11-25. Stable headless API under <code>/api/v1</code>, on by default, with TypeScript and Rust clients; signed webhooks; the <a href="docs/block-sdk.html">block SDK</a> for your own blocks; and host editor profiles. See the <a href="docs/release-020.html">release and upgrade notes</a>.</p>
<h2>Release 0.1.2</h2>
<p>Nextcloud, Mattermost, and Element / Matrix integrations, plus diagram mode, version history, and the headless API. See the <a href="docs/release-012.html">release and upgrade notes</a>.</p>
<h2>Release 0.1.1</h2>
<p>Jitsi Meet integration and temporary canvases. One Prosody plugin and config give every Jitsi meeting a shared canvas under Shared document, like Etherpad, with no Docker changes; tested against a stock docker-jitsi-meet with two browsers. Hosts without file storage can set <code>storage = "ephemeral"</code>: canvases start blank or from a built-in template, survive a server restart, and are deleted when the meeting ends. Also: the block handle no longer disappears before you reach it, and the template button inside an open canvas is gone. See <a href="docs/jitsi.html">Jitsi Meet</a> and <a href="{sitelib.BLOB}CHANGELOG.md">CHANGELOG.md</a>.</p>
<h2>Release 0.1.0</h2>
<p>The first release: 0.1.0-alpha.1 plus the SEC-33, SEC-34 and SEC-35 security fixes, WOPI proof keys, block schema validation and the template load test, with best-effort support and no SLA. WOPI hosts now need proof keys and MCP needs a public URL: read the <a href="docs/release.html#upgrade-notes">upgrade notes</a> before upgrading.</p>
<h2>Release 0.1.0-alpha.1</h2>
<p><strong>Embeddable collaborative workspace canvas.</strong> The first alpha, for evaluation, with no production SLA: rich text, databases, whiteboards, templates and collaboration; a standalone SQLite deployment and the host SDK; import and export for the tested formats. The AI assistant and MCP endpoint are experimental and off by default. Read the <a href="{sitelib.BLOB}docs/25-RELEASE-v0.1.0-alpha.1.md">alpha release notes</a> for the acceptance evidence, the known limitations, and backup and recovery; the summary is in <a href="{sitelib.BLOB}CHANGELOG.md">CHANGELOG.md</a>.</p>
<h2>Integration log</h2>
{chr(10).join(parts)}
</div></section>"""
    desc = "What changed in OpenCanvas and how each change was verified, from the project's integration log."
    modified = sitelib.git_date("docs/10-EXECUTION-TRACKER.md")
    return sitelib.page(title="Changelog", description=desc, body=sitelib.add_heading_ids(body), root="",
                        path="changelog.html", current="changelog", modified=modified,
                        graph=[sitelib.webpage_node("WebPage", "OpenCanvas changelog", desc, "changelog.html", modified)],
                        trail=[(sitelib.NAME, "index.html"), ("Changelog", "changelog.html")])


# ---- SEO and agents ------------------------------------------------------------------------

def _desc(page_html: str) -> str:
    m = re.search(r'<meta name="description" content="([^"]*)"', page_html)
    return html.unescape(m.group(1)) if m else ""


def facts_lines(facts_html: str) -> list[str]:
    """llms.txt lines from the facts page's table: each row's fact, its value and the
    repository file its marking links to, so the two cannot disagree."""
    out = []
    for row in re.findall(r"<tr data-claim[^>]*>(.*?)</tr>", facts_html, flags=re.S):
        cells = [sitelib._plain(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, flags=re.S)]
        href = re.search(r'data-claim-mark="(?:tested|source)"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-claim-mark', row)
        src = (href.group(1) or href.group(2)) if href else ""
        if len(cells) >= 2:
            out.append(f"- {cells[0]}: {cells[1]}" + (f" (source: {src})" if src else " (depends on the deployment)"))
    if not out:
        raise SystemExit("build-site: the facts page has no fact rows (<tr data-claim>)")
    return out


def seo(pages: dict[str, str]) -> dict[str, bytes]:
    base = sitelib.BASE_URL
    listed = [rel for rel in sorted(pages) if rel != "404.html"]
    missing = [rel for rel in listed if rel not in sitelib.MODIFIED]
    if missing:
        raise SystemExit(f"build-site: no modified date for {missing}")
    # lastmod: the date the page's sources last changed (sitelib.git_date), not the build date.
    urls = "".join(f"  <url><loc>{base}{'' if rel == 'index.html' else rel}</loc><lastmod>{sitelib.MODIFIED[rel]}</lastmod></url>\n"
                   for rel in listed)
    updated = max(sitelib.MODIFIED[rel] for rel in listed)
    version, released = sitelib.version(), sitelib.released()
    sitemap = f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n'
    robots = f"User-agent: *\nAllow: /\nDisallow: /app/\n\nSitemap: {base}sitemap.xml\n"

    def line(rel: str) -> str:
        return f"- [{sitelib.page_title(pages[rel], rel)}]({base}{'' if rel == 'index.html' else rel}): {_desc(pages[rel])}"
    docs = [f"docs/{d[0]}.html" for d in sitelib.available_docs()]
    api = _load("build-api")
    llms = "\n".join([
        f"# {sitelib.BRAND}",
        "",
        "> The open-source collaborative workspace engine that applications embed: documents, spreadsheets, databases "
        "(formulas, relations, rollups, Timeline/Gantt and Workload views), whiteboards and diagrams in one real-time "
        "canvas with live cursors, embedded the way apps embed Collabora Online. The host application owns users, permissions (ACL) and files; "
        "OpenCanvas does the editing, real-time merge (Yjs CRDT), presence, export and autosave back to the host. "
        "Rust server, React/Tiptap editor, SQLite by default, MySQL/MariaDB and Redis for clusters. "
        "Optional AI, run only in the OpenCanvas server and off by default: an in-editor assistant (plan, approval, "
        "edits in place as a visible collaborator, suggestions for existing text, run undo, limits, audit) and an MCP "
        "endpoint for external agents with host-issued tokens; models from the Claude Platform or an OpenAI-compatible "
        "server (OpenAI, vLLM, Ollama, llama.cpp). Canvas content is sent to the configured model server. "
        "Open source under the Apache License 2.0 (keep the NOTICE file when redistributing; bundled fonts under the SIL OFL). "
        f"Status: {version} released {released}; best-effort support and no production SLA.",
        "",
        f"Made by CasualOffice ({sitelib.ORG}). This file was last updated {updated}. The facts below are from "
        f"{base}docs/facts.html, where each one links to the repository file, test or tracker entry it comes from.",
        "",
        "## Facts",
        *facts_lines(pages["docs/facts.html"]),
        "",
        "## Site",
        line("index.html"),
        line("roadmap.html"),
        line("changelog.html"),
        line("brand.html"),
        f"- [Interactive demo]({base}{sitelib.DEMO}): the real editor with a sample canvas, no server; its assistant plays a scripted run, no AI server",
        "",
        "## Comparisons and use cases",
        *[line(rel) for rel in listed if rel.startswith(("alternatives/", "solutions/"))],
        "",
        "## Documentation",
        *[line(d) for d in docs],
        "",
        "## API reference",
        f"- [OpenAPI 3.1 document]({sitelib.BLOB}crates/oc-server/api/openapi.json): the source of the reference below; a running server serves it at /api/v1/openapi.json",
        *api.llms_index(pages),
        "",
        "## Source",
        f"- [Repository]({sitelib.REPO})",
        f"- [Licence (Apache-2.0)]({sitelib.BLOB}LICENSE)",
        "",
        "## Optional",
        f"- [Full documentation as text]({base}llms-full.txt): every documentation page and the whole API reference in one file",
        "",
    ])
    full = [f"# OpenCanvas documentation (full text)\n\nSource: {sitelib.REPO}. Generated from the repository's README.md and docs/*.md. "
            f"OpenCanvas {version}, released {released}; last updated {updated}.\n"]
    for slug, title, _g, source in sitelib.available_docs():
        if source == "bench/results":
            full.append(f"\n\n# {title}\n\nURL: {base}docs/{slug}.html\nSource files: bench/results/*.json\n\n{benchmark_markdown().strip()}\n")
        elif source:
            file, text = _md_body(source)
            full.append(f"\n\n# {title}\n\nURL: {base}docs/{slug}.html\nSource file: {file}\n\n{text.strip()}\n")
        else:
            full.append(f"\n\n# {title}\n\nURL: {base}docs/{slug}.html\n\n{sitelib.main_text(pages[f'docs/{slug}.html'])}\n")
    full.append(api.llms_full(pages))
    return {
        "sitemap.xml": sitemap.encode("utf8"),
        "robots.txt": robots.encode("utf8"),
        "llms.txt": llms.encode("utf8"),
        "llms-full.txt": "".join(full).encode("utf8"),
    }


# ---- The published tree -----------------------------------------------------------------

def publish(out: pathlib.Path) -> None:
    """Assemble the published tree in `out` (emptied first): site/ without _src/, and the
    built editor in out/app/ (without source maps or the build manifest)."""
    if out.exists():
        if not out.is_dir() or (any(out.iterdir()) and not (out / ".opencanvas-published").exists()):
            raise SystemExit(f"build-site: {out} exists and is not a tree this tool published; refusing to empty it")
        shutil.rmtree(out)
    shutil.copytree(SITE, out, ignore=lambda d, names: [n for n in names if pathlib.Path(d) == SITE and n == "_src"])
    app = out / "app"
    if app.exists():
        raise SystemExit("build-site: site/app/ exists; the demo copy is published there")
    if not (EDITOR_DIST / "index.html").exists():
        raise SystemExit("build-site: web/packages/editor/dist is not built; run "
                         "OC_EDITOR_BASE=./ pnpm --filter @opencanvas/editor build in web/")
    index = (EDITOR_DIST / "index.html").read_text(encoding="utf8")
    if 'src="./assets/' not in index:
        raise SystemExit("build-site: the editor was not built with OC_EDITOR_BASE=./ (relative paths)")
    shutil.copytree(EDITOR_DIST, app, ignore=lambda d, names: [n for n in names if n.endswith(".map") or n == ".vite"])
    (out / ".nojekyll").write_bytes(b"")
    (out / ".opencanvas-published").write_bytes(b"")
    print(f"build-site: published {sum(1 for p in out.rglob('*') if p.is_file())} files to {out}")


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "--screens":
        screens(pathlib.Path(argv[1]))
        return 0
    if argv and argv[0] == "--publish" and len(argv) == 2:
        publish(pathlib.Path(argv[1]).resolve())
        return 0
    check = argv == ["--check"]
    if argv and not check:
        print(__doc__, file=sys.stderr)
        return 2
    files = build()
    stale = []
    for rel, data in files.items():
        dest = SITE / rel
        if check:
            if not dest.exists() or dest.read_bytes() != data:
                stale.append(rel)
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists() or dest.read_bytes() != data:
            dest.write_bytes(data)
    if check:
        if stale:
            print("build-site: stale, run python3 tools/build-site.py: " + ", ".join(stale), file=sys.stderr)
            return 1
        print(f"build-site: {len(files)} files up to date")
        return 0
    print(f"build-site: wrote {len(files)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
