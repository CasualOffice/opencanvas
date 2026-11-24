// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! DGM-17 Add your own icon: the server-side cleaner (`oc_model::icon_clean`). Every case an
//! uploaded logo could use to run code, fetch something or exhaust the server.

use oc_model::icon_clean::{Format, clean};

fn svg(body: &str) -> Vec<u8> {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" width="24" height="24">{body}</svg>"#).into_bytes()
}

fn removed(r: &oc_model::icon_clean::Cleaned, what: &str) -> usize {
    r.removed
        .iter()
        .find(|x| x.what == what)
        .map_or(0, |x| x.count)
}

fn out(r: &oc_model::icon_clean::Cleaned) -> String {
    String::from_utf8(r.data.clone()).unwrap()
}

#[test]
fn a_plain_logo_is_kept_and_nothing_is_reported() {
    let r = clean(&svg(r##"<circle cx="12" cy="12" r="10" fill="#2a5ad7"/>"##)).unwrap();
    assert_eq!(r.format, Format::Svg);
    assert!(r.removed.is_empty(), "{:?}", r.removed);
    assert!(out(&r).contains("<path"));
}

#[test]
fn scripts_are_removed_and_named() {
    let r = clean(&svg(r#"<script>alert(1)</script><script href="https://x.example/a.js"/><rect width="10" height="10"/>"#)).unwrap();
    assert_eq!(removed(&r, "Scripts"), 2);
    let o = out(&r);
    assert!(!o.contains("script") && !o.contains("alert"));
}

#[test]
fn event_handlers_are_removed() {
    let r = clean(&svg(r#"<rect width="10" height="10" onclick="alert(1)" onmouseover="x()"/><g onload="y()"><path d="M0 0H5V5Z"/></g>"#)).unwrap();
    assert_eq!(removed(&r, "Event handlers"), 3);
    assert!(!out(&r).to_lowercase().contains(" on"));
}

#[test]
fn foreign_object_is_removed() {
    let r = clean(&svg(r#"<foreignObject width="24" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"></iframe></div></foreignObject><rect width="4" height="4"/>"#)).unwrap();
    assert_eq!(removed(&r, "Embedded HTML"), 1);
    let o = out(&r);
    assert!(!o.contains("foreignObject") && !o.contains("iframe") && !o.contains("evil"));
}

#[test]
fn external_references_are_removed() {
    let r = clean(&svg(r##"<image href="https://evil.example/t.png" width="4" height="4"/><image xlink:href="file:///etc/passwd" width="4" height="4"/><use href="https://evil.example/s.svg#a"/><rect width="4" height="4" style="fill:url(https://evil.example/f)"/><style>@import url(https://evil.example/c.css);</style><a href="javascript:alert(1)"><rect width="2" height="2"/></a>"##)).unwrap();
    assert!(removed(&r, "External links") >= 4, "{:?}", r.removed);
    let o = out(&r);
    assert!(!o.contains("evil") && !o.contains("passwd") && !o.contains("javascript"));
}

#[test]
fn billion_laughs_and_any_dtd_are_refused() {
    let bomb = br#"<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&lol3;</text></svg>"#;
    assert_eq!(clean(bomb).unwrap_err().code, "dtd");
}

#[test]
fn oversize_input_too_many_elements_and_too_deep_are_refused() {
    let big = svg(&format!("<!-- {} -->", "x".repeat(300 * 1024)));
    assert_eq!(clean(&big).unwrap_err().code, "too_large");
    let many = svg(&"<rect width=\"1\" height=\"1\"/>".repeat(2100));
    assert_eq!(clean(&many).unwrap_err().code, "too_many_elements");
    let deep = svg(&format!(
        "{}<rect width=\"1\" height=\"1\"/>{}",
        "<g>".repeat(20),
        "</g>".repeat(20)
    ));
    assert_eq!(clean(&deep).unwrap_err().code, "too_deep");
}

#[test]
fn a_cleaned_svg_over_64_kb_is_refused() {
    // Under 256 KB in, but over 64 KB of drawing once normalised.
    let paths: String = (0..1500)
        .map(|i| format!("<path d=\"M{i} 0L{i}.5 10L{i} 20Z\" fill=\"#123456\"/>"))
        .collect();
    assert_eq!(clean(&svg(&paths)).unwrap_err().code, "cleaned_too_large");
}

#[test]
fn a_fake_png_is_refused_and_a_real_one_is_kept() {
    let mut fake = b"\x89PNG\r\n\x1a\n".to_vec();
    fake.extend_from_slice(b"<svg onload=alert(1)>");
    assert_eq!(clean(&fake).unwrap_err().code, "invalid_png");
    assert_eq!(clean(b"GIF89a....").unwrap_err().code, "unsupported");
    let mut px = resvg::tiny_skia::Pixmap::new(8, 8).unwrap();
    px.fill(resvg::tiny_skia::Color::from_rgba8(42, 90, 215, 255));
    let png = px.encode_png().unwrap();
    let r = clean(&png).unwrap();
    assert_eq!(r.format, Format::Png);
    assert_eq!((r.width, r.height), (8, 8));
    assert!(r.data.starts_with(b"\x89PNG"));
}

#[test]
fn a_png_over_1024_px_is_refused() {
    let px = resvg::tiny_skia::Pixmap::new(1100, 10).unwrap();
    assert_eq!(
        clean(&px.encode_png().unwrap()).unwrap_err().code,
        "png_too_large"
    );
}

#[test]
fn the_output_passes_the_allow_list() {
    let r = clean(&svg(r##"<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)"/><text x="2" y="20" font-size="10">Hi</text><metadata>x</metadata><title>Logo</title>"##)).unwrap();
    assert!(oc_model::icon_clean::allowed(&out(&r)));
    assert!(!oc_model::icon_clean::allowed(
        r#"<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>"#
    ));
    assert!(!oc_model::icon_clean::allowed(
        r#"<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x.example/a.png"/></svg>"#
    ));
}

/// SEC-50: usvg expands each `<use>` into a copy of its target. Six levels of ten uses each is
/// about 70 elements in the file but millions of nodes once expanded. Such a file is refused
/// before usvg sees it, and quickly.
#[test]
fn use_chains_that_expand_past_the_element_limit_are_refused() {
    let mut body = String::from(r##"<defs><path id="l0" d="M0 0L1 1"/>"##);
    for level in 1..=6 {
        body.push_str(&format!("<g id=\"l{level}\">"));
        for _ in 0..10 {
            body.push_str(&format!("<use href=\"#l{}\"/>", level - 1));
        }
        body.push_str("</g>");
    }
    body.push_str(r##"</defs><use href="#l6"/><use xlink:href="#l6"/>"##);
    let t = std::time::Instant::now();
    let r = clean(&svg(&body));
    let took = t.elapsed();
    assert_eq!(r.unwrap_err().code, "too_many_elements");
    assert!(took.as_millis() < 500, "took {took:?}");
    // Uses that refer to each other through groups are refused, not followed forever.
    let cycle = svg(r##"<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>"##);
    assert!(clean(&cycle).is_err());
    // A few plain uses are still fine.
    let ok = svg(
        r##"<defs><circle id="c" cx="4" cy="4" r="3"/></defs><use href="#c"/><use href="#c" x="10"/>"##,
    );
    assert!(clean(&ok).is_ok());
}
