// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Operator configuration (`WS_*`, docs/40 §4.1). Everything else is set in the app; a value
//! given here shows there as "Set by the operator" and cannot be changed.

use std::path::PathBuf;

/// What this process runs (docs/40 §3): both halves on one port, or one of them (compose).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    All,
    Workspace,
    Engine,
}

impl Role {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        match s {
            "all" => Ok(Self::All),
            "workspace" => Ok(Self::Workspace),
            "engine" => Ok(Self::Engine),
            other => anyhow::bail!("--role must be all, workspace or engine, got {other:?}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct WsConfig {
    pub data_dir: PathBuf,
    pub bind: String,
    /// `WS_PUBLIC_URL`: fixed by the operator; else the URL chosen at setup.
    pub public_url: Option<String>,
    pub database_url: String,
    /// Where this process reaches the engine (role API, session close). Loopback by default.
    pub engine_url: String,
    /// Where the engine reaches the Workspace's callbacks (docs/05 §5).
    pub callback_base: String,
    /// The engine host id the Workspace is registered as (`[[host]] id`).
    pub host_id: String,
    /// `WS_PUBLIC_LINKS=on|off`: the operator decides whether public links may exist at all.
    pub public_links: Option<bool>,
    /// `WS_PUBLIC_LINK_MAX_ROLE=view|comment|edit`.
    pub public_link_max_role: Option<String>,
    /// Web app files (`web/packages/workspace/dist`); absent = a plain status page.
    pub web_dir: PathBuf,
    /// `WS_SECURE_COOKIES=0` for plain-HTTP trials; on by default when the public URL is https.
    pub secure_cookies: Option<bool>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

impl WsConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let data_dir: PathBuf = var("WS_DATA_DIR").unwrap_or_else(|| "./data".into()).into();
        let bind = var("WS_BIND").unwrap_or_else(|| "0.0.0.0:8080".into());
        let port = bind.rsplit(':').next().unwrap_or("8080").to_string();
        let public_url = var("WS_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_string());
        if let Some(u) = &public_url {
            anyhow::ensure!(
                u.starts_with("http://") || u.starts_with("https://"),
                "WS_PUBLIC_URL must start with http:// or https://"
            );
        }
        let database_url = var("WS_DATABASE_URL")
            .unwrap_or_else(|| format!("sqlite://{}/workspace.db?mode=rwc", data_dir.display()));
        anyhow::ensure!(
            database_url.starts_with("sqlite:") || database_url.starts_with("mysql:"),
            "WS_DATABASE_URL must be sqlite:… or mysql:… (MySQL 8 / MariaDB 10.6+)"
        );
        let public_links = match var("WS_PUBLIC_LINKS").as_deref() {
            None => None,
            Some("on" | "true" | "1") => Some(true),
            Some("off" | "false" | "0") => Some(false),
            Some(v) => anyhow::bail!("WS_PUBLIC_LINKS must be on or off, got {v:?}"),
        };
        let public_link_max_role = var("WS_PUBLIC_LINK_MAX_ROLE");
        if let Some(r) = &public_link_max_role {
            anyhow::ensure!(
                matches!(r.as_str(), "view" | "comment" | "edit"),
                "WS_PUBLIC_LINK_MAX_ROLE must be view, comment or edit"
            );
        }
        Ok(Self {
            engine_url: var("WS_ENGINE_URL")
                .unwrap_or_else(|| format!("http://127.0.0.1:{port}"))
                .trim_end_matches('/')
                .to_string(),
            callback_base: var("WS_CALLBACK_BASE")
                .unwrap_or_else(|| format!("http://127.0.0.1:{port}/api/ws/oc"))
                .trim_end_matches('/')
                .to_string(),
            host_id: var("WS_HOST_ID").unwrap_or_else(|| "workspace".into()),
            web_dir: var("WS_WEB_DIR")
                .unwrap_or_else(|| "web/packages/workspace/dist".into())
                .into(),
            secure_cookies: var("WS_SECURE_COOKIES").map(|v| v != "0" && v != "false"),
            data_dir,
            bind,
            public_url,
            database_url,
            public_links,
            public_link_max_role,
        })
    }

    /// A configuration for tests: everything under `dir`, SQLite.
    pub fn for_tests(dir: &std::path::Path) -> Self {
        Self {
            data_dir: dir.to_path_buf(),
            bind: "127.0.0.1:0".into(),
            public_url: None,
            database_url: format!("sqlite://{}/workspace.db?mode=rwc", dir.display()),
            engine_url: "http://127.0.0.1:9".into(),
            callback_base: "http://127.0.0.1:9/api/ws/oc".into(),
            host_id: "workspace".into(),
            public_links: None,
            public_link_max_role: None,
            web_dir: dir.join("web"),
            secure_cookies: Some(false),
        }
    }

    pub fn files_dir(&self) -> PathBuf {
        self.data_dir.join("files")
    }
    pub fn secrets_dir(&self) -> PathBuf {
        self.data_dir.join("secrets")
    }
}
