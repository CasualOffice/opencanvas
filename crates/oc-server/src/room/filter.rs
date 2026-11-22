// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Role filter for `comment` sessions: an update may only touch the `comments` root.

use std::collections::HashSet;

use oc_model::roots;
use yrs::updates::decoder::Decode;
use yrs::{BranchID, Doc, ReadTxn, StateVector, Transact, Update, WriteTxn};

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
