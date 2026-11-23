// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Applying Yjs updates that may arrive out of causal order.
//!
//! yrs 0.28.2 can strand a pending update for good. When an update holds two structs that
//! depend on each other across clients (A#0 has its right origin in B's missing range, and
//! B#n has A#0 as its right origin), the dependency cycle check in yrs' block picker records
//! the *on-stack* client (A at its current clock) as what the pending update waits for, not
//! the client whose structs are really missing (B). When B's missing structs arrive later,
//! `apply_update` only retries the pending update if the incoming update has blocks of a
//! client listed as missing, or that client's clock moved past the recorded one; neither holds,
//! so the pending structs are never integrated, although every one of them is in the doc's
//! hands. Yjs (JS) records the missing range of the struct's own client and does not have
//! this hole. Found by `tests/fuzz.rs` (seed 66002356), docs/10 integration log 2026-11-24.
//!
//! [`apply_update`] works around it: when an update moved the doc forward and a pending
//! update is left, the pending structs (and pending deletes) are applied once more, exactly
//! as yrs' own retry does. A retry that still cannot integrate leaves them pending as before.

use yrs::{ReadTxn, StateVector, TransactionMut, Update, WriteTxn};

/// Applies `update` and retries whatever yrs left pending if the doc moved forward.
pub fn apply_update(
    txn: &mut TransactionMut,
    update: Update,
) -> Result<(), yrs::error::UpdateError> {
    let before = txn.state_vector();
    txn.apply_update(update)?;
    retry_pending(txn, &before)
}

/// Re-applies the pending structs and deletes, until a pass integrates nothing new.
fn retry_pending(
    txn: &mut TransactionMut,
    before: &StateVector,
) -> Result<(), yrs::error::UpdateError> {
    let mut seen = before.clone();
    loop {
        let has_pending = txn.store().pending_update().is_some();
        let now = txn.state_vector();
        if !has_pending || now == seen {
            return Ok(());
        }
        seen = now;
        if let Some(pending) = txn.prune_pending() {
            txn.apply_update(pending)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, GetString, Text, Transact};

    fn diff(doc: &Doc, since: &StateVector) -> Vec<u8> {
        doc.transact().encode_state_as_update_v1(since)
    }

    fn decode(bytes: &[u8]) -> Update {
        Update::decode_v1(bytes).unwrap()
    }

    /// The smallest form of the fuzz failure: an update with a cross-client dependency cycle
    /// (A#0 before B#0, B#3 before A#0) reaches a peer that lacks B#0..3, then B#0..3 arrives.
    #[test]
    fn a_dependency_cycle_in_a_pending_update_is_integrated_once_its_cause_arrives() {
        // yrs picks the highest client id first: A must sort above B to hit the bug.
        let b = Doc::with_client_id(1);
        let a = Doc::with_client_id(2);
        let tb = b.get_or_insert_text("t");
        let ta = a.get_or_insert_text("t");
        tb.insert(&mut b.transact_mut(), 0, "bbb");
        let b0 = diff(&b, &StateVector::default());
        a.transact_mut().apply_update(decode(&b0)).unwrap();
        ta.insert(&mut a.transact_mut(), 0, "a"); // A#0, right origin B#0
        let from_a = diff(&a, &b.transact().state_vector());
        b.transact_mut().apply_update(decode(&from_a)).unwrap();
        // B's state before it saw A: the update below is A#0 and B#3 only.
        let mut sv = StateVector::default();
        sv.set_max(yrs::block::ClientID::new(1), 3);
        tb.insert(&mut b.transact_mut(), 0, "c"); // B#3, right origin A#0
        let cycle = diff(&b, &sv);

        let want = tb.get_string(&b.transact());
        for fixed in [false, true] {
            let peer = Doc::with_client_id(3);
            let t = peer.get_or_insert_text("t");
            for u in [&cycle, &b0] {
                let u = decode(u);
                let mut txn = peer.transact_mut();
                if fixed {
                    apply_update(&mut txn, u).unwrap();
                } else {
                    txn.apply_update(u).unwrap();
                }
            }
            let txn = peer.transact();
            if fixed {
                assert_eq!(t.get_string(&txn), want);
                assert!(txn.store().pending_update().is_none());
            } else {
                // Documents the yrs 0.28.2 hole this module exists for. If this starts failing,
                // yrs fixed it and the workaround can go.
                assert!(
                    txn.store().pending_update().is_some(),
                    "yrs no longer strands it"
                );
            }
        }
    }
}
