//! Glyph coverage of board PNGs: symbols from the embedded fonts, other scripts from
//! `OC_FONT_DIRS`. System fonts are switched off (`OC_SYSTEM_FONTS=0`) so the result does not
//! depend on the machine running the tests.

use std::sync::Once;

use resvg::tiny_skia::Pixmap;

static ENV: Once = Once::new();

/// Must run before the first render in this process: the font database is built once.
fn env() {
    ENV.call_once(|| {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fonts");
        // SAFETY: every test calls this first and `Once` blocks the others until it returns, so
        // no other thread reads the environment concurrently.
        unsafe {
            std::env::set_var("OC_SYSTEM_FONTS", "0");
            std::env::set_var("OC_FONT_DIRS", format!("/nonexistent/fonts:{dir}"));
        }
    });
}

/// One glyph, 40 px, black on white, in the board's font stack.
fn render(c: char) -> Pixmap {
    env();
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\" viewBox=\"0 0 64 64\" \
         font-family=\"Geist, ui-sans-serif, sans-serif\"><text x=\"8\" y=\"48\" font-size=\"40\" fill=\"#000\">{c}</text></svg>"
    );
    let png = oc_model::board::to_png(&svg, 1.0).expect("png");
    Pixmap::decode_png(&png).expect("valid png")
}

fn ink(pm: &Pixmap) -> usize {
    pm.pixels().iter().filter(|p| p.red() < 128).count()
}

/// Pixels that differ between two renders.
fn diff(a: &Pixmap, b: &Pixmap) -> usize {
    a.pixels()
        .iter()
        .zip(b.pixels())
        .filter(|(x, y)| x.red().abs_diff(y.red()) > 64)
        .count()
}

/// What a character no font has looks like (`.notdef`: a box, or nothing).
fn missing() -> Pixmap {
    render('\u{10FFFD}')
}

fn assert_drawn(c: char) {
    let (pm, tofu) = (render(c), missing());
    assert!(ink(&pm) > 40, "{c:?} drew nothing ({} dark px)", ink(&pm));
    assert!(
        diff(&pm, &tofu) > 40,
        "{c:?} renders as the missing-glyph box ({} px differ)",
        diff(&pm, &tofu)
    );
}

#[test]
fn check_mark_renders() {
    assert_drawn('✓');
    assert_drawn('✗');
}

#[test]
fn arrows_render() {
    assert_drawn('→');
    assert_drawn('⇒');
}

#[test]
fn dingbats_and_shapes_render() {
    for c in ['★', '☐', '☑', '⚠', '➜'] {
        assert_drawn(c);
    }
}

#[test]
fn cjk_renders_from_oc_font_dirs() {
    assert_drawn('中');
    assert_drawn('文');
}

#[test]
fn coverage_lists_characters_no_font_has() {
    env();
    assert_eq!(
        oc_model::fonts::coverage("Done ✓ → 中文"),
        Vec::<char>::new()
    );
    // Not in the fixture subset, and system fonts are off.
    assert_eq!(oc_model::fonts::coverage("日本 日"), vec!['日', '本']);
    assert_eq!(oc_model::fonts::coverage("a\u{10FFFD}"), vec!['\u{10FFFD}']);
}
