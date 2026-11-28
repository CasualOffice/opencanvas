#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Build the website's roadmap page, site/roadmap.html, from the roadmap (docs/09) and
the tracker (docs/10), so the page cannot drift from them.

    python3 -I tools/build-roadmap.py           # write site/roadmap.html
    python3 -I tools/build-roadmap.py --check   # fail if it is stale

Ported from OpenSeal's tools/build-roadmap.py. What it reads:
  docs/09  the phase table (each phase's goal and exit gate), the release table (Version |
           Status | Focus; each status is Released <date>, In progress or Planned) and the
           feature priorities (with a Status column).
  docs/10  every work row (ID | Item | Status | Notes) under the P0, P1, P2 and P3 sections
           (P3 grouped by release), the Workspace track and the block packages section. A
           row listed twice (an early plan row and a later, dated one) is shown once, with
           the furthest status of the two.

Status words are the tracker's: Done; Review (built and verified, awaiting the owner's
approval); In progress; Todo; Backlog (agreed, not scheduled; ranked like Todo); Blocked.
A phase is Done when every row is, "Built, in review" when every row is Done or Review,
Planned when none has started, and In progress otherwise. No dates are promised.
Standard library only; fails non-zero, naming what it could not find.
"""

from __future__ import annotations

import html
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import sitelib  # noqa: E402

ROOT = sitelib.ROOT
ROADMAP = ROOT / "docs/09-ROADMAP.md"
TRACKER = ROOT / "docs/10-EXECUTION-TRACKER.md"
OUT = sitelib.SITE / "roadmap.html"
ISSUES = sitelib.REPO + "/issues"

RANK = {"Todo": 0, "Backlog": 0, "Blocked": 0, "In progress": 1, "Review": 2, "Done": 3}
ID_ROW = re.compile(r"^\|\s*([A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+)\s*\|")
PHASES = ("P0", "P1", "P2", "P3")
WS = "WS"  # the Workspace track


def fail(msg: str) -> None:
    raise SystemExit(f"build-roadmap: {msg}")


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def cells(line: str) -> list[str]:
    return [c.strip() for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]


def plain(md: str) -> str:
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", md)
    return s.replace("**", "").replace("`", "").strip()


def status_of(cell: str) -> str:
    word = plain(cell)
    for k in ("In progress", "Review", "Done", "Todo", "Backlog", "Blocked"):
        if word.startswith(k):
            return k
    if word.startswith("Fixed"):  # "Fixed with regression coverage"
        return "Done"
    fail(f"unknown status {cell!r}")
    return ""


def phases() -> list[list[str]]:
    out = []
    for line in ROADMAP.read_text(encoding="utf8").splitlines():
        m = re.match(r"^\|\s*\*\*(P\d) ([^*]+)\*\*\s*\|", line)
        if m:
            c = cells(line)
            out.append([m.group(1), m.group(2).strip(), plain(c[1]), plain(c[2])])
    if [p[0] for p in out] != list(PHASES):
        fail(f"docs/09: expected phases P0 to P3, found {[p[0] for p in out]}")
    return out


def _doc_link(heading: str) -> str | None:
    d = re.search(r"\]\(([^)#\s]+)", heading)
    return d.group(1) if d else None


def tracker() -> dict[str, list[dict]]:
    """Rows by phase key (P0..P3, WS), duplicates merged to their furthest status. Each P3 row
    carries its release group ("v0.2", "v0.5", ...) and the group's plan document."""
    text = TRACKER.read_text(encoding="utf8")
    by_id: dict[str, dict] = {}
    order: list[str] = []
    phase = group = doc = None
    for line in text.splitlines():
        h = re.match(r"^## (P\d)\b(.*)", line)
        if h:
            phase = h.group(1)
            g = re.search(r"Platform: (v[\d.]+x?)", h.group(2))
            group = g.group(1) if g else None
            doc = _doc_link(h.group(2))
            continue
        if line.startswith("## Workspace track"):
            phase, group, doc = WS, None, _doc_link(line)
            continue
        if line.startswith("## Block packages"):
            phase, group, doc = "blocks", None, None
            continue
        if line.startswith("## "):
            phase = None
            continue
        m = ID_ROW.match(line)
        if not m or phase is None:
            continue
        c = cells(line)
        row = {"id": c[0], "item": plain(c[1]), "status": status_of(c[2]), "raw": plain(c[2]),
               "notes": plain(c[3]) if len(c) > 3 else "", "phase": phase, "group": group, "doc": doc}
        if row["id"] in by_id:
            old = by_id[row["id"]]
            if RANK[row["status"]] > RANK[old["status"]]:
                old.update(status=row["status"], raw=row["raw"], notes=row["notes"] or old["notes"])
            continue
        by_id[row["id"]] = row
        order.append(row["id"])
    out: dict[str, list[dict]] = {k: [] for k in (*PHASES, WS)}
    for rid in order:
        r = by_id[rid]
        # The block packages section re-lists P1/P2 rows; a row only there belongs to P2.
        out["P2" if r["phase"] == "blocks" else r["phase"]].append(r)
    for k, v in out.items():
        if not v:
            fail(f"docs/10 has no rows for {k}")
    return out


def phase_state(rows: list[dict]) -> tuple[str, str]:
    """(pill kind, label) for a phase or a release group, from its rows' statuses."""
    st = [r["status"] for r in rows]
    if all(s == "Done" for s in st):
        return "done", "Done"
    if all(s in ("Done", "Review") for s in st):
        return "done", "Built, in review"
    if all(RANK[s] == 0 for s in st):
        return "later", "Planned"
    return "progress", "In progress"


def release_state(status: str) -> tuple[str, str]:
    """(pill kind, label) for a release table status: Released <date> (notes), In progress or
    Planned. The notes link is shown beside the pill, so a Released label drops it."""
    for prefix, kind in (("Released", "done"), ("In progress", "progress"), ("Planned", "later")):
        if status.startswith(prefix):
            return kind, (re.sub(r"\s*\([^)]*\)$", "", status) if kind == "done" else status)
    fail(f"docs/09: release status {status!r} is not Released <date>, In progress or Planned")
    return "", ""


def pill(kind: str, label: str) -> str:
    ic = {"done": "circle-check", "progress": "loader-circle", "next": "circle-dot", "later": "circle-dashed"}[kind]
    return f'<span class="pill pill-{kind}">{sitelib.icon(ic, 14)}{esc(label)}</span>'


LABEL = {"Done": ("done", "Done"), "Review": ("progress", "Built, in review"), "In progress": ("progress", "In progress"),
         "Todo": ("later", "To do"), "Backlog": ("later", "Backlog"), "Blocked": ("next", "Blocked")}
ICON = {"Done": ("circle-check", "ok"), "Review": ("circle-check", "ok"), "In progress": ("circle-dot", "wip"),
        "Todo": ("circle-dashed", "todo"), "Backlog": ("circle-dashed", "todo"), "Blocked": ("circle-alert", "todo")}
DOT = {"done": "check", "progress": "loader-circle", "later": "rocket"}


def first_sentence(s: str, limit: int = 170) -> str:
    m = re.match(r"(.+?[.;])(\s|$)", s)
    s = m.group(1).rstrip(";") if m else s
    return s if len(s) <= limit else s[: limit - 1].rsplit(" ", 1)[0] + "…"


def section_table(title: str, raw: bool = False) -> list[list[str]]:
    """Rows of the first table under `## <title>` in docs/09, header first: plain text, or the
    Markdown cells with raw."""
    out, inside = [], False
    for line in ROADMAP.read_text(encoding="utf8").splitlines():
        if line.startswith("## "):
            inside = line[3:].strip() == title
            continue
        if inside and line.startswith("|") and not re.match(r"^\|[\s|:-]+\|$", line):
            out.append([c if raw else plain(c) for c in cells(line)])
    if len(out) < 2:
        fail(f"docs/09: no table under '## {title}'")
    return out


def section_text(title: str) -> str:
    """The first paragraph under `## <title>` in docs/09, plain text."""
    text = ROADMAP.read_text(encoding="utf8")
    m = re.search(rf"^## {re.escape(title)}\n\n(.*?)(?:\n\n|\Z)", text, flags=re.S | re.M)
    if not m:
        fail(f"docs/09: no section '## {title}'")
    return plain(m.group(1).replace("\n", " "))


def items(rs: list[dict]) -> str:
    """The rows, furthest status first, each with its tracker status."""
    li = "".join(
        f'<li>{sitelib.icon(ICON[r["status"]][0], 16, ICON[r["status"]][1])}<span><b>{esc(r["id"])}</b> '
        f'{esc(r["item"])} <span class="muted">({esc((r["raw"] if r["raw"] != r["status"] else LABEL[r["status"]][1]).lower())})</span></span></li>'
        for r in sorted(rs, key=lambda r: -RANK[r["status"]]))
    return f'<ul class="tl-items">{li}</ul>'


def summary(rs: list[dict]) -> str:
    n = {k: sum(1 for r in rs if r["status"] == k) for k in RANK}
    backlog = f', {n["Backlog"]} in the backlog' if n["Backlog"] else ""
    return (f'{n["Done"]} done, {n["Review"]} built and in review, {n["In progress"]} in progress, '
            f'{n["Todo"] + n["Blocked"]} to do{backlog}, of {len(rs)} rows.')


def inline(md: str) -> str:
    return sitelib.md_inline(md, "docs/09-ROADMAP.md", "")


def release_row(version: str, status: str, focus: str) -> str:
    kind, label = release_state(plain(status))
    link = re.search(r"\[[^\]]+\]\([^)]+\)", status) if kind == "done" else None
    notes = f" {inline(link.group(0))}" if link else ""
    return f"<tr><th scope='row'>{inline(version)}</th><td>{pill(kind, label)}{notes}</td><td>{inline(focus)}</td></tr>"


def render() -> str:
    ph = phases()
    releases = section_table("Release roadmap", raw=True)
    if [plain(c) for c in releases[0]][:3] != ["Version", "Status", "Focus"]:
        fail("docs/09: the release table's columns must be Version | Status | Focus")
    prios = section_table("Feature priorities")
    if prios[0][:5] != ["Feature", "Value", "Complexity", "Priority", "Status"]:
        fail("docs/09: the feature priorities' columns must be Feature | Value | Complexity | Priority | Status")
    principle = section_text("Architectural principle")
    rows = tracker()
    tl = []
    for key, name, goal, gate in ph:
        rs = rows[key]
        kind, label = phase_state(rs)
        if key == "P3":
            groups: dict[str, list[dict]] = {}
            for r in rs:
                groups.setdefault(r["group"] or "Other", []).append(r)
            parts = []
            for g, grs in groups.items():
                gkind, glabel = phase_state(grs)
                doc = grs[0]["doc"]
                plan = f' <a href="{sitelib.BLOB}docs/{esc(doc)}">Read the {esc(g)} plan</a>.' if doc else ""
                parts.append(f'<div class="tl-title"><h4>{esc(g)}</h4>{pill(gkind, glabel)}</div>'
                             f'<p class="muted">{summary(grs)}{plan}</p>{items(grs)}')
            work, counts = "".join(parts), ""
        else:
            work, counts = items(rs), summary(rs) + " "
        cls = f' class="tl-{kind}"' if kind in ("done", "progress") else ""
        tl.append(f"""<li{cls}><span class="tl-dot">{sitelib.icon(DOT[kind], 20)}</span>
<div class="tl-body"><div class="tl-title"><h3>{esc(key)} {esc(name)}</h3>{pill(kind, label)}</div>
<p>{esc(goal)}.</p>
<p class="muted">{counts}Exit gate: {esc(gate)}.</p>
{work}</div></li>""")

    ws = rows[WS]
    ws_kind, ws_label = phase_state(ws)
    ws_doc = ws[0]["doc"] or "40-WORKSPACE.md"
    ws_focus = next((plain(f) for v, _s, f, *_ in releases[1:] if plain(v) == "Workspace"), "")
    ws_intro = f"{esc(ws_focus)}. " if ws_focus else ""

    gates = "".join(f'<li>{sitelib.icon("milestone", 16, "todo")}<span><b>{esc(k)} {esc(nm)}</b> {esc(g)}</span></li>'
                    for k, nm, _goal, g in ph)
    rel_rows = "".join(release_row(v, s, f) for v, s, f, *_ in releases[1:])
    prio_rows = "".join(f"<tr><th scope='row'>{esc(a)}</th><td>{esc(b)}</td><td>{esc(c)}</td><td>{esc(d)}</td><td>{esc(e)}</td></tr>"
                        for a, b, c, d, e, *_ in prios[1:])

    body = f"""<section class="page-head"><div class="wrap">
  <h1>Roadmap</h1>
  <p class="lede">Where OpenCanvas stands and what comes next, generated from the project's roadmap and its execution tracker. Every unit of work has a row there; this page shows each row's status as the tracker records it.</p>
  <p class="callout">{sitelib.icon("info")}<span>This is the project's plan, not a commitment. No dates are promised for what is not released. "Built, in review" means the work is merged and verified and waits for the owner's approval; "Backlog" means agreed but not scheduled. Ideas and requests are welcome as <a href="{ISSUES}">GitHub issues</a>.</span></p>
</div></section>

<section class="section-tight" aria-labelledby="rel-h"><div class="wrap">
  <div class="sec-head"><h2 id="rel-h">Release roadmap</h2><p>{esc(principle)}</p></div>
  <div class="table-scroll" tabindex="0" role="region" aria-label="Release roadmap"><table><thead><tr><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Focus</th></tr></thead><tbody>{rel_rows}</tbody></table></div>
  <div class="sec-head"><h3 id="prio-h">Feature priorities</h3></div>
  <div class="table-scroll" tabindex="0" role="region" aria-label="Feature priorities"><table><thead><tr><th scope="col">Feature</th><th scope="col">Value</th><th scope="col">Complexity</th><th scope="col">Priority</th><th scope="col">Status</th></tr></thead><tbody>{prio_rows}</tbody></table></div>
</div></section>

<section class="section-tight" aria-labelledby="now-h"><div class="wrap">
  <div class="sec-head"><h2 id="now-h">Phases and their work</h2></div>
  <ol class="timeline">{"".join(tl)}</ol>
</div></section>

<section class="section-tight" aria-labelledby="ws-h"><div class="wrap">
  <div class="sec-head"><h2 id="ws-h">Workspace track</h2><p>{ws_intro}<a href="{sitelib.BLOB}docs/{esc(ws_doc)}">Read the Workspace plan</a>.</p></div>
  <div class="tl-title">{pill(ws_kind, ws_label)}<p class="muted">{summary(ws)}</p></div>
  {items(ws)}
</div></section>

<section class="section-tight section-alt" aria-labelledby="gates-h"><div class="wrap">
  <div class="sec-head"><h2 id="gates-h">Exit gates</h2><p>What must be true before a phase counts as finished.</p></div>
  <ul class="tl-items">{gates}</ul>
  <p class="note">Generated by <code>tools/build-roadmap.py</code> from <a href="{sitelib.BLOB}docs/09-ROADMAP.md">docs/09</a> and <a href="{sitelib.BLOB}docs/10-EXECUTION-TRACKER.md">docs/10</a>. Where the tracker lists a row twice (a plan row and a later, dated one), the furthest status is shown.</p>
</div></section>"""
    desc = "What OpenCanvas has released, what is in review and in progress, and the releases and tracks that follow, from the project's tracker."
    modified = sitelib.git_date("docs/09-ROADMAP.md", "docs/10-EXECUTION-TRACKER.md")
    return sitelib.page(title="Roadmap", description=desc, body=sitelib.add_heading_ids(body), root="", path="roadmap.html",
                        current="roadmap", modified=modified,
                        graph=[sitelib.webpage_node("WebPage", "OpenCanvas roadmap", desc, "roadmap.html", modified)],
                        trail=[(sitelib.NAME, "index.html"), ("Roadmap", "roadmap.html")])


def main(argv: list[str]) -> int:
    out = render()
    if argv == ["--check"]:
        if not OUT.exists() or OUT.read_text(encoding="utf8") != out:
            print("build-roadmap: site/roadmap.html is stale; run python3 -I tools/build-roadmap.py", file=sys.stderr)
            return 1
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(out, encoding="utf8")
    print("build-roadmap: wrote site/roadmap.html")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
