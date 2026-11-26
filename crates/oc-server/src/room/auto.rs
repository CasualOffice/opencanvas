// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The room's side of automation (AUTO-02/03, ADR-067): after each durable batch, what changed
//! and which rules it starts; the loop guard (a rule's writes never start that rule, a chain
//! stops at `max_depth`); and the room's rows in `automation_schedule` when its date and
//! schedule rules change. The runs themselves are tasks ([`crate::automation::runner`]).

use std::collections::HashMap;
use std::sync::Arc;

use oc_model::automation::Rule;
use yrs::{Doc, Map, ReadTxn, Transact};

use crate::automation::engine::{Snapshot, diff, triggered};
use crate::automation::runner::{Applier, ApplyFut, Job};
use crate::automation::{AutomationCfg, schedule, tz::Tz};
use crate::hosts::HostConfig;

use super::{Cmd, ToolFn};

/// Origins of automation writes: `automation:<ruleId>|<depth>|<chain>` on the command, the
/// plain `automation:<ruleId>` on the transaction and as author.
pub fn split_origin(origin: &str) -> Option<(String, u32, Vec<String>)> {
    let rest = origin.strip_prefix("automation:")?;
    let mut it = rest.split('|');
    let rule = it.next()?.to_string();
    let depth = it.next().and_then(|d| d.parse().ok()).unwrap_or(0);
    let chain = it
        .next()
        .map(|c| {
            c.split(',')
                .filter(|x| !x.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    Some((rule, depth, chain))
}

#[derive(Default)]
pub struct AutoState {
    snap: Option<Snapshot>,
    /// The watched rules when `snap` was taken: a change of rules re-takes it without events
    /// (a new rule on a database must not see its rows as just added).
    sig: String,
    sched_sig: Option<String>,
    /// Authors of automation writes in flight: their depth and chain.
    pub pending: HashMap<String, (u32, Vec<String>)>,
}

fn event_rules(doc: &Doc) -> Vec<Rule> {
    oc_model::automation::read_rules(doc)
        .into_iter()
        .filter_map(|(_, _, r)| r.ok())
        .filter(|r| r.runnable() && !r.trigger.is_timed())
        .map(|mut r| {
            // A field may be named by id or by name; events carry ids.
            if let oc_model::automation::Trigger::FieldChanged {
                database, field, ..
            } = &mut r.trigger
                && let Some(db) = crate::automation::engine::Db::read(doc, database)
                && let Some(f) = db.field(field)
            {
                *field = f.0.clone();
            }
            r
        })
        .collect()
}

fn sig(rules: &[Rule]) -> String {
    rules
        .iter()
        .map(|r| {
            format!(
                "{}:{}",
                r.id,
                serde_json::to_string(&r.trigger).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(";")
}

impl AutoState {
    pub fn new(doc: &Doc, host: &HostConfig) -> Self {
        let mut s = Self::default();
        if AutomationCfg::of(host).enabled {
            let rules = event_rules(doc);
            s.sig = sig(&rules);
            s.snap = Some(Snapshot::take(doc, &rules));
        }
        s
    }

    /// The runs a durable batch starts. `users`: the batch's authors.
    pub fn after_batch(
        &mut self,
        doc: &Doc,
        host: &Arc<HostConfig>,
        room: &str,
        file_id: &str,
        users: &[String],
        name_of: &dyn Fn(&str) -> Option<String>,
    ) -> Vec<Job> {
        let cfg = AutomationCfg::of(host);
        if !cfg.enabled {
            return vec![];
        }
        let rules = event_rules(doc);
        let now_sig = sig(&rules);
        let after = Snapshot::take(doc, &rules);
        let before = self.snap.replace(after.clone());
        if rules.is_empty() || now_sig != self.sig {
            self.sig = now_sig;
            return vec![];
        }
        let Some(before) = before else { return vec![] };
        let events = diff(&before, &after, doc);
        if events.is_empty() {
            return vec![];
        }
        // Loop guard: a batch made only by rules continues their chain.
        let autos: Vec<&(u32, Vec<String>)> =
            users.iter().filter_map(|u| self.pending.get(u)).collect();
        let (depth, chain) = if !users.is_empty() && autos.len() == users.len() {
            let depth = autos.iter().map(|a| a.0).max().unwrap_or(0) + 1;
            let mut chain: Vec<String> = autos.iter().flat_map(|a| a.1.iter().cloned()).collect();
            chain.dedup();
            (depth, chain)
        } else {
            (0, vec![])
        };
        for u in users {
            self.pending.remove(u);
        }
        let actor = users
            .iter()
            .find(|u| !u.starts_with("automation:"))
            .map(|u| (u.clone(), name_of(u).unwrap_or_else(|| u.clone())));
        let mut jobs = vec![];
        for ev in &events {
            for r in &rules {
                // A rule's writes never start that same rule.
                if chain.contains(&r.id) || !triggered(r, ev) {
                    continue;
                }
                let mut c = chain.clone();
                c.push(r.id.clone());
                jobs.push(Job {
                    host: host.clone(),
                    room: room.to_string(),
                    file_id: file_id.to_string(),
                    rule_id: r.id.clone(),
                    event: ev.clone(),
                    actor: actor.clone(),
                    depth,
                    chain: c,
                    run_id: format!("run_{}", ulid::Ulid::new().to_string().to_lowercase()),
                });
            }
        }
        jobs
    }

    /// The room's schedule rows when its timed rules changed: `(ruleId, next run ms)`.
    pub fn schedule(
        &mut self,
        doc: &Doc,
        host: &HostConfig,
        now_ms: i64,
    ) -> Option<Vec<(String, i64)>> {
        let cfg = AutomationCfg::of(host);
        let timed: Vec<Rule> = if cfg.enabled {
            oc_model::automation::read_rules(doc)
                .into_iter()
                .filter_map(|(_, _, r)| r.ok())
                .filter(|r| r.runnable() && r.trigger.is_timed())
                .collect()
        } else {
            vec![]
        };
        let s = timed
            .iter()
            .map(|r| {
                format!(
                    "{}:{}:{}",
                    r.id,
                    serde_json::to_string(&r.trigger).unwrap_or_default(),
                    r.time_zone.as_deref().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join(";");
        if self.sched_sig.as_deref() == Some(s.as_str()) {
            return None;
        }
        self.sched_sig = Some(s);
        Some(
            timed
                .iter()
                .filter_map(|r| {
                    let tz = Tz::load(r.time_zone.as_deref().unwrap_or(&cfg.time_zone))
                        .unwrap_or_else(|_| Tz::utc());
                    schedule::next_run(&r.trigger, now_ms / 1000, &tz, cfg.min_interval_min)
                        .map(|t| (r.id.clone(), t * 1000))
                })
                .collect(),
        )
    }
}

/// Runs a job's room work through the room's own command channel.
pub(crate) struct ActorApplier(
    pub tokio::sync::mpsc::UnboundedSender<Cmd>,
    pub u32,
    pub Vec<String>,
);

impl Applier for ActorApplier {
    fn apply(&self, origin: String, author: String, run: ToolFn) -> ApplyFut {
        let tx = self.0.clone();
        let origin = format!("{origin}|{}|{}", self.1, self.2.join(","));
        Box::pin(async move {
            let (reply, rx) = tokio::sync::oneshot::channel();
            tx.send(Cmd::Tool {
                run,
                origin,
                author,
                reply,
            })
            .map_err(|_| crate::ai::tools::ToolError::Unavailable("the room closed".into()))?;
            rx.await
                .map_err(|_| crate::ai::tools::ToolError::Unavailable("the room closed".into()))?
        })
    }
}

/// The role filter for client writes to the `automations` root (ADR-067): automation on for
/// the host, an editor with `perms.automate`, at most `max_rules`, every changed rule valid,
/// its actions allowed, URL calls on allowed origins, schedules not more often than the
/// minimum, and an enabled rule owned by the person saving it ("runs as you from now on").
pub fn check_client(
    doc: &Doc,
    update: &[u8],
    grant: &crate::grant::Grant,
    host: &HostConfig,
) -> Result<(), String> {
    // An update can only reach an empty `automations` root by naming it. Checked first because
    // `touches_root` counts any update that cannot fully integrate yet (out-of-order edits, a
    // normal state) as touching: with automation off that refused ordinary typing (fuzz tests).
    let name = oc_model::roots::AUTOMATIONS.as_bytes();
    let empty = {
        let txn = doc.transact();
        txn.get_map(oc_model::roots::AUTOMATIONS)
            .is_none_or(|m| m.len(&txn) == 0)
    };
    if empty && !update.windows(name.len()).any(|w| w == name) {
        return Ok(());
    }
    if !super::filter::touches_root(doc, update, oc_model::roots::AUTOMATIONS) {
        return Ok(());
    }
    let cfg = AutomationCfg::of(host);
    if !cfg.enabled {
        return Err("automation is off for this host".into());
    }
    if grant.role != crate::grant::Role::Edit || !grant.perms.automate {
        return Err("you may not change automations here".into());
    }
    let scratch = oc_model::new_doc();
    let state =
        yrs::Transact::transact(doc).encode_state_as_update_v1(&yrs::StateVector::default());
    oc_model::ocanvas::apply_update_bytes(&scratch, &state).map_err(|e| e.to_string())?;
    oc_model::ocanvas::apply_update_bytes(&scratch, update)
        .map_err(|_| "malformed update".to_string())?;
    let before: HashMap<String, serde_json::Value> = oc_model::automation::read_rules(doc)
        .into_iter()
        .map(|(id, j, _)| (id, j))
        .collect();
    let after = oc_model::automation::read_rules(&scratch);
    if after.len() > cfg.max_rules && after.len() > before.len() {
        return Err(format!(
            "this canvas has {} rules, the most it can have",
            cfg.max_rules
        ));
    }
    for (id, json, parsed) in &after {
        if before.get(id) == Some(json) {
            continue;
        }
        let rule = parsed.as_ref().map_err(|e| format!("rule {id}: {e}"))?;
        for a in &rule.actions {
            if !cfg.allows(a.kind()) {
                return Err(format!(
                    "rule {id}: the action {} is turned off for this host",
                    a.kind()
                ));
            }
            if let oc_model::automation::Action::HttpPost { url, .. } = a {
                super::super::automation::url_target(host, &cfg, url)
                    .map_err(|e| format!("rule {id}: {e}"))?;
            }
        }
        if let oc_model::automation::Trigger::Schedule {
            every,
            minutes: Some(m),
            ..
        } = &rule.trigger
            && every == "minutes"
            && *m < cfg.min_interval_min
        {
            return Err(format!(
                "rule {id}: schedules run at most every {} minutes",
                cfg.min_interval_min
            ));
        }
        if rule.enabled && rule.owner_id.as_deref() != Some(grant.user.id.as_str()) {
            return Err(format!(
                "rule {id}: an enabled rule runs as the person who saved it"
            ));
        }
    }
    Ok(())
}
