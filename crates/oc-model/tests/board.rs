// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

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
    // text, swatch, shapes outside `order`; UX pass: tone fills, stroke, text sizes, wrapped and
    // auto-grown stickies, connector labels, groups, layer order). Regenerate it with
    // `OC_UPDATE_FIXTURE=1 pnpm --filter @opencanvas/board test` (web/packages/board/src/export.test.ts).
    let expected = include_str!("fixtures/board.web.svg");
    let svg = oc_model::board::to_svg(&fixture_doc(), "b1");
    assert_eq!(normalise(&svg, "ocbd-b1-"), expected);
}

#[test]
fn style_svg_matches_web_export() {
    // BRD-22: `fixtures/board-style.web.svg` is the web `exportBoardSvg` of `board-style.json`
    // (stroke colour, width, dash, opacity, font, rotation, arrowheads, out-of-range values).
    let board: Value =
        serde_json::from_str(include_str!("fixtures/board-style.json")).expect("fixture json");
    let doc = json!({"boards": {"b1": board}, "content": []});
    let svg = oc_model::board::to_svg(&doc, "b1");
    assert_eq!(
        normalise(&svg, "ocbd-b1-"),
        include_str!("fixtures/board-style.web.svg")
    );
}

/// SVG of a board with these shapes, in this order (ids `s0`, `s1`, …).
fn svg_of(shapes: &[Value]) -> String {
    let mut map = serde_json::Map::new();
    let mut order = vec![];
    for (i, s) in shapes.iter().enumerate() {
        map.insert(format!("s{i}"), s.clone());
        order.push(json!(format!("s{i}")));
    }
    let doc = json!({"boards": {"b": {"shapes": map, "order": order}}});
    oc_model::board::to_svg(&doc, "b")
}

fn texts(svg: &str) -> Vec<String> {
    svg.split("<text")
        .skip(1)
        .map(|t| t[t.find('>').unwrap() + 1..t.find("</text>").unwrap()].to_string())
        .collect()
}

#[test]
fn tone_fills_on_rect_ellipse_diamond() {
    let svg = svg_of(&[
        json!({"type": "rect", "x": 0, "y": 0, "w": 100, "h": 50, "fill": "blue"}),
        json!({"type": "ellipse", "x": 0, "y": 60, "w": 100, "h": 50, "fill": "green"}),
        json!({"type": "diamond", "x": 0, "y": 120, "w": 100, "h": 50, "fill": "amber"}),
    ]);
    assert!(
        svg.contains(r##"fill="#e6eefd" stroke="#2350c8""##),
        "{svg}"
    );
    assert!(
        svg.contains(r##"fill="#e2f3e8" stroke="#17703f""##),
        "{svg}"
    );
    assert!(
        svg.contains(r##"fill="#fcf0d9" stroke="#8f5300""##),
        "{svg}"
    );
}

#[test]
fn every_tone_maps_and_unknown_tones_fall_back() {
    for (t, bg, fg) in [
        ("gray", "#efefed", "#55555c"),
        ("blue", "#e6eefd", "#2350c8"),
        ("green", "#e2f3e8", "#17703f"),
        ("amber", "#fcf0d9", "#8f5300"),
        ("red", "#fde6e6", "#b12424"),
        ("purple", "#efe8fd", "#6538c4"),
        ("pink", "#fce6f0", "#ad2c66"),
    ] {
        let svg = svg_of(&[json!({"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "fill": t})]);
        assert!(
            svg.contains(&format!(r#"fill="{bg}" stroke="{fg}""#)),
            "{t}: {svg}"
        );
    }
    let svg = svg_of(&[
        json!({"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "fill": "zz", "stroke": "accent"}),
    ]);
    assert!(
        svg.contains(r##"fill="#ffffff" stroke="#2a5ad7""##),
        "{svg}"
    );
    let svg = svg_of(&[
        json!({"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "fill": "blue", "dashed": true}),
    ]);
    assert!(svg.contains(r##"fill="none" stroke="#8b8b95""##), "{svg}");
}

#[test]
fn shape_text_size_and_line_height() {
    let svg = svg_of(&[
        json!({"type": "rect", "x": 0, "y": 0, "w": 300, "h": 100, "size": 20, "text": "a\nb"}),
        json!({"type": "ellipse", "x": 0, "y": 200, "w": 300, "h": 100, "text": "c"}),
    ]);
    assert!(
        svg.contains(r##"<text x="150" y="44.2" font-size="20" text-anchor="middle" fill="#18181b">a</text><text x="150" y="70.2""##),
        "{svg}"
    );
    assert!(svg.contains(r#"font-size="15" font-weight="600""#), "{svg}");
}

#[test]
fn shape_and_sticky_text_wraps_to_the_width() {
    let svg = svg_of(&[
        json!({"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100, "text": "one two three four five six"}),
    ]);
    assert_eq!(texts(&svg), ["one two", "three four", "five six"]);
    let svg = svg_of(&[
        json!({"type": "sticky", "x": 0, "y": 0, "w": 150, "h": 300, "text": "Wrap this fairly long sticky note text please"}),
    ]);
    assert_eq!(
        texts(&svg),
        ["Wrap this", "fairly long", "sticky note", "text please"]
    );
}

#[test]
fn sticky_grows_to_fit_its_text() {
    let svg = svg_of(&[
        json!({"type": "sticky", "x": 0, "y": 0, "w": 150, "h": 60, "text": "a\nb\nc\nd"}),
    ]);
    assert!(
        svg.contains(r##"<rect x="0" y="0" width="150" height="112" rx="6" fill="#fdeaa0"/>"##),
        "{svg}"
    );
    assert!(svg.contains(r#"height="176""#), "{svg}");
}

#[test]
fn connector_label_sits_in_a_pill_at_the_midpoint() {
    let svg = svg_of(&[
        json!({"type": "arrow", "pts": [[0, 0], [100, 0], [100, 100]], "text": " yes <ok> "}),
    ]);
    assert!(
        svg.contains(r##"<rect x="65" y="-11" width="70" height="22" rx="6" fill="#fbfbfa" stroke="#181820" stroke-opacity="0.15"/><text x="100" y="4" font-size="12.5" font-weight="500" text-anchor="middle" fill="#55555e">yes &lt;ok&gt;</text>"##),
        "{svg}"
    );
    let svg = svg_of(&[json!({"type": "arrow", "pts": [[0, 0], [10, 0]], "text": "  "})]);
    assert!(!svg.contains("#fbfbfa"), "{svg}");
}

#[test]
fn shapes_paint_in_layer_order() {
    let svg = oc_model::board::to_svg(&fixture_doc(), "b1");
    assert!(svg.find(">Below<").unwrap() < svg.find(">On top<").unwrap());
}

#[test]
fn elbow_connectors_route_orthogonally() {
    let svg = svg_of(&[
        json!({"type": "rect", "x": 0, "y": 0, "w": 100, "h": 50}),
        json!({"type": "rect", "x": 300, "y": 200, "w": 100, "h": 50}),
        json!({"type": "arrow", "pts": [[0, 0], [1, 1]], "route": "elbow",
               "start": {"shapeId": "s0", "anchor": "right"}, "end": {"shapeId": "s1", "anchor": "left"}}),
    ]);
    assert!(
        svg.contains(r#"d="M100 25 L200 25 L200 225 L300 225""#),
        "{svg}"
    );
}

#[test]
fn label_text_is_escaped() {
    let svg = svg_of(&[
        json!({"type": "arrow", "pts": [[0, 0], [100, 0]], "text": "a&\"\u{7}"}),
        json!({"type": "rect", "x": 0, "y": 0, "w": 300, "h": 40, "text": "<b>"}),
    ]);
    assert!(svg.contains(">a&amp;&quot;</text>"), "{svg}");
    assert!(svg.contains(">&lt;b&gt;</text>"), "{svg}");
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
    assert_eq!((pm.width(), pm.height()), (1264 * 2, 1004 * 2));
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
    assert_eq!(px(210.0, 700.0), (0xe6, 0xee, 0xfd), "blue tone fill");
    assert_eq!(px(760.0, 685.0), (0xe2, 0xf3, 0xe8), "green ellipse fill");
    assert_eq!(px(706.0, 807.0), (0xfb, 0xfb, 0xfa), "connector label pill");
    assert_eq!(px(5.0, 880.0), (0xd3, 0xf0, 0xdd), "grown sticky");
    assert_eq!(px(590.0, 930.0), (0xfb, 0xd0, 0xde), "sticky over rect");
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
