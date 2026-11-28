// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Admin settings (docs/40 §4.9), kept as one JSON value in `meta`. A value the operator fixed
//! in the environment wins and is reported as locked.

use serde::{Deserialize, Serialize};

use crate::db::Db;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PublicLinks {
    /// "Anyone with the link" may be offered at all (off by default, docs/40 §9.2).
    pub allowed: bool,
    /// The highest role a public link may give: view, comment or edit (owner decision 6).
    pub max_role: String,
    /// Default expiry for new links in days; 0 = never.
    pub default_expiry_days: i64,
    /// Every public link needs a password.
    pub require_password: bool,
}

impl Default for PublicLinks {
    fn default() -> Self {
        Self {
            allowed: false,
            max_role: "view".into(),
            default_expiry_days: 30,
            require_password: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct History {
    /// Every save is kept this many hours …
    pub all_hours: i64,
    /// … then one per hour for this many days …
    pub hourly_days: i64,
    /// … then one per day for this many days. Named versions forever.
    pub daily_days: i64,
}

impl Default for History {
    fn default() -> Self {
        Self {
            all_hours: 24,
            hourly_days: 7,
            daily_days: 90,
        }
    }
}

/// Outgoing e-mail (docs/40 §4.9): optional; invites and resets are links without it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Smtp {
    pub enabled: bool,
    pub host: String,
    pub port: u32,
    /// starttls | tls | none
    pub security: String,
    pub username: String,
    /// Write-only: answered as "" with `hasPassword`.
    pub password: String,
    pub has_password: bool,
    pub from: String,
}

impl Default for Smtp {
    fn default() -> Self {
        Self {
            enabled: false,
            host: String::new(),
            port: 587,
            security: "starttls".into(),
            username: String::new(),
            password: String::new(),
            has_password: false,
            from: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub org_name: String,
    pub public_url: String,
    pub public_links: PublicLinks,
    /// Days in Trash before a purge (1–365).
    pub trash_days: i64,
    pub history: History,
    /// E-mail domains that may sign up without an invite (open sign-up; empty = off).
    pub signup_domains: Vec<String>,
    pub members_create_workspaces: bool,
    pub accent: String,
    pub sign_in_message: String,
    pub smtp: Smtp,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            org_name: "OpenCanvas".into(),
            public_url: String::new(),
            public_links: PublicLinks::default(),
            trash_days: 30,
            history: History::default(),
            signup_domains: vec![],
            members_create_workspaces: true,
            accent: "#2a5ad7".into(),
            sign_in_message: String::new(),
            smtp: Smtp::default(),
        }
    }
}

/// Settings fixed by the operator (`WS_*`), shown as "Set by the operator".
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Locked {
    pub public_url: bool,
    pub public_links_allowed: bool,
    pub public_links_max_role: bool,
}

impl Settings {
    pub async fn load(db: &Db, cfg: &crate::config::WsConfig) -> anyhow::Result<(Self, Locked)> {
        let mut s: Settings = match db.meta("settings").await? {
            Some(v) => serde_json::from_str(&v).unwrap_or_default(),
            None => Settings::default(),
        };
        let mut locked = Locked::default();
        if let Some(u) = &cfg.public_url {
            s.public_url = u.clone();
            locked.public_url = true;
        }
        if let Some(on) = cfg.public_links {
            s.public_links.allowed = on;
            locked.public_links_allowed = true;
        }
        if let Some(r) = &cfg.public_link_max_role {
            s.public_links.max_role = r.clone();
            locked.public_links_max_role = true;
        }
        Ok((s, locked))
    }

    pub async fn save(&self, db: &Db) -> anyhow::Result<()> {
        db.set_meta("settings", &serde_json::to_string(self)?).await
    }

    /// Checks an admin's edit; returns the reason it is refused.
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=365).contains(&self.trash_days) {
            return Err("Trash keeps items 1 to 365 days.");
        }
        if !matches!(
            self.public_links.max_role.as_str(),
            "view" | "comment" | "edit"
        ) {
            return Err("Public links can give view, comment or edit.");
        }
        if !(0..=3650).contains(&self.public_links.default_expiry_days) {
            return Err("Link expiry is 0 (never) to 3650 days.");
        }
        let h = &self.history;
        if !(1..=24 * 30).contains(&h.all_hours)
            || !(0..=365).contains(&h.hourly_days)
            || !(0..=3650).contains(&h.daily_days)
        {
            return Err("History retention is out of range.");
        }
        if self.org_name.trim().is_empty() || self.org_name.chars().count() > 80 {
            return Err("The organisation name is 1 to 80 characters.");
        }
        if !self.public_url.is_empty()
            && !(self.public_url.starts_with("http://") || self.public_url.starts_with("https://"))
        {
            return Err("The public address starts with http:// or https://.");
        }
        let hex = |c: &str| {
            c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
        };
        if !hex(&self.accent) {
            return Err("The accent colour is like #2a5ad7.");
        }
        if self.sign_in_message.chars().count() > 280 {
            return Err("The sign-in message is at most 280 characters.");
        }
        let m = &self.smtp;
        if !(1..=65_535).contains(&m.port)
            || !matches!(m.security.as_str(), "starttls" | "tls" | "none")
        {
            return Err("Check the e-mail server's port and security.");
        }
        if m.enabled && (m.host.trim().is_empty() || !m.from.contains('@')) {
            return Err("E-mail needs a server and a From address.");
        }
        if m.host.chars().any(|c| c.is_whitespace() || c == '/') {
            return Err("The e-mail server is a host name, like smtp.example.com.");
        }
        Ok(())
    }
}
