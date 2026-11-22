// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The agent runtime's room side: [`RoomPort`] over the room actor's mailbox, and audit
//! events to the host through the notification outbox (`POST /ai/events`, ADR-035).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::agent::{AuditSink, RoomPort};
use crate::grant::Role;
use crate::hosts::HostConfig;
use crate::room::{Cmd, Ctx};
use crate::store::NotifyRow;
use crate::util::now_ms;

pub struct ActorPort {
    pub(crate) tx: mpsc::UnboundedSender<Cmd>,
}

#[async_trait::async_trait]
impl RoomPort for ActorPort {
    async fn role(&self, user_id: &str) -> Option<Role> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::AiRole {
                user_id: user_id.to_string(),
                reply,
            })
            .ok()?;
        rx.await.ok().flatten()
    }

    fn presence(&self, run_id: &str, block_id: Option<&str>, active: bool) {
        let _ = self.tx.send(Cmd::AiPresence {
            run_id: run_id.to_string(),
            block_id: block_id.map(str::to_string),
            active,
        });
    }

    fn track(&self, origin: &str) {
        let _ = self.tx.send(Cmd::AiTrack {
            origin: origin.to_string(),
        });
    }

    async fn undo(&self, origin: &str) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::AiUndo {
                origin: origin.to_string(),
                reply,
            })
            .map_err(|_| "room closed".to_string())?;
        rx.await.map_err(|_| "room closed".to_string())?
    }
}

pub struct OutboxAudit {
    pub ctx: Arc<Ctx>,
    pub host: Arc<HostConfig>,
    pub room: String,
    pub file_id: String,
    pub token: String,
    pub seq: AtomicU64,
}

impl AuditSink for OutboxAudit {
    fn event(&self, body: Value) {
        if self.token.is_empty() || !crate::notify::enabled(&self.host, &self.file_id) {
            return;
        }
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        let key = format!(
            "{}:{}:{n}",
            body["runId"].as_str().unwrap_or_default(),
            body["event"].as_str().unwrap_or_default()
        );
        let now = now_ms();
        let row = NotifyRow {
            id: crate::notify::row_id(&self.room, "ai", &key),
            room_id: self.room.clone(),
            host_id: self.host.id.clone(),
            file_id: self.file_id.clone(),
            kind: "ai".into(),
            token: self.token.clone(),
            payload: body.to_string(),
            attempts: 0,
            next_try_at: now + crate::notify::CLAIM_MS,
        };
        let ctx = self.ctx.clone();
        let host = self.host.clone();
        tokio::spawn(async move {
            match ctx.store.notify_insert(&row, now).await {
                Ok(true) => {
                    crate::notify::attempt(&ctx.store, &ctx.host, &host, &row, now_ms()).await;
                }
                Ok(false) => {}
                Err(e) => tracing::error!(error = %e, "queueing an AI audit event failed"),
            }
        });
    }
}
