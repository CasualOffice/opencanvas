// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! One automation run (AUTO-02..05, ADR-067, ADR-068). In order:
//!
//! 1. the run is logged under its id first (a unique row: a run happens once, also across
//!    nodes and retries); a chain past `max_depth` is `stopped`, a limit is `skipped`;
//! 2. the owner's access is re-checked through `/access` (cached 30 s): below edit, the rule is
//!    paused and the run skipped; without `/access` the owner must have opened the canvas in
//!    the last 30 days (the `people` root);
//! 3. conditions, plan and writes in the room, as one transaction with origin and author
//!    `automation:<ruleId>` (the role filter and MOD-01 of every server write apply);
//! 4. notifications through the host's `POST /mentions`, URL calls signed like webhooks;
//! 5. the outcome in the log, an `automation.ran` / `automation.failed` event, and auto-pause
//!    after 10 failed runs in a row (one notification to the owner).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use oc_model::automation::{Rule, Trigger, parse_rule};
use serde_json::{Map as JsonMap, Value, json};
use yrs::{Doc, ReadTxn};

use super::engine::{self, Cx, Db, Event, Subject};
use super::{AutomationCfg, tz::Tz};
use crate::ai::tools::ToolError;
use crate::ai::tools::write::Writer;
use crate::grant::Role;
use crate::host_client::HostClient;
use crate::hosts::HostConfig;
use crate::room::ToolFn;
use crate::store::{RunRow, Store};

/// Failed runs in a row that pause a rule.
pub const PAUSE_AFTER: i64 = 10;
/// Without `/access`, the owner must have opened the canvas this recently.
pub const OWNER_SEEN_MS: i64 = 30 * 86_400_000;
/// URL call timeout.
pub const URL_TIMEOUT: Duration = Duration::from_secs(10);

static RETRY_MS: [AtomicU64; 2] = [AtomicU64::new(60_000), AtomicU64::new(600_000)];

/// Tests: the waits before the 2nd and 3rd URL try (default 1 min and 10 min).
pub fn set_url_retry_ms(first: u64, second: u64) {
    RETRY_MS[0].store(first, Ordering::Relaxed);
    RETRY_MS[1].store(second, Ordering::Relaxed);
}

pub type ApplyFut = Pin<Box<dyn Future<Output = Result<Value, ToolError>> + Send>>;

/// Runs a [`ToolFn`] in the room: the room's own command channel (event rules) or the rooms
/// registry, which opens a closed room from the host (date and schedule rules).
pub trait Applier: Send + Sync {
    fn apply(&self, origin: String, author: String, run: ToolFn) -> ApplyFut;
}

/// What a run needs from the server.
#[derive(Clone)]
pub struct Deps {
    pub store: Store,
    pub host_client: HostClient,
    pub events: Arc<crate::events::Hub>,
    pub http: reqwest::Client,
    pub clock: Arc<crate::clock::Clock>,
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("opencanvas-automation/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

/// One run to do.
#[derive(Debug, Clone)]
pub struct Job {
    pub host: Arc<HostConfig>,
    pub room: String,
    pub file_id: String,
    pub rule_id: String,
    pub event: Event,
    /// Who made the triggering change (id, name).
    pub actor: Option<(String, String)>,
    /// 0 for a person's change; n for a change made by the n-th rule of a chain.
    pub depth: u32,
    pub chain: Vec<String>,
    pub run_id: String,
}

pub fn origin_of(rule: &str) -> String {
    format!("automation:{rule}")
}

fn writer(rule: &str) -> Writer {
    Writer {
        user_id: origin_of(rule),
        name: "Automation".into(),
        color: "#6b7280".into(),
        origin: origin_of(rule),
        mode_default: crate::ai::tools::WriteMode::Direct,
    }
}

fn find_rule(doc: &Doc, id: &str) -> Option<Result<Rule, String>> {
    oc_model::automation::read_rules(doc)
        .into_iter()
        .find(|(rid, ..)| rid == id)
        .map(|(_, _, r)| r)
}

fn title(doc: &Doc) -> String {
    oc_model::doc_to_json(doc)["meta"]["title"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn owner_seen(doc: &Doc, owner: &str) -> Option<i64> {
    oc_model::doc_to_json(doc)["people"][owner]["lastSeen"].as_i64()
}

/// The subjects a run acts on: the triggering row or item, every row a date rule matches, or
/// none for a schedule.
fn subjects(doc: &Doc, rule: &Rule, ev: &Event, tz: &Tz) -> Vec<Subject> {
    match (ev, &rule.trigger) {
        (
            Event::Tick { slot, .. },
            Trigger::DateReached {
                database,
                field,
                offset_days,
                ..
            },
        ) => {
            let date = super::schedule::target_date(*slot, tz, *offset_days);
            engine::rows_dated(doc, database, field, &date)
                .into_iter()
                .map(|row| Subject {
                    db: Some(database.clone()),
                    row: Some(row),
                    ..Subject::default()
                })
                .collect()
        }
        _ => vec![Subject::of(ev)],
    }
}

/// Pauses a rule (written as Automation; never triggers rules).
pub fn pause_fn(rule: String, code: &'static str, at: String) -> ToolFn {
    Box::new(move |doc: &Doc| {
        let s = oc_model::new_doc();
        let state =
            yrs::Transact::transact(doc).encode_state_as_update_v1(&yrs::StateVector::default());
        oc_model::ocanvas::apply_update_bytes(&s, &state)
            .map_err(|e| ToolError::Internal(e.to_string()))?;
        let before = yrs::Transact::transact(&s).state_vector();
        {
            let root = s.get_or_insert_map(oc_model::automation::ROOT);
            let mut txn = yrs::Transact::transact_mut(&s);
            let mut f = JsonMap::new();
            f.insert("paused".into(), json!({"code": code, "at": at}));
            oc_model::automation::write_fields(&mut txn, &root, &rule, &f);
        }
        let u = yrs::Transact::transact(&s).encode_state_as_update_v1(&before);
        Ok((Some(u), json!({})))
    })
}

struct Outcome {
    result: &'static str,
    code: String,
    http: i64,
    changes: i64,
    notified: i64,
}

impl Outcome {
    fn new(result: &'static str, code: &str) -> Self {
        Self {
            result,
            code: code.into(),
            http: 0,
            changes: 0,
            notified: 0,
        }
    }
}

/// Runs `job` and returns its log row.
pub async fn run(d: &Deps, applier: &dyn Applier, job: Job) -> RunRow {
    let started = Instant::now();
    let cfg = AutomationCfg::of(&job.host);
    let now = d.clock.now_ms();
    let mut row = RunRow {
        id: job.run_id.clone(),
        room_id: job.room.clone(),
        host_id: job.host.id.clone(),
        file_id: job.file_id.clone(),
        rule_id: job.rule_id.clone(),
        trigger: job.event.kind().to_string(),
        result: "running".into(),
        error_code: String::new(),
        http_status: 0,
        changes: 0,
        notified: 0,
        depth: job.depth as i64,
        duration_ms: 0,
        at: now,
    };
    match d.store.automation_run_insert(&row).await {
        Ok(true) => {}
        Ok(false) => {
            row.result = "duplicate".into();
            return row;
        }
        Err(e) => {
            tracing::warn!(room = %job.room, error = %e, "automation run log failed");
            row.result = "failed".into();
            row.error_code = "LOG_FAILED".into();
            return row;
        }
    }
    let o = attempt(d, applier, &job, &cfg, now).await;
    row.result = o.result.into();
    row.error_code = o.code;
    row.http_status = o.http;
    row.changes = o.changes;
    row.notified = o.notified;
    row.duration_ms = started.elapsed().as_millis() as i64;
    if let Err(e) = d.store.automation_run_finish(&row).await {
        tracing::warn!(room = %job.room, error = %e, "automation run log failed");
    }
    let mut data = json!({"ruleId": row.rule_id, "runId": row.id, "trigger": row.trigger,
        "by": origin_of(&row.rule_id)});
    let kind = if row.result == "failed" {
        data["code"] = json!(row.error_code);
        if row.http_status > 0 {
            data["httpStatus"] = json!(row.http_status);
        }
        crate::events::AUTOMATION_FAILED
    } else {
        data["result"] = json!(row.result);
        data["changes"] = json!(row.changes);
        if !row.error_code.is_empty() {
            data["code"] = json!(row.error_code);
        }
        crate::events::AUTOMATION_RAN
    };
    d.events.publish(crate::events::FileEvent::new(
        &job.host.id,
        &job.room,
        &job.file_id,
        kind,
        data,
    ));
    if row.result == "failed" {
        auto_pause(d, applier, &job, &row).await;
    }
    tracing::info!(room = %job.room, rule = %job.rule_id, result = %row.result, code = %row.error_code, ms = row.duration_ms, "automation run");
    row
}

async fn auto_pause(d: &Deps, applier: &dyn Applier, job: &Job, _row: &RunRow) {
    let n = d
        .store
        .automation_failures(&job.room, &job.rule_id, PAUSE_AFTER)
        .await
        .unwrap_or(0);
    if n < PAUSE_AFTER {
        return;
    }
    let at = crate::util::rfc3339(d.clock.now_ms());
    let owner = Arc::new(std::sync::Mutex::new(None::<(String, String)>));
    let o2 = owner.clone();
    let rule = job.rule_id.clone();
    let read: ToolFn = Box::new(move |doc: &Doc| {
        if let Some(Ok(r)) = find_rule(doc, &rule) {
            *o2.lock().unwrap() = r.owner_id.clone().map(|o| (o, r.name.clone()));
        }
        Ok((None, json!({})))
    });
    let _ = applier
        .apply(origin_of(&job.rule_id), origin_of(&job.rule_id), read)
        .await;
    let _ = applier
        .apply(
            origin_of(&job.rule_id),
            origin_of(&job.rule_id),
            pause_fn(job.rule_id.clone(), "FAILURES", at),
        )
        .await;
    let who = owner.lock().unwrap().clone();
    if let Some((owner, name)) = who {
        let body = json!({"fileId": job.file_id, "mentioned": [owner], "by": origin_of(&job.rule_id),
            "excerpt": format!("“{name}” failed {PAUSE_AFTER} times in a row and was paused."),
            "automation": {"ruleId": job.rule_id, "paused": "FAILURES"}});
        let _ = d
            .host_client
            .post_mentions(
                &job.host,
                "",
                serde_json::to_vec(&body).unwrap_or_default(),
                &format!("{}-paused", job.run_id),
            )
            .await;
    }
}

async fn attempt(
    d: &Deps,
    applier: &dyn Applier,
    job: &Job,
    cfg: &AutomationCfg,
    now: i64,
) -> Outcome {
    if !cfg.enabled {
        return Outcome::new("skipped", "AUTOMATION_OFF");
    }
    if job.depth >= cfg.max_depth {
        return Outcome::new("stopped", "MAX_DEPTH");
    }
    // Limits: per rule a minute, per canvas a day (logged runs; skipped ones do not count).
    let minute = d
        .store
        .automation_runs(
            &job.room,
            Some(&job.rule_id),
            None,
            None,
            cfg.runs_per_minute as i64 + 1,
        )
        .await
        .map(|v| {
            v.iter()
                .filter(|r| r.at >= now - 60_000 && r.result != "skipped" && r.id != job.run_id)
                .count()
        })
        .unwrap_or(0);
    if minute >= cfg.runs_per_minute as usize {
        return Outcome::new("skipped", "LIMIT_PER_MINUTE");
    }
    let day = d
        .store
        .automation_runs_since(&job.room, now - 86_400_000)
        .await
        .unwrap_or(0);
    if day > cfg.runs_per_day as i64 {
        return Outcome::new("skipped", "LIMIT_PER_DAY");
    }
    // 1. The rule as it is now, and who it runs for.
    let seen = Arc::new(std::sync::Mutex::new(
        None::<(Result<Rule, String>, Option<i64>)>,
    ));
    let s2 = seen.clone();
    let rid = job.rule_id.clone();
    let read: ToolFn = Box::new(move |doc: &Doc| {
        let r = find_rule(doc, &rid).unwrap_or_else(|| Err("the rule was deleted".into()));
        let seen_at = r
            .as_ref()
            .ok()
            .and_then(|r| r.owner_id.as_deref())
            .and_then(|o| owner_seen(doc, o));
        *s2.lock().unwrap() = Some((r, seen_at));
        Ok((None, json!({})))
    });
    if let Err(e) = applier
        .apply(origin_of(&job.rule_id), origin_of(&job.rule_id), read)
        .await
    {
        tracing::info!(room = %job.room, error = %e.message(), "automation: the room did not open");
        return Outcome::new("failed", "FILE_UNAVAILABLE");
    }
    let Some((rule, owner_seen_at)) = seen.lock().unwrap().take() else {
        return Outcome::new("failed", "INTERNAL");
    };
    let rule = match rule {
        Ok(r) => r,
        Err(_) => return Outcome::new("skipped", "RULE_INVALID"),
    };
    if !rule.runnable() {
        return Outcome::new(
            "skipped",
            if rule.paused.is_some() {
                "PAUSED"
            } else {
                "RULE_OFF"
            },
        );
    }
    if job.chain.iter().filter(|r| **r == rule.id).count() > 1 {
        return Outcome::new("stopped", "LOOP");
    }
    if let Some(bad) = rule.actions.iter().find(|a| !cfg.allows(a.kind())) {
        return Outcome::new(
            "skipped",
            &format!("ACTION_OFF_{}", bad.kind().replace('.', "_").to_uppercase()),
        );
    }
    let owner = rule.owner_id.clone().unwrap_or_default();
    // 2. The owner's access, re-checked every run.
    match d.host_client.access(&job.host, &job.file_id, &owner).await {
        Ok(Some(Some(Role::Edit))) => {}
        Ok(Some(_)) => {
            let at = crate::util::rfc3339(now);
            let _ = applier
                .apply(
                    origin_of(&rule.id),
                    origin_of(&rule.id),
                    pause_fn(rule.id.clone(), "OWNER_NO_EDIT", at),
                )
                .await;
            return Outcome::new("skipped", "OWNER_NO_EDIT");
        }
        Ok(None) => {
            if owner_seen_at.is_none_or(|t| now - t > OWNER_SEEN_MS) {
                let at = crate::util::rfc3339(now);
                let _ = applier
                    .apply(
                        origin_of(&rule.id),
                        origin_of(&rule.id),
                        pause_fn(rule.id.clone(), "STALE_OWNER", at),
                    )
                    .await;
                return Outcome::new("skipped", "STALE_OWNER");
            }
        }
        Err(_) => return Outcome::new("failed", "ACCESS_CHECK_FAILED"),
    }
    // 3. Conditions, plan and writes, against the document as it is now.
    let tz =
        Tz::load(rule.time_zone.as_deref().unwrap_or(&cfg.time_zone)).unwrap_or_else(|_| Tz::utc());
    let today = super::schedule::local_date(now / 1000, &tz);
    let rule2 = rule.clone();
    let ev = job.event.clone();
    let actor = job.actor.clone();
    let max_changes = cfg.max_changes;
    let result = Arc::new(std::sync::Mutex::new(
        None::<Result<(engine::Plan, Option<usize>), String>>,
    ));
    let r2 = result.clone();
    let work: ToolFn = Box::new(move |doc: &Doc| {
        let cx_title = title(doc);
        let cx = Cx {
            canvas_title: &cx_title,
            rule_name: &rule2.name,
            today: &today,
        };
        let mut total = engine::Plan::default();
        let mut failed_cond = None;
        for mut s in subjects(doc, &rule2, &ev, &tz) {
            s.actor = actor.clone();
            let db = s.db.as_deref().and_then(|id| Db::read(doc, id));
            if let Err(i) = engine::conditions_hold(&rule2, db.as_ref(), s.row.as_deref(), &today) {
                failed_cond.get_or_insert(i);
                continue;
            }
            match engine::plan(doc, &rule2, &s, &cx) {
                Ok(p) => {
                    total.writes.extend(p.writes);
                    total.notify.extend(p.notify);
                    total.calls.extend(p.calls);
                    total.effects.extend(p.effects);
                }
                Err(e) => {
                    *r2.lock().unwrap() = Some(Err(e));
                    return Ok((None, json!({})));
                }
            }
        }
        if total.changes() > max_changes {
            *r2.lock().unwrap() = Some(Ok((total, failed_cond)));
            return Ok((None, json!({"overLimit": true})));
        }
        let update = engine::apply(doc, &total, &writer(&rule2.id)).map_err(ToolError::BadInput)?;
        *r2.lock().unwrap() = Some(Ok((total, failed_cond)));
        Ok((update, json!({})))
    });
    let applied = applier
        .apply(origin_of(&rule.id), origin_of(&rule.id), work)
        .await;
    let planned = result.lock().unwrap().take();
    let (plan, failed_cond) = match (applied, planned) {
        (Err(e), _) => {
            let code = if e.message().contains("ROLE") {
                "ROLE_FORBIDDEN"
            } else {
                "WRITE_FAILED"
            };
            return Outcome::new("failed", code);
        }
        (Ok(_), Some(Err(_))) => {
            let at = crate::util::rfc3339(now);
            let _ = applier
                .apply(
                    origin_of(&rule.id),
                    origin_of(&rule.id),
                    pause_fn(rule.id.clone(), "BROKEN", at),
                )
                .await;
            return Outcome::new("failed", "RULE_BROKEN");
        }
        (Ok(_), None) => return Outcome::new("failed", "INTERNAL"),
        (Ok(_), Some(Ok(p))) => p,
    };
    if plan.changes() > cfg.max_changes {
        return Outcome::new("stopped", "MAX_CHANGES");
    }
    if plan.writes.is_empty() && plan.notify.is_empty() && plan.calls.is_empty() {
        return Outcome::new(
            "skipped",
            &failed_cond.map_or("NO_MATCH".to_string(), |i| format!("CONDITION_{}", i + 1)),
        );
    }
    let mut out = Outcome::new("done", "");
    out.changes = plan.changes() as i64;
    // 4. Notifications through the host, URL calls.
    for (i, (people, text)) in plan.notify.iter().enumerate() {
        let body = json!({"fileId": job.file_id, "mentioned": people, "by": origin_of(&rule.id),
            "onBehalfOf": owner, "excerpt": text.chars().take(280).collect::<String>(),
            "automation": {"ruleId": rule.id, "name": rule.name, "runId": job.run_id}});
        match d
            .host_client
            .post_mentions(
                &job.host,
                "",
                serde_json::to_vec(&body).unwrap_or_default(),
                &format!("{}-n{i}", job.run_id),
            )
            .await
        {
            Ok(s) if s.is_success() => out.notified += people.len() as i64,
            Ok(s) => {
                out.result = "failed";
                out.code = "NOTIFY_FAILED".into();
                out.http = s.as_u16() as i64;
            }
            Err(_) => {
                out.result = "failed";
                out.code = "NOTIFY_FAILED".into();
            }
        }
    }
    for (url, fields) in &plan.calls {
        let target = match super::url_target(&job.host, cfg, url) {
            Ok(t) => t,
            Err(_) => {
                out.result = "failed";
                out.code = "URL_NOT_ALLOWED".into();
                continue;
            }
        };
        let mut trig = json!({"type": job.event.kind()});
        match &job.event {
            Event::Checked { block, .. } => trig["blockId"] = json!(block),
            Event::RowAdded { db, row } | Event::FieldChanged { db, row, .. } => {
                trig["database"] = json!(db);
                trig["rowId"] = json!(row);
            }
            _ => {}
        }
        if let Some((id, _)) = &job.actor {
            trig["user"] = json!(id);
        }
        let body = json!({"rule": {"id": rule.id, "name": rule.name}, "runId": job.run_id,
            "fileId": job.file_id, "by": owner, "trigger": trig, "fields": fields,
            "at": crate::util::rfc3339(now)});
        let status = call_url(
            d,
            &job.host,
            &target,
            &job.run_id,
            &serde_json::to_vec(&body).unwrap_or_default(),
        )
        .await;
        match status {
            Some(s) if (200..300).contains(&s) => out.http = s,
            Some(s) => {
                out.result = "failed";
                out.code = format!("URL_{s}");
                out.http = s;
            }
            None => {
                out.result = "failed";
                out.code = "URL_UNREACHABLE".into();
            }
        }
    }
    out
}

/// `http.post` (ADR-068): POST, signed like webhooks (v2, the host's secret), `Idempotency-Key`
/// = run id, 10 s, no redirects, 3 tries (now, after 1 min, after 10 min). The last status.
pub async fn call_url(
    d: &Deps,
    host: &HostConfig,
    url: &url::Url,
    run_id: &str,
    body: &[u8],
) -> Option<i64> {
    let secret = crate::webhooks::WebhookCfg::of(host)
        .ok()
        .flatten()
        .and_then(|c| c.secret)
        .map(String::into_bytes)
        .unwrap_or_else(|| host.signing_secret().to_vec());
    let mut last = None;
    for attempt in 0..3 {
        if attempt > 0 {
            // A redirect or a refusal is final (as webhooks); network errors, 408/425/429
            // and 5xx are tried again.
            if last.is_some_and(|s: i64| (300..500).contains(&s) && !matches!(s, 408 | 425 | 429)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(
                RETRY_MS[attempt - 1].load(Ordering::Relaxed),
            ))
            .await;
        }
        let t = crate::util::now_secs();
        let pq = match url.query() {
            Some(q) => format!("{}?{q}", url.path()),
            None => url.path().to_string(),
        };
        let sig = crate::host_client::signature_header(&secret, t, "POST", &pq, body);
        let res = d
            .http
            .post(url.clone())
            .timeout(URL_TIMEOUT)
            .header("content-type", "application/json")
            .header("X-OpenCanvas-Event", "automation.url")
            .header("X-OpenCanvas-Event-Id", run_id)
            .header("Idempotency-Key", run_id)
            .header("X-OpenCanvas-Signature", sig)
            .body(body.to_vec())
            .send()
            .await;
        match res {
            Ok(r) => {
                let s = r.status().as_u16() as i64;
                if (200..300).contains(&s) {
                    return Some(s);
                }
                last = Some(s);
            }
            Err(_) => last = None,
        }
    }
    last
}

/// A test run (AUTO-06/07): what `rule` would do on `subject` (or the most recent matching row
/// or item), changing nothing and sending nothing. Answers `{subject, trigger, conditions,
/// effects, error?}`.
pub fn dry_run(
    doc: &Doc,
    rule_json: &Value,
    row: Option<&str>,
    cfg: &AutomationCfg,
    now_ms: i64,
) -> Value {
    let rule = match parse_rule("au_test", rule_json) {
        Ok(r) => r,
        Err(e) => return json!({"error": e}),
    };
    let tz =
        Tz::load(rule.time_zone.as_deref().unwrap_or(&cfg.time_zone)).unwrap_or_else(|_| Tz::utc());
    let today = super::schedule::local_date(now_ms / 1000, &tz);
    let t = title(doc);
    let cx = Cx {
        canvas_title: &t,
        rule_name: &rule.name,
        today: &today,
    };
    let mut subject = Subject::default();
    let mut label = String::new();
    if let Some(dbid) = rule.trigger.database() {
        let Some(db) = Db::read(doc, dbid) else {
            return json!({"error": "the database was deleted from this canvas"});
        };
        let order: Vec<String> = {
            let j = oc_model::doc_to_json(doc);
            j["databases"][dbid]["order"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_else(|| db.rows.keys().cloned().collect())
        };
        let pick = row.map(String::from).or_else(|| {
            order
                .iter()
                .rev()
                .find(|r| {
                    let matches_to = match &rule.trigger {
                        Trigger::FieldChanged {
                            field,
                            to: Some(want),
                            ..
                        } => db
                            .field(field)
                            .and_then(|f| db.rows.get(*r).and_then(|x| x.get(&f.0)))
                            .is_some_and(|v| {
                                engine::cell_text(v).eq_ignore_ascii_case(&engine::cell_text(want))
                            }),
                        _ => true,
                    };
                    matches_to && engine::conditions_hold(&rule, Some(&db), Some(r), &today).is_ok()
                })
                .cloned()
                .or_else(|| order.last().cloned())
        });
        if let Some(r) = pick {
            label = db.title_of(&r);
            subject = Subject {
                db: Some(dbid.to_string()),
                row: Some(r),
                ..Subject::default()
            };
        }
    }
    let db = subject.db.as_deref().and_then(|id| Db::read(doc, id));
    let conds: Vec<Value> = rule
        .conditions
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let one = Rule { conditions: vec![c.clone()], match_mode: "all".into(), ..rule.clone() };
            json!({"index": i, "field": c.field, "op": c.op, "holds": engine::conditions_hold(&one, db.as_ref(), subject.row.as_deref(), &today).is_ok()})
        })
        .collect();
    let holds = engine::conditions_hold(&rule, db.as_ref(), subject.row.as_deref(), &today).is_ok();
    let mut out = json!({"subject": {"rowId": subject.row, "title": label}, "trigger": rule.trigger.kind(),
        "conditions": conds, "conditionsHold": holds, "changed": false, "sent": false});
    match engine::plan(doc, &rule, &subject, &cx) {
        Ok(p) => {
            out["effects"] = json!(p.effects);
            out["changes"] = json!(p.changes());
        }
        Err(e) => out["error"] = json!(e),
    }
    for a in &rule.actions {
        if !cfg.allows(a.kind()) {
            out["error"] = json!(format!(
                "the action {} is turned off for this host",
                a.kind()
            ));
        }
    }
    out
}
