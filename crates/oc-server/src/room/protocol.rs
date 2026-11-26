// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! y-protocols frames (stock y-websocket) plus the OpenCanvas control message, type 100.

use serde_json::Value;
use yrs::StateVector;
use yrs::sync::{AwarenessUpdate, Message, SyncMessage};
use yrs::updates::encoder::Encode;

pub const MSG_CONTROL: u8 = 100;
/// y-protocols awareness message type.
pub const MSG_AWARENESS: u8 = 1;

pub fn step1(sv: StateVector) -> Vec<u8> {
    Message::Sync(SyncMessage::SyncStep1(sv)).encode_v1()
}

pub fn step2(update: Vec<u8>) -> Vec<u8> {
    Message::Sync(SyncMessage::SyncStep2(update)).encode_v1()
}

pub fn update(update: Vec<u8>) -> Vec<u8> {
    Message::Sync(SyncMessage::Update(update)).encode_v1()
}

pub fn awareness(update: AwarenessUpdate) -> Vec<u8> {
    Message::Awareness(update).encode_v1()
}

/// Largest awareness frame the room sends (about; one state may exceed it alone).
pub const AWARENESS_FRAME_BYTES: usize = 16 * 1024;

/// `update` as frames of at most about [`AWARENESS_FRAME_BYTES`] each (PERF-11, R1K): each
/// connection's socket write buffer keeps the capacity of the largest frame it was sent, and a
/// merged frame of 1,000 cursors is ~200 KB, so every buffer in the room grew to that size.
pub fn awareness_frames(update: AwarenessUpdate) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut part = AwarenessUpdate {
        clients: Default::default(),
    };
    let mut bytes = 0;
    for (client, entry) in update.clients {
        let len = entry.json.len() + 16;
        if bytes + len > AWARENESS_FRAME_BYTES && !part.clients.is_empty() {
            out.push(awareness(std::mem::replace(
                &mut part,
                AwarenessUpdate {
                    clients: Default::default(),
                },
            )));
            bytes = 0;
        }
        bytes += len;
        part.clients.insert(client, entry);
    }
    if !part.clients.is_empty() {
        out.push(awareness(part));
    }
    out
}

pub fn denied(reason: &str) -> Vec<u8> {
    Message::Auth(Some(reason.to_string())).encode_v1()
}

pub fn control(json: &Value) -> Vec<u8> {
    Message::Custom(MSG_CONTROL, json.to_string().into_bytes()).encode_v1()
}

/// PSYNC-02 (ADR-076, docs/15 §3.2): a subdocument frame, `[101, varString guid, <y-protocols
/// message>]`; the guid is `<fileId>/block/<blockId>`.
pub const MSG_SUBDOC: u8 = 101;

pub fn subdoc(guid: &str, inner: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(guid.len() + inner.len() + 4);
    let mut n = guid.len() as u64;
    while n >= 0x80 {
        payload.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    payload.push(n as u8);
    payload.extend_from_slice(guid.as_bytes());
    payload.extend_from_slice(inner);
    Message::Custom(MSG_SUBDOC, payload).encode_v1()
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::sync::awareness::AwarenessUpdateEntry;
    use yrs::updates::decoder::Decode;

    #[test]
    fn a_large_awareness_update_goes_out_in_small_frames_with_every_client() {
        let mut update = AwarenessUpdate {
            clients: Default::default(),
        };
        for c in 0..900u64 {
            let json = format!(
                "{{\"user\":{{\"name\":\"User {c}\"}},\"cursor\":\"{}\"}}",
                "x".repeat(180)
            );
            update.clients.insert(
                yrs::ClientID::new(c + 1),
                AwarenessUpdateEntry {
                    clock: 1,
                    json: json.into(),
                },
            );
        }
        let frames = awareness_frames(update);
        assert!(frames.len() > 1);
        let mut seen = 0;
        for f in &frames {
            assert!(f.len() <= AWARENESS_FRAME_BYTES + 512, "{} bytes", f.len());
            let Ok(Message::Awareness(u)) = Message::decode_v1(f) else {
                panic!("not an awareness frame")
            };
            seen += u.clients.len();
        }
        assert_eq!(seen, 900);
    }
}
