// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! DGM-15: draw.io and Excalidraw import (`oc_model::diagram_import`). Golden checks on the
//! supported subset (ids, edges, labels, grouping, styles), the dry-run report, and hostile files.

use base64::Engine;
use oc_model::diagram_import::{Converted, Format, convert};
use serde_json::{Value, json};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/import/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn drawio(name: &str, page: usize) -> Converted {
    convert(Format::Drawio, &fixture(name), page).unwrap()
}

/// The shape converted from source id `src`.
fn by_src<'a>(c: &'a Converted, src: &str) -> &'a Value {
    c.shapes
        .iter()
        .find(|s| s["props"]["sourceId"] == src)
        .unwrap_or_else(|| panic!("no shape from {src}: {:#?}", c.shapes))
}

fn item<'a>(c: &'a Converted, code: &str) -> &'a Value {
    c.report["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["code"] == code)
        .unwrap_or_else(|| panic!("no report item {code}: {:#}", c.report))
}

fn has_item(c: &Converted, code: &str) -> bool {
    c.report["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["code"] == code)
}

fn all_text(c: &Converted) -> String {
    serde_json::to_string(&c.shapes).unwrap()
}

#[test]
fn drawio_flowchart_maps_shapes_edges_labels_and_styles() {
    let c = drawio("flowchart.drawio", 0);
    assert_eq!(c.pages, vec!["Checkout flow".to_string()]);
    let start = by_src(&c, "start");
    assert_eq!(start["type"], "ellipse");
    assert_eq!(start["fill"], "green");
    assert_eq!(
        (&start["x"], &start["y"], &start["w"], &start["h"]),
        (&json!(120.0), &json!(40.0), &json!(120.0), &json!(60.0))
    );
    let cart = by_src(&c, "cart");
    assert_eq!(cart["type"], "rect");
    assert_eq!(cart["fill"], "blue");
    // HTML label → plain text; the XML-escaped `&amp;amp;` is one `&` once decoded twice.
    assert_eq!(cart["text"], "Load cart\nfrom & session");
    assert_eq!(by_src(&c, "stock")["type"], "diamond");
    assert_eq!(by_src(&c, "stock")["fill"], "amber");
    assert_eq!(by_src(&c, "reserve")["fill"], Value::Null);
    let note = by_src(&c, "note");
    assert_eq!(note["type"], "text");
    assert_eq!(note["size"], 16.0);
    // Edges: ids of the bound shapes, labels, elbow routes and waypoints.
    let id = |src: &str| by_src(&c, src)["id"].clone();
    let e1 = by_src(&c, "e1");
    assert_eq!(e1["type"], "arrow");
    assert_eq!(e1["route"], "elbow");
    assert_eq!(e1["start"]["shapeId"], id("start"));
    assert_eq!(e1["end"]["shapeId"], id("cart"));
    let e3 = by_src(&c, "e3");
    assert_eq!(e3["text"], "yes");
    assert_eq!(e3["start"]["anchor"], "bottom");
    let e4 = by_src(&c, "e4");
    assert_eq!(e4["text"], "no", "the edge label child becomes the label");
    assert_eq!(e4["via"], json!([[290.0, 320.0]]));
    assert_eq!(e4["start"]["anchor"], "right");
    assert_eq!(e4["end"]["anchor"], "left");
    let e5 = by_src(&c, "e5");
    assert_eq!(e5["route"], "elbow");
    assert_eq!(e5["text"], "retry");
    let loose = by_src(&c, "loose");
    assert!(loose["start"].is_null());
    assert_eq!(loose["pts"], json!([[560.0, 200.0], [660.0, 200.0]]));
    // Every shape id is unique and every binding points at a converted shape.
    let ids: Vec<&Value> = c.shapes.iter().map(|s| &s["id"]).collect();
    let uniq: std::collections::HashSet<String> = ids.iter().map(|v| v.to_string()).collect();
    assert_eq!(uniq.len(), ids.len());
    for s in &c.shapes {
        for end in ["start", "end"] {
            if let Some(b) = s[end]["shapeId"].as_str() {
                assert!(c.shapes.iter().any(|t| t["id"] == b), "{b}");
            }
        }
    }
    assert_eq!(c.report["counts"]["shapes"], 6);
    assert_eq!(c.report["counts"]["connectors"], 6);
    assert_eq!(item(&c, "curved")["count"], 1);
    assert_eq!(item(&c, "elbow")["count"], 4);
    // Colours that aren't a board colour are named, with what they became.
    let colour = item(&c, "colour");
    assert!(
        colour["detail"]
            .as_str()
            .unwrap()
            .contains("#d5e8d4 → Green"),
        "{colour}"
    );
    // The dashed red box keeps its fill; the dash is reported.
    assert!(has_item(&c, "dashed"));
    assert!(
        has_item(&c, "text_style"),
        "bold in an HTML label is reported"
    );
}

#[test]
fn drawio_vendor_stencils_become_named_boxes_and_groups_become_containers() {
    let c = drawio("architecture.drawio", 0);
    let fraud = by_src(&c, "fraud");
    assert_eq!(fraud["type"], "rect");
    assert_eq!(fraud["text"], "fraud-check");
    assert_eq!(fraud["props"]["stencil"], "mxgraph.aws4.lambda");
    // Absolute position: vpc (200, 40) + grp (40, 60) + (0, 0); size kept.
    assert_eq!((&fraud["x"], &fraud["y"]), (&json!(240.0), &json!(100.0)));
    assert_eq!((&fraud["w"], &fraud["h"]), (&json!(78.0), &json!(78.0)));
    let users = by_src(&c, "users");
    assert_eq!(users["text"], "Customers", "UserObject label");
    assert_eq!(users["props"]["stencil"], "mxgraph.azure.user");
    let st = item(&c, "stencil");
    assert_eq!(st["level"], "warn");
    assert_eq!(st["count"], 3);
    let detail = st["detail"].as_str().unwrap();
    assert!(detail.contains("Lambda: fraud-check"), "{detail}");
    assert!(
        detail.contains("They keep size and connections."),
        "{detail}"
    );
    // Connections to stencils are kept.
    let a1 = by_src(&c, "a1");
    assert_eq!(a1["end"]["shapeId"], fraud["id"]);
    assert_eq!(a1["text"], "HTTPS");
    // Containers: the VPC group and the plain group, with their children pointing at them.
    let vpc = by_src(&c, "vpc");
    assert_eq!(vpc["type"], "rect");
    assert_eq!(vpc["dashed"], true);
    assert_eq!(vpc["label"], "VPC · eu-central-1");
    let grp = by_src(&c, "grp");
    assert_eq!(grp["dashed"], true);
    assert_eq!(fraud["props"]["parent"], grp["id"]);
    assert_eq!(grp["props"]["parent"], vpc["id"]);
    assert_eq!(by_src(&c, "db")["props"]["parent"], vpc["id"]);
    assert_eq!(item(&c, "containers")["count"], 2);
    // Containers paint below their children.
    let pos = |src: &str| {
        c.shapes
            .iter()
            .position(|s| s["props"]["sourceId"] == src)
            .unwrap()
    };
    assert!(pos("vpc") < pos("grp") && pos("grp") < pos("fraud"));
    // Cylinder: no board equivalent, a box with its name.
    let db = by_src(&c, "db");
    assert_eq!(
        (db["type"].as_str(), db["text"].as_str()),
        (Some("rect"), Some("orders-db"))
    );
    assert!(
        item(&c, "shape_box")["detail"]
            .as_str()
            .unwrap()
            .contains("orders-db")
    );
    // The embedded PNG is an image; the linked one is never fetched and is reported.
    let logo = by_src(&c, "logo");
    assert_eq!(logo["type"], "image");
    assert!(
        logo["src"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,iVBOR")
    );
    assert_eq!(item(&c, "image_link")["count"], 1);
    assert!(!all_text(&c).contains("example.com"));
    // The javascript: link is not imported, and the report says so.
    assert_eq!(item(&c, "link")["count"], 1);
    assert!(!all_text(&c).contains("javascript"));
    // Most important first: warnings before notes before what's fine.
    let levels: Vec<&str> = c.report["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["level"].as_str().unwrap())
        .collect();
    let rank = |l: &str| {
        ["bad", "warn", "gray", "ok"]
            .iter()
            .position(|x| *x == l)
            .unwrap()
    };
    assert!(
        levels.windows(2).all(|w| rank(w[0]) <= rank(w[1])),
        "{levels:?}"
    );
    assert_eq!(
        c.report["counts"]["needLook"],
        json!(st["count"].as_u64().unwrap() + 3)
    );
}

#[test]
fn compressed_and_bare_drawio_files_decode() {
    let c = drawio("compressed.drawio", 0);
    let z1 = by_src(&c, "z1");
    assert_eq!(z1["text"], "Compressed & fine");
    assert_eq!(z1["fill"], "purple");
    assert_eq!(by_src(&c, "z3")["end"]["shapeId"], by_src(&c, "z2")["id"]);
    let c = drawio("plain.xml", 0);
    assert_eq!(by_src(&c, "x")["text"], "Bare model");
}

#[test]
fn multi_page_files_import_one_page_and_report_the_others() {
    let c = drawio("multipage.drawio", 0);
    assert_eq!(
        c.pages,
        vec!["Production".to_string(), "Sequence".to_string()]
    );
    assert_eq!(c.shapes.len(), 1);
    assert!(
        item(&c, "page_other")["title"]
            .as_str()
            .unwrap()
            .contains("Sequence")
    );
    let c = drawio("multipage.drawio", 1);
    assert_eq!(c.page, 1);
    assert_eq!(c.report["counts"]["shapes"], 2);
    assert_eq!(c.report["counts"]["connectors"], 1);
    assert!(
        item(&c, "page_other")["title"]
            .as_str()
            .unwrap()
            .contains("Production")
    );
    assert!(convert(Format::Drawio, &fixture("multipage.drawio"), 2).is_err());
}

#[test]
fn excalidraw_elements_map_to_board_shapes() {
    let c = convert(Format::Excalidraw, &fixture("board.excalidraw"), 0).unwrap();
    let r1 = by_src(&c, "r1");
    assert_eq!(r1["type"], "rect");
    assert_eq!(
        r1["text"], "Plan sprint",
        "bound text becomes the shape label"
    );
    assert_eq!(r1["fill"], "blue");
    assert_eq!(r1["group"], "g1");
    assert!(
        !c.shapes.iter().any(|s| s["props"]["sourceId"] == "t1"),
        "bound text is not a shape of its own"
    );
    let e1 = by_src(&c, "e1");
    assert_eq!(e1["type"], "ellipse");
    assert_eq!(
        e1["fill"], "green",
        "stroke colour when there's no background"
    );
    let d1 = by_src(&c, "d1");
    assert_eq!(d1["type"], "diamond");
    assert_eq!(d1["group"], "g1", "the outermost group");
    let a1 = by_src(&c, "a1");
    assert_eq!(a1["type"], "arrow");
    assert_eq!(a1["start"]["shapeId"], r1["id"]);
    assert_eq!(a1["end"]["shapeId"], e1["id"]);
    assert_eq!(a1["text"], "then");
    assert_eq!(a1["via"], json!([[250.0, 120.0]]));
    assert_eq!(a1["pts"][0], json!([200.0, 100.0]));
    let t3 = by_src(&c, "t3");
    assert_eq!(t3["type"], "text");
    assert_eq!(t3["text"], "Free text note");
    assert_eq!(t3["size"], 28.0);
    let l1 = by_src(&c, "l1");
    assert_eq!(l1["type"], "pen");
    assert_eq!(l1["pts"], json!([[40.0, 360.0], [160.0, 360.0]]));
    let p1 = by_src(&c, "p1");
    assert_eq!(p1["type"], "pen");
    assert_eq!(p1["pts"][3], json!([520.0, 290.0]));
    let img = by_src(&c, "img1");
    assert_eq!(img["type"], "image");
    assert!(
        img["src"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,")
    );
    let frame = by_src(&c, "frame1");
    assert_eq!(
        (frame["type"].as_str(), frame["label"].as_str()),
        (Some("rect"), Some("Sprint board"))
    );
    assert_eq!(frame["dashed"], true);
    assert_eq!(r1["props"]["parent"], frame["id"]);
    // Deleted elements are skipped; the SVG image is left out and reported.
    assert!(!c.shapes.iter().any(|s| s["props"]["sourceId"] == "gone"));
    assert_eq!(
        by_src(&c, "img2")["type"],
        "rect",
        "a box keeps the left-out image's place"
    );
    assert!(by_src(&c, "img2")["src"].is_null());
    assert!(!all_text(&c).contains("svg+xml"));
    assert_eq!(item(&c, "image_svg")["count"], 1);
    assert_eq!(item(&c, "image_svg")["level"], "warn");
    for code in [
        "rough",
        "font",
        "fill_style",
        "stroke_width",
        "rotation",
        "opacity",
        "link",
        "nested_groups",
        "colour",
        "dashed",
        "containers",
    ] {
        assert!(has_item(&c, code), "{code}: {:#}", c.report);
    }
    assert!(!all_text(&c).contains("javascript"));
    assert_eq!(c.report["counts"]["images"], 1);
}

// ---------- hostile files ----------

fn refused(format: Format, bytes: &[u8]) -> String {
    match convert(format, bytes, 0) {
        Ok(c) => panic!("accepted: {:#}", c.report),
        Err(e) => {
            assert!(!e.message.is_empty());
            e.code.to_string()
        }
    }
}

#[test]
fn billion_laughs_and_external_entities_are_refused() {
    let laughs = r#"<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
<!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
<!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
<!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
<!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
<!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
<!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">]>
<mxfile><diagram name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="&lol9;" vertex="1" parent="1"><mxGeometry width="10" height="10" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>"#;
    let t = std::time::Instant::now();
    assert_eq!(refused(Format::Drawio, laughs.as_bytes()), "unreadable");
    // Generous bound (slow CI runners): expansion would take far longer, or run out of memory.
    assert!(t.elapsed().as_secs() < 60);
    let xxe = r#"<?xml version="1.0"?><!DOCTYPE m [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="&x;" vertex="1" parent="1"><mxGeometry width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>"#;
    assert_eq!(refused(Format::Drawio, xxe.as_bytes()), "unreadable");
}

#[test]
fn deep_nesting_is_refused_without_overflowing_the_stack() {
    let n = 50_000;
    let xml = format!("<mxfile>{}{}</mxfile>", "<a>".repeat(n), "</a>".repeat(n));
    assert_eq!(refused(Format::Drawio, xml.as_bytes()), "too_deep");
    let json = format!(
        r#"{{"type":"excalidraw","elements":[{}{}]}}"#,
        "[".repeat(n),
        "]".repeat(n)
    );
    assert_eq!(refused(Format::Excalidraw, json.as_bytes()), "unreadable");
    // A cycle in draw.io parents does not loop.
    let cyc = r#"<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="A" vertex="1" parent="b"><mxGeometry width="10" height="10" as="geometry"/></mxCell>
<mxCell id="b" value="B" vertex="1" parent="a"><mxGeometry width="10" height="10" as="geometry"/></mxCell>
</root></mxGraphModel>"#;
    let _ = convert(Format::Drawio, cyc.as_bytes(), 0);
}

#[test]
fn decompression_bombs_and_node_floods_are_refused() {
    use std::io::Write;
    // 64 MB of the same character deflates to ~64 KB.
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(&vec![b'a'; 64 << 20]).unwrap();
    let raw = enc.finish().unwrap();
    let b64 = base64::engine::general_purpose::STANDARD.encode(raw);
    let file = format!(r#"<mxfile><diagram name="bomb">{b64}</diagram></mxfile>"#);
    assert!(file.len() < 5 << 20);
    assert_eq!(refused(Format::Drawio, file.as_bytes()), "too_large");
    let cells: String = (0..300_000).map(|i| format!("<c i=\"{i}\"/>")).collect();
    let flood = format!("<mxGraphModel><root>{cells}</root></mxGraphModel>");
    assert_eq!(refused(Format::Drawio, flood.as_bytes()), "too_large");
    // Damaged compressed data says so instead of importing nothing.
    let bad = r#"<mxfile><diagram name="x">bm90IGRlZmxhdGU=</diagram></mxfile>"#;
    assert_eq!(refused(Format::Drawio, bad.as_bytes()), "unreadable");
    assert_eq!(refused(Format::Drawio, b"hello"), "unreadable");
    assert_eq!(
        refused(Format::Excalidraw, br#"{"type":"tldraw"}"#),
        "not_diagram"
    );
}

#[test]
fn labels_are_plain_text_and_scripts_links_and_svg_are_removed() {
    let label = "&lt;a href=&quot;javascript:alert(1)&quot;&gt;Pay&lt;/a&gt;&lt;script&gt;alert(2)&lt;/script&gt;&lt;svg onload=&quot;alert(3)&quot;&gt;&lt;text&gt;x&lt;/text&gt;&lt;/svg&gt;&lt;style&gt;p{}&lt;/style&gt; now&amp;nbsp;&amp;#169;";
    let xml = format!(
        r#"<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="{label}" style="html=1;" vertex="1" parent="1"><mxGeometry width="100" height="40" as="geometry"/></mxCell>
<mxCell id="i" style="shape=image;image=data:image/svg+xml,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+;" vertex="1" parent="1"><mxGeometry x="200" width="40" height="40" as="geometry"/></mxCell>
<mxCell id="j" style="shape=image;image=javascript:alert(1);" vertex="1" parent="1"><mxGeometry x="300" width="40" height="40" as="geometry"/></mxCell>
</root></mxGraphModel>"#
    );
    let c = convert(Format::Drawio, xml.as_bytes(), 0).unwrap();
    assert_eq!(by_src(&c, "a")["text"], "Pay now\u{a0}©");
    let s = all_text(&c);
    for bad in ["javascript", "alert", "<", "svg", "onload"] {
        assert!(!s.contains(bad), "{bad} in {s}");
    }
    assert_eq!(item(&c, "image_svg")["count"], 1);
    assert_eq!(item(&c, "image_link")["count"], 1);
    // Left-out images keep their place as a box, so connections and layout stay.
    assert_eq!(by_src(&c, "i")["type"], "rect");
}

#[test]
fn image_data_urls_are_checked_for_type_and_size() {
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    let huge = base64::engine::general_purpose::STANDARD.encode(vec![0x89u8; 3 << 20]);
    let fake = base64::engine::general_purpose::STANDARD.encode(b"<svg onload=alert(1)>");
    let file = json!({"type": "excalidraw", "elements": [
        {"id": "ok", "type": "image", "x": 0, "y": 0, "width": 10, "height": 10, "fileId": "a"},
        {"id": "big", "type": "image", "x": 20, "y": 0, "width": 10, "height": 10, "fileId": "b"},
        {"id": "liar", "type": "image", "x": 40, "y": 0, "width": 10, "height": 10, "fileId": "c"},
        {"id": "gone", "type": "image", "x": 60, "y": 0, "width": 10, "height": 10, "fileId": "missing"}
    ], "files": {
        "a": {"mimeType": "image/png", "dataURL": format!("data:image/png;base64,{png}")},
        "b": {"mimeType": "image/png", "dataURL": format!("data:image/png;base64,{huge}")},
        "c": {"mimeType": "image/png", "dataURL": format!("data:image/png;base64,{fake}")}
    }});
    let c = convert(Format::Excalidraw, file.to_string().as_bytes(), 0).unwrap();
    assert_eq!(by_src(&c, "ok")["type"], "image");
    assert_eq!(by_src(&c, "big")["type"], "rect");
    assert_eq!(by_src(&c, "liar")["type"], "rect");
    assert_eq!(by_src(&c, "gone")["type"], "rect");
    assert_eq!(item(&c, "image_large")["count"], 1);
    assert_eq!(item(&c, "image_type")["count"], 2);
    assert!(!all_text(&c).contains(&huge[..100]));
}
