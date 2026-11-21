# Third-party fonts

Embedded in `oc-model` (`include_bytes!`) for board PNG rendering. All under the SIL Open
Font License 1.1; none has a Reserved Font Name that the files here use.

| File | Font | Source | Licence | Notes |
|---|---|---|---|---|
| `Geist-Regular.ttf`, `Geist-SemiBold.ttf` | Geist | vercel/geist-font | OFL 1.1, `OFL-Geist.txt` | Unmodified |
| `NotoSansSymbols2-Subset.ttf` | Noto Sans Symbols 2 | google/fonts `ofl/notosanssymbols2` | OFL 1.1, `OFL-Noto.txt` | Subset (fontTools 4.60) to U+2022, U+2026, U+2190–21FF, U+2300–23FF, U+2460–24FF, U+25A0–25FF, U+2600–26FF, U+2700–27BF, U+2B00–2BFF (check marks, dingbats, shapes, misc symbols) |
| `NotoSansMath-Subset.ttf` | Noto Sans Math | google/fonts `ofl/notosansmath` | OFL 1.1, `OFL-Noto.txt` | Subset to U+2190–22FF, U+27F0–27FF, U+2900–297F (arrows, math operators) |

Test fixture (not shipped in the binary): `tests/fixtures/fonts/NotoSansSC-Subset.ttf`,
Noto Sans SC (google/fonts `ofl/notosanssc`), instanced at wght 400 and subset to 中文字;
licence in `tests/fixtures/fonts/OFL.txt`.

Regenerate a subset with:

```sh
pyftsubset NotoSansSymbols2-Regular.ttf --layout-features='*' \
  --unicodes="U+2022,U+2026,U+2190-21FF,U+2300-23FF,U+2460-24FF,U+25A0-25FF,U+2600-26FF,U+2700-27BF,U+2B00-2BFF" \
  --output-file=NotoSansSymbols2-Subset.ttf
```

The server image adds Debian `fonts-noto-core` and `fonts-noto-cjk` (OFL) at runtime; they are
not redistributed from this repository.
