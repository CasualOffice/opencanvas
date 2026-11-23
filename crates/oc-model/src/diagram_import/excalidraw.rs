// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Excalidraw: JSON `{type: "excalidraw", elements, files}`, any version. Deleted elements are
//! skipped; text bound to a shape or an arrow becomes its label.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use super::{ImageRefusal, ImportError, Out, bbox, finite, html_to_text, refuse_image, safe_image, set_fill, thin, tone_of};

fn f(e: &Value, k: &str) -> f64 {
    finite(e[k].as_f64().unwrap_or(0.0))
}

fn points(e: &Value) -> Vec<[f64; 2]> {
    let (x, y) = (f(e, "x"), f(e, "y"));
    e["points"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| Some([x + finite(p.get(0)?.as_f64()?), y + finite(p.get(1)?.as_f64()?)]))
                .collect()
        })
        .unwrap_or_default()
}

const BINDABLE: &[&str] = &["rectangle", "ellipse", "diamond", "text", "image", "frame", "magicframe", "embeddable", "iframe"];

pub(super) fn convert(text: &str, out: &mut Out) -> Result<(), ImportError> {
    // serde_json refuses nesting deeper than 128, without recursing further.
    let v: Value = serde_json::from_str(text)
        .map_err(|_| ImportError::new("unreadable", "It isn't readable JSON. Save it again from Excalidraw."))?;
    let ty = v["type"].as_str().unwrap_or("");
    if !ty.starts_with("excalidraw") || ty == "excalidrawlib" {
        return Err(ImportError::new("not_diagram", "It isn't an Excalidraw drawing."));
    }
    let empty = vec![];
    let elements: Vec<&Value> = v["elements"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|e| e.is_object() && e["isDeleted"] != true && e["id"].is_string())
        .collect();
    let by_id: HashMap<&str, &Value> = elements.iter().map(|e| (e["id"].as_str().unwrap_or(""), *e)).collect();
    // Bound text → label of its container.
    let mut labels: HashMap<&str, (String, Option<f64>)> = HashMap::new();
    let mut bound_text: HashSet<&str> = HashSet::new();
    for e in elements.iter().filter(|e| e["type"] == "text") {
        if let Some(c) = e["containerId"].as_str().filter(|c| by_id.contains_key(c)) {
            let t = html_to_text(e["text"].as_str().or(e["originalText"].as_str()).unwrap_or("")).0;
            labels.insert(c, (t, e["fontSize"].as_f64()));
            bound_text.insert(e["id"].as_str().unwrap_or(""));
            style_notes(e, out);
        }
    }
    // Frames paint below everything (Excalidraw draws them first too).
    let (frames, rest): (Vec<&Value>, Vec<&Value>) =
        elements.into_iter().partition(|e| matches!(e["type"].as_str(), Some("frame" | "magicframe")));
    let ordered: Vec<&Value> = frames
        .into_iter()
        .chain(rest.into_iter().filter(|e| !bound_text.contains(e["id"].as_str().unwrap_or(""))))
        .collect();
    let local: HashMap<&str, String> = ordered
        .iter()
        .enumerate()
        .map(|(i, e)| (e["id"].as_str().unwrap_or(""), format!("s{}", i + 1)))
        .collect();
    let frame_ids: HashSet<&str> = ordered
        .iter()
        .filter(|e| matches!(e["type"].as_str(), Some("frame" | "magicframe")))
        .map(|e| e["id"].as_str().unwrap_or(""))
        .collect();
    let files = &v["files"];
    for e in ordered {
        let id = e["id"].as_str().unwrap_or("");
        let kind = e["type"].as_str().unwrap_or("");
        let mut props = json!({"source": "excalidraw", "sourceId": id});
        if let Some(fr) = e["frameId"].as_str().filter(|fr| frame_ids.contains(fr)) {
            props["parent"] = json!(local[fr]);
        }
        let (x, y) = (f(e, "x"), f(e, "y"));
        let (w, h) = (f(e, "width").abs(), f(e, "height").abs());
        let mut s = json!({"id": local[id], "x": x, "y": y, "w": w, "h": h});
        let label = labels.get(id).cloned();
        match kind {
            "rectangle" | "ellipse" | "diamond" => {
                s["type"] = json!(match kind {
                    "rectangle" => "rect",
                    k => k,
                });
                if let Some((t, size)) = &label {
                    s["text"] = json!(t);
                    if let Some(sz) = size {
                        s["size"] = json!(finite(*sz));
                    }
                }
                shape_fill(e, &mut s, out);
            }
            "text" => {
                s["type"] = json!("text");
                s["text"] = json!(html_to_text(e["text"].as_str().or(e["originalText"].as_str()).unwrap_or("")).0);
                s["size"] = json!(e["fontSize"].as_f64().map_or(20.0, finite));
            }
            "frame" | "magicframe" => {
                out.note("containers", None);
                s["type"] = json!("rect");
                s["dashed"] = json!(true);
                s["label"] = json!(e["name"].as_str().map(|n| html_to_text(n).0).filter(|n| !n.is_empty()).unwrap_or_else(|| "Frame".into()));
            }
            "image" => {
                let file = e["fileId"].as_str().map(|f| &files[f]);
                let name = format!("Image {id}");
                let res = match file {
                    Some(fl) if fl.is_object() => {
                        if fl["mimeType"].as_str().is_some_and(|m| m.contains("svg")) {
                            Err(ImageRefusal::Svg)
                        } else {
                            safe_image(fl["dataURL"].as_str().unwrap_or(""))
                        }
                    }
                    _ => Err(ImageRefusal::Type),
                };
                match res {
                    Ok(url) => {
                        out.note("images", None);
                        s["type"] = json!("image");
                        s["src"] = json!(url);
                        s["alt"] = json!("Image");
                    }
                    Err(ImageRefusal::Link) => refuse_image(out, &mut s, ImageRefusal::Type, &name),
                    Err(why) => refuse_image(out, &mut s, why, &name),
                }
            }
            "arrow" | "line" => {
                let pts = points(e);
                let bound = |k: &str| e[k]["elementId"].as_str().filter(|b| {
                    local.contains_key(b) && by_id.get(b).is_some_and(|t| BINDABLE.contains(&t["type"].as_str().unwrap_or("")))
                });
                let (sb, eb) = (bound("startBinding"), bound("endBinding"));
                if kind == "line" && sb.is_none() && eb.is_none() {
                    out.note("lines", None);
                    pen(e, &mut s, pts, out, id);
                } else {
                    s["type"] = json!("arrow");
                    if let Some(b) = sb {
                        s["start"] = json!({"shapeId": local[b], "anchor": "center"});
                    }
                    if let Some(b) = eb {
                        s["end"] = json!({"shapeId": local[b], "anchor": "center"});
                    }
                    if pts.len() > 2 {
                        s["via"] = json!(pts[1..pts.len() - 1]);
                    }
                    if e["elbowed"] == true {
                        out.note("elbow", None);
                        s["route"] = json!("elbow");
                    }
                    if let Some((t, _)) = &label {
                        s["text"] = json!(t);
                    }
                    let start_head = !e["startArrowhead"].is_null();
                    let end_head = e["endArrowhead"].as_str();
                    if kind == "line" || start_head || !matches!(end_head, Some("arrow" | "triangle")) {
                        out.note("arrowheads", None);
                    }
                    let (bx, by, bw, bh) = bbox(&pts);
                    let pts = if pts.len() >= 2 { pts } else { vec![[x, y], [x, y]] };
                    s["pts"] = json!(pts);
                    s["x"] = json!(bx);
                    s["y"] = json!(by);
                    s["w"] = json!(bw);
                    s["h"] = json!(bh);
                    // Connectors have one colour on a board.
                    let stroke = e["strokeColor"].as_str().unwrap_or("");
                    if tone_of(stroke).is_some() {
                        out.note("colour", Some(format!("{} → connector colour", stroke.to_ascii_lowercase())));
                    }
                }
            }
            "freedraw" => {
                pen(e, &mut s, points(e), out, id);
            }
            "embeddable" | "iframe" => {
                out.note("embed", Some(id.to_string()));
                s["type"] = json!("rect");
                s["text"] = json!("Web embed");
            }
            other => {
                out.note("shape_box", Some(other.to_string()));
                s["type"] = json!("rect");
                if let Some((t, _)) = &label {
                    s["text"] = json!(t);
                }
            }
        }
        if let Some(g) = e["groupIds"].as_array().and_then(|a| a.last()).and_then(Value::as_str) {
            s["group"] = json!(g);
            out.note("groups", None);
            if e["groupIds"].as_array().is_some_and(|a| a.len() > 1) {
                out.note("nested_groups", None);
            }
        }
        style_notes(e, out);
        if e["strokeStyle"].as_str().is_some_and(|st| st != "solid") {
            if s["type"] == "rect" && s["fill"].is_null() && s["dashed"].is_null() {
                s["dashed"] = json!(true);
            } else if s["dashed"].is_null() {
                out.note("dashed", None);
            }
        }
        s["props"] = props;
        out.push(s);
    }
    Ok(())
}

/// Background colour, or the stroke colour when there is no background.
fn shape_fill(e: &Value, s: &mut Value, out: &mut Out) {
    let bg = e["backgroundColor"].as_str().unwrap_or("transparent");
    if tone_of(bg).is_some() {
        set_fill(out, s, bg);
        if matches!(e["fillStyle"].as_str(), Some("hachure" | "cross-hatch" | "zigzag")) {
            out.note("fill_style", None);
        }
    } else if let Some(stroke) = e["strokeColor"].as_str() {
        set_fill(out, s, stroke);
    }
}

fn pen(e: &Value, s: &mut Value, pts: Vec<[f64; 2]>, out: &mut Out, id: &str) {
    let pts = thin(pts, out, id);
    let (x, y, w, h) = bbox(&pts);
    s["type"] = json!("pen");
    s["pts"] = json!(pts);
    s["x"] = json!(x);
    s["y"] = json!(y);
    s["w"] = json!(w);
    s["h"] = json!(h);
    let stroke = e["strokeColor"].as_str().unwrap_or("");
    if tone_of(stroke).is_some() {
        s["stroke"] = json!("accent");
        out.note("colour", Some(format!("{} → Accent", stroke.to_ascii_lowercase())));
    }
}

fn style_notes(e: &Value, out: &mut Out) {
    let name = || Some(e["id"].as_str().unwrap_or("").to_string());
    if e["roughness"].as_f64().is_some_and(|r| r > 0.0) {
        out.note("rough", None);
    }
    if e["strokeWidth"].as_f64().is_some_and(|w| w > 2.0) {
        out.note("stroke_width", None);
    }
    if e["opacity"].as_f64().is_some_and(|o| o < 100.0) {
        out.note("opacity", None);
    }
    if e["angle"].as_f64().is_some_and(|a| a.abs() > 1e-6) {
        out.note("rotation", name());
    }
    if e["link"].as_str().is_some_and(|l| !l.trim().is_empty()) {
        out.note("link", name());
    }
    if e["type"] == "text" && e["fontFamily"].as_f64().is_some_and(|f| f != 2.0) {
        out.note("font", None);
    }
}
