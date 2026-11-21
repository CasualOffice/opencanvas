//! Block patches from the host API (`POST /v1/files/:id/patch`, docs/04 §6).
//!
//! Blocks are addressed by the optional `blockId` attribute (docs/15 §4). Ops run against a
//! scratch copy of the doc so a failing op leaves the real doc untouched; the result is one
//! Yjs update that the room applies, logs and broadcasts like any client update.

use serde::Deserialize;
use serde_json::{Value, json};
use yrs::types::xml::XmlOut;
use yrs::{
    Doc, ReadTxn, StateVector, Transact, TransactionMut, Xml, XmlElementRef, XmlFragment,
    XmlFragmentRef,
};

use crate::import::{insert_children, markdown_to_json};
use crate::roots;

/// Attribute that carries a block's stable id.
pub const BLOCK_ID: &str = "blockId";
/// Most ops per request.
pub const MAX_OPS: usize = 500;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PatchOp {
    Append {
        #[serde(default)]
        markdown: Option<String>,
        #[serde(default)]
        blocks: Option<Vec<Value>>,
    },
    InsertAfter {
        block_id: String,
        #[serde(default)]
        markdown: Option<String>,
        #[serde(default)]
        blocks: Option<Vec<Value>>,
    },
    Replace {
        block_id: String,
        #[serde(default)]
        markdown: Option<String>,
        #[serde(default)]
        blocks: Option<Vec<Value>>,
    },
    Delete {
        block_id: String,
    },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PatchError {
    #[error("op {0}: no block with blockId {1:?}")]
    NotFound(usize, String),
    #[error("op {0}: {1}")]
    Invalid(usize, String),
    #[error("{0}")]
    Request(String),
}

#[derive(Debug, Default)]
pub struct PatchOutcome {
    /// v1 update that turns the original doc into the patched one (empty when nothing changed).
    pub update: Vec<u8>,
    /// `blockId`s of the top-level blocks the ops inserted, in order.
    pub block_ids: Vec<String>,
}

/// Which parent a block lives in.
enum Parent {
    Root(XmlFragmentRef),
    El(XmlElementRef),
}

impl Parent {
    fn insert(&self, txn: &mut TransactionMut, at: u32, nodes: &[Value]) -> u32 {
        match self {
            Parent::Root(f) => insert_children(txn, f, at, nodes),
            Parent::El(e) => insert_children(txn, e, at, nodes),
        }
    }
    fn remove(&self, txn: &mut TransactionMut, at: u32) {
        match self {
            Parent::Root(f) => f.remove_range(txn, at, 1),
            Parent::El(e) => e.remove_range(txn, at, 1),
        }
    }
}

fn find_in<T: ReadTxn, F>(txn: &T, parent: &F, id: &str) -> Option<(Parent, u32)>
where
    F: XmlFragment + Clone + Into<ParentOf>,
{
    for (i, child) in parent.children(txn).enumerate() {
        if let XmlOut::Element(el) = child {
            let matches = el
                .get_attribute(txn, BLOCK_ID)
                .is_some_and(|v| v.to_string(txn) == id);
            if matches {
                return Some((parent.clone().into().0, i as u32));
            }
            if let Some(hit) = find_in(txn, &el, id) {
                return Some(hit);
            }
        }
    }
    None
}

/// Helper so `find_in` can name the parent of a hit whatever its Y type.
struct ParentOf(Parent);
impl From<XmlFragmentRef> for ParentOf {
    fn from(f: XmlFragmentRef) -> Self {
        ParentOf(Parent::Root(f))
    }
}
impl From<XmlElementRef> for ParentOf {
    fn from(e: XmlElementRef) -> Self {
        ParentOf(Parent::El(e))
    }
}

/// Turns an op's `markdown` / `blocks` into top-level Tiptap nodes with ids assigned.
fn op_blocks(
    n: usize,
    markdown: &Option<String>,
    blocks: &Option<Vec<Value>>,
    new_id: &mut dyn FnMut() -> String,
    ids: &mut Vec<String>,
) -> Result<Vec<Value>, PatchError> {
    let mut nodes = match (markdown, blocks) {
        (Some(md), None) => markdown_to_json(md)["content"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
        (None, Some(b)) => b.clone(),
        _ => {
            return Err(PatchError::Invalid(
                n,
                "exactly one of markdown or blocks is required".into(),
            ));
        }
    };
    for node in &mut nodes {
        let ty = node.get("type").and_then(Value::as_str).unwrap_or_default();
        if ty.is_empty() || ty == "text" || !node.is_object() {
            return Err(PatchError::Invalid(
                n,
                "blocks must be Tiptap block nodes ({\"type\": …})".into(),
            ));
        }
        if node.get("attrs").is_some_and(|a| !a.is_object()) {
            return Err(PatchError::Invalid(n, "attrs must be an object".into()));
        }
        let attrs = node
            .as_object_mut()
            .expect("checked")
            .entry("attrs")
            .or_insert_with(|| json!({}));
        let id = match attrs.get(BLOCK_ID).and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => {
                let id = new_id();
                attrs[BLOCK_ID] = Value::String(id.clone());
                id
            }
        };
        ids.push(id);
    }
    Ok(nodes)
}

/// Applies `ops` to a copy of `doc` and returns the update that reproduces them.
pub fn apply_patch(
    doc: &Doc,
    ops: &[PatchOp],
    new_id: &mut dyn FnMut() -> String,
) -> Result<PatchOutcome, PatchError> {
    if ops.is_empty() {
        return Err(PatchError::Request("ops is empty".into()));
    }
    if ops.len() > MAX_OPS {
        return Err(PatchError::Request(format!("at most {MAX_OPS} ops")));
    }
    let scratch = crate::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    crate::ocanvas::apply_update_bytes(&scratch, &state)
        .map_err(|e| PatchError::Request(e.to_string()))?;
    let before = scratch.transact().state_vector();
    let content = scratch.get_or_insert_xml_fragment(roots::CONTENT);
    let mut ids = Vec::new();
    {
        let mut txn = scratch.transact_mut();
        for (n, op) in ops.iter().enumerate() {
            match op {
                PatchOp::Append { markdown, blocks } => {
                    let nodes = op_blocks(n, markdown, blocks, new_id, &mut ids)?;
                    let at = content.len(&txn);
                    insert_children(&mut txn, &content, at, &nodes);
                }
                PatchOp::InsertAfter {
                    block_id,
                    markdown,
                    blocks,
                }
                | PatchOp::Replace {
                    block_id,
                    markdown,
                    blocks,
                } => {
                    let (parent, at) = find_in(&txn, &content, block_id)
                        .ok_or_else(|| PatchError::NotFound(n, block_id.clone()))?;
                    let nodes = op_blocks(n, markdown, blocks, new_id, &mut ids)?;
                    if matches!(op, PatchOp::Replace { .. }) {
                        parent.remove(&mut txn, at);
                        parent.insert(&mut txn, at, &nodes);
                    } else {
                        parent.insert(&mut txn, at + 1, &nodes);
                    }
                }
                PatchOp::Delete { block_id } => {
                    let (parent, at) = find_in(&txn, &content, block_id)
                        .ok_or_else(|| PatchError::NotFound(n, block_id.clone()))?;
                    parent.remove(&mut txn, at);
                }
            }
        }
    }
    let update = scratch.transact().encode_state_as_update_v1(&before);
    Ok(PatchOutcome {
        update,
        block_ids: ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc_to_json;
    use crate::import::apply_document_json;

    fn ops(v: Value) -> Vec<PatchOp> {
        serde_json::from_value(v).unwrap()
    }

    fn seeded() -> Doc {
        let doc = crate::new_doc();
        apply_document_json(
            &doc,
            &json!({"content": [
                {"type":"paragraph","attrs":{"blockId":"b_1"},"content":[{"type":"text","text":"one"}]},
                {"type":"bulletList","content":[{"type":"listItem","attrs":{"blockId":"b_li"},"content":[
                    {"type":"paragraph","content":[{"type":"text","text":"item"}]}]}]},
                {"type":"paragraph","attrs":{"blockId":"b_2"},"content":[{"type":"text","text":"two"}]}
            ]}),
        );
        doc
    }

    fn apply(doc: &Doc, v: Value) -> Result<PatchOutcome, PatchError> {
        let mut n = 0;
        let out = apply_patch(doc, &ops(v), &mut || {
            n += 1;
            format!("b_new{n}")
        })?;
        crate::ocanvas::apply_update_bytes(doc, &out.update).unwrap();
        Ok(out)
    }

    fn texts(doc: &Doc) -> Vec<String> {
        fn text(v: &Value) -> String {
            match v["text"].as_str() {
                Some(t) => t.to_string(),
                None => v["content"]
                    .as_array()
                    .map(|a| a.iter().map(text).collect())
                    .unwrap_or_default(),
            }
        }
        doc_to_json(doc)["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(text)
            .collect()
    }

    #[test]
    fn append_insert_replace_delete() {
        let doc = seeded();
        let out = apply(
            &doc,
            json!([
                {"op":"append","markdown":"- [ ] Follow up"},
                {"op":"insertAfter","blockId":"b_1","blocks":[{"type":"callout","attrs":{"tone":"blue"},
                    "content":[{"type":"paragraph","content":[{"type":"text","text":"hey"}]}]}]},
                {"op":"replace","blockId":"b_2","markdown":"## New **heading**"},
                {"op":"delete","blockId":"b_li"}
            ]),
        )
        .unwrap();
        assert_eq!(out.block_ids, ["b_new1", "b_new2", "b_new3"]);
        assert_eq!(
            texts(&doc),
            ["one", "hey", "", "New heading", "Follow up"],
            "{:#}",
            doc_to_json(&doc)
        );
        let json = doc_to_json(&doc);
        let c = json["content"].as_array().unwrap();
        assert_eq!(c[1]["type"], "callout");
        assert_eq!(c[1]["attrs"]["blockId"], "b_new2");
        assert_eq!(c[1]["attrs"]["tone"], "blue");
        assert_eq!(c[2]["type"], "bulletList");
        assert!(c[2].get("content").is_none(), "nested listItem deleted");
        assert_eq!(c[3]["type"], "heading");
        assert_eq!(c[3]["attrs"]["blockId"], "b_new3");
        assert_eq!(c[3]["content"][1]["marks"][0]["type"], "bold");
        assert_eq!(c[4]["type"], "taskList");
        // The replaced block is gone and new ids are addressable.
        apply(&doc, json!([{"op":"delete","blockId":"b_new3"}])).unwrap();
        assert_eq!(texts(&doc), ["one", "hey", "", "Follow up"]);
    }

    #[test]
    fn failing_op_leaves_the_doc_untouched() {
        let doc = seeded();
        let before = doc_to_json(&doc);
        let err = apply(
            &doc,
            json!([{"op":"append","markdown":"x"},{"op":"delete","blockId":"b_missing"}]),
        )
        .unwrap_err();
        assert_eq!(err, PatchError::NotFound(1, "b_missing".into()));
        assert_eq!(doc_to_json(&doc), before);
        assert!(matches!(
            apply(&doc, json!([{"op":"append"}])),
            Err(PatchError::Invalid(0, _))
        ));
        assert!(matches!(
            apply(
                &doc,
                json!([{"op":"append","blocks":[{"type":"text","text":"x"}]}])
            ),
            Err(PatchError::Invalid(0, _))
        ));
        assert!(matches!(
            apply(&doc, json!([])),
            Err(PatchError::Request(_))
        ));
    }

    #[test]
    fn caller_ids_are_kept() {
        let doc = crate::new_doc();
        let out = apply(
            &doc,
            json!([{"op":"append","blocks":[{"type":"paragraph","attrs":{"blockId":"mine"}}]}]),
        )
        .unwrap();
        assert_eq!(out.block_ids, ["mine"]);
    }
}
