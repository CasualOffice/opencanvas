// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Automation (AUTO-01..05, ADR-067, ADR-068, docs/34 §5): rules stored in the canvas
//! (`oc_model::automation`), run by the node that owns the room as the collaborator
//! "Automation" on behalf of the rule's owner.
//!
//! - [`AutomationCfg`]: `[host.automation]` (off unless the operator turns it on).
//! - [`engine`]: what changed (row added, field changed, checklist checked, comment added),
//!   which rules match, their conditions, and the plan of a run, as pure functions over a doc.
//! - [`runner`]: one run: the owner's access re-checked through `/access`, the writes as one
//!   server transaction (origin `automation:<ruleId>`), notify through `POST /mentions`, URL
//!   calls signed like webhooks, the run log, events, auto-pause.
//! - [`schedule`]: next run times for date and schedule rules, in the canvas time zone.
//! - [`tz`]: time zones from the system's zoneinfo (no new dependency).

pub mod engine;
pub mod runner;
pub mod schedule;
pub mod tz;
pub mod worker;

use url::Url;

use crate::hosts::HostConfig;

/// Every action kind the server knows (the operator may allow fewer).
pub const ACTIONS: [&str; 7] = [
    "field.set",
    "row.move",
    "todo.set",
    "todo.add",
    "comment.add",
    "notify",
    "http.post",
];

/// `[host.automation]`, checked.
#[derive(Debug, Clone, PartialEq)]
pub struct AutomationCfg {
    pub enabled: bool,
    pub max_rules: usize,
    pub runs_per_minute: u32,
    pub runs_per_day: u32,
    pub max_changes: usize,
    pub max_depth: u32,
    pub min_interval_min: u32,
    pub time_zone: String,
    /// Extra origins `http.post` may call, besides the host's callback origin.
    pub allow_origins: Vec<Url>,
    pub actions: Vec<String>,
}

impl Default for AutomationCfg {
    fn default() -> Self {
        Self {
            enabled: false,
            max_rules: 25,
            runs_per_minute: 60,
            runs_per_day: 1000,
            max_changes: 50,
            max_depth: 3,
            min_interval_min: 15,
            time_zone: "UTC".into(),
            allow_origins: vec![],
            actions: ACTIONS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

fn int(t: &toml::Table, k: &str, lo: i64, hi: i64, d: i64) -> anyhow::Result<i64> {
    match t.get(k) {
        None => Ok(d),
        Some(v) => v
            .as_integer()
            .filter(|n| (lo..=hi).contains(n))
            .ok_or_else(|| anyhow::anyhow!("[host.automation] {k} is {lo}-{hi}")),
    }
}

impl AutomationCfg {
    pub fn parse(t: &toml::Table) -> anyhow::Result<Self> {
        let d = Self::default();
        for k in t.keys() {
            if !matches!(
                k.as_str(),
                "enabled"
                    | "max_rules"
                    | "runs_per_minute"
                    | "runs_per_day"
                    | "max_changes"
                    | "max_depth"
                    | "min_interval_min"
                    | "time_zone"
                    | "allow_origins"
                    | "actions"
            ) {
                anyhow::bail!("[host.automation] has no setting {k:?}");
            }
        }
        let enabled = match t.get("enabled") {
            None => !t.is_empty(),
            Some(v) => v
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("[host.automation] enabled takes true or false"))?,
        };
        let time_zone = match t.get("time_zone") {
            None => d.time_zone.clone(),
            Some(v) => {
                let z = v
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("[host.automation] time_zone is a string"))?;
                tz::Tz::load(z)
                    .map_err(|e| anyhow::anyhow!("[host.automation] time_zone {z:?}: {e}"))?;
                z.to_string()
            }
        };
        let mut allow_origins = vec![];
        if let Some(v) = t.get("allow_origins") {
            for o in v
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("[host.automation] allow_origins is a list"))?
            {
                let s = o.as_str().unwrap_or_default();
                let u = Url::parse(s).map_err(|e| {
                    anyhow::anyhow!("[host.automation] allow_origins entry {s:?}: {e}")
                })?;
                if !matches!(u.scheme(), "https" | "http")
                    || u.host_str().is_none()
                    || !u.username().is_empty()
                    || u.path() != "/"
                    || u.query().is_some()
                {
                    anyhow::bail!(
                        "[host.automation] allow_origins entry {s:?} must be an origin like https://ci.example"
                    );
                }
                allow_origins.push(u);
            }
        }
        let actions = match t.get("actions") {
            None => d.actions.clone(),
            Some(v) => {
                let mut out = vec![];
                for a in v
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("[host.automation] actions is a list"))?
                {
                    let a = a.as_str().unwrap_or_default();
                    if !ACTIONS.contains(&a) {
                        anyhow::bail!(
                            "[host.automation] unknown action {a:?}; one of {}",
                            ACTIONS.join(", ")
                        );
                    }
                    out.push(a.to_string());
                }
                out
            }
        };
        Ok(Self {
            enabled,
            max_rules: int(
                t,
                "max_rules",
                1,
                oc_model::automation::MAX_RULES as i64,
                25,
            )? as usize,
            runs_per_minute: int(t, "runs_per_minute", 1, 600, 60)? as u32,
            runs_per_day: int(t, "runs_per_day", 1, 100_000, 1000)? as u32,
            max_changes: int(t, "max_changes", 1, 500, 50)? as usize,
            max_depth: int(t, "max_depth", 1, 10, 3)? as u32,
            min_interval_min: int(t, "min_interval_min", 15, 1440, 15)? as u32,
            time_zone,
            allow_origins,
            actions,
        })
    }

    pub fn of(host: &HostConfig) -> Self {
        Self::parse(&host.automation).unwrap_or_default()
    }

    pub fn allows(&self, action: &str) -> bool {
        self.actions.iter().any(|a| a == action)
    }

    /// The origins `http.post` may call, for the editor ("may call docs.acme.example or …").
    pub fn origins(&self, host: &HostConfig) -> Vec<String> {
        let mut out = vec![];
        if let Ok(u) = Url::parse(&host.callback_base) {
            out.push(u.origin().ascii_serialization());
        }
        out.extend(
            self.allow_origins
                .iter()
                .map(|u| u.origin().ascii_serialization()),
        );
        out
    }
}

/// The URL an `http.post` action calls (ADR-068): on the host's callback origin (as webhooks,
/// with the dev callback override) or an operator `allow_origins` entry; credentials in the URL
/// are refused. Checked when a rule is saved and again before every call.
pub fn url_target(host: &HostConfig, cfg: &AutomationCfg, raw: &str) -> Result<Url, String> {
    let u = Url::parse(raw).map_err(|_| "not a URL".to_string())?;
    if !matches!(u.scheme(), "https" | "http") || u.host_str().is_none() {
        return Err("the URL must be http(s)://host/…".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("the URL must not carry credentials".into());
    }
    if let Ok(t) = crate::webhooks::target(host, &u) {
        return Ok(t);
    }
    if cfg.allow_origins.iter().any(|o| o.origin() == u.origin()) {
        return Ok(u);
    }
    Err(format!(
        "{} is not allowed; automations here may call {}",
        u.origin().ascii_serialization(),
        cfg.origins(host).join(" or ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_limits_and_errors() {
        let c = AutomationCfg::parse(&toml::Table::new()).unwrap();
        assert!(!c.enabled);
        let c = AutomationCfg::parse(&toml::from_str("enabled = true").unwrap()).unwrap();
        assert!(c.enabled && c.max_rules == 25 && c.max_depth == 3 && c.min_interval_min == 15);
        assert_eq!(c.actions.len(), 7);
        for bad in [
            "max_rules = 101",
            "min_interval_min = 5",
            "actions = [\"delete.canvas\"]",
            "allow_origins = [\"https://ci.example/path\"]",
            "allow_origins = [\"ftp://ci.example\"]",
            "colour = 1",
            "time_zone = \"Mars/Olympus\"",
        ] {
            assert!(
                AutomationCfg::parse(&toml::from_str(bad).unwrap()).is_err(),
                "{bad}"
            );
        }
        let c = AutomationCfg::parse(
            &toml::from_str("allow_origins = [\"https://ci.example\"]\nactions = [\"notify\"]")
                .unwrap(),
        )
        .unwrap();
        assert!(c.enabled && c.allows("notify") && !c.allows("http.post"));
    }
}
