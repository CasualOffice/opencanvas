# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Tests for the site's Markdown renderer. Run: python3 -I tools/test_sitelib.py"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import sitelib  # noqa: E402


class FencedCodeInLists(unittest.TestCase):
    """Install steps in the integration READMEs put fenced code inside numbered items."""

    SRC = (
        "1. Copy the plugin:\n"
        "   ```sh\n"
        "   mkdir -p /plugins\n"
        "   cp mod_x.lua /plugins/\n"
        "   ```\n"
        "2. Add to `.env`:\n"
        "   ```toml\n"
        '   id = "acme"  # <secret>\n'
        "   ```\n"
        "   Then restart.\n"
    )

    def test_code_keeps_its_lines_and_stays_in_the_item(self):
        out = sitelib.markdown(self.SRC)
        self.assertIn('<pre><code class="language-sh">mkdir -p /plugins\ncp mod_x.lua /plugins/</code></pre>', out)
        self.assertIn('id = &quot;acme&quot;  # &lt;secret&gt;</code></pre>', out)
        self.assertNotIn("```", out)
        # Both steps stay one ordered list, and the text after the fence stays in step 2.
        self.assertEqual(out.count("<ol>"), 1)
        self.assertIn("</code></pre> Then restart.</li>", out)

    def test_plain_lists_are_unchanged(self):
        self.assertEqual(sitelib.markdown("- a\n  b\n- c"), "<ul><li>a b</li><li>c</li></ul>")


class SearchEntries(unittest.TestCase):
    """API reference sub-headings (data-index="no") stay inside their operation's entry."""

    PAGE = ('<html><head><title>Blocks | OpenCanvas</title></head><body><main>'
            '<h2 id="listBlocks">List top-level blocks</h2><p>Pages of blocks.</p>'
            '<h3 data-index="no">Parameters</h3><p>limit 1-100</p>'
            '<h2 id="getBlock">Read one block</h2><p>Nested ones too.</p></main></body></html>')

    def test_sub_headings_do_not_start_entries(self):
        entries = sitelib.index_entries("api/reference/blocks.html", self.PAGE)
        self.assertEqual([e["u"] for e in entries],
                         ["api/reference/blocks.html#listBlocks", "api/reference/blocks.html#getBlock"])
        self.assertIn("limit 1-100", entries[0]["t"])
        self.assertIn("Parameters", entries[0]["t"])


class StructuredData(unittest.TestCase):
    """The JSON-LD helpers state what the page shows, and the release the repository has."""

    def test_faq_pairs_from_details_and_question_headings(self):
        body = ('<details><summary>Is it free?<svg><path d="M0"/></svg></summary><div data-answer><p>Yes, under '
                '<a href="x">Apache-2.0</a>.</p></div></details>'
                '<h2 id="a">What is it?</h2><p>A canvas.</p><ul><li>One</li></ul>'
                '<h2 id="b">Licence</h2><p>Not a question.</p>')
        self.assertEqual(sitelib.faq_pairs(body), [("Is it free?", "Yes, under Apache-2.0."),
                                                   ("What is it?", "A canvas. One")])

    def test_claim_marks_stay_out_of_answers(self):
        body = ('<h2>How many?</h2><p data-claim>Up to 5,000. <a class="claim-mark" data-claim-mark="source" '
                'href="x">Source: docs/22</a></p>')
        self.assertEqual(sitelib.faq_pairs(body), [("How many?", "Up to 5,000.")])

    def test_breadcrumbs_count_from_one_and_use_public_urls(self):
        node = sitelib.breadcrumb_node([("OpenCanvas", "index.html"), ("Docs", "docs/index.html")])
        self.assertEqual([i["position"] for i in node["itemListElement"]], [1, 2])
        self.assertEqual(node["itemListElement"][0]["item"], sitelib.BASE_URL)
        self.assertEqual(node["itemListElement"][1]["item"], sitelib.BASE_URL + "docs/index.html")

    def test_the_release_has_a_changelog_date(self):
        self.assertRegex(sitelib.released(), r"^\d{4}-\d\d-\d\d$")
        with self.assertRaises(SystemExit):
            sitelib.released("99.0.0")

    def test_version_placeholders_expand_before_claims(self):
        out = sitelib.expand("{{version}} on {{released}}", "")
        self.assertEqual(out, f"{sitelib.version()} on {sitelib.released()}")


class SharedPartsAndTitles(unittest.TestCase):
    """The alternatives/ and solutions/ pages share one table of what ships, and every title
    names "OpenCanvas by CasualOffice"."""

    def test_a_partial_is_included_and_expanded_at_the_page_depth(self):
        out = sitelib.expand("<main>{{include:compare-footer}}</main>", "../")
        self.assertIn('href="../app/#demo"', out)
        self.assertNotIn("{{", out)
        self.assertNotIn("<!--", out)  # the partial's own comment stays in the source

    def test_a_missing_partial_stops_the_build(self):
        with self.assertRaises(SystemExit):
            sitelib.expand("{{include:no-such-part}}", "")

    def test_titles_carry_the_brand_and_search_results_drop_it(self):
        page = sitelib.page(title="Changelog", description="d", body="", root="", path="404.html", noindex=True)
        self.assertIn("<title>Changelog | OpenCanvas by CasualOffice</title>", page)
        self.assertEqual(sitelib.page_title(page, "404.html"), "Changelog")


class BenchOrderIsStable(unittest.TestCase):
    """The site lists perf results by commit time, not file mtime: a fresh checkout gives every
    file the same mtime, so ordering by it rebuilt a different page and failed the prepush gate."""

    def test_db_perf_order_ignores_mtime(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("build_site", os.path.join(os.path.dirname(__file__), "build-site.py"))
        bs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bs)
        files = sorted(bs.PERF.glob("db100k-*.json"))
        if len(files) < 2:
            self.skipTest("needs two db100k results")
        saved = [(f, f.stat().st_atime, f.stat().st_mtime) for f in files]
        try:
            orders = []
            for newest in files:
                for f in files:
                    os.utime(f, (1, 2 if f == newest else 1))
                md = "\n".join(bs._db_perf_markdown())
                orders.append([f.stem for f in sorted(files, key=lambda f: md.index("— " + f.stem + "\n"))])
            self.assertTrue(all(o == orders[0] for o in orders), orders)
        finally:
            for f, at, mt in saved:
                os.utime(f, (at, mt))
def _roadmap():
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_roadmap", os.path.join(os.path.dirname(__file__), "build-roadmap.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Roadmap(unittest.TestCase):
    """The roadmap page shows each phase's state from its rows, the Workspace track, the
    Backlog status and the release table's statuses (tools/build-roadmap.py)."""

    br = _roadmap()

    def test_backlog_is_ranked_like_todo_and_labelled_backlog(self):
        self.assertEqual(self.br.status_of("Backlog"), "Backlog")
        self.assertEqual(self.br.RANK["Backlog"], self.br.RANK["Todo"])
        self.assertEqual(self.br.LABEL["Backlog"][1], "Backlog")

    def test_a_phase_state_follows_its_rows(self):
        rows = lambda *s: [{"status": x} for x in s]  # noqa: E731
        st = self.br.phase_state
        self.assertEqual(st(rows("Done", "Done")), ("done", "Done"))
        self.assertEqual(st(rows("Done", "Review")), ("done", "Built, in review"))
        self.assertEqual(st(rows("Done", "Todo")), ("progress", "In progress"))
        self.assertEqual(st(rows("Todo", "Backlog")), ("later", "Planned"))

    def test_release_statuses(self):
        rs = self.br.release_state
        self.assertEqual(rs("Released 2026-11-24 (notes)"), ("done", "Released 2026-11-24"))
        self.assertEqual(rs("In progress (parallel track)"), ("progress", "In progress (parallel track)"))
        self.assertEqual(rs("Planned"), ("later", "Planned"))
        with self.assertRaises(SystemExit):
            rs("Soon")

    def test_the_tracker_has_the_workspace_track_and_p3_releases(self):
        rows = self.br.tracker()
        ws = {r["id"]: r for r in rows["WS"]}
        self.assertEqual(ws["WS-07"]["status"], "Backlog")
        self.assertEqual(ws["WS-01"]["status"], "Done")
        groups = [r["group"] for r in rows["P3"]]
        self.assertIn("v0.2", groups)
        self.assertIn("v0.5", groups)

    def test_the_page_shows_release_statuses_and_the_workspace_track(self):
        page = self.br.render()
        self.assertIn("Workspace track", page)
        self.assertIn("pill-done", page.split('id="rel-h"')[1].split("</table>")[0])
        self.assertNotIn("Plugin ecosystem, developer tooling", page)


if __name__ == "__main__":
    unittest.main()
