// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The schedule worker (AUTO-03): every node claims due `automation_schedule` rows (a
//! conditional update, so one node takes each slot; the run id is the slot, so a slot runs
//! once even across a crash), opens the room the way the headless API does (loading the file
//! from the host when it is closed), runs the rule, and moves the row to its next time. A file
//! that cannot be loaded is retried every 5 minutes for an hour, then logged as failed.

use std::sync::Arc;

use serde_json::json;
use yrs::Doc;

use super::engine::Event;
use super::runner::{self, Applier, ApplyFut, Deps, Job};
use super::{AutomationCfg, schedule, tz::Tz};
use crate::SharedState;
use crate::grant::{FileRef, Grant, Perms, Role, User, room_id};
use crate::hosts::HostConfig;
use crate::room::ToolFn;
use crate::store::{RunRow, ScheduleRow};

/// Rows one sweep claims.
pub const SWEEP_ROWS: i64 = 20;
/// How long a claim holds.
pub const CLAIM_MS: i64 = 120_000;
/// A file that does not load is retried this often, for [`RETRY_FOR_MS`].
pub const RETRY_MS: i64 = 300_000;
pub const RETRY_FOR_MS: i64 = 3_600_000;

/// The grant a scheduled run acts under: "Automation", edit, no callback token (the host
/// authenticates the signed call, docs/05 §5).
pub fn service_grant(host: &HostConfig, file_id: &str, rule: &str) -> Grant {
    Grant {
        ext_blocks: true,
        wopi_history: None,
        host_id: host.id.clone(),
        room: room_id(&host.id, file_id),
        role: Role::Edit,
        user: User {
            id: runner::origin_of(rule),
            name: "Automation".into(),
            color: "#6b7280".into(),
            ..Default::default()
        },
        file: FileRef {
            id: file_id.to_string(),
            name: file_id.to_string(),
            version: None,
        },
        perms: Perms {
            comment: true,
            ..Perms::default()
        },
        callback_token: String::new(),
        members: vec![],
        live: Default::default(),
    }
}

/// Runs a job's room work through the rooms registry (opening the room when closed).
pub struct RoomsApplier {
    pub state: SharedState,
    pub host: Arc<HostConfig>,
    pub grant: Grant,
}

impl Applier for RoomsApplier {
    fn apply(&self, origin: String, _author: String, run: ToolFn) -> ApplyFut {
        let (state, host, grant) = (self.state.clone(), self.host.clone(), self.grant.clone());
        let origin = format!(
            "{origin}|0|{}",
            grant.user.id.trim_start_matches("automation:")
        );
        Box::pin(async move { state.rooms.tool(&host, &grant, &origin, run).await })
    }
}

pub fn deps(state: &SharedState) -> Deps {
    Deps {
        store: state.store.clone(),
        host_client: state.host.clone(),
        events: state.rooms.ctx().events.clone(),
        http: state.rooms.ctx().auto_http.clone(),
        clock: state.clock.clone(),
    }
}

/// One sweep: claims and runs every due row. Returns how many it ran.
pub async fn sweep(state: &SharedState, node: &str) -> anyhow::Result<usize> {
    use futures::StreamExt;
    let now = state.clock.now_ms();
    let mut claimed = vec![];
    for row in state.store.automation_due(now, SWEEP_ROWS).await? {
        if state
            .store
            .automation_claim(&row, node, now + CLAIM_MS)
            .await?
        {
            claimed.push(row);
        }
    }
    let n = claimed.len();
    futures::stream::iter(claimed)
        .for_each_concurrent(4, |row| async move {
            if let Err(e) = run_row(state, &row).await {
                tracing::warn!(room = %row.room_id, rule = %row.rule_id, error = %e, "scheduled automation failed");
            }
        })
        .await;
    Ok(n)
}

async fn run_row(state: &SharedState, row: &ScheduleRow) -> anyhow::Result<()> {
    let now = state.clock.now_ms();
    let Some(host) = state.hosts.get(&row.host_id) else {
        // The host is gone from the configuration: look again tomorrow.
        return state
            .store
            .automation_advance(
                &row.room_id,
                &row.rule_id,
                row.next_run_at,
                now + 86_400_000,
            )
            .await;
    };
    let cfg = AutomationCfg::of(&host);
    let applier = RoomsApplier {
        state: state.clone(),
        host: host.clone(),
        grant: service_grant(&host, &row.file_id, &row.rule_id),
    };
    // The rule as it is in the file now.
    let seen = Arc::new(std::sync::Mutex::new(None));
    let s2 = seen.clone();
    let rid = row.rule_id.clone();
    let read: ToolFn = Box::new(move |doc: &Doc| {
        let r = oc_model::automation::read_rules(doc)
            .into_iter()
            .find(|(id, ..)| *id == rid)
            .and_then(|(_, _, r)| r.ok());
        *s2.lock().unwrap() = Some(r);
        Ok((None, json!({})))
    });
    let slot = row.next_run_at;
    match applier
        .apply(runner::origin_of(&row.rule_id), String::new(), read)
        .await
    {
        Ok(_) => {}
        Err(e) => {
            if now - slot < RETRY_FOR_MS {
                return state
                    .store
                    .automation_advance(&row.room_id, &row.rule_id, slot, now + RETRY_MS)
                    .await;
            }
            tracing::info!(room = %row.room_id, error = %e.message(), "scheduled automation: file not loaded for an hour");
            let _ = state
                .store
                .automation_run_insert(&RunRow {
                    id: format!("run_{}_{}", row.rule_id, slot / 1000),
                    room_id: row.room_id.clone(),
                    host_id: row.host_id.clone(),
                    file_id: row.file_id.clone(),
                    rule_id: row.rule_id.clone(),
                    trigger: "schedule".into(),
                    result: "failed".into(),
                    error_code: "FILE_UNAVAILABLE".into(),
                    http_status: 0,
                    changes: 0,
                    notified: 0,
                    depth: 0,
                    duration_ms: 0,
                    at: now,
                })
                .await;
            return state
                .store
                .automation_advance(&row.room_id, &row.rule_id, slot, now + 86_400_000)
                .await;
        }
    }
    let Some(rule) = seen.lock().unwrap().take().flatten() else {
        // Deleted or broken since: the room rewrites the rows when rules change.
        return state
            .store
            .automation_advance(&row.room_id, &row.rule_id, slot, now + 86_400_000)
            .await;
    };
    let tz =
        Tz::load(rule.time_zone.as_deref().unwrap_or(&cfg.time_zone)).unwrap_or_else(|_| Tz::utc());
    if rule.runnable() && rule.trigger.is_timed() {
        let job = Job {
            host: host.clone(),
            room: row.room_id.clone(),
            file_id: row.file_id.clone(),
            rule_id: rule.id.clone(),
            event: Event::Tick {
                slot: slot / 1000,
                date: matches!(
                    rule.trigger,
                    oc_model::automation::Trigger::DateReached { .. }
                )
                .then(String::new),
            },
            actor: None,
            depth: 0,
            chain: vec![rule.id.clone()],
            run_id: format!("run_{}_{}", rule.id, slot / 1000),
        };
        let _ = runner::run(&deps(state), &applier, job).await;
    }
    let next = schedule::next_run(
        &rule.trigger,
        (slot / 1000).max(now / 1000),
        &tz,
        cfg.min_interval_min,
    )
    .map_or(now + 86_400_000, |t| t * 1000);
    state
        .store
        .automation_advance(&row.room_id, &row.rule_id, slot, next)
        .await
}

/// The run log purge (30 days).
pub async fn purge(state: &SharedState) {
    if state.store.automation_supported()
        && let Err(e) = state.store.automation_purge(state.clock.now_ms()).await
    {
        tracing::warn!(error = %e, "automation run purge failed");
    }
}

/// Whether any host turned automation on.
pub fn any_on(state: &SharedState) -> bool {
    state.hosts.iter().any(|h| AutomationCfg::of(h).enabled)
}
