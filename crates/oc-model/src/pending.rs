// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Queued uploads (OFF-05, docs/34 §3.3, ADR-064): an image or file added offline is inserted
//! with `src` (images) or `url` (file attachments) = `oc-pending:<uuid>` and `pendingBy =
//! <userId>`, and rewritten to the uploaded URL on reconnect. The scheme is accepted only from
//! the person it names: a new or changed pending reference must carry the writer's own id
//! (MOD-01). Exports draw a placeholder ([`crate::export::PENDING_TEXT`]); nothing fetches it.

use serde_json::Value;

/// The scheme of a queued upload.
pub const SCHEME: &str = "oc-pending:";

/// A well-formed pending reference: `oc-pending:` + 1-64 of `[A-Za-z0-9-]`.
pub fn is_well_formed(v: &str) -> bool {
    v.strip_prefix(SCHEME).is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 64
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

/// Every pending reference in `doc` (any depth): `(node type, reference, pendingBy)`.
pub fn refs(doc: &Value) -> Vec<(String, String, String)> {
    fn walk(n: &Value, out: &mut Vec<(String, String, String)>) {
        let ty = n["type"].as_str().unwrap_or_default();
        let key = match ty {
            "image" => Some("src"),
            "fileAttachment" => Some("url"),
            _ => None,
        };
        if let Some(k) = key
            && let Some(v) = n["attrs"][k].as_str()
            && v.trim_start().starts_with(SCHEME)
        {
            let by = n["attrs"]["pendingBy"].as_str().unwrap_or_default();
            out.push((ty.to_string(), v.to_string(), by.to_string()));
        }
        if let Some(c) = n["content"].as_array() {
            for x in c {
                walk(x, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(doc, &mut out);
    out
}

/// The first pending reference that `after` has and `before` did not (new, or with another
/// `pendingBy`) which is malformed or does not name `writer`. `None`: the change is fine.
pub fn error(before: &Value, after: &Value, writer: &str) -> Option<String> {
    let had = refs(before);
    refs(after)
        .into_iter()
        .filter(|r| !had.contains(r))
        .find_map(|(ty, v, by)| {
            if !is_well_formed(v.trim()) {
                Some(format!("{ty}: a malformed {SCHEME} reference"))
            } else if by != writer {
                Some(format!(
                    "{ty}: an {SCHEME} upload must name its own device's person in pendingBy"
                ))
            } else {
                None
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(nodes: Value) -> Value {
        json!({"type": "doc", "content": nodes})
    }

    #[test]
    fn a_pending_upload_must_name_its_writer() {
        let empty = doc(json!([]));
        let mine = doc(
            json!([{"type": "image", "attrs": {"src": "oc-pending:9b1e-77", "pendingBy": "u1"}}]),
        );
        let theirs = doc(
            json!([{"type": "image", "attrs": {"src": "oc-pending:9b1e-77", "pendingBy": "u2"}}]),
        );
        let file = doc(
            json!([{"type": "columns", "content": [{"type": "column", "content": [
            {"type": "fileAttachment", "attrs": {"url": "oc-pending:abc", "pendingBy": "u2"}}]}]}]),
        );
        assert_eq!(error(&empty, &mine, "u1"), None);
        assert!(
            error(&empty, &theirs, "u1").is_some(),
            "someone else's name"
        );
        assert!(
            error(&empty, &file, "u1").is_some(),
            "nested file attachment"
        );
        assert_eq!(error(&empty, &file, "u2"), None);
        assert!(
            error(&mine, &theirs, "u1").is_some(),
            "re-pointing pendingBy"
        );
        assert_eq!(
            error(&theirs, &theirs, "u1"),
            None,
            "untouched references pass"
        );
        let bad =
            doc(json!([{"type": "image", "attrs": {"src": "oc-pending:../x", "pendingBy": "u1"}}]));
        assert!(error(&empty, &bad, "u1").is_some(), "malformed");
        let done = doc(json!([{"type": "image", "attrs": {"src": "https://cdn/x.png"}}]));
        assert_eq!(
            error(&theirs, &done, "u1"),
            None,
            "rewriting to a real URL is an ordinary edit"
        );
    }
}
