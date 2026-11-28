// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! First run (WS-09, docs/40 §4.1): a one-time six-word setup code printed in the log, skipped
//! from the same machine; then the organisation, the Owner, the first workspace and, by
//! default, a Welcome workspace with three sample files.

use crate::Ws;
use crate::util::{id, now_ms};

const WORDS: &[&str] = &[
    "maple", "orbit", "lantern", "seven", "quiet", "harbor", "copper", "meadow", "violet",
    "summit", "river", "amber", "falcon", "garden", "pepper", "tundra", "willow", "cobalt",
    "ember", "fjord", "glacier", "hazel", "island", "jasper", "kettle", "lemon", "marble",
    "nectar", "olive", "pebble", "quartz", "raven", "saffron", "timber", "umber", "velvet",
    "walnut", "yarrow", "zephyr", "anchor", "beacon", "canyon", "delta", "echo", "forest",
    "granite", "horizon", "indigo", "juniper", "koala", "lagoon", "mosaic", "nebula", "oasis",
    "prairie", "quill", "ripple", "sierra", "thistle", "upland", "valley", "wander", "yonder",
    "zenith",
];

pub fn new_code() -> String {
    let b = crate::util::random_bytes(6);
    b.iter()
        .map(|x| WORDS[*x as usize % WORDS.len()])
        .collect::<Vec<_>>()
        .join(" ")
}

/// Compares a typed code with the one in the log: order matters, case and separators don't.
pub fn code_matches(expected: &str, typed: &str) -> bool {
    let norm = |s: &str| {
        s.split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(|w| w.to_lowercase())
            .collect::<Vec<_>>()
            .join(" ")
    };
    crate::util::ct_eq(norm(expected).as_bytes(), norm(typed).as_bytes())
}

pub async fn is_done(ws: &Ws) -> anyhow::Result<bool> {
    Ok(ws.db.meta("setup_done").await?.as_deref() == Some("1"))
}

/// Sample content for the Welcome workspace, served as Markdown until the first save.
const WELCOME: &[(&str, &str, &str)] = &[
    (
        "Welcome to OpenCanvas",
        "document",
        "# Welcome to OpenCanvas\n\nThis is a **document**: write, plan and mix any blocks. Type `/` for tables, databases, boards and more.\n\n## Try this\n\n- [ ] Rename this document\n- [ ] Share it with a colleague (Share, top right)\n- [ ] Open the version history\n\n> Everything saves automatically.\n",
    ),
    (
        "Meeting notes",
        "document",
        "# Meeting notes\n\n**Date:** \n\n## Agenda\n\n1. \n\n## Notes\n\n## Action items\n\n- [ ] \n",
    ),
    (
        "Project plan",
        "document",
        "# Project plan\n\n## Goal\n\nWhat does done look like?\n\n## Tasks\n\n| Task | Owner | Due |\n| --- | --- | --- |\n| Kick-off | | |\n| First draft | | |\n| Review | | |\n",
    ),
];

pub struct SetupInput {
    pub org_name: String,
    pub public_url: String,
    pub admin_name: String,
    pub admin_email: String,
    pub admin_password_hash: Option<String>,
    pub workspace_name: String,
    pub sample: bool,
}

/// Creates everything in one transaction; returns the Owner's id.
pub async fn run(ws: &Ws, s: &SetupInput) -> anyhow::Result<String> {
    let now = now_ms();
    let owner = id("u_");
    let mut tx = ws.db.pool.begin().await?;
    // Exactly once, even if two browsers finish setup together.
    let claimed = sqlx::query(sqlx::AssertSqlSafe(format!(
        "{} INTO meta (k, v) VALUES ('setup_claim', ?)",
        ws.db.insert_ignore()
    )))
    .bind(&owner)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    anyhow::ensure!(claimed == 1, "setup is already done");
    sqlx::query("INSERT INTO users (id, email, name, password_hash, role, status, color, created_at) VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?)")
        .bind(&owner)
        .bind(&s.admin_email)
        .bind(&s.admin_name)
        .bind(s.admin_password_hash.as_deref())
        .bind(crate::auth::color_for(&owner))
        .bind(now)
        .execute(&mut *tx)
        .await?;
    let make_ws = |name: &str, icon: &str, color: &str| {
        let wid = id("w_");
        (wid, name.to_string(), icon.to_string(), color.to_string())
    };
    let mut spaces = vec![make_ws(&s.workspace_name, "layers", "blue")];
    if s.sample {
        spaces.push(make_ws("Welcome", "sparkles", "purple"));
    }
    for (wid, name, icon, color) in &spaces {
        sqlx::query("INSERT INTO workspaces (id, name, icon, color, description, visibility, created_at) VALUES (?, ?, ?, ?, '', 'open', ?)")
            .bind(wid)
            .bind(name)
            .bind(icon)
            .bind(color)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO workspace_members (workspace_id, principal_kind, principal_id, role) VALUES (?, 'user', ?, 'admin')")
            .bind(wid)
            .bind(&owner)
            .execute(&mut *tx)
            .await?;
    }
    if s.sample {
        let wid = &spaces[1].0;
        for (i, (name, ftype, md)) in WELCOME.iter().enumerate() {
            sqlx::query("INSERT INTO canvases (id, workspace_id, name, ftype, seed, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(id("c_"))
                .bind(wid)
                .bind(*name)
                .bind(*ftype)
                .bind(*md)
                .bind(&owner)
                .bind(now - i as i64)
                .bind(now - i as i64)
                .execute(&mut *tx)
                .await?;
        }
    }
    personal_space(ws, &mut tx, &owner, now).await?;
    tx.commit().await?;
    let mut settings = crate::settings::Settings::load(&ws.db, &ws.cfg).await?.0;
    settings.org_name = s.org_name.clone();
    if !s.public_url.is_empty() {
        settings.public_url = s.public_url.clone();
        ws.db.set_meta("public_url", &s.public_url).await?;
    }
    settings.save(&ws.db).await?;
    ws.db.set_meta("setup_done", "1").await?;
    *ws.setup_code.lock().unwrap() = None;
    ws.acl.invalidate();
    Ok(owner)
}

/// "My canvases": a private workspace per person.
pub async fn personal_space(
    _ws: &Ws,
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user: &str,
    now: i64,
) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO workspaces (id, name, icon, color, description, visibility, personal_owner, created_at) VALUES (?, 'My canvases', 'lock', 'gray', '', 'private', ?, ?)")
        .bind(id("w_"))
        .bind(user)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_six_words_and_match_loosely() {
        let c = new_code();
        assert_eq!(c.split(' ').count(), 6);
        assert!(code_matches(&c, &c.to_uppercase().replace(' ', " · ")));
        assert!(!code_matches("a b c d e f", "a b c d e g"));
        assert!(!code_matches("a b c d e f", "b a c d e f"));
    }
}
