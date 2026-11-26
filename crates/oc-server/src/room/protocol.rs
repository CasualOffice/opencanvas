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
