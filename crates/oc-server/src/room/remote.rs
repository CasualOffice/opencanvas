// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Room calls forwarded to the owning node in cluster mode (`POST /v1/internal/rooms/:room`).

use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{PatchFailure, Patched, Rooms};
use crate::grant::{Grant, Role};
use crate::hosts::HostConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RemoteOp {
    Info {
        grant: Grant,
    },
    State {
        grant: Grant,
    },
    Patch {
        grant: Grant,
        ops: Vec<oc_model::patch::PatchOp>,
        author: String,
    },
    Commit {
        grant: Grant,
    },
    /// TPL-01: a prepared team template.
    Template {
        grant: Grant,
        doc: Value,
        origin: String,
    },
    TemplateUndo {
        grant: Grant,
        origin: String,
    },
    /// VH-01b: version history writes.
    History {
        grant: Grant,
        history: super::HistoryOp,
    },
    /// DGM-17: a change to the server-written `icons` root.
    Icons {
        grant: Grant,
        icon_op: oc_model::doc_icons::IconOp,
        author: String,
    },
    CommitLive,
    SetRole {
        user_id: String,
        role: Option<Role>,
    },
    Close,
}

impl RemoteOp {
    pub fn grant(&self) -> Option<&Grant> {
        match self {
            Self::Info { grant }
            | Self::State { grant }
            | Self::Patch { grant, .. }
            | Self::Template { grant, .. }
            | Self::TemplateUndo { grant, .. }
            | Self::History { grant, .. }
            | Self::Icons { grant, .. }
            | Self::Commit { grant } => Some(grant),
            Self::CommitLive | Self::SetRole { .. } | Self::Close => None,
        }
    }
}

pub(super) fn decode<T: serde::de::DeserializeOwned>(v: Value) -> anyhow::Result<T> {
    Ok(serde_json::from_value(v)?)
}

pub(super) fn decode_bytes(v: Value) -> anyhow::Result<Vec<u8>> {
    let s = v["state"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("state missing"))?;
    Ok(base64::engine::general_purpose::STANDARD.decode(s)?)
}

fn encode_patch(r: Result<Patched, PatchFailure>) -> Value {
    match r {
        Ok(p) => json!({"ok": {"block_ids": p.block_ids}}),
        Err(PatchFailure::Invalid(e)) => json!({"err": "invalid", "message": e.to_string()}),
        Err(PatchFailure::TooLarge) => json!({"err": "too_large"}),
        Err(PatchFailure::Conflict) => json!({"err": "conflict"}),
        Err(PatchFailure::Unavailable) => json!({"err": "unavailable"}),
    }
}

pub(super) fn decode_patch(v: Value) -> anyhow::Result<Result<Patched, PatchFailure>> {
    if let Some(ids) = v["ok"]["block_ids"].as_array() {
        return Ok(Ok(Patched {
            block_ids: ids
                .iter()
                .filter_map(|i| i.as_str().map(String::from))
                .collect(),
        }));
    }
    Ok(Err(match v["err"].as_str() {
        Some("too_large") => PatchFailure::TooLarge,
        Some("conflict") => PatchFailure::Conflict,
        Some("unavailable") => PatchFailure::Unavailable,
        _ => PatchFailure::Invalid(oc_model::patch::PatchError::Request(
            v["message"].as_str().unwrap_or("invalid patch").to_string(),
        )),
    }))
}

impl Rooms {
    /// Owner side of a forwarded call: runs it here and never forwards again
    /// ([`super::NotOwner`] when this node does not own the room).
    pub async fn serve_remote(
        &self,
        room: &str,
        host: Option<Arc<HostConfig>>,
        op: RemoteOp,
    ) -> anyhow::Result<Value> {
        let need_host = || host.clone().ok_or_else(|| anyhow::anyhow!("host missing"));
        let owns = || self.cluster().is_some_and(|c| c.leases.owns(room));
        Ok(match op {
            RemoteOp::Info { grant } => {
                json!(self.info_at(&need_host()?, &grant, false).await?)
            }
            RemoteOp::State { grant } => {
                let state = self.state_at(&need_host()?, &grant, false).await?;
                json!({"state": base64::engine::general_purpose::STANDARD.encode(state)})
            }
            RemoteOp::Patch { grant, ops, author } => encode_patch(
                self.patch_at(&need_host()?, &grant, ops, &author, false)
                    .await?,
            ),
            RemoteOp::Template { grant, doc, origin } => encode_patch(
                self.template_at(&need_host()?, &grant, doc, &origin, false)
                    .await?,
            ),
            RemoteOp::Icons {
                grant,
                icon_op,
                author,
            } => encode_patch(
                self.icons_at(&need_host()?, &grant, icon_op, &author, false)
                    .await?,
            ),
            RemoteOp::TemplateUndo { grant, origin } => encode_patch(
                self.template_undo_at(&need_host()?, &grant, &origin, false)
                    .await?,
            ),
            RemoteOp::History { grant, history } => {
                self.history_at(&need_host()?, &grant, history, false)
                    .await?
            }
            RemoteOp::Commit { grant } => {
                json!(self.commit_at(&need_host()?, &grant, false).await?)
            }
            // Live-only calls: answer for this node's actor; a node that no longer owns the
            // room says so, and the caller looks the owner up again.
            RemoteOp::CommitLive => {
                if !self.is_live(room) && !owns() {
                    return Err(super::NotOwner(room.into()).into());
                }
                json!(self.commit_live_local(room).await)
            }
            RemoteOp::SetRole { user_id, role } => {
                json!(self.set_role_local(room, &user_id, role).await)
            }
            RemoteOp::Close => json!(self.close_local(room).await),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_results_round_trip() {
        let ok = decode_patch(encode_patch(Ok(Patched {
            block_ids: vec!["b_1".into()],
        })))
        .unwrap()
        .unwrap();
        assert_eq!(ok.block_ids, vec!["b_1"]);
        assert!(matches!(
            decode_patch(encode_patch(Err(PatchFailure::TooLarge))).unwrap(),
            Err(PatchFailure::TooLarge)
        ));
        assert!(matches!(
            decode_patch(encode_patch(Err(PatchFailure::Conflict))).unwrap(),
            Err(PatchFailure::Conflict)
        ));
    }

    #[test]
    fn ops_serialize_with_patch_ops() {
        let op: RemoteOp = serde_json::from_value(json!({
            "op": "set_role", "user_id": "u", "role": "view"
        }))
        .unwrap();
        assert!(matches!(
            op,
            RemoteOp::SetRole {
                role: Some(Role::View),
                ..
            }
        ));
        let ops: Vec<oc_model::patch::PatchOp> =
            serde_json::from_value(json!([{"op": "append", "markdown": "hi"}])).unwrap();
        let v = serde_json::to_value(&ops).unwrap();
        assert_eq!(v[0]["op"], "append");
        let back: Vec<oc_model::patch::PatchOp> = serde_json::from_value(v).unwrap();
        assert_eq!(back.len(), 1);
    }
}
