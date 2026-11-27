// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! MOD-01: block schema validation. Every rule has a negative case; unknown content is a
//! warning and is kept.

use oc_model::import::{apply_document_json, markdown_to_json};
use oc_model::patch::{PatchError, PatchOp, apply_patch};
use oc_model::{CommitInfo, new_doc, read_ocanvas, validate_blocks, validate_json, write_ocanvas};
use serde_json::{Value, json};

fn t(s: &str) -> Value {
    json!({"type":"text","text":s})
}
fn p(s: &str) -> Value {
    json!({"type":"paragraph","content":[t(s)]})
}
fn doc(content: Value) -> Value {
    json!({"type":"doc","content":content})
}

#[test]
fn every_rule_has_a_negative_case() {
    let cases: Vec<(Value, &str)> = vec![
        // node shape
        (json!("text"), "/content/0: a node must be an object"),
        (json!({"attrs":{}}), "a node needs a string \"type\""),
        (
            json!({"type":"paragraph","attrs":[1]}),
            "/content/0/attrs: attrs must be an object",
        ),
        (
            json!({"type":"paragraph","content":{}}),
            "/content/0/content: content must be an array",
        ),
        // attribute value types
        (
            json!({"type":"heading","attrs":{"level":7},"content":[t("x")]}),
            "heading.level must be an integer 1-3",
        ),
        (
            json!({"type":"heading","attrs":{"level":"2"}}),
            "heading.level must be an integer 1-3",
        ),
        (
            json!({"type":"orderedList","attrs":{"start":"x"},"content":[{"type":"listItem","content":[p("a")]}]}),
            "orderedList.start must be an integer",
        ),
        (
            json!({"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":"yes"},"content":[p("a")]}]}),
            "/content/0/content/0/attrs/checked: taskItem.checked must be true or false",
        ),
        (
            json!({"type":"codeBlock","attrs":{"language":3}}),
            "codeBlock.language must be a string",
        ),
        (
            json!({"type":"image","attrs":{"src":"x","align":"middle"}}),
            "image.align must be one of left, right",
        ),
        (
            json!({"type":"image","attrs":{"src":"x","width":"wide"}}),
            "image.width must be a number",
        ),
        (
            json!({"type":"callout","attrs":{"tone":5},"content":[p("a")]}),
            "callout.tone must be a string",
        ),
        (
            json!({"type":"toggle","attrs":{"open":1},"content":[{"type":"toggleSummary"},{"type":"toggleContent","content":[p("a")]}]}),
            "toggle.open must be true or false",
        ),
        (
            json!({"type":"database","attrs":{"dbId":""}}),
            "database.dbId must be a non-empty string",
        ),
        (
            json!({"type":"board","attrs":{"boardId":4}}),
            "board.boardId must be a non-empty string",
        ),
        (
            json!({"type":"bookmark","attrs":{"url":["x"]}}),
            "bookmark.url must be a string",
        ),
        (
            json!({"type":"embed","attrs":{"provider":false}}),
            "embed.provider must be a string",
        ),
        (
            json!({"type":"fileAttachment","attrs":{"size":-1}}),
            "fileAttachment.size must be a number ≥ 0",
        ),
        (
            json!({"type":"fileAttachment","attrs":{"height":5000}}),
            "fileAttachment.height must be a number 240-1600",
        ),
        (
            json!({"type":"fileAttachment","attrs":{"display":"inline"}}),
            "fileAttachment.display must be one of card, preview",
        ),
        (
            json!({"type":"columns","attrs":{"widths":"half,half"},"content":[{"type":"column","content":[p("a")]},{"type":"column","content":[p("b")]}]}),
            "columns.widths must be whole percents",
        ),
        (
            json!({"type":"columns","content":[{"type":"column","attrs":{"title":1},"content":[p("a")]},{"type":"column","content":[p("b")]}]}),
            "column.title must be a string",
        ),
        (
            json!({"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":0},"content":[p("a")]}]}]}),
            "tableCell.colspan must be an integer 1-1000",
        ),
        (
            json!({"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","attrs":{"colwidth":"100"},"content":[p("a")]}]}]}),
            "tableHeader.colwidth must be an array of widths",
        ),
        (
            json!({"type":"paragraph","content":[{"type":"mention","attrs":{"id":""}}]}),
            "mention.id must be a non-empty string",
        ),
        (
            json!({"type":"paragraph","content":[{"type":"dateMention","attrs":{"date":"2026-13-01"}}]}),
            "dateMention.date must be a YYYY-MM-DD date",
        ),
        (
            json!({"type":"paragraph","attrs":{"blockId":7}}),
            "blockId must be a non-empty string",
        ),
        // content rules
        (
            json!({"type":"bulletList","content":[p("a")]}),
            "paragraph is not allowed inside bulletList",
        ),
        (
            json!({"type":"bulletList"}),
            "bulletList needs at least 1 child node",
        ),
        (
            json!({"type":"orderedList","content":[{"type":"taskItem","content":[p("a")]}]}),
            "taskItem is not allowed inside orderedList",
        ),
        (
            json!({"type":"taskList","content":[{"type":"listItem","content":[p("a")]}]}),
            "listItem is not allowed inside taskList",
        ),
        (
            json!({"type":"bulletList","content":[{"type":"listItem"}]}),
            "listItem needs at least 1 child node",
        ),
        (
            json!({"type":"blockquote","content":[t("loose text")]}),
            "text is not allowed inside blockquote",
        ),
        (
            json!({"type":"paragraph","content":[p("nested")]}),
            "paragraph is not allowed inside paragraph",
        ),
        (
            json!({"type":"heading","attrs":{"level":1},"content":[{"type":"horizontalRule"}]}),
            "horizontalRule is not allowed inside heading",
        ),
        (
            json!({"type":"codeBlock","content":[{"type":"text","text":"x","marks":[{"type":"bold"}]}]}),
            "text inside codeBlock can't have marks",
        ),
        (
            json!({"type":"codeBlock","content":[{"type":"hardBreak"}]}),
            "hardBreak is not allowed inside codeBlock",
        ),
        (
            json!({"type":"horizontalRule","content":[p("a")]}),
            "paragraph is not allowed inside horizontalRule",
        ),
        (
            json!({"type":"image","content":[t("a")]}),
            "text is not allowed inside image",
        ),
        (
            json!({"type":"callout","content":[{"type":"heading","attrs":{"level":1}}]}),
            "heading is not allowed inside callout",
        ),
        (
            json!({"type":"toggle","content":[{"type":"toggleContent","content":[p("a")]}]}),
            "toggle must contain exactly toggleSummary, toggleContent",
        ),
        (
            json!({"type":"toggle","content":[{"type":"toggleSummary"},{"type":"toggleContent"}]}),
            "toggleContent needs at least 1 child node",
        ),
        (
            json!({"type":"columns","content":[p("a")]}),
            "paragraph is not allowed inside columns",
        ),
        (
            json!({"type":"columns","content":[{"type":"column"},{"type":"column","content":[p("b")]}]}),
            "column needs at least 1 child node",
        ),
        (
            json!({"type":"table","content":[{"type":"tableCell","content":[p("a")]}]}),
            "tableCell is not allowed inside table",
        ),
        (
            json!({"type":"table","content":[{"type":"tableRow","content":[p("a")]}]}),
            "paragraph is not allowed inside tableRow",
        ),
        (
            json!({"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell"}]}]}),
            "tableCell needs at least 1 child node",
        ),
        (
            json!({"type":"database","attrs":{"dbId":"d"},"content":[p("a")]}),
            "paragraph is not allowed inside database",
        ),
        (
            json!({"type":"listItem","content":[p("a")]}),
            "listItem is not allowed inside doc",
        ),
        // text and marks
        (
            json!({"type":"paragraph","content":[{"type":"text","text":""}]}),
            "a text node needs a non-empty string \"text\"",
        ),
        (
            json!({"type":"paragraph","content":[{"type":"text","text":"a","marks":{}}]}),
            "marks must be an array",
        ),
        (
            json!({"type":"paragraph","content":[{"type":"text","text":"a","marks":[{}]}]}),
            "a mark needs a string \"type\"",
        ),
        (
            json!({"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"link","attrs":{"href":1}}]}]}),
            "link.href must be a string",
        ),
        (
            json!({"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"commentMark","attrs":{"threadId":""}}]}]}),
            "commentMark.threadId must be a non-empty string",
        ),
        (
            json!({"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"bold","attrs":"x"}]}]}),
            "attrs must be an object",
        ),
    ];
    let mut failed = vec![];
    for (block, want) in cases {
        let r = validate_json(&doc(json!([block.clone()])));
        let all: Vec<String> = r.errors.iter().map(ToString::to_string).collect();
        if !all.iter().any(|e| e.contains(want)) {
            failed.push(format!("{block}\n  want {want:?}\n  got  {all:?}"));
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn database_board_and_document_structure() {
    let cases: Vec<(Value, &str)> = vec![
        (json!([]), ": the document must be a JSON object"),
        (
            json!({"type":"page"}),
            "/type: the document type must be \"doc\"",
        ),
        (json!({"content":{}}), "/content: content must be an array"),
        (json!({"meta":[]}), "/meta: meta must be an object"),
        (
            json!({"meta":{"title":3}}),
            "/meta/title: meta.title must be a string",
        ),
        (
            json!({"databases":{"d":[]}}),
            "/databases/d: a database must be an object",
        ),
        (
            json!({"databases":{"d":{"fields":{}}}}),
            "/databases/d/fields: fields must be an array",
        ),
        (
            json!({"databases":{"d":{"fields":[{"name":"x"}]}}}),
            "/databases/d/fields/0/id: a field needs a non-empty string id",
        ),
        (
            json!({"databases":{"d":{"fields":[{"id":"a"},{"id":"a"}]}}}),
            "/databases/d/fields/1/id: field id \"a\" is used twice",
        ),
        (
            json!({"databases":{"d":{"fields":[{"id":"a","type":5}]}}}),
            "field type must be a string",
        ),
        (
            json!({"databases":{"d":{"fields":[{"id":"a","options":[{"c":"red"}]}]}}}),
            "/databases/d/fields/0/options/0: an option needs a string \"v\"",
        ),
        (
            json!({"databases":{"d":{"fields":[{"id":"a","options":"nope"}]}}}),
            "options must be an array of {v, c}",
        ),
        (
            json!({"databases":{"d":{"rows":[]}}}),
            "/databases/d/rows: rows must be an object",
        ),
        (
            json!({"databases":{"d":{"rows":{"r":1}}}}),
            "/databases/d/rows/r: a row must be an object",
        ),
        (
            json!({"databases":{"d":{"order":[1]}}}),
            "/databases/d/order/0: order must list row ids",
        ),
        (
            json!({"databases":{"d":{"views":"table"}}}),
            "database views must be an object",
        ),
        (
            json!({"boards":{"b":{"shapes":[]}}}),
            "/boards/b/shapes: shapes must be an object",
        ),
        (
            json!({"boards":{"b":{"shapes":{"s":{"x":1}}}}}),
            "/boards/b/shapes/s/type: a shape needs a string type",
        ),
        (
            json!({"boards":{"b":{"shapes":{"s":{"type":"rect","x":"1"}}}}}),
            "shape x must be a number",
        ),
        (
            json!({"boards":{"b":{"shapes":{"s":{"type":"pen","pts":[[1]]}}}}}),
            "pts must be an array of [x, y] numbers",
        ),
        (
            json!({"boards":{"b":{"shapes":{"s":{"type":"arrow","start":"s2"}}}}}),
            "start must be {shapeId, anchor}",
        ),
        (
            json!({"boards":{"b":{"shapes":{"s":{"type":"sticky","text":5}}}}}),
            "shape text must be a string",
        ),
        (
            json!({"boards":{"b":{"order":"s"}}}),
            "/boards/b/order: order must be an array",
        ),
        (
            json!({"comments":{"t":{"messages":{}}}}),
            "/comments/t/messages: messages must be an array",
        ),
    ];
    let mut failed = vec![];
    for (d, want) in cases {
        let r = validate_json(&d);
        let all: Vec<String> = r.errors.iter().map(ToString::to_string).collect();
        if !all.iter().any(|e| e.contains(want)) {
            failed.push(format!("{d}\n  want {want:?}\n  got  {all:?}"));
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn unknown_content_passes_with_warnings() {
    let d = json!({
        "type": "doc",
        "content": [
            {"type":"futureBlock","attrs":{"weird":[1]},"content":[p("child")]},
            {"type":"paragraph","attrs":{"futureAttr":"kept","blockId":"b_1"},"content":[
                {"type":"text","text":"x","marks":[{"type":"sparkle"},{"type":"textColor","attrs":{"color":"teal"}}]},
                {"type":"futureInline"}
            ]},
            {"type":"paragraph","attrs":{"blockId":"b_1"}},
            {"type":"database","attrs":{"dbId":"missing"}},
            {"type":"columns","attrs":{"widths":"50,50"},"content":[{"type":"column","content":[p("only")]}]},
            t("bare top-level text")
        ],
        "databases": {"d": {"fields":[{"id":"f","type":"stars"}], "order":["gone"], "rows":{}}},
        "boards": {"b": {"shapes":{"s":{"type":"hexagon"}}, "order":["s","gone"]}}
    });
    let r = validate_json(&d);
    assert!(r.is_ok(), "{:?}", r.errors);
    let w: Vec<String> = r.warnings.iter().map(ToString::to_string).collect();
    for want in [
        "/content/0: unknown node type \"futureBlock\"",
        "/content/1/attrs/futureAttr: unknown attribute",
        "/content/1/content/0/marks/0: unknown mark type \"sparkle\"",
        "textColor.color \"teal\" is not one of",
        "/content/1/content/1: unknown node type \"futureInline\"",
        "/content/2/attrs/blockId: blockId \"b_1\" is also used at /content/1",
        "/content/3/attrs/dbId: database \"missing\" is not in databases",
        "/content/4: columns has 1 columns",
        "widths lists 2 columns but there are 1",
        "/databases/d/fields/0/type: unknown field type \"stars\"",
        "/databases/d/order/0: row \"gone\" is not in rows",
        "/boards/b/shapes/s/type: unknown shape type \"hexagon\"",
        "/boards/b/order/1: shape \"gone\" is not in shapes",
        "/content/5: text at the top level, outside a block (kept)",
    ] {
        assert!(
            w.iter().any(|x| x.contains(want)),
            "missing {want:?} in {w:#?}"
        );
    }
    // ...and the unknown content survives a write → read with the warnings intact.
    let ydoc = new_doc();
    apply_document_json(&ydoc, &d);
    let bytes = write_ocanvas(&ydoc, &CommitInfo::default()).unwrap();
    let back = read_ocanvas(&bytes).expect("warnings never reject a file");
    let again = oc_model::validate(&back.doc);
    assert!(again.is_ok() && !again.warnings.is_empty());
}

#[test]
fn converters_produce_valid_documents() {
    let md = "# Title\n\nSome **bold** and [a link](https://x.y) text.\n\n- one\n- two\n\n1. a\n2. b\n\n- [ ] todo\n- [x] done\n\n> quote\n\n```rust\nfn main() {}\n```\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![alt](https://x.y/i.png)\n";
    let r = validate_json(&markdown_to_json(md));
    assert!(r.is_ok() && r.warnings.is_empty(), "{r:?}");
    let html = "<h2>T</h2><p><b>b</b> <i>i</i> <u>u</u> <s>s</s> <code>c</code> <mark>m</mark><br><a href='https://x.y'>l</a></p><ul><li>a</li></ul><ol><li>b</li></ol><blockquote><p>q</p></blockquote><pre><code class='language-js'>x</code></pre><hr><table><tr><th>h</th></tr><tr><td>d</td></tr></table><img src='https://x.y/i.png' alt='a'>";
    let r = validate_json(&oc_model::html::html_to_json(html));
    assert!(r.is_ok(), "{r:?}");
}

/// A `.ocanvas` whose document breaks the schema is refused with the path of the bad node.
#[test]
fn read_ocanvas_rejects_an_invalid_document() {
    let ydoc = new_doc();
    apply_document_json(
        &ydoc,
        &doc(json!([p("ok"), {"type":"heading","attrs":{"level":9},"content":[t("bad")]}])),
    );
    let bytes = write_ocanvas(&ydoc, &CommitInfo::default()).unwrap();
    let err = read_ocanvas(&bytes)
        .err()
        .expect("must be refused")
        .to_string();
    assert!(
        err.contains("/content/1/attrs/level") && err.contains("heading.level"),
        "{err}"
    );
}

#[test]
fn patch_refuses_invalid_blocks_with_the_path() {
    let ydoc = new_doc();
    let ops: Vec<PatchOp> = serde_json::from_value(json!([
        {"op":"append","blocks":[p("fine")]},
        {"op":"append","blocks":[p("fine"), {"type":"bulletList","content":[p("not an item")]}]}
    ]))
    .unwrap();
    let err = apply_patch(&ydoc, &ops, &mut || "b_x".into()).unwrap_err();
    assert_eq!(
        err,
        PatchError::Invalid(
            1,
            "blocks/1/content/0: paragraph is not allowed inside bulletList".into()
        )
    );
    // Unknown blocks are still accepted (and kept).
    let ok: Vec<PatchOp> =
        serde_json::from_value(json!([{"op":"append","blocks":[{"type":"futureBlock"}]}])).unwrap();
    assert!(apply_patch(&ydoc, &ok, &mut || "b_y".into()).is_ok());
    // validate_blocks reports relative paths for any caller.
    let r = validate_blocks("blocks", &[json!({"type":"heading","attrs":{"level":0}})]);
    assert_eq!(
        r.first_error().unwrap(),
        "blocks/0/attrs/level: heading.level must be an integer 1-3"
    );
}

/// Deeply nested content is refused with an error, not a stack overflow (the same class as
/// SEC-29): a document built in memory has no JSON parser depth cap in front of it.
#[test]
fn deeply_nested_content_is_an_error_not_a_crash() {
    // Built by hand: `json!` would serialise the inner value recursively and overflow first.
    fn wrap(ty: &str, inner: Value) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("type".into(), Value::String(ty.into()));
        m.insert("content".into(), Value::Array(vec![inner]));
        Value::Object(m)
    }
    let mut node = json!({"type": "paragraph", "content": [{"type": "text", "text": "x"}]});
    for _ in 0..200_000 {
        node = wrap("blockquote", node);
    }
    let doc = wrap("doc", node);
    let report = validate_json(&doc);
    assert!(
        report.errors.iter().any(|e| e.message.contains("nested")),
        "{:?}",
        report.errors.first()
    );
    // Dropping a 200 000-deep serde_json::Value recurses too; leak it so the test checks only
    // the validator (the server never builds such a value from a request: serde caps parse depth).
    std::mem::forget(doc);
}

/// SHEET-08: a Spreadsheet block is a known node: `sheetId` must be an id, it has no content,
/// and a block whose sheets are missing from the `sheets` root is a warning.
#[test]
fn spreadsheet_blocks_follow_the_schema() {
    let d = json!({"type": "doc", "content": [
        {"type": "spreadsheet", "attrs": {"sheetId": "sh1"}},
        {"type": "spreadsheet", "attrs": {"sheetId": "gone"}},
    ], "sheets": {"sh1": {"order": [], "sheets": {}, "styles": {}}}});
    let r = validate_json(&d);
    assert!(r.is_ok(), "{:?}", r.errors);
    let w: Vec<String> = r.warnings.iter().map(ToString::to_string).collect();
    assert!(
        w.iter()
            .any(|w| w.contains("/content/1/attrs/sheetId: sheet \"gone\" is not in sheets")),
        "{w:?}"
    );
    assert_eq!(w.len(), 1, "{w:?}");
    let bad = validate_blocks(
        "blocks",
        &[json!({"type": "spreadsheet", "attrs": {"sheetId": 7}})],
    );
    assert!(!bad.is_ok());
    let child = validate_blocks(
        "blocks",
        &[json!({"type": "spreadsheet", "attrs": {"sheetId": "a"}, "content": [t("x")]})],
    );
    assert!(!child.is_ok(), "a spreadsheet has no content");
}
