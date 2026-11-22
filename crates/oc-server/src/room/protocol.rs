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
