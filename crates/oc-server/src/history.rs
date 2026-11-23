// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Version history (docs/30, ADR-051, ADR-055): where a session's versions come from.
//!
//! Two sources, chosen per host: the host's own versions (JWT callbacks, WOPI extensions) and
//! the bounded history kept inside the `.ocanvas` (in-file). OpenCanvas stores no version in
//! its database (AGENTS.md rule 5).

use serde_json::{Value, json};

use crate::grant::Grant;
use crate::host_client::SaveTarget;
use crate::hosts::HostConfig;

/// What the history panel can do for this session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sources {
    /// The host lists and returns versions.
    pub host: bool,
    /// In-file history is kept (ADR-055).
    pub file: bool,
    /// A link to the host's own version page (`link` mode), and whether to post
    /// `UI_FileVersions` to the host page instead of opening it.
    pub link: Option<String>,
    pub post_message: bool,
    /// `[host.versions] prefer_host`.
    pub prefer_host: bool,
}

impl Sources {
    pub fn of(host: &HostConfig, grant: &Grant) -> Self {
        if host.ephemeral() {
            return Self {
                host: false,
                file: false,
                link: None,
                post_message: false,
                prefer_host: true,
            };
        }
        let wopi = matches!(
            SaveTarget::of(host, &grant.file.id),
            Ok(SaveTarget::Wopi(_))
        );
        let (host_full, link, post_message) = match (&grant.wopi_history, wopi) {
            (Some(w), true) => (w.supports, w.url.clone(), w.post_message),
            _ => (host.host_history(), host.history_url(&grant.file.id), false),
        };
        Self {
            host: host_full,
            file: host.file_history().is_some(),
            link,
            post_message,
            prefer_host: host.prefer_host_versions(),
        }
    }

    /// `full` | `link` | `none` (docs/30 §3 support detection).
    pub fn mode(&self) -> &'static str {
        if self.host || self.file {
            "full"
        } else if self.link.is_some() {
            "link"
        } else {
            "none"
        }
    }

    /// The list shown first: `host` or `file`; `None` without history.
    pub fn primary(&self) -> Option<&'static str> {
        match (self.host, self.file) {
            (true, false) => Some("host"),
            (true, true) if self.prefer_host => Some("host"),
            (_, true) => Some("file"),
            _ => None,
        }
    }

    /// The session answer's history fields (docs/15 §2).
    pub fn session_json(&self, host: &HostConfig) -> Value {
        let mut v = json!({"history": self.mode()});
        if let Some(p) = self.primary() {
            v["historySource"] = json!(p);
            // The panel footer: "Kept in this file" or "Kept by <host name>".
            v["historyHostName"] = json!(host.name);
        }
        if self.mode() == "link" {
            v["historyUrl"] = json!(self.link);
            v["historyPostMessage"] = json!(self.post_message);
        }
        v
    }
}
