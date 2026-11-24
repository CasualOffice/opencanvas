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


if __name__ == "__main__":
    unittest.main()
