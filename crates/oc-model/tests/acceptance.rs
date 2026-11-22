//! Acceptance (docs/23): `.ocanvas` compatibility and export outputs from one rich document
//! that has every block type, every database field type and view, every board shape and
//! comments, with CJK, RTL and emoji text.
//!
//! `OC_ACC_OUT=<dir>` also writes every export there for external checks (pdftotext, Word).
//! `OC_ACC_REGEN=1` rewrites the committed `fixtures/v1-rich.ocanvas`.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use base64::Engine;
use oc_model::import::apply_document_json;
use oc_model::{CommitInfo, doc_to_json, new_doc, read_ocanvas, write_ocanvas};
use serde_json::{Value, json};
use yrs::{ReadTxn, Transact};
use zip::write::SimpleFileOptions;

const CJK: &str = "日本語のテキストと中文";
const RTL: &str = "שלום עולם مرحبا";
const EMOJI: &str = "Launch 🚀✅";

fn t(s: &str) -> Value {
    json!({"type":"text","text":s})
}
fn p(s: &str) -> Value {
    json!({"type":"paragraph","content":[t(s)]})
}

fn red_png() -> Vec<u8> {
    let mut pm = resvg::tiny_skia::Pixmap::new(4, 4).unwrap();
    pm.fill(resvg::tiny_skia::Color::from_rgba8(255, 0, 0, 255));
    pm.encode_png().unwrap()
}

fn png_url() -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(red_png())
    )
}

fn board() -> Value {
    serde_json::from_str(include_str!("fixtures/board.json")).unwrap()
}

/// Every Tiptap node of docs/15 §4, plus an unknown block and unknown attrs.
pub fn rich() -> Value {
    let li = |s: &str| json!({"type":"listItem","content":[p(s)]});
    let fields = json!([
        {"id":"f_title","name":"Name","type":"title"},
        {"id":"f_text","name":"Notes","type":"text","description":"Free text"},
        {"id":"f_status","name":"Status","type":"status","options":[{"v":"Todo","c":"gray"},{"v":"Done","c":"green"}]},
        {"id":"f_select","name":"Team","type":"select","options":[{"v":"Web","c":"blue"}]},
        {"id":"f_tags","name":"Tags","type":"tags","options":[{"v":"p1","c":"red"},{"v":"ux","c":"pink"}]},
        {"id":"f_person","name":"Owner","type":"person"},
        {"id":"f_date","name":"Due","type":"date"},
        {"id":"f_number","name":"Points","type":"number"},
        {"id":"f_check","name":"Shipped","type":"checkbox"},
        {"id":"f_url","name":"Link","type":"url"},
        {"id":"f_progress","name":"Progress","type":"progress"},
        {"id":"f_future","name":"Rating","type":"stars","futureOption":{"max":5}}
    ]);
    json!({
        "type": "doc",
        "content": [
            {"type":"heading","attrs":{"level":1,"blockId":"b_h1"},"content":[t("Acceptance plan")]},
            {"type":"heading","attrs":{"level":2},"content":[t(CJK)]},
            {"type":"paragraph","content":[
                t("Plain "),
                {"type":"text","text":"bold","marks":[{"type":"bold"}]},
                t(" "),
                {"type":"text","text":"link","marks":[{"type":"link","attrs":{"href":"https://example.com/x"}}]},
                t(" "),
                {"type":"text","text":"evil","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]},
                t(" "),
                {"type":"text","text":"blue","marks":[{"type":"textColor","attrs":{"color":"blue"}}]},
                t(" "),
                {"type":"text","text":"commented","marks":[{"type":"commentMark","attrs":{"threadId":"th_1"}}]},
                t(" <script>alert('x')</script> "),
                {"type":"mention","attrs":{"id":"u_asha","label":"Asha Rao"}},
                t(" "),
                {"type":"dateMention","attrs":{"date":"2026-12-04"}}
            ]},
            p(RTL),
            p(EMOJI),
            {"type":"bulletList","content":[li("Bullet one"), li("Bullet two")]},
            {"type":"orderedList","content":[li("First step"), li("Second step")]},
            {"type":"taskList","content":[
                {"type":"taskItem","attrs":{"checked":true},"content":[p("Done task")]},
                {"type":"taskItem","attrs":{"checked":false},"content":[p("Open task")]}
            ]},
            {"type":"blockquote","content":[p("A quote")]},
            {"type":"codeBlock","attrs":{"language":"rust"},"content":[t("fn main() {}")]},
            {"type":"horizontalRule"},
            {"type":"image","attrs":{"src":png_url(),"alt":"Red square","caption":"Figure 1"}},
            {"type":"callout","attrs":{"tone":"amber","icon":"info"},"content":[p("Callout body")]},
            {"type":"toggle","attrs":{"open":false},"content":[
                {"type":"toggleSummary","content":[t("Toggle title")]},
                {"type":"toggleContent","content":[p("Hidden body")]}
            ]},
            {"type":"columns","attrs":{"widths":"25,75"},"content":[
                {"type":"column","attrs":{"title":"Left"},"content":[p("Left column")]},
                {"type":"column","content":[p("Right column")]}
            ]},
            {"type":"table","content":[
                {"type":"tableRow","content":[
                    {"type":"tableHeader","content":[p("Metric")]},
                    {"type":"tableHeader","content":[p("Target")]}
                ]},
                {"type":"tableRow","content":[
                    {"type":"tableCell","content":[p("Latency")]},
                    {"type":"tableCell","content":[p("120 ms")]}
                ]}
            ]},
            {"type":"bookmark","attrs":{"url":"https://docs.example.com","title":"Handbook","description":"How we ship","site":"docs.example.com"}},
            {"type":"embed","attrs":{"provider":"youtube","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","title":"Demo video"}},
            {"type":"embed","attrs":{"provider":"evil","url":"javascript:alert(2)","title":"Bad embed"}},
            {"type":"fileAttachment","attrs":{"name":"spec.pdf","size":2048,"url":"https://files.example.com/spec.pdf","mime":"application/pdf"}},
            {"type":"database","attrs":{"dbId":"db_1"}},
            {"type":"board","attrs":{"boardId":"bd_1"}},
            {"type":"futureBlock","attrs":{"weird":[1,2,{"a":true}]},"content":[p("future child")]},
            {"type":"paragraph","attrs":{"futureAttr":"kept"},"content":[t("Last line")]}
        ],
        "meta": {"title": "Acceptance plan", "icon": "rocket", "futureMeta": 7},
        "databases": {
            "db_1": {
                "name": "Tasks", "icon": "list", "tone": "blue",
                "fields": fields,
                "order": ["r1", "r2"],
                "rows": {
                    "r1": {"f_title":"Write tests","f_text":"多言語","f_status":"Done","f_select":"Web",
                           "f_tags":["p1","ux"],"f_person":"u_asha","f_date":"2026-12-01","f_number":3,
                           "f_check":true,"f_url":"https://example.com","f_progress":50,"f_future":4},
                    "r2": {"f_title":"Ship it 🚀","f_status":"Todo"}
                },
                "notes": {"r1": "Row note"},
                "view": "table",
                "views": {
                    "table": {"sorts":[{"f":"f_number","dir":-1}],"widths":{"f_title":220}},
                    "board": {"group":"f_status"},
                    "calendar": {"date":"f_date","cal":"2026-12"},
                    "gallery": {"cover":"color"}
                },
                "futureKey": "x"
            }
        },
        "boards": {"bd_1": board()},
        "comments": {
            "th_1": {"quote":"commented","resolved":false,"messages":[
                {"user":"u_asha","name":"Asha Rao","color":"#7c3aed","text":"Looks good @Ravi","at":1_763_700_000_000_i64,
                 "mentions":["u_ravi"],"labels":{"u_ravi":"@Ravi"}}
            ]}
        }
    })
}

fn loaded_rich() -> yrs::Doc {
    let doc = new_doc();
    apply_document_json(&doc, &rich());
    doc
}

fn commit() -> CommitInfo {
    CommitInfo {
        id: "01ACC".into(),
        authors: vec!["u_asha".into()],
        at: "2026-11-22T00:00:00Z".into(),
    }
}

fn unzip(bytes: &[u8]) -> HashMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..z.len())
        .map(|i| {
            let mut f = z.by_index(i).unwrap();
            let mut b = vec![];
            f.read_to_end(&mut b).unwrap();
            (f.name().unwrap().to_string(), b)
        })
        .collect()
}

fn out(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("OC_ACC_OUT") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(std::path::Path::new(&dir).join(name), bytes).unwrap();
    }
}

// ------------------------------------------------------------------ file compatibility

/// FC-01/02: every block, field, view, shape and comment survives write → read, unknown
/// blocks/attrs/fields/meta included.
#[test]
fn fc_round_trip_every_block_and_unknowns() {
    let doc = loaded_rich();
    let before = doc_to_json(&doc);
    assert_eq!(
        before["content"],
        rich()["content"],
        "content mirrors input"
    );
    let bytes = write_ocanvas(&doc, &commit()).unwrap();
    out("rich.ocanvas", &bytes);
    let back = doc_to_json(&read_ocanvas(&bytes).unwrap().doc);
    assert_eq!(back, before);
    // Logical equality with the input for every root (numbers may widen int → float).
    for root in ["meta", "databases", "boards", "comments"] {
        let a = serde_json::to_string(&rich()[root]).unwrap();
        let b = serde_json::to_string(&back[root]).unwrap();
        let norm = |s: &str| {
            s.replace(".0,", ",")
                .replace(".0]", "]")
                .replace(".0}", "}")
        };
        let (av, bv): (Value, Value) = (
            serde_json::from_str(&norm(&a)).unwrap(),
            serde_json::from_str(&norm(&b)).unwrap(),
        );
        assert_eq!(av, bv, "root {root}");
    }
    assert_eq!(back["content"][22]["type"], "futureBlock");
    assert_eq!(back["content"][23]["attrs"]["futureAttr"], "kept");
    assert_eq!(back["databases"]["db_1"]["fields"][11]["type"], "stars");
}

/// FC-03: the committed v1 file (format 1, schema 1) still reads to the same document.
#[test]
fn fc_reads_committed_v1_fixture() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/v1-rich.ocanvas"
    );
    if std::env::var("OC_ACC_REGEN").is_ok() {
        std::fs::write(path, write_ocanvas(&loaded_rich(), &commit()).unwrap()).unwrap();
    }
    let bytes = std::fs::read(path).expect("fixture");
    let l = read_ocanvas(&bytes).unwrap();
    assert_eq!(l.manifest["version"], 1);
    assert_eq!(doc_to_json(&l.doc)["content"], rich()["content"]);
}

/// FC-03: older/other writers: document.json only, a v2 ydoc.bin, no manifest, and a
/// manifest with a different schemaVersion (document.json wins over ydoc.bin).
#[test]
fn fc_reads_variant_archives() {
    let json_only = zipped(&[("document.json", rich().to_string().into_bytes())]);
    assert_eq!(
        doc_to_json(&read_ocanvas(&json_only).unwrap().doc)["content"],
        rich()["content"]
    );
    let doc = loaded_rich();
    let v2 = doc
        .transact()
        .encode_state_as_update_v2(&yrs::StateVector::default());
    let bin_only = zipped(&[("ydoc.bin", v2)]);
    assert_eq!(
        doc_to_json(&read_ocanvas(&bin_only).unwrap().doc)["content"],
        rich()["content"]
    );
    let other = new_doc();
    apply_document_json(&other, &json!({"content":[p("stale ydoc")]}));
    let schema2 = zipped(&[
        (
            "manifest.json",
            br#"{"format":"ocanvas","version":1,"schemaVersion":2}"#.to_vec(),
        ),
        ("document.json", rich().to_string().into_bytes()),
        ("ydoc.bin", oc_model::ocanvas::encode_state(&other)),
    ]);
    assert_eq!(
        doc_to_json(&read_ocanvas(&schema2).unwrap().doc)["content"],
        rich()["content"]
    );
}

/// FC-06: document.json written next to ydoc.bin is exactly the walk of ydoc.bin.
#[test]
fn fc_document_json_matches_ydoc() {
    let bytes = write_ocanvas(&loaded_rich(), &commit()).unwrap();
    let files = unzip(&bytes);
    let dj: Value = serde_json::from_slice(&files["document.json"]).unwrap();
    let from_bin = new_doc();
    oc_model::ocanvas::apply_update_bytes(&from_bin, &files["ydoc.bin"]).unwrap();
    assert_eq!(dj, doc_to_json(&from_bin));
    let m: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
    assert_eq!(m["title"], "Acceptance plan");
    assert_eq!(m["commit"]["id"], "01ACC");
}

fn zipped(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (n, b) in entries {
        z.start_file(*n, SimpleFileOptions::default()).unwrap();
        z.write_all(b).unwrap();
    }
    z.finish().unwrap().into_inner()
}

/// FC-04: bomb, traversal, oversized and too many entries are refused, without panics.
#[test]
fn fc_zip_limits() {
    // Zip bomb: 200 MB of zeros deflated to ~200 KB (ratio and total limits).
    let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
    z.start_file(
        "document.json",
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    )
    .unwrap();
    let chunk = vec![0u8; 1 << 20];
    for _ in 0..200 {
        z.write_all(&chunk).unwrap();
    }
    let bomb = z.finish().unwrap().into_inner();
    assert!(matches!(
        read_ocanvas(&bomb),
        Err(oc_model::Error::Limit(_))
    ));
    // Path traversal and absolute paths.
    for name in ["../evil", "a/../../b", "assets/../../x"] {
        let bytes = zipped(&[(name, b"x".to_vec())]);
        assert!(read_ocanvas(&bytes).is_err(), "{name}");
        assert!(oc_model::ocanvas::read_assets(&bytes).is_err(), "{name}");
    }
    // An absolute name is never written to disk (entries are read into memory by name) and
    // is not an asset.
    let abs = zipped(&[("/etc/passwd", b"x".to_vec())]);
    assert!(read_ocanvas(&abs).is_err());
    assert!(oc_model::ocanvas::read_assets(&abs).unwrap().is_empty());
    // Oversized stored entry (> 100 MB total).
    let big = zipped(&[("ydoc.bin", vec![1u8; 101 * 1024 * 1024])]);
    assert!(matches!(read_ocanvas(&big), Err(oc_model::Error::Limit(_))));
    // Too many entries.
    let many: Vec<(String, Vec<u8>)> = (0..1001).map(|i| (format!("x/{i}"), vec![])).collect();
    let refs: Vec<(&str, Vec<u8>)> = many.iter().map(|(n, b)| (n.as_str(), b.clone())).collect();
    assert!(matches!(
        read_ocanvas(&zipped(&refs)),
        Err(oc_model::Error::Limit(_))
    ));
}

/// FC-05: corrupt and truncated files fail with an error, never a panic.
#[test]
fn fc_corrupt_and_truncated_fail_cleanly() {
    let good = write_ocanvas(&loaded_rich(), &commit()).unwrap();
    for cut in [0, 4, 30, good.len() / 2, good.len() - 10] {
        assert!(read_ocanvas(&good[..cut]).is_err(), "truncated at {cut}");
    }
    assert!(read_ocanvas(b"not a zip at all").is_err());
    let mut flipped = good.clone();
    let mid = flipped.len() / 3;
    for b in &mut flipped[mid..mid + 64] {
        *b ^= 0xff;
    }
    let _ = read_ocanvas(&flipped); // must not panic
    assert!(read_ocanvas(&zipped(&[("ydoc.bin", vec![0xff; 64])])).is_err());
    assert!(read_ocanvas(&zipped(&[("document.json", b"{not json".to_vec())])).is_err());
    assert!(matches!(
        read_ocanvas(&zipped(&[("other.txt", b"x".to_vec())])),
        Err(oc_model::Error::Empty)
    ));
}

// ------------------------------------------------------------------ exports

fn rich_json() -> Value {
    doc_to_json(&loaded_rich())
}

/// EX-MD: tables, lists, tasks, code; script URLs dropped; non-ASCII kept.
#[test]
fn ex_markdown() {
    let md = oc_model::export::to_markdown(&rich_json());
    out("rich.md", md.as_bytes());
    for want in [
        "# Acceptance plan",
        "| Metric | Target |",
        "| Latency | 120 ms |",
        "- Bullet one",
        "1. First step",
        "- [x] Done task",
        "- [ ] Open task",
        "```rust",
        "Write tests",
        CJK,
        RTL,
        EMOJI,
        "https://example.com/x",
    ] {
        assert!(md.contains(want), "markdown lacks {want:?}:\n{md}");
    }
    assert!(!md.contains("javascript:"), "{md}");
    assert!(
        md.contains("| Name |"),
        "database exported as a table:\n{md}"
    );
}

/// EX-HTML: sanitised (no script, no javascript: or iframe of an unknown provider).
#[test]
fn ex_html() {
    let html = oc_model::export::to_html(&rich_json());
    out("rich.html", html.as_bytes());
    let lower = html.to_lowercase();
    assert!(!lower.contains("<script"), "script element in HTML export");
    assert!(
        !lower.contains("javascript:"),
        "javascript: URL in HTML export"
    );
    assert!(!lower.contains("<iframe"), "exports never embed iframes");
    assert!(lower.contains("&lt;script&gt;"), "script text escaped");
    for want in [CJK, RTL, EMOJI, "<table", "<svg", "Latency", "Write tests"] {
        assert!(html.contains(want), "html lacks {want:?}");
    }
    assert!(html.contains("charset=\"utf-8\"") || lower.contains("charset=utf-8"));
}

fn docx_xml() -> String {
    let json = rich_json();
    let mut images = HashMap::new();
    images.insert(png_url(), red_png());
    let (bytes, _notes) = oc_model::docx::to_docx(&json, &images).unwrap();
    out("rich.docx", &bytes);
    let files = unzip(&bytes);
    assert!(files.contains_key("[Content_Types].xml"));
    assert!(
        files.keys().any(|k| k.starts_with("word/media/")),
        "an image is embedded: {:?}",
        files.keys().collect::<Vec<_>>()
    );
    String::from_utf8(files["word/document.xml"].clone()).unwrap()
}

/// EX-DOCX: headings, tables, images, non-ASCII.
#[test]
fn ex_docx() {
    let xml = docx_xml();
    assert!(xml.contains("Heading1"), "heading style");
    assert!(
        xml.contains("<w:tbl>") || xml.contains("<w:tbl "),
        "a table"
    );
    assert!(
        xml.contains("<w:drawing>") || xml.contains("<w:drawing"),
        "an image"
    );
    for want in [CJK, RTL, EMOJI, "Latency", "Write tests"] {
        assert!(xml.contains(want), "docx lacks {want:?}");
    }
    assert!(!xml.contains("javascript:"));
}

/// EX-BOARD: SVG is valid XML, PNG decodes at the fitted size.
#[test]
fn ex_board_svg_png() {
    let json = rich_json();
    let svg = oc_model::board::to_svg(&json, "bd_1");
    out("board.svg", svg.as_bytes());
    let tree =
        resvg::usvg::Tree::from_str(&svg, &resvg::usvg::Options::default()).expect("valid SVG");
    let png = oc_model::board::to_png(&svg, 1.0).unwrap();
    out("board.png", &png);
    let pm = resvg::tiny_skia::Pixmap::decode_png(&png).unwrap();
    let size = tree.size();
    assert_eq!(
        (pm.width(), pm.height()),
        (size.width().ceil() as u32, size.height().ceil() as u32)
    );
    assert!(svg.contains("Ünïcode ✓"));
}

/// EX-OC: the .ocanvas export is a readable file with the same content.
#[test]
fn ex_ocanvas() {
    let bytes = write_ocanvas(&loaded_rich(), &commit()).unwrap();
    assert!(oc_model::ocanvas::is_zip(&bytes));
    let l = read_ocanvas(&bytes).unwrap();
    assert_eq!(doc_to_json(&l.doc), rich_json());
    assert_ne!(l.doc.transact().state_vector(), yrs::StateVector::default());
}
