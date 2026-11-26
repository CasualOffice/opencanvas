#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Check every internal link of the website in site/.

    python3 -I tools/check-site-links.py

Ported from OpenSeal's tools/check-site-links.py. For each HTML page (site/_src/
excluded, as it is not published), every href, src and srcset that is not an external
URL must name a file that exists, and a #fragment must name an id on the target page.
Also refuses a page with two elements of one id. External links (http:, https:, mailto:)
are counted, not fetched: no network.

A link into app/ names the editor's demo copy, which tools/build-site.py --publish copies
there from web/packages/editor/dist, so it must name a file of that build (index.html for
app/); its #fragment (#demo) is the editor's launch hash, not an id. A root-relative link
(the 404 page, which GitHub Pages serves at any depth) is resolved
against site/. Standard library only; exits non-zero, naming each broken link and its page.
"""

from __future__ import annotations

import pathlib
import sys
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
EDITOR = ROOT / "web/packages/editor"
PREFIX = "/"  # the site is served at the root of canvas.casualoffice.org


class Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self.ids: list[str] = []

    def handle_starttag(self, tag, attrs):
        for k, v in attrs:
            if v is None:
                continue
            if k == "id":
                self.ids.append(v)
            elif k in ("href", "src") or (k == "xlink:href"):
                if tag == "link" and dict(attrs).get("rel") == "canonical":
                    continue  # the page's own public URL
                self.links.append(v)
            elif k == "srcset":
                self.links.extend(part.strip().split(" ")[0] for part in v.split(",") if part.strip())


def pages() -> list[pathlib.Path]:
    return sorted(p for p in SITE.rglob("*.html") if "_src" not in p.relative_to(SITE).parts)


def app_file(rest: list[str]) -> bool:
    """Is app/<rest> a file the published editor copy will have?"""
    if not rest or rest == [""]:
        return (EDITOR / "index.html").is_file()  # dist/index.html is built from it
    return (EDITOR / "dist").joinpath(*rest).is_file() or (EDITOR / "public").joinpath(*rest).is_file()


def main() -> int:
    if not SITE.is_dir():
        print("check-site-links: site/ does not exist", file=sys.stderr)
        return 1
    parsed: dict[pathlib.Path, Page] = {}
    for path in pages():
        p = Page()
        p.feed(path.read_text(encoding="utf8"))
        parsed[path.resolve()] = p
    problems: list[str] = []
    internal = external = 0
    site = SITE.resolve()
    for path, p in parsed.items():
        rel = path.relative_to(site)
        seen: set[str] = set()
        for i in p.ids:
            if i in seen:
                problems.append(f"{rel}: id {i!r} used twice")
            seen.add(i)
        for link in p.links:
            parts = urlsplit(link)
            if parts.scheme in ("http", "https", "mailto"):
                external += 1
                continue
            if parts.scheme or link.startswith("//"):
                if not link.startswith("data:"):
                    problems.append(f"{rel}: unexpected link {link!r}")
                continue
            internal += 1
            if parts.path.startswith("/"):
                if not parts.path.startswith(PREFIX):
                    problems.append(f"{rel}: root-relative link {link!r} outside {PREFIX}")
                    continue
                target = (site / unquote(parts.path[len(PREFIX):])).resolve()
            else:
                target = path if not parts.path else (path.parent / unquote(parts.path)).resolve()
            try:
                inside = target.relative_to(site).parts
            except ValueError:
                problems.append(f"{rel}: {link!r} leaves site/")
                continue
            if inside and inside[0] == "app":
                if (SITE / "app").exists():
                    problems.append(f"{rel}: site/app/ exists, but app/ is the published demo copy of the editor")
                elif not app_file(list(inside[1:]) if parts.path.rstrip("/").split("/")[-1] != "app" else []):
                    problems.append(f"{rel}: {link!r} names no file of the editor build")
                continue
            if parts.path.endswith("/") or target.is_dir():
                target = target / "index.html"
            if "_src" in inside:
                problems.append(f"{rel}: {link!r} points into site/_src, which is not published")
                continue
            if not target.exists():
                problems.append(f"{rel}: broken link {link!r}")
                continue
            if parts.fragment and target.suffix == ".html":
                ids = parsed[target].ids if target in parsed else []
                if unquote(parts.fragment) not in ids:
                    problems.append(f"{rel}: {link!r}: no id {parts.fragment!r} on {target.relative_to(site)}")
    if problems:
        print(f"check-site-links: {len(problems)} problem(s)", file=sys.stderr)
        for line in problems:
            print(f"  {line}", file=sys.stderr)
        return 1
    print(f"check-site-links: {len(parsed)} pages, {internal} internal links resolve, {external} external links not fetched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
