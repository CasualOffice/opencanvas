// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Role filter for `comment` sessions: an update may only touch the `comments` root.

use std::collections::HashSet;

use oc_model::roots;
use yrs::updates::decoder::Decode;
use yrs::{BranchID, DeepObservable, Doc, ReadTxn, StateVector, Transact, Update, WriteTxn};

/// Applies `update` to a scratch copy of `doc` and reports whether every change landed
/// under the `comments` root. Updates that cannot fully integrate are refused.
pub fn touches_only_comments(doc: &Doc, update: &[u8]) -> bool {
    let Ok(update) = Update::decode_v1(update) else {
        return false;
    };
    let scratch = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    if oc_model::ocanvas::apply_update_bytes(&scratch, &state).is_err() {
        return false;
    }
    let before: HashSet<String> = {
        let mut txn = scratch.transact_mut();
        let names: Vec<String> = txn.root_refs().map(|(n, _)| n.to_string()).collect();
        // Give roots of unknown type a concrete type so their changes produce events.
        for n in names.iter().filter(|n| *n != roots::CONTENT) {
            txn.get_or_insert_map(n.as_str());
        }
        names.into_iter().collect()
    };
    let mut txn = scratch.transact_mut();
    if txn.apply_update(update).is_err() {
        return false;
    }
    txn.commit();
    let foreign_change = txn
        .changed_parent_types()
        .iter()
        .any(|b| matches!(b.id(), BranchID::Root(name) if &*name != roots::COMMENTS));
    let new_root = txn
        .root_refs()
        .any(|(n, _)| n != roots::COMMENTS && !before.contains(n));
    let pending = txn.store().pending_update().is_some() || txn.store().pending_ds().is_some();
    !foreign_change && !new_root && !pending
}

/// True when `update` would change anything under the root `root` (DGM-17: the server-written
/// `icons`). Cheap when the document has no such root and the update doesn't name it: an update
/// can only reach a subtree through its root's name or items already in it. Otherwise the update
/// is applied to a scratch copy with a deep observer on the root; updates that can't fully
/// integrate count as touching it.
pub fn touches_root(doc: &Doc, update: &[u8], root: &str) -> bool {
    let present = doc.transact().root_refs().any(|(n, _)| n == root);
    if !present && !update.windows(root.len()).any(|w| w == root.as_bytes()) {
        return false;
    }
    let Ok(update) = Update::decode_v1(update) else {
        return true;
    };
    let scratch = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    if oc_model::ocanvas::apply_update_bytes(&scratch, &state).is_err() {
        return true;
    }
    let hit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let map = scratch.get_or_insert_map(root);
    let h = hit.clone();
    map.observe_deep("oc-root-guard", move |_, _| {
        h.store(true, std::sync::atomic::Ordering::Relaxed)
    });
    let mut txn = scratch.transact_mut();
    if txn.apply_update(update).is_err() {
        return true;
    }
    txn.commit();
    let pending = txn.store().pending_update().is_some() || txn.store().pending_ds().is_some();
    drop(txn);
    pending && present || hit.load(std::sync::atomic::Ordering::Relaxed)
}

/// `extBlock` elements in the content tree.
fn ext_block_count<T: ReadTxn>(txn: &T) -> usize {
    count_tags(txn, &[oc_model::ext::NODE])
}

/// Elements named one of `tags` in the content tree.
fn count_tags<T: ReadTxn>(txn: &T, tags: &[&str]) -> usize {
    use yrs::XmlFragment;
    use yrs::types::xml::XmlOut;
    fn walk<T: ReadTxn>(
        txn: &T,
        children: yrs::types::xml::XmlNodes<'_, T>,
        tags: &[&str],
        n: &mut usize,
        depth: usize,
    ) {
        for c in children {
            if let XmlOut::Element(el) = c {
                if tags.contains(&el.tag().as_ref()) {
                    *n += 1;
                }
                if depth < 64 {
                    walk(txn, el.children(txn), tags, n, depth + 1);
                }
            }
        }
    }
    let mut n = 0;
    if let Some(f) = txn.get_xml_fragment(roots::CONTENT) {
        walk(txn, f.children(txn), tags, &mut n, 0);
    }
    n
}

const LIVE_TAGS: [&str; 2] = [oc_model::live::LIVE_BLOCK, oc_model::live::BLOCK_REF];

/// The live block references of the content tree as `(node, blockId, fileId)` (LIVE-07 usage
/// events), or `None` when an update cannot change them: the document has none and `update`
/// names none.
pub fn live_refs_if_relevant(
    doc: &Doc,
    update: &[u8],
) -> Option<HashSet<(String, String, String)>> {
    let named = LIVE_TAGS
        .iter()
        .any(|t| update.windows(t.len()).any(|w| w == t.as_bytes()));
    if !named && count_tags(&doc.transact(), &LIVE_TAGS) == 0 {
        return None;
    }
    Some(live_refs(doc))
}

/// See [`live_refs_if_relevant`].
pub fn live_refs(doc: &Doc) -> HashSet<(String, String, String)> {
    use yrs::types::xml::XmlOut;
    use yrs::{Xml, XmlFragment};
    fn walk<T: ReadTxn>(
        txn: &T,
        children: yrs::types::xml::XmlNodes<'_, T>,
        out: &mut HashSet<(String, String, String)>,
        depth: usize,
    ) {
        for c in children {
            if let XmlOut::Element(el) = c {
                let tag = el.tag().to_string();
                if LIVE_TAGS.contains(&tag.as_str()) {
                    let a = |k: &str| {
                        el.get_attribute(txn, k)
                            .map(|v| v.to_string(txn))
                            .unwrap_or_default()
                    };
                    out.insert((tag, a("blockId"), a("fileId")));
                }
                if depth < 64 {
                    walk(txn, el.children(txn), out, depth + 1);
                }
            }
        }
    }
    let txn = doc.transact();
    let mut out = HashSet::new();
    if let Some(f) = txn.get_xml_fragment(roots::CONTENT) {
        walk(&txn, f.children(&txn), &mut out, 0);
    }
    out
}

/// Who is writing, for the live block rules (LIVE-02, docs/27 §2.2 and §2.5).
#[derive(Debug, Clone, Copy)]
pub struct LiveRules {
    /// `[host.flags] live_blocks`: new references may be added.
    pub on: bool,
    /// `[host.live] snapshot`.
    pub policy: oc_model::live::Snapshot,
    /// May add references (`perms.live`; the server's own writes always).
    pub may_embed: bool,
    /// Keeps `liveBlock`/`blockRef` nodes (`caps=live`; the server always).
    pub keeps_nodes: bool,
}

/// What [`live_check`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveVerdict {
    Ok,
    /// A client without `caps=live` removed a reference: an editor older than 0.3 (4426).
    OutOfDate,
    /// The update breaks a rule; the message says which.
    Refused(String),
}

/// The live block rules for one update (LIVE-02): an editor without `caps=live` may not remove
/// a `liveBlock` or `blockRef` (what y-prosemirror does to nodes its schema lacks); adding one
/// needs the feature on and `perms.live`; and the document after the update may not break a
/// rule it did not already break: the depth rule (`meta.kind = "live"` holds no references),
/// at most 50 references, and the snapshot policy. Free when the document has no references
/// and the update names none; otherwise one scratch copy, O(document).
pub fn live_check(doc: &Doc, update: &[u8], rules: &LiveRules) -> LiveVerdict {
    let has = |needle: &[u8]| update.windows(needle.len()).any(|w| w == needle);
    let named = LIVE_TAGS.iter().any(|t| has(t.as_bytes()));
    let before = count_tags(&doc.transact(), &LIVE_TAGS);
    if before == 0 && !named {
        return LiveVerdict::Ok;
    }
    let touches_attrs = has(b"snapshot") || has(b"title") || has(b"kind");
    if !named && rules.keeps_nodes && !touches_attrs {
        return LiveVerdict::Ok;
    }
    let Ok(decoded) = Update::decode_v1(update) else {
        return LiveVerdict::Refused("malformed update".into());
    };
    let scratch = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    if oc_model::ocanvas::apply_update_bytes(&scratch, &state).is_err() {
        return LiveVerdict::Ok;
    }
    {
        let mut txn = scratch.transact_mut();
        if txn.apply_update(decoded).is_err() {
            return LiveVerdict::Refused("update could not be applied".into());
        }
    }
    let after = count_tags(&scratch.transact(), &LIVE_TAGS);
    if after < before && !rules.keeps_nodes {
        return LiveVerdict::OutOfDate;
    }
    if after > before {
        if !rules.on {
            return LiveVerdict::Refused(
                "live blocks are off for this host ([host.flags] live_blocks)".into(),
            );
        }
        if !rules.may_embed {
            return LiveVerdict::Refused("adding live blocks needs perms.live".into());
        }
    }
    let had: HashSet<String> =
        oc_model::live::rule_errors(&oc_model::doc_to_json(doc), rules.policy)
            .into_iter()
            .collect();
    match oc_model::live::rule_errors(&oc_model::doc_to_json(&scratch), rules.policy)
        .into_iter()
        .find(|e| !had.contains(e))
    {
        Some(e) => LiveVerdict::Refused(e),
        None => LiveVerdict::Ok,
    }
}

/// True when `update` removes an `extBlock` from the document (BSDK-02): what an editor older
/// than 0.2 does to a node its schema lacks. Cheap when the document has none. Updates that
/// cannot be decoded or fully integrated count as removing one.
/// OFF-05 (ADR-064): the first `oc-pending:` reference `update` adds or re-points that does
/// not name `writer` in `pendingBy` (or is malformed). Cheap unless the update mentions one.
pub fn pending_error(doc: &Doc, update: &[u8], writer: &str) -> Option<String> {
    let has = |needle: &[u8]| update.windows(needle.len()).any(|w| w == needle);
    if !has(b"oc-pending:") && !has(b"pendingBy") {
        return None;
    }
    let Ok(decoded) = Update::decode_v1(update) else {
        return Some("malformed update".into());
    };
    let scratch = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    if oc_model::ocanvas::apply_update_bytes(&scratch, &state).is_err() {
        return None;
    }
    {
        let mut txn = scratch.transact_mut();
        if txn.apply_update(decoded).is_err() {
            return Some("update could not be applied".into());
        }
    }
    oc_model::pending::error(
        &oc_model::doc_to_json(doc),
        &oc_model::doc_to_json(&scratch),
        writer,
    )
}

pub fn removes_ext_block(doc: &Doc, update: &[u8]) -> bool {
    let before = ext_block_count(&doc.transact());
    if before == 0 {
        return false;
    }
    let Ok(update) = Update::decode_v1(update) else {
        return true;
    };
    let scratch = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    if oc_model::ocanvas::apply_update_bytes(&scratch, &state).is_err() {
        return true;
    }
    let mut txn = scratch.transact_mut();
    if txn.apply_update(update).is_err() {
        return true;
    }
    txn.commit();
    ext_block_count(&txn) < before
}

/// BSDK-03: the first schema error an update would add to the room's SDK blocks (attrs or
/// data of an installed type at its data version), or `None`. Errors the document already
/// had are not the update's. Free when no package is installed, or when the document has no
/// `extBlock` and the update does not name one; otherwise one scratch copy, O(document).
pub fn sdk_block_error(doc: &Doc, update: &[u8]) -> Option<String> {
    let reg = oc_model::ext::installed();
    if reg.is_empty() {
        return None;
    }
    let named = update
        .windows(oc_model::ext::NODE.len())
        .any(|w| w == oc_model::ext::NODE.as_bytes());
    if !named && ext_block_count(&doc.transact()) == 0 {
        return None;
    }
    let Ok(decoded) = Update::decode_v1(update) else {
        return Some("malformed update".into());
    };
    let scratch = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    if oc_model::ocanvas::apply_update_bytes(&scratch, &state).is_err() {
        return None;
    }
    {
        let mut txn = scratch.transact_mut();
        if txn.apply_update(decoded).is_err() {
            return Some("update could not be applied".into());
        }
    }
    let before: std::collections::HashSet<String> =
        oc_model::ext::document_errors(&reg, &oc_model::doc_to_json(doc))
            .into_iter()
            .collect();
    oc_model::ext::document_errors(&reg, &oc_model::doc_to_json(&scratch))
        .into_iter()
        .find(|e| !before.contains(e))
}

/// True when `update` carries nothing the room does not already have. Read-only clients
/// send their (empty or stale) state as sync step 2 on every connect; that is not a write.
pub fn adds_nothing(doc: &Doc, update: &[u8]) -> bool {
    let Ok(update) = Update::decode_v1(update) else {
        return false;
    };
    let scratch = oc_model::new_doc();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    if oc_model::ocanvas::apply_update_bytes(&scratch, &state).is_err() {
        return false;
    }
    let before = scratch.transact().state_vector();
    let mut txn = scratch.transact_mut();
    if txn.apply_update(update).is_err() {
        return false;
    }
    txn.commit();
    let pending = txn.store().pending_update().is_some() || txn.store().pending_ds().is_some();
    txn.changed_parent_types().is_empty() && txn.state_vector() == before && !pending
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Map, Text, XmlFragment, XmlTextPrelim};

    fn edit(base: &Doc, f: impl FnOnce(&Doc)) -> Vec<u8> {
        let client = Doc::new();
        let state = base
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        client
            .transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let sv = client.transact().state_vector();
        f(&client);
        client.transact().encode_state_as_update_v1(&sv)
    }

    fn base() -> Doc {
        let doc = oc_model::new_doc();
        let content = doc.get_or_insert_xml_fragment("content");
        let mut txn = doc.transact_mut();
        let t = content.push_back(&mut txn, XmlTextPrelim::new("hello"));
        t.push(&mut txn, "!");
        drop(txn);
        doc
    }

    #[test]
    fn comments_only_update_passes() {
        let doc = base();
        let u = edit(&doc, |c| {
            let m = c.get_or_insert_map("comments");
            m.insert(&mut c.transact_mut(), "t1", "nice");
        });
        assert!(touches_only_comments(&doc, &u));
    }

    #[test]
    fn stale_state_adds_nothing_but_edits_do() {
        let doc = base();
        let empty = Doc::new()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        assert!(adds_nothing(&doc, &empty));
        let full = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        assert!(adds_nothing(&doc, &full));
        let edit = edit(&doc, |c| {
            let f = c.get_or_insert_xml_fragment("content");
            f.push_back(&mut c.transact_mut(), XmlTextPrelim::new("spam"));
        });
        assert!(!adds_nothing(&doc, &edit));
    }

    #[test]
    fn content_meta_and_new_roots_rejected() {
        let doc = base();
        let content = edit(&doc, |c| {
            let f = c.get_or_insert_xml_fragment("content");
            f.push_back(&mut c.transact_mut(), XmlTextPrelim::new("spam"));
        });
        assert!(!touches_only_comments(&doc, &content));
        let meta = edit(&doc, |c| {
            let m = c.get_or_insert_map("meta");
            m.insert(&mut c.transact_mut(), "title", "pwned");
        });
        assert!(!touches_only_comments(&doc, &meta));
        let other = edit(&doc, |c| {
            let m = c.get_or_insert_map("somethingElse");
            m.insert(&mut c.transact_mut(), "k", 1);
        });
        assert!(!touches_only_comments(&doc, &other));
        let delete = edit(&doc, |c| {
            let f = c.get_or_insert_xml_fragment("content");
            f.remove_range(&mut c.transact_mut(), 0, 1);
        });
        assert!(!touches_only_comments(&doc, &delete));
    }
}
