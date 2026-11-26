#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Check the website's search, answer-engine and generative-engine metadata.

    python3 -I tools/check-site-seo.py              # the built site, site/
    python3 -I tools/check-site-seo.py --self-test  # broken sample pages must fail, a good one pass

For every page in site/ (site/_src/ excluded), it fails on:

- a missing, empty, too long or duplicate <title>; a missing or duplicate meta description, or
  one outside 70-160 characters on an indexable page (engines cut longer ones mid-sentence);
- a missing or wrong canonical link (it must be the page's public URL), missing Open Graph or
  Twitter tags, an og:url that is not the canonical, an og:image that is not a site file;
- not exactly one <h1>; an <img> without an alt attribute (alt="" marks a decorative one);
- JSON-LD that does not parse, lacks @context, uses a type this check does not know, or lacks
  a type's required properties (SoftwareApplication: version equal to Cargo.toml's, licence,
  free offer; TechArticle and APIReference: headline, url, dates, author, publisher; FAQPage:
  questions whose text is on the page; HowTo: steps; BreadcrumbList: positions 1..n whose
  items are pages of the site, ending at this page); an indexable page without any;
- sitemap.xml missing an indexable page, listing a page twice or one that does not exist or
  is noindex, or an entry without a valid <lastmod> (and one that disagrees with the page's
  dateModified); robots.txt not naming the sitemap; llms.txt not listing an indexable page.

Exits non-zero naming each problem. Standard library only; no network.
"""

from __future__ import annotations

import json
import pathlib
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
BASE = "https://canvas.casualoffice.org/"
TITLE_MAX = 70
DESC_MIN, DESC_MAX = 70, 160
HEADLINE_MAX = 110
DATE = re.compile(r"^\d{4}-\d\d-\d\d$")


def cargo_version() -> str:
    m = re.search(r'^\[workspace\.package\]\s*\nversion\s*=\s*"([^"]+)"', (ROOT / "Cargo.toml").read_text(encoding="utf8"), re.M)
    return m.group(1) if m else ""


class Page(HTMLParser):
    """What the check needs from one page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: str | None = None
        self.meta: dict[str, list[str]] = {}
        self.links: dict[str, str] = {}
        self.ld: list[str] = []
        self.h1 = 0
        self.imgs_without_alt: list[str] = []
        self.text: list[str] = []
        self._in: str | None = None
        self._buf = ""
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if tag == "title":
            self._in, self._buf = "title", ""
        elif tag == "meta":
            key = a.get("name") or a.get("property")
            if key:
                self.meta.setdefault(key, []).append(a.get("content", ""))
        elif tag == "link" and a.get("rel"):
            self.links.setdefault(a["rel"], a.get("href", ""))
        elif tag == "script" and a.get("type") == "application/ld+json":
            self._in, self._buf = "ld", ""
        elif tag == "h1":
            self.h1 += 1
        elif tag == "img" and "alt" not in a:
            self.imgs_without_alt.append(a.get("src", "?"))
        if tag in ("script", "style", "svg"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag == "title" and self._in == "title":
            self.title, self._in = self._buf.strip(), None
        elif tag == "script" and self._in == "ld":
            self.ld.append(self._buf)
            self._in = None
        if tag in ("script", "style", "svg"):
            self._skip = max(0, self._skip - 1)

    def handle_data(self, data):
        if self._in:
            self._buf += data
        elif not self._skip:
            self.text.append(data)


def norm(s: str) -> str:
    return " ".join(s.split())


def squash(s: str) -> str:
    """Text without any whitespace: tags split words differently in markup and in JSON-LD."""
    return re.sub(r"\s+", "", s)


def url_of(rel: str) -> str:
    return BASE + ("" if rel == "index.html" else rel)


def rel_of(url: str) -> str | None:
    if not url.startswith(BASE):
        return None
    rel = url[len(BASE):].split("#", 1)[0]
    return rel or "index.html"


# ---- JSON-LD ---------------------------------------------------------------------------

ARTICLE = ("headline", "description", "url", "dateModified", "author", "publisher", "inLanguage")
REQUIRED = {
    "Organization": ("name", "url"),
    "WebSite": ("name", "url", "publisher"),
    "WebPage": ("name", "url"),
    "CollectionPage": ("name", "url"),
    "AboutPage": ("name", "url"),
    "SoftwareApplication": ("name", "description", "url", "applicationCategory", "operatingSystem",
                            "softwareVersion", "license", "offers"),
    "TechArticle": ARTICLE,
    "APIReference": ARTICLE,
    "FAQPage": ("mainEntity",),
    "HowTo": ("name", "step"),
    "BreadcrumbList": ("itemListElement",),
    # Nested nodes.
    "Offer": ("price", "priceCurrency"),
    "Question": ("name", "acceptedAnswer"),
    "Answer": ("text",),
    "HowToStep": ("text",),
    "ListItem": ("position", "name", "item"),
    "ImageObject": ("url",),
}
TOP = {"Organization", "WebSite", "WebPage", "CollectionPage", "AboutPage", "SoftwareApplication", "TechArticle",
       "APIReference", "FAQPage", "HowTo", "BreadcrumbList"}


def check_node(node, where: str, ctx: dict, problems: list[str], top: bool) -> None:
    if isinstance(node, list):
        for n in node:
            check_node(n, where, ctx, problems, top)
        return
    if not isinstance(node, dict):
        return
    t = node.get("@type")
    if t is None:
        if set(node) - {"@id"}:
            problems.append(f"{where}: a JSON-LD object without @type: {sorted(node)[:4]}")
        return
    if t not in REQUIRED:
        problems.append(f"{where}: JSON-LD type {t!r} is not one this check knows; add its required properties")
        return
    if top and t not in TOP:
        problems.append(f"{where}: JSON-LD {t} at the top level")
    for prop in REQUIRED[t]:
        v = node.get(prop)
        if v in (None, "", [], {}):
            problems.append(f"{where}: JSON-LD {t} lacks {prop}")
    canon = ctx["canonical"]
    if t == "SoftwareApplication":
        if node.get("softwareVersion") and node["softwareVersion"] != ctx["version"]:
            problems.append(f"{where}: SoftwareApplication softwareVersion {node['softwareVersion']!r} is not "
                            f"Cargo.toml's {ctx['version']!r}")
        offer = node.get("offers") or {}
        if isinstance(offer, dict) and offer.get("price") not in ("0", 0):
            problems.append(f"{where}: SoftwareApplication offers.price is not 0 (OpenCanvas is free)")
    if t in ("TechArticle", "APIReference"):
        if len(str(node.get("headline", ""))) > HEADLINE_MAX:
            problems.append(f"{where}: {t} headline over {HEADLINE_MAX} characters")
        if node.get("url") and node["url"] != canon:
            problems.append(f"{where}: {t} url {node['url']} is not the canonical {canon}")
        for d in ("dateModified", "datePublished"):
            if d in node and not DATE.match(str(node[d])):
                problems.append(f"{where}: {t} {d} {node[d]!r} is not YYYY-MM-DD")
    if top and node.get("dateModified"):
        ctx["modified"].add(node["dateModified"])
    if t == "FAQPage":
        qs = node.get("mainEntity") or []
        if not isinstance(qs, list):
            qs = [qs]
        for q in qs:
            if isinstance(q, dict) and q.get("name") and squash(q["name"]) not in ctx["text"]:
                problems.append(f"{where}: FAQ question {q['name']!r} is not on the page")
            ans = (q.get("acceptedAnswer") or {}) if isinstance(q, dict) else {}
            if isinstance(ans, dict) and ans.get("text") and squash(re.sub(r"<[^>]+>", "", ans["text"]))[:60] not in ctx["text"]:
                problems.append(f"{where}: the answer to {q.get('name')!r} is not the page's own text")
    if t == "BreadcrumbList":
        items = node.get("itemListElement") or []
        positions = [i.get("position") for i in items if isinstance(i, dict)]
        if positions != list(range(1, len(items) + 1)):
            problems.append(f"{where}: BreadcrumbList positions {positions} are not 1..{len(items)}")
        for i in items:
            if not isinstance(i, dict):
                continue
            target = i.get("item")
            target = target.get("@id") if isinstance(target, dict) else target
            rel = rel_of(str(target or ""))
            if rel is None or rel not in ctx["pages"]:
                problems.append(f"{where}: breadcrumb {i.get('name')!r} -> {target} is not a page of the site")
        if items and isinstance(items[-1], dict) and items[-1].get("item") != canon:
            problems.append(f"{where}: the last breadcrumb is not this page ({canon})")
    if t in ("WebPage", "CollectionPage", "AboutPage") and node.get("url") and node["url"] != canon:
        problems.append(f"{where}: {t} url {node['url']} is not the canonical {canon}")
    for k, v in node.items():
        if k.startswith("@"):
            continue
        check_node(v, where, ctx, problems, False)


def check_jsonld(raw: str, where: str, ctx: dict, problems: list[str]) -> None:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        problems.append(f"{where}: JSON-LD does not parse: {e}")
        return
    if not isinstance(data, dict) or data.get("@context") not in ("https://schema.org", "https://schema.org/"):
        problems.append(f"{where}: JSON-LD without @context https://schema.org")
        return
    nodes = data.get("@graph", [data])
    if "@graph" in data and not isinstance(nodes, list):
        problems.append(f"{where}: JSON-LD @graph is not a list")
        return
    for n in nodes:
        n = {k: v for k, v in n.items() if k != "@context"} if isinstance(n, dict) else n
        check_node(n, where, ctx, problems, True)


# ---- The whole site --------------------------------------------------------------------

def pages(site: pathlib.Path) -> list[str]:
    return sorted(p.relative_to(site).as_posix() for p in site.rglob("*.html")
                  if "_src" not in p.relative_to(site).parts)


def check(site: pathlib.Path, version: str) -> list[str]:
    problems: list[str] = []
    rels = pages(site)
    titles: dict[str, list[str]] = {}
    descs: dict[str, list[str]] = {}
    indexable: list[str] = []
    modified: dict[str, set[str]] = {}
    for rel in rels:
        p = Page()
        p.feed((site / rel).read_text(encoding="utf8"))
        noindex = any("noindex" in c for c in p.meta.get("robots", []))
        if not noindex:
            indexable.append(rel)
        canon = url_of(rel)
        if not p.title:
            problems.append(f"{rel}: no <title>")
        else:
            titles.setdefault(p.title, []).append(rel)
            if len(p.title) > TITLE_MAX:
                problems.append(f"{rel}: title is {len(p.title)} characters (at most {TITLE_MAX}): {p.title!r}")
        desc = (p.meta.get("description") or [""])[0]
        if not desc.strip():
            problems.append(f"{rel}: no meta description")
        else:
            descs.setdefault(desc, []).append(rel)
            if not noindex and not DESC_MIN <= len(desc) <= DESC_MAX:
                problems.append(f"{rel}: description is {len(desc)} characters ({DESC_MIN}-{DESC_MAX}): {desc[:60]!r}...")
        if not noindex:
            if p.links.get("canonical") != canon:
                problems.append(f"{rel}: canonical is {p.links.get('canonical')!r}, not {canon}")
            for key in ("og:title", "og:description", "og:url", "og:image", "og:type", "og:locale",
                        "twitter:card", "twitter:title", "twitter:description", "twitter:image"):
                if not (p.meta.get(key) or [""])[0]:
                    problems.append(f"{rel}: no {key}")
            if (p.meta.get("og:url") or [""])[0] not in ("", canon):
                problems.append(f"{rel}: og:url is not the canonical {canon}")
            for key in ("og:image", "twitter:image"):
                img = (p.meta.get(key) or [""])[0]
                if img and (rel_of(img) is None or not (site / rel_of(img)).is_file()):
                    problems.append(f"{rel}: {key} {img} is not a file of the site")
            if not p.ld:
                problems.append(f"{rel}: no JSON-LD structured data")
        if p.h1 != 1:
            problems.append(f"{rel}: {p.h1} <h1> elements (want exactly 1)")
        for src in p.imgs_without_alt:
            problems.append(f"{rel}: <img src={src!r}> has no alt attribute")
        ctx = {"canonical": canon, "version": version, "pages": set(rels), "text": squash("".join(p.text)),
               "modified": set()}
        for raw in p.ld:
            check_jsonld(raw, rel, ctx, problems)
        modified[rel] = ctx["modified"]
    for t, where in titles.items():
        if len(where) > 1:
            problems.append(f"duplicate title {t!r}: {', '.join(where)}")
    for d, where in descs.items():
        if len(where) > 1:
            problems.append(f"duplicate description {d[:60]!r}...: {', '.join(where)}")

    # Sitemap, robots and llms.txt.
    sm = site / "sitemap.xml"
    if not sm.is_file():
        problems.append("sitemap.xml is missing")
    else:
        try:
            tree = ET.parse(sm)
        except ET.ParseError as e:
            problems.append(f"sitemap.xml does not parse: {e}")
            tree = None
        if tree is not None:
            ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
            seen: dict[str, int] = {}
            for u in tree.getroot().findall("s:url", ns):
                loc = (u.findtext("s:loc", "", ns) or "").strip()
                lastmod = (u.findtext("s:lastmod", "", ns) or "").strip()
                rel = rel_of(loc)
                seen[rel or loc] = seen.get(rel or loc, 0) + 1
                if rel is None or rel not in rels:
                    problems.append(f"sitemap.xml lists {loc}, which is not a page of the site")
                elif rel not in indexable:
                    problems.append(f"sitemap.xml lists {loc}, which is noindex")
                if not DATE.match(lastmod):
                    problems.append(f"sitemap.xml: {loc} has no valid <lastmod> ({lastmod!r})")
                elif rel in modified and modified[rel] and lastmod not in modified[rel]:
                    problems.append(f"sitemap.xml: {loc} lastmod {lastmod} is not the page's dateModified {sorted(modified[rel])}")
            for rel in indexable:
                n = seen.get(rel, 0)
                if n != 1:
                    problems.append(f"sitemap.xml lists {url_of(rel)} {n} times (want 1)")
    robots = site / "robots.txt"
    if not robots.is_file() or f"Sitemap: {BASE}sitemap.xml" not in robots.read_text(encoding="utf8"):
        problems.append(f"robots.txt does not name Sitemap: {BASE}sitemap.xml")
    llms = site / "llms.txt"
    if not llms.is_file():
        problems.append("llms.txt is missing")
    else:
        listed = set(re.findall(r"\]\((https://[^)\s]+)\)", llms.read_text(encoding="utf8")))
        for rel in indexable:
            if url_of(rel) not in listed:
                problems.append(f"llms.txt does not list {url_of(rel)}")
    return problems


# ---- Self-test ---------------------------------------------------------------------------

def _page(rel: str, *, title: str, desc: str, ld: str | None, h1: int = 1, img_alt: bool = True,
          canonical: str | None = None, noindex: bool = False) -> str:
    canon = url_of(rel) if canonical is None else canonical
    tags = "".join(f'<meta property="{k}" content="{v}">' for k, v in (
        ("og:title", title), ("og:description", desc), ("og:url", canon), ("og:image", BASE + "a.png"),
        ("og:type", "article"), ("og:locale", "en_US")))
    tags += "".join(f'<meta name="{k}" content="{v}">' for k, v in (
        ("twitter:card", "summary_large_image"), ("twitter:title", title), ("twitter:description", desc),
        ("twitter:image", BASE + "a.png")))
    robots = '<meta name="robots" content="noindex">' if noindex else ""
    script = f'<script type="application/ld+json">{ld}</script>' if ld is not None else ""
    img = '<img src="a.png" alt="A screenshot">' if img_alt else '<img src="a.png">'
    return (f'<!doctype html><html lang="en"><head><title>{title}</title><meta name="description" content="{desc}">'
            f'{robots}<link rel="canonical" href="{canon}">{tags}{script}</head><body><main>'
            + "<h1>Heading</h1>" * h1 + f"<p>What is OpenCanvas? It is a canvas you embed in your app.</p>{img}</main></body></html>")


GOOD_DESC = "A description long enough for a search engine to show in full, and short enough that it is not cut."


def _ld(rel: str, **over) -> str:
    art = {"@type": "TechArticle", "headline": "Heading", "description": "d", "url": url_of(rel),
           "dateModified": "2026-11-26", "author": {"@type": "Organization", "name": "CasualOffice", "url": BASE},
           "publisher": {"@id": BASE + "#organization"}, "inLanguage": "en"}
    art.update(over)
    return json.dumps({"@context": "https://schema.org", "@graph": [art]})


def _site(tmp: pathlib.Path, pages_: dict[str, str], sitemap: list[tuple[str, str]] | None = None,
          llms: list[str] | None = None) -> pathlib.Path:
    for rel, text in pages_.items():
        (tmp / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp / rel).write_text(text, encoding="utf8")
    (tmp / "a.png").write_bytes(b"\x89PNG")
    if sitemap is None:
        sitemap = [(r, "2026-11-26") for r in pages_ if "noindex" not in pages_[r]]
    urls = "".join(f"<url><loc>{url_of(r)}</loc>" + (f"<lastmod>{d}</lastmod>" if d else "") + "</url>" for r, d in sitemap)
    (tmp / "sitemap.xml").write_text(f'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>',
                                     encoding="utf8")
    (tmp / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {BASE}sitemap.xml\n", encoding="utf8")
    llms = [r for r in pages_ if "noindex" not in pages_[r]] if llms is None else llms
    (tmp / "llms.txt").write_text("".join(f"- [x]({url_of(r)})\n" for r in llms), encoding="utf8")
    return tmp


def self_test() -> int:
    good = {"index.html": _page("index.html", title="Home", desc=GOOD_DESC, ld=_ld("index.html")),
            "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.", ld=_ld("docs/a.html")),
            "404.html": _page("404.html", title="Not found", desc="Gone.", ld=None, noindex=True)}
    faq_ok = json.dumps({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": "What is OpenCanvas?",
         "acceptedAnswer": {"@type": "Answer", "text": "It is a canvas you embed in your app."}}]})
    cases: list[tuple[str, dict, dict, str | None]] = [
        ("a good site passes", good, {}, None),
        ("a good FAQPage passes", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.", ld=faq_ok)}, {}, None),
        ("missing title", {**good, "docs/a.html": _page("docs/a.html", title="", desc=GOOD_DESC + " A.", ld=_ld("docs/a.html"))}, {}, "no <title>"),
        ("duplicate title", {**good, "docs/a.html": _page("docs/a.html", title="Home", desc=GOOD_DESC + " A.", ld=_ld("docs/a.html"))}, {}, "duplicate title"),
        ("missing description", {**good, "docs/a.html": _page("docs/a.html", title="A", desc="", ld=_ld("docs/a.html"))}, {}, "no meta description"),
        ("duplicate description", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC, ld=_ld("docs/a.html"))}, {}, "duplicate description"),
        ("description too long", {**good, "docs/a.html": _page("docs/a.html", title="A", desc="x" * 200, ld=_ld("docs/a.html"))}, {}, "description is 200 characters"),
        ("missing canonical", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.", ld=_ld("docs/a.html"), canonical="")}, {}, "canonical is"),
        ("invalid JSON-LD", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.", ld="{not json")}, {}, "does not parse"),
        ("JSON-LD missing a property", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.", ld=_ld("docs/a.html", headline=""))}, {}, "lacks headline"),
        ("no JSON-LD", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.", ld=None)}, {}, "no JSON-LD"),
        ("FAQ question not on the page", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.",
                                          ld=faq_ok.replace("What is OpenCanvas?", "Is it magic?"))}, {}, "is not on the page"),
        ("wrong software version", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.", ld=json.dumps({
            "@context": "https://schema.org", "@type": "SoftwareApplication", "name": "OpenCanvas", "description": "d", "url": BASE,
            "applicationCategory": "DeveloperApplication", "operatingSystem": "Linux", "softwareVersion": "9.9.9",
            "license": "https://x", "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"}}))}, {}, "is not Cargo.toml's"),
        ("missing alt text", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.", ld=_ld("docs/a.html"), img_alt=False)}, {}, "has no alt attribute"),
        ("two h1", {**good, "docs/a.html": _page("docs/a.html", title="A", desc=GOOD_DESC + " A.", ld=_ld("docs/a.html"), h1=2)}, {}, "2 <h1> elements"),
        ("sitemap missing a page", good, {"sitemap": [("index.html", "2026-11-26")]}, "sitemap.xml lists https://canvas.casualoffice.org/docs/a.html 0 times"),
        ("sitemap without lastmod", good, {"sitemap": [("index.html", "2026-11-26"), ("docs/a.html", "")]}, "has no valid <lastmod>"),
        ("sitemap lastmod not dateModified", good, {"sitemap": [("index.html", "2026-11-26"), ("docs/a.html", "2026-01-01")]}, "is not the page's dateModified"),
        ("sitemap lists the 404", good, {"sitemap": [("index.html", "2026-11-26"), ("docs/a.html", "2026-11-26"), ("404.html", "2026-11-26")]}, "which is noindex"),
        ("llms.txt missing a page", good, {"llms": ["index.html"]}, "llms.txt does not list"),
    ]
    failed = 0
    for name, pages_, extra, expect in cases:
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="oc-seo-"))
        try:
            got = check(_site(tmp, pages_, **extra), "0.2.1")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        ok = (not got) if expect is None else any(expect in g for g in got)
        if not ok:
            failed += 1
            print(f"self-test FAIL: {name}: expected {'no problems' if expect is None else repr(expect)}, got {got}", file=sys.stderr)
    if failed:
        return 1
    print(f"check-site-seo: self-test passed ({len(cases)} cases)")
    return 0


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        return self_test()
    if argv:
        print(__doc__, file=sys.stderr)
        return 2
    version = cargo_version()
    if not version:
        print("check-site-seo: no [workspace.package] version in Cargo.toml", file=sys.stderr)
        return 1
    problems = check(SITE, version)
    if problems:
        print(f"check-site-seo: {len(problems)} problem(s)\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1
    print(f"check-site-seo: {len(pages(SITE))} pages, titles, descriptions, canonicals, JSON-LD, alt text, sitemap and llms.txt OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
