#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Write the website's logo files from the editor's mark and the Geist font.

    python3 tools/build-logo.py      # writes site/assets/{mark,logo,logo-dark}.svg

The mark is the editor's favicon (web/packages/editor/index.html: a cobalt rounded square
with three text lines). The wordmark is "OpenCanvas" set in Geist SemiBold and converted
to outlines, so the SVG needs no font when used as an <img>. The outputs are committed;
this needs fontTools and brotli (a one-off developer tool, not part of the site build).
"""

from __future__ import annotations

import pathlib

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONT = ROOT / "site/assets/fonts/ui/geist-1.3.1-variable.woff2"
OUT = ROOT / "site/assets"
ACCENT = "#2a5ad7"
WORD = "OpenCanvas"

MARK_PATHS = (f'<rect width="32" height="32" rx="8" fill="{ACCENT}"/>'
              '<path d="M10 11h12M10 16h12M10 21h7" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/>')


def wordmark(height: float) -> tuple[str, float]:
    """The word as one SVG path whose cap height is `height`; returns (path, advance width)."""
    font = instantiateVariableFont(TTFont(FONT), {"wght": 600})
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    cap = font["OS/2"].sCapHeight or font["head"].unitsPerEm * 0.7
    scale = height / cap
    pen = SVGPathPen(gs)
    x = 0.0
    for ch in WORD:
        name = cmap[ord(ch)]
        # Flip y: font units go up, SVG goes down; baseline at y = height.
        tp = TransformPen(pen, (scale, 0, 0, -scale, x * scale, height))
        gs[name].draw(tp)
        x += gs[name].width
    return pen.getCommands(), x * scale


def main() -> None:
    (OUT / "mark.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">{MARK_PATHS}</svg>\n', encoding="utf8")
    # 144 units high like OpenSeal's logo: a 144 px mark, then the word at cap height 72.
    cap = 72.0
    path, width = wordmark(cap)
    gap = 36.0
    total = 144 + gap + width
    for name, ink in (("logo.svg", "#18181b"), ("logo-dark.svg", "#f4f4f5")):
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total:.1f} 144" width="{total:.1f}" height="144" '
               f'role="img" aria-label="OpenCanvas"><title>OpenCanvas</title>'
               f'<g transform="scale(4.5)">{MARK_PATHS}</g>'
               f'<path transform="translate({144 + gap:.1f} {(144 - cap) / 2:.1f})" fill="{ink}" d="{path}"/></svg>\n')
        (OUT / name).write_text(svg, encoding="utf8")
    print(f"build-logo: wrote mark.svg, logo.svg, logo-dark.svg ({total:.1f} x 144)")


if __name__ == "__main__":
    main()
