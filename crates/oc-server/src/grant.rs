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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub color: String,
    pub avatar: Option<String>,
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
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grant {
    pub host_id: String,
    pub room: String,
    pub role: Role,
    pub user: User,
    pub file: FileRef,
    pub perms: Perms,
    pub callback_token: String,
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

    /// The `user` object stamped into awareness states.
    pub fn awareness_user(&self) -> Value {
        json!({"id": self.user.id, "name": self.user.name, "color": self.user.color, "avatar": self.user.avatar})
    }
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
    #[test]
    fn room_ids_are_stable_and_short() {
        let a = super::room_id("acme", "doc_1");
        assert_eq!(a.len(), 28);
        assert_eq!(a, super::room_id("acme", "doc_1"));
        assert_ne!(a, super::room_id("acme", "doc_2"));
    }
}
