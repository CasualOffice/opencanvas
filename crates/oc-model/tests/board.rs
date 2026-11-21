//! Board rendering: parity with the web `exportBoardSvg` and headless PNG output.

use std::collections::HashMap;

use serde_json::{Value, json};

fn fixture_doc() -> Value {
    let board: Value =
        serde_json::from_str(include_str!("fixtures/board.json")).expect("fixture json");
    json!({"boards": {"b1": board}, "content": []})
}

/// The web output names its clip paths with a module-wide counter and fixed ids; ours are
/// per board. Normalise both before comparing.
fn normalise(svg: &str, prefix: &str) -> String {
    svg.replace(prefix, "ocbd-x-")
}

#[test]
fn svg_matches_web_export() {
    // `fixtures/board.web.svg` is the output of the web `shapesToSvg` for `fixtures/board.json`
    // (sticky, frame, ellipse, diamond, straight + elbow bound arrows, free arrow, pen, image,
    // text, swatch, shapes outside `order`).
    let expected = include_str!("fixtures/board.web.svg");
    let svg = oc_model::board::to_svg(&fixture_doc(), "b1");
    assert_eq!(normalise(&svg, "ocbd-b1-"), expected);
}

#[test]
fn empty_and_missing_boards_are_blank_pages() {
    let doc = json!({"boards": {"e": {"shapes": {}, "order": []}}});
    for id in ["e", "nope"] {
        let svg = oc_model::board::to_svg(&doc, id);
        assert!(svg.contains(r#"viewBox="0 0 320 200""#), "{svg}");
        assert!(svg.starts_with("<svg") && svg.ends_with("</svg>"));
    }
}

#[test]
fn unsafe_image_hrefs_are_dropped() {
    let doc = json!({"boards": {"b": {"order": ["i"], "shapes": {
        "i": {"type": "image", "x": 0, "y": 0, "w": 10, "h": 10, "src": "javascript:alert(1)"}}}}});
    let svg = oc_model::board::to_svg(&doc, "b");
    assert!(!svg.contains("javascript:"));
}

#[test]
fn board_image_sources_are_listed_for_fetching() {
    let srcs = oc_model::board::image_sources(&fixture_doc());
    assert_eq!(srcs, vec!["https://host.example/a.png?x=1&y=2".to_string()]);
}

/// 1×1 red PNG.
fn red_png() -> Vec<u8> {
    let mut pm = resvg::tiny_skia::Pixmap::new(4, 4).unwrap();
    pm.fill(resvg::tiny_skia::Color::from_rgba8(255, 0, 0, 255));
    pm.encode_png().unwrap()
}

fn decode(png: &[u8]) -> resvg::tiny_skia::Pixmap {
    resvg::tiny_skia::Pixmap::decode_png(png).expect("valid png")
}

#[test]
fn png_renders_shapes_text_and_inlined_images() {
    let doc = fixture_doc();
    let mut images = HashMap::new();
    images.insert("https://host.example/a.png?x=1&y=2".to_string(), red_png());
    let svg = oc_model::board::to_svg_with_images(&doc, "b1", &images);
    assert!(svg.contains("href=\"data:image/png;base64,"));
    let png = oc_model::board::to_png(&svg, 2.0).expect("png");
    if let Ok(out) = std::env::var("OC_BOARD_PNG_OUT") {
        std::fs::write(out, &png).unwrap();
    }
    let pm = decode(&png);
    assert_eq!((pm.width(), pm.height()), (1064 * 2, 589 * 2));
    let px = |x: f32, y: f32| {
        // board coordinates → pixels (viewBox starts at -32,-32; scale 2)
        let p = pm
            .pixel(((x + 32.0) * 2.0) as u32, ((y + 32.0) * 2.0) as u32)
            .unwrap();
        (p.red(), p.green(), p.blue())
    };
    assert_eq!(px(-20.0, -20.0), (255, 255, 255), "white background");
    assert_eq!(px(100.0, 140.0), (0xcf, 0xe3, 0xfb), "blue sticky fill");
    assert_eq!(px(820.0, 85.0), (255, 0, 0), "inlined image");
    // Text renders headless with the embedded font: the sticky's first line has dark pixels.
    let mut dark = 0;
    for y in ((44.0 + 18.0 + 32.0) * 2.0) as u32..((44.0 + 32.0 + 32.0) * 2.0) as u32 {
        for x in ((40.0 + 32.0) * 2.0) as u32..((150.0 + 32.0) * 2.0) as u32 {
            let p = pm.pixel(x, y).unwrap();
            if p.red() < 120 && p.green() < 120 {
                dark += 1;
            }
        }
    }
    assert!(dark > 200, "sticky text not rendered ({dark} dark pixels)");
}

#[test]
fn png_ignores_remote_and_file_hrefs() {
    // Only data: URLs are decoded; a remote URL or a local path must never be read.
    let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><rect width="20" height="20" fill="white"/><image href="/etc/hosts" width="20" height="20"/><image href="Cargo.toml" width="20" height="20"/></svg>"#;
    let pm = decode(&oc_model::board::to_png(svg, 1.0).unwrap());
    let p = pm.pixel(10, 10).unwrap();
    assert_eq!((p.red(), p.green(), p.blue()), (255, 255, 255));
}

#[test]
fn png_scale_is_capped() {
    let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="100" viewBox="0 0 5000 100"/>"#;
    let pm = decode(&oc_model::board::to_png(svg, 16.0).unwrap());
    assert!(pm.width() <= 16384, "{}", pm.width());
}
