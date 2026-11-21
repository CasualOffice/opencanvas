#!/usr/bin/env python3
"""Check that every claim on the website traces to the repository.

    python3 -I tools/check-site-claims.py            # the built site, site/
    python3 -I tools/check-site-claims.py --self-test

Ported from OpenSeal's tools/check-site-claims.py and made stricter. A claim block is an
element with a `data-claim` attribute, or any item of a `ul.facts` list. Each must hold
exactly one marking, written by the `{{claim:...}}` placeholder (tools/sitelib.py):

- `data-claim-mark="tested"`: a link to the test, script or CI workflow that proves it,
  in the repository (under the repository's blob/main/, and the file must exist);
- `data-claim-mark="source"`: a link to a repository file plus `data-quote`, text that
  must appear in that file word for word (whitespace aside). Every number in the claim's
  own text must appear in the quote, so a figure cannot be rounded, inflated or invented;
- `data-claim-mark="deployment"`: what the operator configures, as non-empty text.

A number in a claim with a tested or deployment marking fails too: a figure needs a
source. And on every page, llms.txt and llms-full.txt, the words "open source" (or
"open-source") fail the check: OpenCanvas is source-available (BUSL-1.1), not open
source. Exits non-zero naming each problem. Standard library only; no network.
"""

from __future__ import annotations

import html as html_mod
import pathlib
import re
import sys
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
REPO_BLOB = "https://github.com/CasualOffice/opencanvas/blob/main/"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
        "path", "circle", "line", "rect", "polyline", "polygon", "ellipse"}
NUMBER = re.compile(r"(?<![\w.\-])\d+(?:[.,]\d+)*(?![A-Za-z])")
BANNED = re.compile(r"\bopen[\s\-]+source\b", re.I)


def norm(s: str) -> str:
    return " ".join(s.split())


class Claims(HTMLParser):
    """Collects claim blocks: their own text and the markings inside them."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict] = []
        self.open: list[dict] = []
        self.claims: list[dict] = []
        self.mark: dict | None = None
        self.skip = 0  # inside <svg>: icons, no text

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        parent_facts = bool(self.stack) and self.stack[-1]["tag"] == "ul" and self.stack[-1]["facts"]
        is_claim = "data-claim" in a or (tag == "li" and parent_facts and "data-not-claim" not in a)
        entry = {"tag": tag, "facts": tag == "ul" and "facts" in classes, "claim": None, "mark": False}
        if is_claim:
            claim = {"text": "", "marks": []}
            self.claims.append(claim)
            self.open.append(claim)
            entry["claim"] = claim
        kind = a.get("data-claim-mark")
        if kind is not None:
            mark = {"kind": kind, "href": a.get("href") or "", "quote": a.get("data-quote"), "text": "", "tag": tag}
            for c in self.open:
                c["marks"].append(mark)
            if not self.open:
                self.claims.append({"text": "(a marking outside any claim)", "marks": [mark], "stray": True})
            self.mark = mark
            entry["mark"] = True
        if tag == "svg":
            self.skip += 1
        if tag not in VOID:
            self.stack.append(entry)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        while self.stack:
            entry = self.stack.pop()
            if entry["claim"] is not None and entry["claim"] in self.open:
                self.open.remove(entry["claim"])
            if entry["mark"]:
                self.mark = None
            if entry["tag"] == "svg":
                self.skip = max(0, self.skip - 1)
            if entry["tag"] == tag:
                break

    def handle_data(self, data):
        if self.skip:
            return
        if self.mark is not None:
            self.mark["text"] += data
            return  # a marking's own words are not the claim's
        for c in self.open:
            c["text"] += data


def repo_path(href: str) -> str | None:
    if not href.startswith(REPO_BLOB) or len(href) <= len(REPO_BLOB):
        return None
    return href[len(REPO_BLOB):].split("#", 1)[0]


def problems_in(rel: str, page: str) -> tuple[int, list[str]]:
    p = Claims()
    p.feed(page)
    out = []
    for c in p.claims:
        words = norm(c["text"])
        name = f"{rel}: \"{words[:70]}{'…' if len(words) > 70 else ''}\""
        if c.get("stray"):
            out.append(f"{rel}: a claim marking outside any claim block")
            continue
        marks = c["marks"]
        numbers = set(NUMBER.findall(words))
        if not marks:
            out.append(f"{name} has no marking: add {{{{claim:tested|WHAT|PATH}}}}, {{{{claim:source|QUOTE|PATH}}}} or {{{{claim:deployment|WHAT}}}}")
            continue
        if len(marks) > 1:
            out.append(f"{name} has {len(marks)} markings; give it one")
            continue
        m = marks[0]
        text = norm(m["text"])
        path = repo_path(m["href"])
        if m["kind"] in ("tested", "source"):
            if m["tag"] != "a" or path is None:
                out.append(f"{name}: a {m['kind']} marking must link to a file in the repository")
                continue
            if not (ROOT / path).exists():
                out.append(f"{name}: {path!r} is not in the repository")
                continue
        if m["kind"] == "source":
            quote = norm(m["quote"] or "")
            if not quote:
                out.append(f"{name}: a source marking needs its quote")
            elif quote not in norm((ROOT / path).read_text(encoding="utf8")):
                out.append(f"{name}: the quote {quote!r} is not in {path}")
            else:
                missing = sorted(n for n in numbers if n not in set(NUMBER.findall(quote)))
                if missing:
                    out.append(f"{name}: number(s) {', '.join(missing)} are not in the quoted source")
        elif m["kind"] in ("tested", "deployment"):
            if m["kind"] == "deployment" and len(text) <= len("Depends on your deployment:"):
                out.append(f"{name}: a deployment marking must say what the operator configures")
            if numbers:
                out.append(f"{name}: number(s) {', '.join(sorted(numbers))} need a source marking that quotes them")
        else:
            out.append(f"{name}: unknown marking {m['kind']!r} (tested, source or deployment)")
    return len([c for c in p.claims if not c.get("stray")]), out


def banned_in(rel: str, text: str) -> list[str]:
    plain = html_mod.unescape(re.sub(r"<[^>]+>", " ", text))
    return [f"{rel}: says \"{m.group(0)}\"; OpenCanvas is source-available (BUSL-1.1)" for m in BANNED.finditer(plain)]


def self_test() -> int:
    tracker = "docs/10-EXECUTION-TRACKER.md"
    ok = '<a data-claim-mark="tested" href="' + REPO_BLOB + 'tools/check-site-claims.py">Tested: this</a>'
    src = ('<a data-claim-mark="source" data-quote="cargo test 88, vitest 182" href="' + REPO_BLOB + tracker + '">'
           'Source</a>')
    dep = '<span data-claim-mark="deployment">Depends on your deployment: your key</span>'
    cases = [
        (f'<ul class="facts"><li><strong>A</strong>{ok}</li></ul>', 0),
        ('<ul class="facts"><li><strong>Unmarked claim</strong></li></ul>', 1),
        ('<ul class="facts"><li data-not-claim="roadmap">Later</li></ul>', 0),
        (f'<p data-claim>Keys {dep}</p>', 0),
        (f'<p data-claim>Two {dep}{ok}</p>', 1),
        ('<p data-claim>Empty <span data-claim-mark="deployment">Depends on your deployment:</span></p>', 1),
        ('<p data-claim>Off-repo <a data-claim-mark="tested" href="https://example.com/t">Tested</a></p>', 1),
        ('<p data-claim>Missing file <a data-claim-mark="tested" href="' + REPO_BLOB + 'no/such/test.rs">Tested</a></p>', 1),
        (f'<p data-claim>88 server tests and 182 web tests {src}</p>', 0),
        (f'<p data-claim>90 server tests {src}</p>', 1),
        (f'<p data-claim>12 tests {ok}</p>', 1),
        ('<p data-claim>Quote not in file <a data-claim-mark="source" data-quote="cargo test 9999" href="' + REPO_BLOB + tracker + '">S</a></p>', 1),
        (f'<p data-claim>AES-256-GCM and HS256 {dep}</p>', 0),
    ]
    failed = 0
    for i, (page, want) in enumerate(cases):
        _, got = problems_in(f"case{i}", page)
        if len(got) != want:
            print(f"check-site-claims self-test: case {i} expected {want} problem(s), got {got}", file=sys.stderr)
            failed += 1
    for page, want in (("<p>An open-source canvas</p>", 1), ("<p>Open Source</p>", 1), ("<p>open or closed source</p>", 0),
                       ("<p>source-available</p>", 0)):
        if len(banned_in("case", page)) != want:
            print(f"check-site-claims self-test: banned-words case {page!r} expected {want}", file=sys.stderr)
            failed += 1
    if failed:
        return 1
    print(f"check-site-claims: self-test passed ({len(cases) + 4} cases)")
    return 0


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        return self_test()
    if argv:
        print(__doc__, file=sys.stderr)
        return 2
    pages = sorted(p for p in SITE.rglob("*.html") if "_src" not in p.relative_to(SITE).parts)
    if not pages:
        print("check-site-claims: no pages in site/; run tools/build-site.py", file=sys.stderr)
        return 1
    total, problems = 0, []
    for path in pages:
        rel = str(path.relative_to(SITE))
        text = path.read_text(encoding="utf8")
        n, out = problems_in(rel, text)
        total += n
        problems.extend(out)
        problems.extend(banned_in(rel, text))
    for name in ("llms.txt", "llms-full.txt"):
        if (SITE / name).exists():
            problems.extend(banned_in(name, (SITE / name).read_text(encoding="utf8")))
    if problems:
        print(f"check-site-claims: {len(problems)} problem(s)", file=sys.stderr)
        for line in problems:
            print(f"  {line}", file=sys.stderr)
        return 1
    print(f"check-site-claims: {total} claims on {len(pages)} pages, each traced to a test, a quoted source or the deployment; no page says \"open source\"")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
