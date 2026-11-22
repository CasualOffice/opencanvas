//! Host notifications other than saves (UX-02, ADR-025): `POST {callback_base}/mentions`.
//!
//! Fire-and-forget for the room: a notification is written to `notify_outbox` first, then sent
//! once straight away. A failed call stays pending and the sweeper (`AppState::
//! deliver_notifications`) retries it with backoff and the same `Idempotency-Key`. The row id is
//! derived from the room and the item that carried the mention, so one message is never queued
//! twice. WOPI hosts have no callback API, so nothing is queued for them.

use reqwest::StatusCode;
use sha2::{Digest, Sha256};

use crate::host_client::{HostClient, SaveTarget};
use crate::hosts::HostConfig;
use crate::store::{NotifyRow, Store};

/// One attempt holds a row this long before another worker may take it.
pub const CLAIM_MS: i64 = 30_000;
/// Give up after this many failed attempts (about 2 h with [`BACKOFF_MS`]).
pub const MAX_ATTEMPTS: i64 = 8;
const BACKOFF_MS: [i64; 6] = [10_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];

/// Whether `file_id` of `host` gets notifications: JWT callbacks only (no WOPI).
pub fn enabled(host: &HostConfig, file_id: &str) -> bool {
    !host.callback_base.trim().is_empty()
        && matches!(SaveTarget::of(host, file_id), Ok(SaveTarget::Callbacks))
}

/// The outbox id for a notification: sha256(room, kind, key), 32 hex characters.
pub fn row_id(room: &str, kind: &str, key: &str) -> String {
    let mut h = Sha256::new();
    h.update(room.as_bytes());
    h.update([0]);
    h.update(kind.as_bytes());
    h.update([0]);
    h.update(key.as_bytes());
    hex::encode(&h.finalize()[..16])
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Done,
    /// 404/405/410/501: the host does not implement the callback. Not retried.
    Unsupported,
    /// Another 4xx (bad token, refused): retrying the same request cannot help.
    Rejected,
    /// Network error or 5xx; retried later unless attempts are used up.
    Retry,
    GaveUp,
}

/// Sends one claimed row and records the result.
pub async fn attempt(
    store: &Store,
    client: &HostClient,
    host: &HostConfig,
    row: &NotifyRow,
    now_ms: i64,
) -> Outcome {
    let sent = client
        .post_notification(
            host,
            if row.kind == "ai" {
                &["ai", "events"]
            } else {
                &["mentions"]
            },
            &row.token,
            row.payload.clone().into_bytes(),
            &row.id,
        )
        .await;
    let outcome = match sent {
        Ok(s) if s.is_success() => Outcome::Done,
        Ok(
            StatusCode::NOT_FOUND
            | StatusCode::METHOD_NOT_ALLOWED
            | StatusCode::GONE
            | StatusCode::NOT_IMPLEMENTED,
        ) => Outcome::Unsupported,
        Ok(s) if s.is_client_error() && s != StatusCode::TOO_MANY_REQUESTS => Outcome::Rejected,
        _ if row.attempts + 1 >= MAX_ATTEMPTS => Outcome::GaveUp,
        _ => Outcome::Retry,
    };
    let status = match outcome {
        Outcome::Done => "done",
        Outcome::Unsupported => "unsupported",
        Outcome::Rejected => "rejected",
        Outcome::GaveUp => "failed",
        Outcome::Retry => "",
    };
    let recorded = if status.is_empty() {
        let delay = BACKOFF_MS[(row.attempts as usize).min(BACKOFF_MS.len() - 1)];
        store.notify_retry(&row.id, now_ms + delay).await
    } else {
        store.notify_finish(&row.id, status).await
    };
    if let Err(e) = recorded {
        tracing::error!(error = %e, "recording a notification attempt failed");
    }
    match (&outcome, sent) {
        (Outcome::Done, _) => {}
        (_, Ok(s)) => {
            tracing::info!(room = %row.room_id, kind = %row.kind, status = s.as_u16(), ?outcome, "host notification not accepted")
        }
        (_, Err(e)) => {
            tracing::warn!(room = %row.room_id, kind = %row.kind, error = %e, ?outcome, "host notification failed")
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    #[test]
    fn row_ids_are_stable_and_distinct() {
        let a = super::row_id("r_1", "mention", "c:1:2");
        assert_eq!(a, super::row_id("r_1", "mention", "c:1:2"));
        assert_eq!(a.len(), 32);
        assert_ne!(a, super::row_id("r_2", "mention", "c:1:2"));
        assert_ne!(a, super::row_id("r_1", "mention", "c:1:3"));
    }
}
