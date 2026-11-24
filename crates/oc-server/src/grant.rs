// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! What a session may do: built from the launch token, stored with the session row.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    View,
    Comment,
    Edit,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "view" => Some(Role::View),
            "comment" => Some(Role::Comment),
            "edit" => Some(Role::Edit),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::View => "view",
            Role::Comment => "comment",
            Role::Edit => "edit",
        }
    }
}

/// A person as the host describes them (docs/21 "The user object").
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub color: String,
    pub avatar: Option<String>,
    /// Host-chosen second line (team, title, handle) that tells same-named people apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRef {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Perms {
    #[serde(default = "yes")]
    pub export: bool,
    #[serde(default = "yes")]
    pub download: bool,
    #[serde(default = "yes")]
    pub comment: bool,
    /// PDF export / print (WOPI `DisablePrint`; JWT `perms.print`).
    #[serde(default = "yes")]
    pub print: bool,
    /// docs/30 §7: see history, previews and diffs. Absent: editors yes, others no.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<bool>,
    /// docs/30 §5: restore a version (with the edit role). Default true.
    #[serde(default = "yes")]
    pub restore: bool,
    /// docs/30 §4: name a version (with the edit role). Default true.
    #[serde(default = "yes", rename = "commitMessage")]
    pub commit_message: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Grant {
    pub host_id: String,
    pub room: String,
    pub role: Role,
    pub user: User,
    pub file: FileRef,
    pub perms: Perms,
    pub callback_token: String,
    /// docs/21 revision 2: the people with access to this canvas, from the launch token
    /// (`members[]`, at most 500).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<User>,
    /// WOPI launches: what CheckFileInfo said about version history (docs/30 §3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wopi_history: Option<WopiHistory>,
    /// BSDK-02 (docs/15 §3): the connection said it keeps `extBlock` nodes (`caps=ext` on the
    /// WebSocket URL). Editors before 0.2 delete nodes their schema lacks, so an update from a
    /// connection without it that deletes an `extBlock` is refused and the connection closed
    /// with 4426.
    #[serde(default)]
    pub ext_blocks: bool,
}

/// CheckFileInfo `OpenCanvas_SupportsVersions`, `FileVersionUrl`, `FileVersionPostMessage`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WopiHistory {
    pub supports: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub post_message: bool,
}

/// Like the derived `Debug`, with the callback bearer (WOPI: the access token) redacted, so
/// a `?grant` in a log line can never leak it (SEC-09).
impl std::fmt::Debug for Grant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grant")
            .field("host_id", &self.host_id)
            .field("room", &self.room)
            .field("role", &self.role)
            .field("user", &self.user)
            .field("file", &self.file)
            .field("perms", &self.perms)
            .field("members", &self.members.len())
            .field("callback_token", &"<redacted>")
            .finish()
    }
}

impl Grant {
    /// Applies a live role change from the host (docs/05 §7).
    pub fn set_role(&mut self, role: Role) {
        self.role = role;
        self.perms.comment = role != Role::View;
    }

    pub fn can_write(&self) -> bool {
        self.role != Role::View
    }

    /// docs/30 §7: history, previews and diffs. Editors by default; others only with
    /// `perms.history` (WOPI `OpenCanvas_UserCanSeeHistory`).
    pub fn can_see_history(&self) -> bool {
        self.perms.history.unwrap_or(self.role == Role::Edit)
    }

    /// docs/30 §5: restore needs the edit role, `perms.restore` and history access.
    pub fn can_restore(&self) -> bool {
        self.role == Role::Edit && self.perms.restore && self.can_see_history()
    }

    /// docs/30 §4: naming a version needs the edit role and `perms.commitMessage`.
    pub fn can_name_version(&self) -> bool {
        self.role == Role::Edit && self.perms.commit_message
    }

    /// The `user` object stamped into awareness states.
    pub fn awareness_user(&self) -> Value {
        let mut v = json!({"id": self.user.id, "name": self.user.name, "color": self.user.color, "avatar": self.user.avatar});
        if let Some(d) = &self.user.detail {
            v["detail"] = json!(d);
        }
        v
    }
}

/// `#rgb`, `#rrggbb` or `#rrggbbaa` (SEC-12): the colour ends up in other people's CSS.
pub fn is_hex_color(c: &str) -> bool {
    c.strip_prefix('#')
        .is_some_and(|h| matches!(h.len(), 3 | 6 | 8) && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

const PALETTE: [&str; 10] = [
    "#7a45f0", "#2563eb", "#0891b2", "#059669", "#65a30d", "#d97706", "#dc2626", "#db2777",
    "#9333ea", "#4f46e5",
];

pub fn derive_color(user_id: &str) -> String {
    let h = Sha256::digest(user_id.as_bytes());
    PALETTE[h[0] as usize % PALETTE.len()].to_string()
}

/// `r_` + 26 base32 chars of sha256(host:file) (docs/04 §3).
pub fn room_id(host_id: &str, file_id: &str) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let digest = Sha256::digest(format!("{host_id}:{file_id}").as_bytes());
    let mut out = String::from("r_");
    let (mut buf, mut bits) = (0u32, 0u32);
    for &b in digest.iter() {
        buf = (buf << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 && out.len() < 28 {
            bits -= 5;
            out.push(ALPHABET[((buf >> bits) & 31) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {

    /// SEC-09: `{:?}` of a grant (or a session built from it) must never print the token.
    #[test]
    fn debug_output_redacts_the_callback_token() {
        let g = super::Grant {
            ext_blocks: false,
            wopi_history: None,
            host_id: "h".into(),
            room: "r".into(),
            role: super::Role::Edit,
            user: super::User {
                id: "u".into(),
                name: "U".into(),
                color: "#123456".into(),
                ..Default::default()
            },
            file: super::FileRef {
                id: "f".into(),
                name: "F".into(),
                version: None,
            },
            perms: super::Perms::default(),
            callback_token: "super-secret-bearer".into(),
            members: vec![],
        };
        let dbg = format!("{g:?}");
        assert!(!dbg.contains("super-secret-bearer"), "{dbg}");
        assert!(dbg.contains("callback_token"), "{dbg}");
    }
    #[test]
    fn room_ids_are_stable_and_short() {
        let a = super::room_id("acme", "doc_1");
        assert_eq!(a.len(), 28);
        assert_eq!(a, super::room_id("acme", "doc_1"));
        assert_ne!(a, super::room_id("acme", "doc_2"));
    }
}
