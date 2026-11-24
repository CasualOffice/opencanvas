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

/// A decoded version: its `document.json` and Yjs state (what the editor previews).
pub struct VersionDoc {
    pub json: Value,
    pub state: Vec<u8>,
}

/// The host's current file as far as in-file history is concerned (ADR-055).
pub struct FileSnapshot {
    pub current: Value,
    pub meta: oc_model::history::VersionMeta,
    pub history: oc_model::history::FileHistory,
}

/// In-memory caches (docs/30 §6.1: memory only, never the database). Keys start with the room
/// id, so a room's entries can be dropped together.
pub struct Caches {
    /// Decoded versions, 64 MB, 5 minutes.
    pub versions: oc_model::diff::DiffCache<VersionDoc>,
    /// Diff results between two fixed versions, 16 MB, 5 minutes.
    pub diffs: oc_model::diff::DiffCache<Value>,
    /// Version lists, 30 s (docs/30 §2: listing costs a host round trip).
    pub lists: oc_model::diff::DiffCache<Value>,
    /// The host file's in-file history, 30 s.
    pub files: oc_model::diff::DiffCache<FileSnapshot>,
    /// Rooms whose host answered the list call with 404/405/501: no host history, until the
    /// server-clock second stored (5 minutes later; SEC-53).
    pub unsupported: std::sync::Mutex<std::collections::HashMap<String, i64>>,
    /// The newest save each room's editors were told about (`known` on the list call, VH-01d):
    /// a list cached before it is stale.
    pub known: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl Default for Caches {
    fn default() -> Self {
        use std::time::Duration;
        Self {
            versions: oc_model::diff::DiffCache::new(64 << 20, Duration::from_secs(300)),
            diffs: oc_model::diff::DiffCache::new(16 << 20, Duration::from_secs(300)),
            lists: oc_model::diff::DiffCache::new(8 << 20, Duration::from_secs(30)),
            files: oc_model::diff::DiffCache::new(64 << 20, Duration::from_secs(30)),
            unsupported: Default::default(),
            known: Default::default(),
        }
    }
}

impl Caches {
    /// Forgets what a save makes stale for `room` (lists, the file snapshot).
    pub fn saved(&self, room: &str) {
        self.lists.remove_prefix(room);
        self.files.remove_prefix(room);
    }

    /// The editor names the newest save it knows of (the `saved` control's version). The first
    /// time a room sees that version, its cached lists are dropped. Bounded: one entry per room,
    /// at most 10,000 rooms (then it starts over).
    pub fn seen(&self, room: &str, version: &str) {
        if version.is_empty() || version.len() > 200 {
            return;
        }
        let mut k = self.known.lock().expect("lock");
        if k.get(room).map(String::as_str) == Some(version) {
            return;
        }
        if k.len() >= 10_000 {
            k.clear();
        }
        k.insert(room.to_string(), version.to_string());
        drop(k);
        self.saved(room);
    }
}
