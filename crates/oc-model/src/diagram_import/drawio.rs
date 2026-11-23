// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! draw.io / diagrams.net: `mxfile` → `diagram` → `mxGraphModel` (inline or compressed: base64,
//! raw deflate, URL-encoding), or a bare `mxGraphModel`. One page per import.

use std::collections::{HashMap, HashSet};
use std::io::Read;

use base64::Engine;
use serde_json::json;

use super::{
    ImageRefusal, ImportError, MAX_INFLATED, MAX_XML_DEPTH, MAX_XML_NODES, Out, bbox, finite,
    html_to_text, refuse_image, safe_image, set_fill, tidy,
};

fn parse(text: &str) -> Result<roxmltree::Document<'_>, ImportError> {
    let opt = roxmltree::ParsingOptions {
        allow_dtd: false,
        nodes_limit: MAX_XML_NODES,
        ..Default::default()
    };
    let doc = roxmltree::Document::parse_with_options(text, opt).map_err(|e| match e {
        roxmltree::Error::NodesLimitReached => ImportError::new(
            "too_large",
            format!("It has more than {MAX_XML_NODES} XML nodes. In draw.io, export one page, then try again."),
        ),
        roxmltree::Error::DtdDetected => ImportError::new(
            "unreadable",
            "It declares XML entities, which are never read. Save it again from draw.io.",
        ),
        _ => ImportError::new("unreadable", "It isn't readable XML. Save it again from draw.io."),
    })?;
    // Depth without recursion: a node's depth is its parent's plus one (document order).
    let mut depth: Vec<u16> = vec![0; doc.descendants().count()];
    for n in doc.descendants() {
        if let Some(p) = n.parent() {
            let d = depth[p.id().get_usize()].saturating_add(1);
            depth[n.id().get_usize()] = d;
            if usize::from(d) > MAX_XML_DEPTH {
                return Err(ImportError::new(
                    "too_deep",
                    format!("Its XML is nested more than {MAX_XML_DEPTH} levels deep, which draw.io never writes."),
                ));
            }
        }
    }
    Ok(doc)
}

/// Base64 → raw deflate (≤ [`MAX_INFLATED`]) → URL-decoding.
fn inflate(data: &str) -> Result<String, ImportError> {
    let unreadable = || ImportError::new("unreadable", "A compressed page is damaged. Save it again from draw.io.");
    let clean: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let raw = super::B64.decode(clean.as_bytes()).map_err(|_| unreadable())?;
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(raw.as_slice())
        .take(MAX_INFLATED as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| unreadable())?;
    if out.len() > MAX_INFLATED {
        return Err(ImportError::new(
            "too_large",
            format!("A compressed page unpacks to more than {} MB. In draw.io, export one page, then try again.", MAX_INFLATED >> 20),
        ));
    }
    let s = String::from_utf8(out).map_err(|_| unreadable())?;
    let s = if s.trim_start().starts_with('<') {
        s
    } else {
        percent_encoding::percent_decode_str(&s)
            .decode_utf8()
            .map_err(|_| unreadable())?
            .into_owned()
    };
    Ok(s)
}

pub(super) fn convert(text: &str, page: usize, out: &mut Out) -> Result<(Vec<String>, usize), ImportError> {
    let doc = parse(text)?;
    let root = doc.root_element();
    let (pages, model_text): (Vec<String>, Option<String>) = match root.tag_name().name() {
        "mxGraphModel" => (vec!["Page-1".into()], None),
        "mxfile" => {
            let diagrams: Vec<roxmltree::Node> = root.children().filter(|n| n.has_tag_name("diagram")).collect();
            if diagrams.is_empty() {
                return Err(ImportError::new("not_diagram", "It has no pages."));
            }
            let names: Vec<String> = diagrams
                .iter()
                .enumerate()
                .map(|(i, d)| {
                    d.attribute("name")
                        .map(|n| tidy(n))
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| format!("Page-{}", i + 1))
                })
                .collect();
            let Some(d) = diagrams.get(page) else {
                return Err(ImportError::new("no_page", format!("It has {} pages; page {} doesn't exist.", names.len(), page + 1)));
            };
            for (i, n) in names.iter().enumerate().filter(|(i, _)| *i != page) {
                out.other_pages.push((i, n.clone()));
                out.note("page_other", Some(n.clone()));
            }
            let inline = d.children().any(|n| n.has_tag_name("mxGraphModel"));
            let model = if inline {
                None
            } else {
                let data: String = d.children().filter(|n| n.is_text()).filter_map(|n| n.text()).collect();
                if data.trim().is_empty() {
                    return Err(ImportError::new("not_diagram", "The page is empty."));
                }
                Some(inflate(&data)?)
            };
            (names, model)
        }
        other => {
            return Err(ImportError::new(
                "not_diagram",
                format!("It is XML, but not a draw.io diagram (it starts with <{}>).", tidy(other)),
            ));
        }
    };
    match model_text {
        Some(t) => {
            let d = parse(&t)?;
            let m = d.root_element();
            if !m.has_tag_name("mxGraphModel") {
                return Err(ImportError::new("not_diagram", "A compressed page isn't a draw.io diagram."));
            }
            convert_model(m, out);
        }
        None => {
            let m = if root.has_tag_name("mxGraphModel") {
                root
            } else {
                let d = root.children().filter(|n| n.has_tag_name("diagram")).nth(page).expect("checked");
                d.children().find(|n| n.has_tag_name("mxGraphModel")).expect("checked")
            };
            convert_model(m, out);
        }
    }
    let page = if pages.len() > 1 { page } else { 0 };
    Ok((pages, page))
}

#[derive(Default, Clone)]
struct Geo {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    points: Vec<[f64; 2]>,
    source: Option<[f64; 2]>,
    target: Option<[f64; 2]>,
}

struct Cell {
    id: String,
    label: String,
    style: HashMap<String, String>,
    /// First bare word of the style (`ellipse`, `text`, `group`, …).
    base: String,
    vertex: bool,
    edge: bool,
    parent: Option<String>,
    source: Option<String>,
    target: Option<String>,
    geo: Geo,
    link: Option<String>,
    data: usize,
}

fn num(n: &roxmltree::Node, a: &str) -> f64 {
    finite(n.attribute(a).and_then(|v| v.trim().parse().ok()).unwrap_or(0.0))
}

fn point(n: &roxmltree::Node) -> [f64; 2] {
    [num(n, "x"), num(n, "y")]
}

fn geometry(cell: &roxmltree::Node) -> Geo {
    let Some(g) = cell.children().find(|n| n.has_tag_name("mxGeometry")) else {
        return Geo::default();
    };
    let mut geo = Geo {
        x: num(&g, "x"),
        y: num(&g, "y"),
        w: num(&g, "width").max(0.0),
        h: num(&g, "height").max(0.0),
        ..Default::default()
    };
    for c in g.children().filter(|n| n.is_element()) {
        match (c.tag_name().name(), c.attribute("as")) {
            ("mxPoint", Some("sourcePoint")) => geo.source = Some(point(&c)),
            ("mxPoint", Some("targetPoint")) => geo.target = Some(point(&c)),
            ("Array", Some("points")) => {
                geo.points = c.children().filter(|n| n.has_tag_name("mxPoint")).map(|p| point(&p)).collect();
            }
            _ => {}
        }
    }
    geo
}

fn style_map(s: &str) -> (HashMap<String, String>, String) {
    let mut m = HashMap::new();
    let mut base = String::new();
    for part in s.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        match part.split_once('=') {
            Some((k, v)) => {
                m.insert(k.trim().to_string(), v.trim().to_string());
            }
            None => {
                if base.is_empty() {
                    base = part.to_string();
                }
                m.insert(part.to_string(), "1".into());
            }
        }
    }
    (m, base)
}

/// Attributes of a `UserObject`/`object` wrapper that are not custom data.
const KNOWN_ATTRS: &[&str] = &["id", "label", "placeholders", "link", "linkTarget", "class"];

fn cells(model: roxmltree::Node) -> Vec<Cell> {
    let Some(root) = model.children().find(|n| n.has_tag_name("root")) else {
        return vec![];
    };
    let mut v = Vec::new();
    for n in root.children().filter(|n| n.is_element()) {
        let (wrapper, cell) = match n.tag_name().name() {
            "mxCell" => (None, n),
            "UserObject" | "object" => match n.children().find(|c| c.has_tag_name("mxCell")) {
                Some(c) => (Some(n), c),
                None => continue,
            },
            _ => continue,
        };
        let id = wrapper.and_then(|w| w.attribute("id")).or(cell.attribute("id")).unwrap_or("").to_string();
        let label = wrapper
            .and_then(|w| w.attribute("label"))
            .or(cell.attribute("value"))
            .unwrap_or("")
            .to_string();
        let (style, base) = style_map(cell.attribute("style").unwrap_or(""));
        let link = wrapper.and_then(|w| w.attribute("link")).map(str::to_string);
        let data = wrapper.map_or(0, |w| w.attributes().filter(|a| !KNOWN_ATTRS.contains(&a.name())).count());
        v.push(Cell {
            id,
            label,
            vertex: cell.attribute("vertex") == Some("1"),
            edge: cell.attribute("edge") == Some("1"),
            parent: cell.attribute("parent").map(str::to_string),
            source: cell.attribute("source").map(str::to_string),
            target: cell.attribute("target").map(str::to_string),
            geo: geometry(&cell),
            style,
            base,
            link,
            data,
        });
    }
    v
}

fn label_of(c: &Cell, out: &mut Out) -> String {
    if c.style.get("html").is_some_and(|v| v == "1") || c.label.contains('<') && c.label.contains('>') {
        let (t, styled) = html_to_text(&c.label);
        if styled {
            out.note("text_style", Some(t.lines().next().unwrap_or("").to_string()));
        }
        t
    } else {
        tidy(&c.label)
    }
}

/// "mxgraph.aws4.lambda_function" → ("AWS", "Lambda function").
fn stencil_names(id: &str) -> (String, String) {
    let parts: Vec<&str> = id.split('.').collect();
    let lib = parts.get(1).copied().unwrap_or("");
    let vendor = if lib.starts_with("aws") {
        "AWS".to_string()
    } else if lib.starts_with("azure") {
        "Azure".to_string()
    } else if lib.starts_with("gcp") {
        "Google Cloud".to_string()
    } else if lib.starts_with("kubernetes") {
        "Kubernetes".to_string()
    } else if lib.starts_with("cisco") {
        "Cisco".to_string()
    } else {
        let mut c = lib.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    };
    let last = parts.last().copied().unwrap_or("").replace(['_', '-'], " ");
    let mut c = last.chars();
    let name = c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default();
    (vendor, name)
}

fn anchor(style: &HashMap<String, String>, prefix: &str) -> &'static str {
    let get = |k: &str| style.get(&format!("{prefix}{k}")).and_then(|v| v.parse::<f64>().ok());
    let (Some(x), Some(y)) = (get("X"), get("Y")) else {
        return "center";
    };
    // Nearest side of the unit box.
    let d = [(y, "top"), (1.0 - x, "right"), (1.0 - y, "bottom"), (x, "left")];
    d.iter()
        .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
        .map_or("center", |t| t.1)
}

/// Absolute origin of a cell's coordinate space (the sum of its vertex ancestors), cycle-safe.
fn origin_of<'a>(cells: &'a [Cell], by_id: &HashMap<&str, usize>, mut id: Option<&'a str>) -> [f64; 2] {
    let mut o = [0.0, 0.0];
    let mut seen: HashSet<String> = HashSet::new();
    while let Some(p) = id {
        let Some(c) = by_id.get(p).map(|i| &cells[*i]).filter(|c| c.vertex) else {
            break;
        };
        if !seen.insert(p.to_string()) || seen.len() > super::MAX_XML_DEPTH {
            break;
        }
        o[0] += c.geo.x;
        o[1] += c.geo.y;
        id = c.parent.as_deref();
    }
    o
}

fn bound<'a>(end: &'a Option<String>, boxes: &HashMap<&str, [f64; 4]>) -> Option<&'a str> {
    end.as_deref().filter(|e| boxes.contains_key(e))
}

const GENERIC: &[&str] = &["", "rounded", "whiteSpace", "label", "html", "process", "rect", "rectangle", "swimlane"];

fn convert_model(model: roxmltree::Node, out: &mut Out) {
    let cells = cells(model);
    let by_id: HashMap<&str, usize> = cells.iter().enumerate().map(|(i, c)| (c.id.as_str(), i)).collect();
    // Layers: cells whose parent is the root cell (the one without a parent).
    let roots: HashSet<&str> = cells.iter().filter(|c| c.parent.is_none()).map(|c| c.id.as_str()).collect();
    let layers: HashSet<&str> = cells
        .iter()
        .filter(|c| !c.vertex && !c.edge && c.parent.as_deref().is_some_and(|p| roots.contains(p)))
        .map(|c| c.id.as_str())
        .collect();
    if layers.len() > 1 {
        out.note("layers", None);
    }
    let is_vertex = |id: &str| by_id.get(id).is_some_and(|i| cells[*i].vertex);
    let is_edge = |id: &str| by_id.get(id).is_some_and(|i| cells[*i].edge);
    // Containers: groups, swimlanes, `container=1`, and any vertex with vertex children.
    let mut containers: HashSet<&str> = cells
        .iter()
        .filter(|c| c.vertex && (c.base == "group" || c.base == "swimlane" || c.style.get("container").is_some_and(|v| v == "1")))
        .map(|c| c.id.as_str())
        .collect();
    for c in cells.iter().filter(|c| c.vertex) {
        if let Some(p) = c.parent.as_deref().filter(|p| is_vertex(p)) {
            containers.insert(p);
        }
    }
    let origin = |id: Option<&str>| origin_of(&cells, &by_id, id);
    let mut local: HashMap<&str, String> = HashMap::new();
    let mut boxes: HashMap<&str, [f64; 4]> = HashMap::new();
    let mut edge_labels: HashMap<&str, Vec<String>> = HashMap::new();
    let mut n = 0usize;
    let mut next_id = || {
        n += 1;
        format!("s{n}")
    };
    // Ids first, so a container's children and edges can refer to it whatever the order.
    for c in &cells {
        if c.vertex && c.parent.as_deref().is_some_and(is_edge) {
            continue;
        }
        if c.vertex || c.edge {
            local.insert(c.id.as_str(), next_id());
        }
    }
    let mut vertices = Vec::new();
    for c in cells.iter().filter(|c| c.vertex) {
        if let Some(e) = c.parent.as_deref().filter(|p| is_edge(p)) {
            let t = label_of(c, out);
            if !t.is_empty() {
                edge_labels.entry(e).or_default().push(t);
            }
            continue;
        }
        vertices.push(c);
    }
    for c in vertices {
        let o = origin(c.parent.as_deref());
        let (x, y, w, h) = (o[0] + c.geo.x, o[1] + c.geo.y, c.geo.w, c.geo.h);
        boxes.insert(c.id.as_str(), [x, y, w, h]);
        let text = label_of(c, out);
        let shape_name = c.style.get("shape").cloned().unwrap_or_else(|| c.base.clone());
        let mut props = json!({"source": "drawio", "sourceId": c.id});
        if let Some(p) = c.parent.as_deref().filter(|p| containers.contains(p)) {
            props["parent"] = json!(local[p]);
        }
        let mut s = json!({"id": local[c.id.as_str()], "x": x, "y": y, "w": w, "h": h});
        let container = containers.contains(c.id.as_str());
        if container {
            out.note("containers", None);
            s["type"] = json!("rect");
            s["dashed"] = json!(true);
            if !text.is_empty() {
                s["label"] = json!(text);
            }
        } else if c.base == "text" || shape_name == "text" {
            s["type"] = json!("text");
            s["text"] = json!(text);
            s["size"] = json!(c.style.get("fontSize").and_then(|v| v.parse::<f64>().ok()).map_or(14.0, finite));
        } else if shape_name == "image" || c.base == "image" {
            let src = c.style.get("image").cloned().unwrap_or_default();
            let name = if text.is_empty() { "Image".to_string() } else { text.clone() };
            match safe_image(&src) {
                Ok(url) => {
                    out.note("images", None);
                    s["type"] = json!("image");
                    s["src"] = json!(url);
                    s["alt"] = json!(name);
                }
                Err(why) => {
                    let why = if matches!(why, ImageRefusal::Type) && !src.trim_start().to_ascii_lowercase().starts_with("data:") {
                        ImageRefusal::Link
                    } else {
                        why
                    };
                    refuse_image(out, &mut s, why, &name);
                }
            }
        } else if shape_name.starts_with("mxgraph.") {
            let id = c.style.get("resIcon").filter(|r| r.starts_with("mxgraph.")).cloned().unwrap_or(shape_name.clone());
            let (vendor, name) = stencil_names(&id);
            if !out.vendors.contains(&vendor) {
                out.vendors.push(vendor);
            }
            out.note("stencil", Some(if text.is_empty() { name.clone() } else { format!("{name}: {}", text.lines().next().unwrap_or("")) }));
            s["type"] = json!("rect");
            s["text"] = json!(if text.is_empty() { name } else { text.clone() });
            props["stencil"] = json!(id);
        } else {
            let ty = match shape_name.as_str() {
                "ellipse" | "doubleEllipse" => "ellipse",
                "rhombus" => "diamond",
                other => {
                    if !GENERIC.contains(&other) {
                        let mut ch = other.chars();
                        let nice = ch.next().map(|f| f.to_uppercase().collect::<String>() + ch.as_str()).unwrap_or_default();
                        let nice = nice.trim_end_matches(|c: char| c.is_ascii_digit()).to_string();
                        out.note("shape_box", Some(if text.is_empty() { nice } else { format!("{nice}: {}", text.lines().next().unwrap_or("")) }));
                        props["shape"] = json!(other);
                    }
                    "rect"
                }
            };
            s["type"] = json!(ty);
            if !text.is_empty() {
                s["text"] = json!(text);
            }
            if let Some(sz) = c.style.get("fontSize").and_then(|v| v.parse::<f64>().ok()) {
                s["size"] = json!(finite(sz));
            }
        }
        if !container && s["type"] != "image" && s["type"] != "text" {
            if let Some(f) = c.style.get("fillColor") {
                set_fill(out, &mut s, f);
            }
            if c.style.get("dashed").is_some_and(|v| v == "1") {
                if s["type"] == "rect" && s["fill"].is_null() {
                    s["dashed"] = json!(true);
                } else {
                    out.note("dashed", None);
                }
            }
        }
        style_notes(c, out, &text);
        s["props"] = props;
        out.push(s);
    }
    for c in cells.iter().filter(|c| c.edge) {
        let o = origin(c.parent.as_deref());
        let off = |p: [f64; 2]| [o[0] + p[0], o[1] + p[1]];
        let bind = |end| bound(end, &boxes);
        let centre = |id: &str| {
            let b = boxes[id];
            [b[0] + b[2] / 2.0, b[1] + b[3] / 2.0]
        };
        let mut s = json!({"id": local[c.id.as_str()], "type": "arrow"});
        let mut text = label_of(c, out);
        if let Some(extra) = edge_labels.get(c.id.as_str()) {
            for t in extra {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(t);
            }
        }
        if !text.is_empty() {
            s["text"] = json!(text);
        }
        for (end, which) in [(&c.source, "source"), (&c.target, "target")] {
            if end.is_some() && bind(end).is_none() {
                out.note("unbound", Some(text.lines().next().unwrap_or(&c.id).to_string()));
            }
            let _ = which;
        }
        let a = match bind(&c.source) {
            Some(id) => {
                s["start"] = json!({"shapeId": local[id], "anchor": anchor(&c.style, "exit")});
                centre(id)
            }
            None => c.geo.source.map(off).unwrap_or([0.0, 0.0]),
        };
        let b = match bind(&c.target) {
            Some(id) => {
                s["end"] = json!({"shapeId": local[id], "anchor": anchor(&c.style, "entry")});
                centre(id)
            }
            None => c.geo.target.map(off).unwrap_or(a),
        };
        let via: Vec<[f64; 2]> = c.geo.points.iter().map(|p| off(*p)).collect();
        let edge_style = c.style.get("edgeStyle").map(String::as_str).unwrap_or("");
        if c.style.get("curved").is_some_and(|v| v == "1") {
            out.note("curved", None);
            s["route"] = json!("elbow");
        } else if matches!(edge_style, "orthogonalEdgeStyle" | "elbowEdgeStyle" | "entityRelationEdgeStyle" | "segmentEdgeStyle") {
            out.note("elbow", None);
            s["route"] = json!("elbow");
        } else if !edge_style.is_empty() && edge_style != "none" {
            out.note("curved", None);
            s["route"] = json!("elbow");
        }
        if !via.is_empty() {
            s["via"] = json!(via);
        }
        let mut pts = vec![a];
        pts.extend(via.iter().copied());
        pts.push(b);
        let (x, y, w, h) = bbox(&pts);
        s["pts"] = json!(pts);
        s["x"] = json!(x);
        s["y"] = json!(y);
        s["w"] = json!(w);
        s["h"] = json!(h);
        let start_arrow = c.style.get("startArrow").map(String::as_str).unwrap_or("none");
        let end_arrow = c.style.get("endArrow").map(String::as_str).unwrap_or("classic");
        if start_arrow != "none" || !matches!(end_arrow, "classic" | "block" | "open" | "classicThin" | "blockThin") {
            out.note("arrowheads", None);
        }
        if c.style.get("dashed").is_some_and(|v| v == "1") {
            out.note("dashed", None);
        }
        style_notes(c, out, &text);
        s["props"] = json!({"source": "drawio", "sourceId": c.id});
        out.push(s);
    }
}

/// Style that a board can't show: noted, never silently dropped.
fn style_notes(c: &Cell, out: &mut Out, text: &str) {
    let name = || Some(text.lines().next().unwrap_or(&c.id).to_string());
    let f = |k: &str| c.style.get(k).and_then(|v| v.parse::<f64>().ok());
    if let Some(l) = &c.link {
        if !l.trim().is_empty() {
            out.note("link", name());
        }
    }
    if c.data > 0 {
        out.note("data", name());
    }
    if f("rotation").is_some_and(|r| r % 360.0 != 0.0) {
        out.note("rotation", name());
    }
    if f("strokeWidth").is_some_and(|w| (w - 1.0).abs() > 0.01) {
        out.note("stroke_width", None);
    }
    if c.style.get("fontFamily").is_some_and(|v| !v.eq_ignore_ascii_case("helvetica")) {
        out.note("font", None);
    }
    if f("fontStyle").is_some_and(|v| v != 0.0) {
        out.note("text_style", name());
    }
    if c.style.get("sketch").is_some_and(|v| v == "1") {
        out.note("rough", None);
    }
    if ["opacity", "fillOpacity", "strokeOpacity", "textOpacity"].iter().any(|k| f(k).is_some_and(|v| v < 100.0)) {
        out.note("opacity", None);
    }
    if c.style.get("shadow").is_some_and(|v| v == "1") || c.style.get("gradientColor").is_some_and(|v| v != "none") {
        out.note("effects", None);
    }
}
