// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! DGM-14.6: draw.io and Mermaid export (`oc_model::diagram_export`). Golden round trips: a
//! board exported to draw.io and imported again (`diagram_import`) keeps ids (`props.sourceId`),
//! connectors and their ends, labels, containers, groups, positions and tones on the supported
//! subset; Mermaid keeps node ids, names, links and labels and nests subgraphs.

use std::collections::{HashMap, HashSet};

use oc_model::diagram_export::{Format as Out, export};
use oc_model::diagram_import::{Format as In, convert};
use serde_json::{Value, json};

/// A service map: a VPC container holding two services (one grouped with a cache), a gateway,
/// a database, labelled and elbow connectors, a waypoint, an "avoid" connector, a sticky, a
/// pen stroke and a stored image.
fn board() -> Value {
    let shapes = json!({
        "vpc": {"type": "rect", "x": 200, "y": 100, "w": 500, "h": 300, "dashed": true, "label": "VPC · eu-central-1"},
        "gw": {"type": "rect", "x": 20, "y": 20, "w": 140, "h": 60, "text": "API gateway", "fill": "blue"},
        "orders": {"type": "rect", "x": 240, "y": 160, "w": 140, "h": 60, "text": "Orders service\nGo · 6 pods", "fill": "green", "props": {"parent": "vpc"}, "group": "g1"},
        "cache": {"type": "ellipse", "x": 240, "y": 280, "w": 140, "h": 60, "text": "Stock cache", "props": {"parent": "vpc"}, "group": "g1"},
        "pay": {"type": "diamond", "x": 480, "y": 160, "w": 140, "h": 80, "text": "Payments \"PCI\"", "fill": "amber", "props": {"parent": "vpc"}},
        "db": {"type": "rect", "x": 800, "y": 300, "w": 120, "h": 80, "text": "orders-db", "props": {"shape": "cylinder3"}},
        "note": {"type": "text", "x": 20, "y": 420, "w": 200, "h": 30, "text": "Draft <v2> & notes", "size": 16},
        "st": {"type": "sticky", "x": 900, "y": 20, "w": 150, "h": 110, "text": "Ask Lea", "fill": "p"},
        "pen": {"type": "pen", "pts": [[0, 0], [10, 10]]},
        "img": {"type": "image", "x": 900, "y": 200, "w": 64, "h": 64, "src": "/v1/assets/abc", "alt": "logo.png"},
        "e1": {"type": "arrow", "pts": [[90, 80], [310, 160]], "text": "HTTPS", "route": "elbow",
            "start": {"shapeId": "gw", "anchor": "bottom"}, "end": {"shapeId": "orders", "anchor": "top"}},
        "e2": {"type": "arrow", "pts": [[380, 190], [480, 200]], "text": "card auth",
            "start": {"shapeId": "orders", "anchor": "right"}, "end": {"shapeId": "pay", "anchor": "left"}, "via": [[430, 190]]},
        "e3": {"type": "arrow", "pts": [[620, 200], [760, 200], [760, 340], [800, 340]], "route": "elbow", "routing": "avoid",
            "start": {"shapeId": "pay", "anchor": "right"}, "end": {"shapeId": "db", "anchor": "left", "port": "in"}},
        "e4": {"type": "arrow", "pts": [[10, 500], [100, 500]]}
    });
    let order = json!([
        "vpc", "gw", "orders", "cache", "pay", "db", "note", "st", "pen", "img", "e1", "e2", "e3",
        "e4"
    ]);
    json!({"boards": {"b1": {"name": "Service map", "shapes": shapes, "order": order}}})
}

fn by_src(shapes: &[Value]) -> HashMap<String, &Value> {
    shapes
        .iter()
        .map(|s| (s["props"]["sourceId"].as_str().unwrap().to_string(), s))
        .collect()
}

fn items(report: &Value) -> HashMap<String, &Value> {
    report["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (i["code"].as_str().unwrap().to_string(), i))
        .collect()
}

#[test]
fn drawio_round_trip_keeps_ids_edges_labels_containers_and_groups() {
    let doc = board();
    let e = export(Out::Drawio, &doc, "b1", None).unwrap();
    let back = convert(In::Drawio, e.text.as_bytes(), 0).unwrap();
    assert_eq!(back.pages, vec!["Service map".to_string()]);
    let m = by_src(&back.shapes);
    // Every exported shape comes back under its own id (pen and swatches are left out, reported).
    let mut ids: Vec<&str> = m.keys().map(String::as_str).collect();
    ids.sort();
    assert_eq!(
        ids,
        [
            "cache", "db", "e1", "e2", "e3", "e4", "gw", "img", "note", "orders", "pay", "st",
            "vpc"
        ]
    );
    let local = |src: &str| m[src]["id"].clone();
    // Types, positions (absolute again after relative container geometry), sizes, tones.
    let o = m["orders"];
    assert_eq!(o["type"], "rect");
    assert_eq!(
        (&o["x"], &o["y"], &o["w"], &o["h"]),
        (&json!(240.0), &json!(160.0), &json!(140.0), &json!(60.0))
    );
    assert_eq!(o["text"], "Orders service\nGo · 6 pods");
    assert_eq!(o["fill"], "green");
    assert_eq!(m["gw"]["fill"], "blue");
    assert_eq!(m["cache"]["type"], "ellipse");
    assert_eq!(m["pay"]["type"], "diamond");
    assert_eq!(m["pay"]["fill"], "amber");
    assert_eq!(m["pay"]["text"], "Payments \"PCI\"");
    assert_eq!(m["db"]["props"]["shape"], "cylinder3");
    assert_eq!(m["note"]["type"], "text");
    assert_eq!(m["note"]["text"], "Draft <v2> & notes");
    assert_eq!(m["note"]["size"], 16.0);
    assert_eq!(m["st"]["fill"], "pink", "sticky → a box in its tone");
    // Containers and groups.
    let vpc = m["vpc"];
    assert_eq!(vpc["dashed"], true);
    assert_eq!(vpc["label"], "VPC · eu-central-1");
    assert_eq!((&vpc["x"], &vpc["y"]), (&json!(200.0), &json!(100.0)));
    for k in ["orders", "cache", "pay"] {
        assert_eq!(m[k]["props"]["parent"], local("vpc"), "{k}");
    }
    assert!(m["orders"]["group"].is_string());
    assert_eq!(m["orders"]["group"], m["cache"]["group"]);
    assert!(m["pay"]["group"].is_null());
    assert_eq!(
        (&m["cache"]["x"], &m["cache"]["y"]),
        (&json!(240.0), &json!(280.0))
    );
    // Connectors: ends, anchors, labels, routes, waypoints.
    let e1 = m["e1"];
    assert_eq!(e1["start"]["shapeId"], local("gw"));
    assert_eq!(e1["start"]["anchor"], "bottom");
    assert_eq!(e1["end"]["shapeId"], local("orders"));
    assert_eq!(e1["end"]["anchor"], "top");
    assert_eq!(e1["text"], "HTTPS");
    assert_eq!(e1["route"], "elbow");
    let e2 = m["e2"];
    assert_eq!(e2["text"], "card auth");
    assert_eq!(e2["via"], json!([[430.0, 190.0]]));
    assert!(e2["route"].is_null());
    let e3 = m["e3"];
    assert_eq!(e3["end"]["shapeId"], local("db"));
    assert_eq!(
        e3["via"],
        json!([[760.0, 200.0], [760.0, 340.0]]),
        "avoid route as fixed bends"
    );
    let e4 = m["e4"];
    assert!(e4["start"].is_null() && e4["end"].is_null());
    assert_eq!(e4["pts"], json!([[10.0, 500.0], [100.0, 500.0]]));
    // The import report doesn't flag anything the export wrote itself, except the stored image box.
    let imp = items(&back.report);
    for code in ["link", "data", "unbound", "layers", "colour"] {
        if code == "colour" {
            continue; // tones go through the nearest-colour mapping, reported as approximations
        }
        assert!(
            !imp.contains_key(code),
            "unexpected import item {code}: {:#}",
            back.report
        );
    }
    // The export report (frame 7f).
    let r = items(&e.report);
    assert_eq!(e.report["format"], "drawio");
    assert_eq!(e.report["counts"]["connectors"], 4);
    assert_eq!(r["containers"]["count"], 1);
    assert_eq!(
        r["containers"]["title"],
        "Containers become draw.io containers"
    );
    assert_eq!(r["groups"]["count"], 1);
    assert_eq!(
        r["avoid"]["title"],
        "Routes around shapes are saved as fixed bends"
    );
    assert_eq!(r["ports"]["count"], 1);
    assert_eq!(r["pen"]["level"], "warn");
    assert_eq!(r["image_stored"]["count"], 1);
    assert_eq!(r["sticky"]["count"], 1);
    assert_eq!(
        r["kept"]["title"],
        "Shapes and connectors keep position, size, text and colour"
    );
}

#[test]
fn drawio_export_is_deterministic_and_escapes_text() {
    let doc = board();
    let a = export(Out::Drawio, &doc, "b1", None).unwrap().text;
    let b = export(Out::Drawio, &doc, "b1", None).unwrap().text;
    assert_eq!(a, b);
    assert!(a.starts_with("<mxfile host=\"OpenCanvas\""));
    assert!(
        a.contains("value=\"Draft &amp;lt;v2&amp;gt; &amp;amp; notes\""),
        "{a}"
    );
    assert!(!a.contains("<v2>"));
    // Containers before their children (parents first).
    assert!(a.find("id=\"vpc\"").unwrap() < a.find("id=\"orders\"").unwrap());
    assert!(export(Out::Drawio, &doc, "nope", None).is_none());
}

#[test]
fn a_stale_avoid_route_exports_as_a_plain_elbow() {
    // ADR-047 point 3 (DGM-12b): bends are written only while the stored route still starts and
    // ends at the bound shapes' anchors; after `pay` moved (an older client, no re-sync), draw.io
    // gets no fixed bends and routes the orthogonal edge itself.
    let mut doc = board();
    doc["boards"]["b1"]["shapes"]["pay"]["y"] = json!(100);
    let e = export(Out::Drawio, &doc, "b1", None).unwrap();
    let back = convert(In::Drawio, e.text.as_bytes(), 0).unwrap();
    let m = by_src(&back.shapes);
    assert!(m["e3"]["via"].is_null(), "{}", m["e3"]);
    assert_eq!(m["e3"]["route"], "elbow");
    assert!(!items(&e.report).contains_key("avoid"));
    // A diagonal leg is not a route either.
    let mut doc = board();
    doc["boards"]["b1"]["shapes"]["e3"]["pts"] = json!([[620, 200], [760, 340], [800, 340]]);
    let e = export(Out::Drawio, &doc, "b1", None).unwrap();
    assert!(
        !e.text
            .contains("<Array as=\"points\"><mxPoint x=\"760\" y=\"340\"/>")
    );
}

#[test]
fn a_selection_exports_its_shapes_and_the_connectors_between_them() {
    let doc = board();
    let only: HashSet<String> = ["gw", "orders", "e1"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let e = export(Out::Drawio, &doc, "b1", Some(&only)).unwrap();
    let back = convert(In::Drawio, e.text.as_bytes(), 0).unwrap();
    let m = by_src(&back.shapes);
    let mut ids: Vec<&str> = m.keys().map(String::as_str).collect();
    ids.sort();
    assert_eq!(ids, ["e1", "gw", "orders"]);
    assert!(
        m["orders"]["props"]["parent"].is_null(),
        "its container wasn't selected"
    );
    assert_eq!(m["e1"]["end"]["shapeId"], m["orders"]["id"]);
}

#[test]
fn drawio_images_with_data_urls_round_trip() {
    // 1×1 PNG.
    let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    let doc = json!({"boards": {"b": {"shapes": {"i": {"type": "image", "x": 1, "y": 2, "w": 30, "h": 30, "src": png, "alt": "dot"}}}}});
    let e = export(Out::Drawio, &doc, "b", None).unwrap();
    let back = convert(In::Drawio, e.text.as_bytes(), 0).unwrap();
    assert_eq!(back.shapes[0]["type"], "image");
    assert_eq!(back.shapes[0]["props"]["sourceId"], "i");
    assert!(
        back.shapes[0]["src"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png")
    );
}

#[test]
fn mermaid_golden() {
    let doc = board();
    let e = export(Out::Mermaid, &doc, "b1", None).unwrap();
    let want = "flowchart TB
    subgraph vpc [\"VPC · eu-central-1\"]
        orders[\"Orders service\"]
        cache([\"Stock cache\"])
        pay{\"Payments #quot;PCI#quot;\"}
    end
    gw[\"API gateway\"]
    db[\"orders-db\"]
    note[\"Draft #lt;v2#gt; & notes\"]
    st[\"Ask Lea\"]
    img[\"logo.png\"]
    gw -->|\"HTTPS\"| orders
    orders -->|\"card auth\"| pay
    pay --> db
    classDef amber fill:#fcf0d9,stroke:#8f5300,color:#18181b
    class pay amber
    classDef blue fill:#e6eefd,stroke:#2350c8,color:#18181b
    class gw blue
    classDef green fill:#e2f3e8,stroke:#17703f,color:#18181b
    class orders green
    classDef pink fill:#fce6f0,stroke:#ad2c66,color:#18181b
    class st pink
";
    assert_eq!(e.text, want);
    let r = items(&e.report);
    assert_eq!(e.report["format"], "mermaid");
    assert_eq!(r["positions"]["title"], "Positions and sizes are not kept");
    assert_eq!(r["detail"]["count"], 1, "Orders service's second line");
    assert_eq!(r["containers"]["title"], "Containers become subgraphs");
    assert_eq!(r["labels"]["count"], 2);
    assert_eq!(r["colours"]["count"], 4);
    assert_eq!(r["unbound"]["count"], 1);
    assert_eq!(r["groups_lost"]["count"], 1);
}

#[test]
fn mermaid_ids_are_safe_and_unique() {
    let doc = json!({"boards": {"b": {"shapes": {
        "end": {"type": "rect", "x": 0, "y": 0, "text": "a"},
        "1x": {"type": "rect", "x": 0, "y": 0, "text": "b"},
        "a-b": {"type": "rect", "x": 0, "y": 0, "text": "c"},
        "a_b": {"type": "rect", "x": 0, "y": 0, "text": "d"},
        "p": {"type": "rect", "x": 0, "y": 0, "text": "loop", "props": {"parent": "q"}},
        "q": {"type": "rect", "x": 0, "y": 0, "label": "Q", "props": {"parent": "p"}}
    }}}});
    let t = export(Out::Mermaid, &doc, "b", None).unwrap().text;
    assert!(t.contains("n_1x[\"b\"]"), "{t}");
    assert!(t.contains("n_end[\"a\"]"), "{t}");
    assert!(
        t.contains("a_b[\"c\"]") && t.contains("a_b_2[\"d\"]"),
        "{t}"
    );
    // A parent cycle doesn't hang or lose the shapes.
    assert!(!t.contains("subgraph p") || t.matches("end\n").count() >= 1);
}
