// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Automation rules and runs over HTTP (AUTO-05, AUTO-07, ADR-067): the API under
//! `/api/v1/files/{fileId}/automations…`, the editor's session routes `/v1/automations/…`, and
//! the MCP tools, one implementation. Rules are document data: writes go through the room as
//! one transaction like any API write; the run log is metadata.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map as JsonMap, Value, json};
use yrs::{Doc, ReadTxn};

use super::problem::Problem;
use super::{Answer, caller, check_file};
use crate::SharedState;
use crate::automation::{AutomationCfg, runner};
use crate::grant::{Grant, Role};
use crate::hosts::HostConfig;
use crate::room::ToolFn;

fn off() -> Problem {
    Problem::not_found(
        "AUTOMATION_OFF",
        "automation is not enabled for this host ([host.automation])",
    )
}
fn forbidden(m: &str) -> Problem {
    Problem::new(StatusCode::FORBIDDEN, "ROLE_FORBIDDEN", m.to_string())
}

/// What the editor and API need to show limits and allowed origins.
pub fn limits_json(host: &HostConfig) -> Value {
    let c = AutomationCfg::of(host);
    json!({"maxRules": c.max_rules, "maxChanges": c.max_changes, "runsPerMinute": c.runs_per_minute,
        "runsPerDay": c.runs_per_day, "maxDepth": c.max_depth, "minIntervalMin": c.min_interval_min,
        "timeZone": c.time_zone, "actions": c.actions, "origins": c.origins(host)})
}

async fn in_room(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
    origin: &str,
    run: ToolFn,
) -> Result<Value, Problem> {
    state
        .rooms
        .tool(host, grant, origin, run)
        .await
        .map_err(Problem::from)
}

/// The rules of a canvas: `{rules: [{id, rule, valid, error?, nextRunAt?}], limits}`.
pub async fn list(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
) -> Result<Value, Problem> {
    if !AutomationCfg::of(host).enabled {
        return Err(off());
    }
    let run: ToolFn = Box::new(|doc: &Doc| {
        let rules: Vec<Value> = oc_model::automation::read_rules(doc)
            .into_iter()
            .map(|(id, j, p)| match p {
                Ok(_) => json!({"id": id, "rule": j, "valid": true}),
                Err(e) => json!({"id": id, "rule": j, "valid": false, "error": e}),
            })
            .collect();
        Ok((None, json!({"rules": rules})))
    });
    let mut out = in_room(state, host, grant, "api:automations", run).await?;
    let next = state
        .store
        .automation_schedule_of(&grant.room)
        .await
        .unwrap_or_default();
    if let Some(rules) = out["rules"].as_array_mut() {
        for r in rules {
            if let Some((_, t)) = next.iter().find(|(id, _)| r["id"] == **id) {
                r["nextRunAt"] = json!(t);
            }
        }
    }
    out["limits"] = limits_json(host);
    Ok(out)
}

/// Checks a rule as the room's client filter does, for server writes.
fn check(host: &HostConfig, id: &str, rule: &Value) -> Result<oc_model::automation::Rule, Problem> {
    let cfg = AutomationCfg::of(host);
    let r = oc_model::automation::parse_rule(id, rule)
        .map_err(|e| Problem::bad_request("RULE_INVALID", e))?;
    for a in &r.actions {
        if !cfg.allows(a.kind()) {
            return Err(Problem::bad_request(
                "RULE_INVALID",
                format!("the action {} is turned off for this host", a.kind()),
            ));
        }
        if let oc_model::automation::Action::HttpPost { url, .. } = a {
            crate::automation::url_target(host, &cfg, url)
                .map_err(|e| Problem::bad_request("URL_NOT_ALLOWED", e))?;
        }
    }
    if let oc_model::automation::Trigger::Schedule {
        every,
        minutes: Some(m),
        ..
    } = &r.trigger
        && every == "minutes"
        && *m < cfg.min_interval_min
    {
        return Err(Problem::bad_request(
            "RULE_INVALID",
            format!(
                "schedules run at most every {} minutes",
                cfg.min_interval_min
            ),
        ));
    }
    Ok(r)
}

fn may_write(host: &HostConfig, grant: &Grant, may_automate: bool) -> Result<(), Problem> {
    if !AutomationCfg::of(host).enabled {
        return Err(off());
    }
    if grant.role != Role::Edit || !may_automate {
        return Err(forbidden(
            "changing automations needs edit access and permission to automate",
        ));
    }
    Ok(())
}

/// Creates or replaces a rule; the caller becomes its owner ("runs as you from now on").
pub async fn save(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
    may_automate: bool,
    rule_id: &str,
    mut body: Value,
) -> Result<Value, Problem> {
    may_write(host, grant, may_automate)?;
    if !body.is_object() {
        return Err(Problem::bad_request(
            "BAD_INPUT",
            "the body is a rule object",
        ));
    }
    body["v"] = json!(1);
    body["ownerId"] = json!(grant.user.id);
    body["ownerName"] = json!(grant.user.name);
    body["updatedAt"] = json!(crate::util::rfc3339(state.clock.now_ms()));
    if body.get("enabled").is_none() {
        body["enabled"] = json!(true);
    }
    body["paused"] = Value::Null;
    check(host, rule_id, &body)?;
    let max = AutomationCfg::of(host).max_rules;
    let id = rule_id.to_string();
    let fields: JsonMap<String, Value> = body.as_object().cloned().unwrap_or_default();
    let run: ToolFn = Box::new(move |doc: &Doc| {
        let rules = oc_model::automation::read_rules(doc);
        if !rules.iter().any(|(r, ..)| *r == id) && rules.len() >= max {
            return Err(crate::ai::tools::ToolError::BadInput(format!(
                "RULE_LIMIT: this canvas has {max} rules, the most it can have"
            )));
        }
        let s = oc_model::new_doc();
        oc_model::ocanvas::apply_update_bytes(&s, &oc_model::ocanvas::encode_state(doc))
            .map_err(|e| crate::ai::tools::ToolError::Internal(e.to_string()))?;
        let before = yrs::Transact::transact(&s).state_vector();
        {
            let root = s.get_or_insert_map(oc_model::automation::ROOT);
            let mut txn = yrs::Transact::transact_mut(&s);
            oc_model::automation::write_fields(&mut txn, &root, &id, &fields);
        }
        let u = yrs::Transact::transact(&s).encode_state_as_update_v1(&before);
        Ok((Some(u), json!({"id": id})))
    });
    in_room(state, host, grant, &format!("api:{}", grant.user.id), run).await
}

/// Switches a rule on (the caller becomes its owner) or off.
pub async fn enable(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
    may_automate: bool,
    rule_id: &str,
    on: bool,
) -> Result<Value, Problem> {
    may_write(host, grant, may_automate)?;
    let (id, user, name, at) = (
        rule_id.to_string(),
        grant.user.id.clone(),
        grant.user.name.clone(),
        crate::util::rfc3339(state.clock.now_ms()),
    );
    let run: ToolFn = Box::new(move |doc: &Doc| {
        if !oc_model::automation::read_rules(doc)
            .iter()
            .any(|(r, ..)| *r == id)
        {
            return Err(crate::ai::tools::ToolError::NotFound(format!(
                "RULE_NOT_FOUND: no rule {id:?}"
            )));
        }
        let mut f = JsonMap::new();
        f.insert("enabled".into(), json!(on));
        if on {
            f.insert("ownerId".into(), json!(user));
            f.insert("ownerName".into(), json!(name));
            f.insert("updatedAt".into(), json!(at));
            f.insert("paused".into(), Value::Null);
        }
        let s = oc_model::new_doc();
        oc_model::ocanvas::apply_update_bytes(&s, &oc_model::ocanvas::encode_state(doc))
            .map_err(|e| crate::ai::tools::ToolError::Internal(e.to_string()))?;
        let before = yrs::Transact::transact(&s).state_vector();
        {
            let root = s.get_or_insert_map(oc_model::automation::ROOT);
            let mut txn = yrs::Transact::transact_mut(&s);
            oc_model::automation::write_fields(&mut txn, &root, &id, &f);
        }
        let u = yrs::Transact::transact(&s).encode_state_as_update_v1(&before);
        Ok((Some(u), json!({"id": id, "enabled": on})))
    });
    in_room(state, host, grant, &format!("api:{}", grant.user.id), run).await
}

pub async fn delete(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
    may_automate: bool,
    rule_id: &str,
) -> Result<Value, Problem> {
    may_write(host, grant, may_automate)?;
    let id = rule_id.to_string();
    let run: ToolFn = Box::new(move |doc: &Doc| {
        if !oc_model::automation::read_rules(doc)
            .iter()
            .any(|(r, ..)| *r == id)
        {
            return Err(crate::ai::tools::ToolError::NotFound(format!(
                "RULE_NOT_FOUND: no rule {id:?}"
            )));
        }
        let s = oc_model::new_doc();
        oc_model::ocanvas::apply_update_bytes(&s, &oc_model::ocanvas::encode_state(doc))
            .map_err(|e| crate::ai::tools::ToolError::Internal(e.to_string()))?;
        let before = yrs::Transact::transact(&s).state_vector();
        {
            let root = s.get_or_insert_map(oc_model::automation::ROOT);
            let mut txn = yrs::Transact::transact_mut(&s);
            yrs::Map::remove(&root, &mut txn, &id);
        }
        let u = yrs::Transact::transact(&s).encode_state_as_update_v1(&before);
        Ok((Some(u), json!({"id": id, "deleted": true})))
    });
    in_room(state, host, grant, &format!("api:{}", grant.user.id), run).await
}

/// A test run: what the rule would do, changing nothing and sending nothing.
pub async fn test(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
    may_automate: bool,
    rule: Value,
    row: Option<String>,
) -> Result<Value, Problem> {
    may_write(host, grant, may_automate)?;
    let cfg = AutomationCfg::of(host);
    if let Err(p) = check(host, "au_test", &rule) {
        let detail = p.body()["detail"].clone();
        return Ok(json!({"error": detail}));
    }
    let now = state.clock.now_ms();
    let run: ToolFn = Box::new(move |doc: &Doc| {
        Ok((None, runner::dry_run(doc, &rule, row.as_deref(), &cfg, now)))
    });
    in_room(state, host, grant, "api:automations", run).await
}

/// The run log (editors only): newest first, `rule` and `result` filters, `before` pages.
pub async fn runs(
    state: &SharedState,
    host: &Arc<HostConfig>,
    grant: &Grant,
    q: &RunsQ,
) -> Result<Value, Problem> {
    if !AutomationCfg::of(host).enabled {
        return Err(off());
    }
    if grant.role != Role::Edit {
        return Err(forbidden("the run history is for editors"));
    }
    let limit = q.limit.unwrap_or(100).clamp(1, 500) as i64;
    let rows = state
        .store
        .automation_runs(
            &grant.room,
            q.rule.as_deref(),
            q.result.as_deref(),
            q.before,
            limit,
        )
        .await
        .map_err(|e| Problem::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", e.to_string()))?;
    let next = rows
        .last()
        .filter(|_| rows.len() as i64 == limit)
        .map(|r| r.at);
    Ok(json!({"runs": rows, "next": next}))
}

#[derive(Deserialize, Default)]
pub struct RunsQ {
    pub rule: Option<String>,
    pub result: Option<String>,
    pub before: Option<i64>,
    pub limit: Option<u64>,
}

fn rule_id_ok(id: &str) -> Result<(), Problem> {
    if oc_model::automation::valid_id(id) {
        Ok(())
    } else {
        Err(Problem::bad_request(
            "BAD_INPUT",
            "a rule id is 1-64 letters, digits, - or _",
        ))
    }
}

fn body_json(body: &Bytes) -> Result<Value, Problem> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body)
        .map_err(|e| Problem::bad_request("BAD_INPUT", format!("the body is not JSON: {e}")))
}

fn ok(v: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response()
}

// ---------- API handlers ----------

async fn api_ctx(
    state: &SharedState,
    headers: &HeaderMap,
    file_id: &str,
) -> Result<(Arc<HostConfig>, Grant, bool), Problem> {
    let p = caller(state, headers).await?;
    check_file(file_id)?;
    let grant = p.grant(state, file_id).await?;
    let writes = crate::ai::tools::role_allows(p.ceiling, crate::ai::tools::Scope::Write);
    Ok((p.host.clone(), grant, writes))
}

pub async fn api_list(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Answer {
    let (host, grant, _) = api_ctx(&state, &headers, &file_id).await?;
    Ok(ok(list(&state, &host, &grant).await?))
}

pub async fn api_put(
    State(state): State<SharedState>,
    Path((file_id, rule_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    rule_id_ok(&rule_id)?;
    let (host, grant, w) = api_ctx(&state, &headers, &file_id).await?;
    Ok(ok(save(
        &state,
        &host,
        &grant,
        w,
        &rule_id,
        body_json(&body)?,
    )
    .await?))
}

pub async fn api_delete(
    State(state): State<SharedState>,
    Path((file_id, rule_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Answer {
    rule_id_ok(&rule_id)?;
    let (host, grant, w) = api_ctx(&state, &headers, &file_id).await?;
    Ok(ok(delete(&state, &host, &grant, w, &rule_id).await?))
}

pub async fn api_enable(
    State(state): State<SharedState>,
    Path((file_id, rule_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    rule_id_ok(&rule_id)?;
    let (host, grant, w) = api_ctx(&state, &headers, &file_id).await?;
    let b = body_json(&body)?;
    let on = b["enabled"]
        .as_bool()
        .ok_or_else(|| Problem::bad_request("BAD_INPUT", "enabled (true or false) is required"))?;
    Ok(ok(enable(&state, &host, &grant, w, &rule_id, on).await?))
}

pub async fn api_test(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (host, grant, w) = api_ctx(&state, &headers, &file_id).await?;
    let b = body_json(&body)?;
    let rule = b
        .get("rule")
        .cloned()
        .ok_or_else(|| Problem::bad_request("BAD_INPUT", "rule is required"))?;
    let row = b["rowId"].as_str().map(String::from);
    Ok(ok(test(&state, &host, &grant, w, rule, row).await?))
}

pub async fn api_runs(
    State(state): State<SharedState>,
    Path(file_id): Path<String>,
    Query(q): Query<RunsQ>,
    headers: HeaderMap,
) -> Answer {
    let (host, grant, _) = api_ctx(&state, &headers, &file_id).await?;
    Ok(ok(runs(&state, &host, &grant, &q).await?))
}

// ---------- editor session routes ----------

/// Explicit fields: a `#[serde(flatten)]` query struct reads every value as a string, so a
/// numeric `limit` or `before` was refused (400).
#[derive(Deserialize)]
pub struct TicketQ {
    pub ticket: String,
    pub rule: Option<String>,
    pub result: Option<String>,
    pub before: Option<i64>,
    pub limit: Option<u64>,
}

fn editor(r: Result<Value, Problem>) -> Response {
    match r {
        Ok(v) => ok(v),
        Err(p) => p.into_response(),
    }
}

/// `GET /v1/automations/runs?ticket=&rule=&result=&before=`.
pub async fn editor_runs(
    State(state): State<SharedState>,
    Query(q): Query<TicketQ>,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = crate::routes::session(&state, &q.ticket).await?;
    let q2 = RunsQ {
        rule: q.rule,
        result: q.result,
        before: q.before,
        limit: q.limit,
    };
    Ok(editor(runs(&state, &host, &grant, &q2).await))
}

#[derive(Deserialize)]
pub struct TicketOnly {
    pub ticket: String,
}

/// `POST /v1/automations/test?ticket=` `{rule, rowId?}`.
pub async fn editor_test(
    State(state): State<SharedState>,
    Query(q): Query<TicketOnly>,
    body: Bytes,
) -> Result<Response, crate::routes::ApiError> {
    let (host, grant) = crate::routes::session(&state, &q.ticket).await?;
    let b = match body_json(&body) {
        Ok(b) => b,
        Err(p) => return Ok(p.into_response()),
    };
    let rule = b.get("rule").cloned().unwrap_or(Value::Null);
    let row = b["rowId"].as_str().map(String::from);
    let may = grant.perms.automate;
    Ok(editor(test(&state, &host, &grant, may, rule, row).await))
}
