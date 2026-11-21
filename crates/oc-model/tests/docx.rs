//! DOCX export: the package opens (parts present, XML well-formed) and, when LibreOffice is
//! installed, converts to PDF headlessly.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::process::Command;

use oc_model::docx::{image_info, image_sources, to_docx};
use serde_json::{Value, json};

pub const PNG_1X1: [u8; 70] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x05, 0x02, 0x00, 0x5f, 0xc8, 0xf1, 0xd2, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

fn t(text: &str) -> Value {
    json!({"type": "text", "text": text})
}

fn p(content: Vec<Value>) -> Value {
    json!({"type": "paragraph", "content": content})
}

fn sample() -> Value {
    json!({
        "type": "doc",
        "meta": {"title": "Sprint <42> & co"},
        "databases": {"d1": {"name": "Tasks", "fields": [{"id":"f1","name":"Name"},{"id":"f2","name":"Status"}],
            "order": ["r1","r2"], "rows": {"r1": {"f1": "Ship", "f2": {"v":"Done","c":"green"}}, "r2": {"f1": "Test"}}}},
        "boards": {"b1": {"order": ["s1","s2","s3"], "shapes": {"s1": {"type":"sticky","x":0,"y":0,"w":150,"h":110,"text":"Idea one"}, "s2": {"type":"rect","x":200,"y":0,"w":100,"h":60}, "s3": {"type":"image","x":320,"y":0,"w":40,"h":40,"src":"https://host.example/assets/b1"}}}},
        "content": [
            {"type":"heading","attrs":{"level":1},"content":[t("Plan")]},
            p(vec![
                t("plain "),
                json!({"type":"text","text":"bold","marks":[{"type":"bold"}]}),
                json!({"type":"text","text":" italic","marks":[{"type":"italic"}]}),
                json!({"type":"text","text":" under","marks":[{"type":"underline"}]}),
                json!({"type":"text","text":" strike","marks":[{"type":"strike"}]}),
                json!({"type":"text","text":" code","marks":[{"type":"code"}]}),
                json!({"type":"text","text":" link","marks":[{"type":"link","attrs":{"href":"https://example.com/?a=1&b=2"}}]}),
                json!({"type":"text","text":" js","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}),
                json!({"type":"hardBreak"}),
                json!({"type":"mention","attrs":{"id":"u1","label":"Asha"}}),
                t(" ctrl\u{1}char"),
            ]),
            {"type":"heading","attrs":{"level":2},"content":[t("Lists")]},
            {"type":"bulletList","content":[
                {"type":"listItem","content":[p(vec![t("b1")]),
                    {"type":"orderedList","content":[{"type":"listItem","content":[p(vec![t("nested n1")])]}]}]},
                {"type":"listItem","content":[p(vec![t("b2")])]}]},
            {"type":"orderedList","content":[{"type":"listItem","content":[p(vec![t("n1")])]},{"type":"listItem","content":[p(vec![t("n2")])]}]},
            {"type":"taskList","content":[
                {"type":"taskItem","attrs":{"checked":true},"content":[p(vec![t("done")])]},
                {"type":"taskItem","attrs":{"checked":false},"content":[p(vec![t("todo")])]}]},
            {"type":"blockquote","content":[p(vec![t("quoted")])]},
            {"type":"codeBlock","attrs":{"language":"rust"},"content":[t("fn main() {\n    println!(\"<hi>\");\n}")]},
            {"type":"horizontalRule"},
            {"type":"callout","attrs":{"tone":"blue","icon":"info"},"content":[p(vec![t("call out")])]},
            {"type":"table","content":[
                {"type":"tableRow","content":[{"type":"tableHeader","content":[p(vec![t("H1")])]},{"type":"tableHeader","content":[p(vec![t("H2")])]}]},
                {"type":"tableRow","content":[{"type":"tableCell","content":[p(vec![t("c1")])]},{"type":"tableCell","content":[{"type":"paragraph"}]}]}]},
            {"type":"image","attrs":{"src":"https://host.example/assets/a1","alt":"Dot","caption":"A dot"}},
            {"type":"image","attrs":{"src":"https://evil.example/x.png","alt":"Elsewhere"}},
            {"type":"toggle","content":[{"type":"toggleSummary","content":[t("More")]},{"type":"toggleContent","content":[p(vec![t("hidden")])]}]},
            {"type":"database","attrs":{"dbId":"d1"}},
            {"type":"board","attrs":{"boardId":"b1"}},
            {"type":"bookmark","attrs":{"url":"https://opencanvas.dev","title":"OpenCanvas"}},
            {"type":"columns","content":[{"type":"column","content":[p(vec![t("left")])]},{"type":"column","content":[p(vec![t("right")])]}]},
            {"type":"futureBlock","attrs":{"x":1}}
        ]
    })
}

fn unzip(bytes: &[u8]) -> HashMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).expect("docx is a zip");
    (0..z.len())
        .map(|i| {
            let mut f = z.by_index(i).unwrap();
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).unwrap();
            (f.name().to_string(), buf)
        })
        .collect()
}

/// Minimal XML well-formedness check: balanced, properly nested tags, quoted attributes,
/// known entities only, no raw `<`/`&` in text.
fn well_formed(xml: &str) -> Result<(), String> {
    let mut stack: Vec<&str> = Vec::new();
    let mut rest = xml;
    if let Some(r) = rest.strip_prefix("<?xml") {
        rest = &r[r.find("?>").ok_or("unterminated declaration")? + 2..];
    }
    let check_text = |t: &str| -> Result<(), String> {
        let mut s = t;
        while let Some(p) = s.find('&') {
            let end = s[p..].find(';').ok_or("bare &")?;
            let ent = &s[p + 1..p + end];
            let ok = matches!(ent, "amp" | "lt" | "gt" | "quot" | "apos") || ent.starts_with('#');
            if !ok {
                return Err(format!("unknown entity &{ent};"));
            }
            s = &s[p + end..];
        }
        Ok(())
    };
    let mut seen_root = false;
    while !rest.is_empty() {
        let lt = rest.find('<').unwrap_or(rest.len());
        let text = &rest[..lt];
        if stack.is_empty() && !text.trim().is_empty() {
            return Err(format!("text outside root: {text:?}"));
        }
        check_text(text)?;
        rest = &rest[lt..];
        if rest.is_empty() {
            break;
        }
        let gt = rest.find('>').ok_or("unterminated tag")?;
        let tag = &rest[1..gt];
        rest = &rest[gt + 1..];
        if let Some(name) = tag.strip_prefix('/') {
            let open = stack.pop().ok_or(format!("stray </{name}>"))?;
            if open != name.trim() {
                return Err(format!("</{name}> closes <{open}>"));
            }
            continue;
        }
        let self_closing = tag.ends_with('/');
        let body = tag.trim_end_matches('/');
        let name_end = body.find(char::is_whitespace).unwrap_or(body.len());
        let name = &body[..name_end];
        if name.is_empty() || name.contains(['<', '"', '&']) {
            return Err(format!("bad tag name in <{tag}>"));
        }
        // attributes: name="value" pairs
        let mut attrs = body[name_end..].trim();
        let mut names = Vec::new();
        while !attrs.is_empty() {
            let eq = attrs
                .find('=')
                .ok_or(format!("attr without value in <{tag}>"))?;
            let an = attrs[..eq].trim();
            if names.contains(&an) {
                return Err(format!("duplicate attribute {an} in <{name}>"));
            }
            names.push(an);
            let after = attrs[eq + 1..].trim_start();
            let q = after.chars().next().ok_or("missing value")?;
            if q != '"' && q != '\'' {
                return Err(format!("unquoted attribute in <{tag}>"));
            }
            let close = after[1..].find(q).ok_or("unterminated attribute")?;
            let value = &after[1..1 + close];
            if value.contains('<') {
                return Err("< in attribute".into());
            }
            check_text(value)?;
            attrs = after[close + 2..].trim_start();
        }
        if stack.is_empty() {
            if seen_root {
                return Err("two roots".into());
            }
            seen_root = true;
        }
        if !self_closing {
            stack.push(name);
        }
    }
    if let Some(open) = stack.pop() {
        return Err(format!("<{open}> never closed"));
    }
    if !seen_root {
        return Err("no root".into());
    }
    if xml
        .chars()
        .any(|c| (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Err("control character".into());
    }
    Ok(())
}

#[test]
fn checker_rejects_broken_xml() {
    assert!(well_formed("<a><b></a></b>").is_err());
    assert!(well_formed("<a x=1/>").is_err());
    assert!(well_formed("<a>&nope;</a>").is_err());
    assert!(well_formed("<a/><b/>").is_err());
    assert!(well_formed("<?xml version=\"1.0\"?>\n<a x=\"1\"><b/>t &amp; u</a>").is_ok());
}

#[test]
fn docx_package_is_complete_and_well_formed() {
    let doc = sample();
    assert_eq!(
        image_sources(&doc),
        [
            "https://host.example/assets/a1",
            "https://evil.example/x.png",
            "https://host.example/assets/b1"
        ]
    );
    assert_eq!(image_info(&PNG_1X1), Some(("png", 1, 1)));
    let mut images = HashMap::new();
    images.insert(
        "https://host.example/assets/a1".to_string(),
        PNG_1X1.to_vec(),
    );
    let (bytes, notes) = to_docx(&doc, &images).unwrap();
    let parts = unzip(&bytes);
    for name in [
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/core.xml",
        "word/document.xml",
        "word/_rels/document.xml.rels",
        "word/styles.xml",
        "word/numbering.xml",
        "word/media/image1.png",
        "word/media/image2.png",
    ] {
        let part = parts.get(name).unwrap_or_else(|| panic!("missing {name}"));
        if name.ends_with(".xml") || name.ends_with(".rels") {
            let xml = std::str::from_utf8(part).unwrap();
            well_formed(xml).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }
    assert_eq!(parts["word/media/image1.png"], PNG_1X1);
    let document = String::from_utf8(parts["word/document.xml"].clone()).unwrap();
    let rels = String::from_utf8(parts["word/_rels/document.xml.rels"].clone()).unwrap();
    for needle in [
        "<w:pStyle w:val=\"Heading1\"/>",
        "<w:b/>",
        "<w:i/>",
        "<w:u w:val=\"single\"/>",
        "<w:strike/>",
        "w:ascii=\"Consolas\"",
        "<w:hyperlink r:id=",
        "<w:numId w:val=\"1\"/>",
        "<w:ilvl w:val=\"1\"/><w:numId w:val=\"2\"/>",
        "<w:numId w:val=\"3\"/>",
        "\u{2612} ",
        "\u{2610} ",
        "<w:pStyle w:val=\"Quote\"/>",
        "<w:pStyle w:val=\"Code\"/>",
        "println!(&quot;&lt;hi&gt;&quot;);",
        "w:fill=\"E8F0FE\"",
        "<w:tbl>",
        "<w:tblHeader/>",
        "<a:blip r:embed=",
        "Image: Elsewhere",
        "A dot",
        ">Tasks<",
        ">Done<",
        ">Whiteboard<",
        "descr=\"Whiteboard: Idea one\"",
        "@Asha",
        "ctrlchar",
        ">left<",
    ] {
        assert!(document.contains(needle), "document.xml lacks {needle:?}");
    }
    assert!(!document.contains("javascript"), "unsafe link dropped");
    let core = String::from_utf8(parts["docProps/core.xml"].clone()).unwrap();
    assert!(core.contains("<dc:title>Sprint &lt;42&gt; &amp; co</dc:title>"));
    assert!(rels.contains("Target=\"https://example.com/?a=1&amp;b=2\" TargetMode=\"External\""));
    assert!(
        rels.contains("Target=\"https://evil.example/x.png\""),
        "unfetched image is a link"
    );
    assert!(rels.contains("Target=\"media/image1.png\""));
    // The board is a rendered PNG (fitted: 360 + 2×32 = 424 px wide, rendered at 2×).
    let board = &parts["word/media/image2.png"];
    assert_eq!(image_info(board).map(|i| (i.0, i.1)), Some(("png", 848)));
    assert!(
        document.contains("cx=\"4038600\""),
        "board shown at 424 px = 4038600 EMU"
    );
    assert!(notes.iter().any(|n| n.contains("evil.example")));

    smoke_with_tools(&bytes);
}

/// `xmllint` and LibreOffice, when present: strict XML parse, then DOCX → PDF.
fn smoke_with_tools(bytes: &[u8]) {
    let dir = std::env::temp_dir().join(format!("oc-docx-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("export.docx");
    std::fs::write(&path, bytes).unwrap();
    if Command::new("xmllint").arg("--version").output().is_ok() {
        for (name, data) in unzip(bytes) {
            if name.ends_with(".xml") || name.ends_with(".rels") {
                let f = dir.join(name.replace('/', "_"));
                std::fs::write(&f, data).unwrap();
                let out = Command::new("xmllint")
                    .arg("--noout")
                    .arg(&f)
                    .output()
                    .unwrap();
                assert!(
                    out.status.success(),
                    "xmllint {name}: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
            }
        }
    }
    let soffice = ["soffice", "libreoffice"].into_iter().find(|b| {
        Command::new(b)
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    });
    match soffice {
        Some(bin) => {
            let profile = format!("-env:UserInstallation=file://{}/lo-profile", dir.display());
            let out = Command::new(bin)
                .args([
                    profile.as_str(),
                    "--headless",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                ])
                .arg(&dir)
                .arg(&path)
                .output()
                .unwrap();
            let pdf = dir.join("export.pdf");
            let ok = std::fs::read(&pdf).is_ok_and(|b| b.starts_with(b"%PDF") && b.len() > 1000);
            assert!(
                ok,
                "LibreOffice could not convert the docx: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            if let Ok(keep) = std::env::var("OC_DOCX_OUT") {
                std::fs::copy(&pdf, format!("{keep}.pdf")).unwrap();
                std::fs::copy(&path, format!("{keep}.docx")).unwrap();
            }
            eprintln!(
                "LibreOffice converted the docx to PDF ({} bytes)",
                std::fs::metadata(&pdf).unwrap().len()
            );
        }
        None => eprintln!("LibreOffice not installed; skipped the PDF smoke test"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}
