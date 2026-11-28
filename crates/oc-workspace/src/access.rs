// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Who may do what (docs/40 §4.3, §4.6; ADR-085 §6). Effective access to a canvas is the highest
//! of: the person's instance role (Owner and Admin: full access, except someone else's "My
//! canvases"), their own "My canvases", their workspace role (directly or through a team), shares
//! on the canvas's folders (inherited downwards), shares on the canvas, and an organisation link
//! (not for guests). Public links are resolved separately, from the link token alone.
//!
//! The resolver works on an in-memory [`Snapshot`] of the access tables, rebuilt after any change,
//! so a 550-person room launching at once costs no database queries per person (docs/40 §0.5).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use sqlx::Row;
use tokio::sync::RwLock;

use crate::db::Db;

/// A role on one canvas or folder. The engine sees `view`, `comment` or `edit`; `Full` (share,
/// move, delete) is enforced only by the Workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    View = 1,
    Comment = 2,
    Edit = 3,
    Full = 4,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "full" => Some(Self::Full),
            "edit" => Some(Self::Edit),
            "comment" => Some(Self::Comment),
            "view" => Some(Self::View),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Edit => "edit",
            Self::Comment => "comment",
            Self::View => "view",
        }
    }
    /// The engine's role (docs/05 §3).
    pub fn engine(self) -> &'static str {
        match self {
            Self::Full | Self::Edit => "edit",
            Self::Comment => "comment",
            Self::View => "view",
        }
    }
    /// A workspace role (Admin, Editor, Commenter, Viewer) as a canvas role.
    pub fn from_workspace_role(s: &str) -> Option<Self> {
        match s {
            "admin" => Some(Self::Full),
            "editor" => Some(Self::Edit),
            "commenter" => Some(Self::Comment),
            "viewer" => Some(Self::View),
            _ => None,
        }
    }
    pub fn workspace_role(self) -> &'static str {
        match self {
            Self::Full => "admin",
            Self::Edit => "editor",
            Self::Comment => "commenter",
            Self::View => "viewer",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instance {
    Owner,
    Admin,
    Member,
    Guest,
}

impl Instance {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "owner" => Some(Self::Owner),
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            "guest" => Some(Self::Guest),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
            Self::Guest => "guest",
        }
    }
    pub fn is_admin(self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Principal {
    User(String),
    Team(String),
}

impl Principal {
    pub fn new(kind: &str, id: String) -> Option<Self> {
        match kind {
            "user" => Some(Self::User(id)),
            "team" => Some(Self::Team(id)),
            _ => None,
        }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Self::User(_) => "user",
            Self::Team(_) => "team",
        }
    }
    pub fn id(&self) -> &str {
        match self {
            Self::User(s) | Self::Team(s) => s,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkAccess {
    None,
    Org,
    Public,
}

impl LinkAccess {
    pub fn parse(s: &str) -> Self {
        match s {
            "org" => Self::Org,
            "public" => Self::Public,
            _ => Self::None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Org => "org",
            Self::Public => "public",
        }
    }
}

#[derive(Clone, Debug)]
pub struct UserAcl {
    pub instance: Instance,
    pub active: bool,
    pub teams: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct WorkspaceAcl {
    pub personal_owner: Option<String>,
    pub open: bool,
    pub deleted: bool,
    pub members: Vec<(Principal, Role)>,
}

#[derive(Clone, Debug)]
pub struct FolderAcl {
    pub workspace: String,
    pub parent: Option<String>,
    pub deleted: bool,
    pub shares: Vec<(Principal, Role)>,
}

#[derive(Clone, Debug)]
pub struct CanvasAcl {
    pub workspace: String,
    pub folder: Option<String>,
    pub deleted: bool,
    pub shares: Vec<(Principal, Role)>,
    pub link: LinkAccess,
    pub link_role: Role,
}

/// The access tables in memory.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub users: HashMap<String, UserAcl>,
    pub workspaces: HashMap<String, WorkspaceAcl>,
    pub folders: HashMap<String, FolderAcl>,
    pub canvases: HashMap<String, CanvasAcl>,
}

/// Folders nest at most this deep (docs/40 §4.4); the walk stops there even on a cycle.
pub const MAX_DEPTH: usize = 8;

impl Snapshot {
    fn best_of(&self, user: &str, u: &UserAcl, grants: &[(Principal, Role)]) -> Option<Role> {
        grants
            .iter()
            .filter(|(p, _)| match p {
                Principal::User(id) => id == user,
                Principal::Team(t) => u.teams.iter().any(|x| x == t),
            })
            .map(|(_, r)| *r)
            .max()
    }

    /// The person's role in a workspace (membership or ownership; admins get Full on shared
    /// workspaces). `None` = not a member.
    pub fn workspace_role(&self, user: &str, ws: &str) -> Option<Role> {
        let u = self.users.get(user).filter(|u| u.active)?;
        let w = self.workspaces.get(ws)?;
        if let Some(owner) = &w.personal_owner {
            return (owner == user).then_some(Role::Full);
        }
        let mut best = self.best_of(user, u, &w.members);
        if u.instance.is_admin() {
            best = Some(Role::Full);
        }
        best
    }

    /// Role on a folder: workspace role, then shares on it and its ancestors.
    pub fn folder_role(&self, user: &str, folder: &str) -> Option<Role> {
        let f = self.folders.get(folder)?;
        let u = self.users.get(user).filter(|u| u.active)?;
        let best = self.workspace_role(user, &f.workspace);
        if self.is_personal_of_other(&f.workspace, user) {
            return best;
        }
        best.max(self.folder_chain_role(user, u, folder))
    }

    fn folder_chain_role(&self, user: &str, u: &UserAcl, start: &str) -> Option<Role> {
        let mut best = None;
        let mut cur = Some(start.to_string());
        let mut seen = HashSet::new();
        for _ in 0..=MAX_DEPTH {
            let Some(id) = cur else { break };
            if !seen.insert(id.clone()) {
                break;
            }
            let Some(f) = self.folders.get(&id) else {
                break;
            };
            best = best.max(self.best_of(user, u, &f.shares));
            cur = f.parent.clone();
        }
        best
    }

    fn is_personal_of_other(&self, ws: &str, user: &str) -> bool {
        self.workspaces
            .get(ws)
            .and_then(|w| w.personal_owner.as_ref())
            .is_some_and(|o| o != user)
    }

    /// Effective role on a canvas, ignoring Trash (callers decide what a trashed canvas allows).
    pub fn canvas_role(&self, user: &str, canvas: &str) -> Option<Role> {
        let c = self.canvases.get(canvas)?;
        let u = self.users.get(user).filter(|u| u.active)?;
        if self.workspaces.get(&c.workspace).is_none_or(|w| w.deleted) {
            return None;
        }
        let mut best = self.workspace_role(user, &c.workspace);
        if self.is_personal_of_other(&c.workspace, user) {
            // Someone's "My canvases": only what they shared explicitly.
            return self.best_of(user, u, &c.shares);
        }
        if let Some(f) = &c.folder {
            best = best.max(self.folder_chain_role(user, u, f));
        }
        best = best.max(self.best_of(user, u, &c.shares));
        if c.link == LinkAccess::Org && u.instance != Instance::Guest {
            best = best.max(Some(c.link_role.min(Role::Edit)));
        }
        best
    }

    /// A canvas the person may open now: a role, and not in Trash.
    pub fn can_open(&self, user: &str, canvas: &str) -> Option<Role> {
        let c = self.canvases.get(canvas)?;
        if c.deleted {
            return None;
        }
        self.canvas_role(user, canvas)
    }

    /// Everyone who may open the canvas, with their role.
    pub fn members_of(&self, canvas: &str) -> Vec<(String, Role)> {
        let mut v: Vec<(String, Role)> = self
            .users
            .keys()
            .filter_map(|u| self.can_open(u, canvas).map(|r| (u.clone(), r)))
            .collect();
        v.sort();
        v
    }

    /// Canvases under a folder (directly or in sub-folders), for cascading changes.
    pub fn canvases_under_folder(&self, folder: &str) -> Vec<String> {
        let mut out = Vec::new();
        for (id, c) in &self.canvases {
            let mut cur = c.folder.clone();
            for _ in 0..=MAX_DEPTH {
                let Some(f) = cur else { break };
                if f == folder {
                    out.push(id.clone());
                    break;
                }
                cur = self.folders.get(&f).and_then(|x| x.parent.clone());
            }
        }
        out.sort();
        out
    }

    pub fn canvases_in_workspace(&self, ws: &str) -> Vec<String> {
        let mut v: Vec<String> = self
            .canvases
            .iter()
            .filter(|(_, c)| c.workspace == ws)
            .map(|(id, _)| id.clone())
            .collect();
        v.sort();
        v
    }

    pub async fn load(db: &Db) -> anyhow::Result<Self> {
        let mut s = Snapshot::default();
        for r in sqlx::query("SELECT id, role, status FROM users")
            .fetch_all(&db.pool)
            .await?
        {
            let id: String = r.try_get(0)?;
            let role: String = r.try_get(1)?;
            let status: String = r.try_get(2)?;
            s.users.insert(
                id,
                UserAcl {
                    instance: Instance::parse(&role).unwrap_or(Instance::Guest),
                    active: status == "active",
                    teams: vec![],
                },
            );
        }
        for r in sqlx::query("SELECT team_id, user_id FROM team_members")
            .fetch_all(&db.pool)
            .await?
        {
            let t: String = r.try_get(0)?;
            let u: String = r.try_get(1)?;
            if let Some(x) = s.users.get_mut(&u) {
                x.teams.push(t);
            }
        }
        for r in sqlx::query("SELECT id, personal_owner, visibility, deleted_at FROM workspaces")
            .fetch_all(&db.pool)
            .await?
        {
            let id: String = r.try_get(0)?;
            let vis: String = r.try_get(2)?;
            s.workspaces.insert(
                id,
                WorkspaceAcl {
                    personal_owner: r.try_get(1)?,
                    open: vis == "open",
                    deleted: r.try_get::<Option<i64>, _>(3)?.is_some(),
                    members: vec![],
                },
            );
        }
        for r in sqlx::query(
            "SELECT workspace_id, principal_kind, principal_id, role FROM workspace_members",
        )
        .fetch_all(&db.pool)
        .await?
        {
            let ws: String = r.try_get(0)?;
            let kind: String = r.try_get(1)?;
            let pid: String = r.try_get(2)?;
            let role: String = r.try_get(3)?;
            if let (Some(w), Some(p), Some(role)) = (
                s.workspaces.get_mut(&ws),
                Principal::new(&kind, pid),
                Role::from_workspace_role(&role),
            ) {
                w.members.push((p, role));
            }
        }
        for r in sqlx::query("SELECT id, workspace_id, parent_id, deleted_at FROM folders")
            .fetch_all(&db.pool)
            .await?
        {
            let id: String = r.try_get(0)?;
            s.folders.insert(
                id,
                FolderAcl {
                    workspace: r.try_get(1)?,
                    parent: r.try_get(2)?,
                    deleted: r.try_get::<Option<i64>, _>(3)?.is_some(),
                    shares: vec![],
                },
            );
        }
        for r in sqlx::query(
            "SELECT id, workspace_id, folder_id, deleted_at, link_access, link_role FROM canvases",
        )
        .fetch_all(&db.pool)
        .await?
        {
            let id: String = r.try_get(0)?;
            let la: String = r.try_get(4)?;
            let lr: String = r.try_get(5)?;
            s.canvases.insert(
                id,
                CanvasAcl {
                    workspace: r.try_get(1)?,
                    folder: r.try_get(2)?,
                    deleted: r.try_get::<Option<i64>, _>(3)?.is_some(),
                    shares: vec![],
                    link: LinkAccess::parse(&la),
                    link_role: Role::parse(&lr).unwrap_or(Role::View),
                },
            );
        }
        for r in sqlx::query(
            "SELECT object_kind, object_id, principal_kind, principal_id, role FROM shares",
        )
        .fetch_all(&db.pool)
        .await?
        {
            let ok: String = r.try_get(0)?;
            let oid: String = r.try_get(1)?;
            let pk: String = r.try_get(2)?;
            let pid: String = r.try_get(3)?;
            let role: String = r.try_get(4)?;
            let (Some(p), Some(role)) = (Principal::new(&pk, pid), Role::parse(&role)) else {
                continue;
            };
            match ok.as_str() {
                "canvas" => {
                    if let Some(c) = s.canvases.get_mut(&oid) {
                        c.shares.push((p, role));
                    }
                }
                "folder" => {
                    if let Some(f) = s.folders.get_mut(&oid) {
                        f.shares.push((p, role));
                    }
                }
                _ => {}
            }
        }
        Ok(s)
    }
}

/// The snapshot cache: rebuilt on first use after any change to the access tables.
#[derive(Default)]
pub struct AclCache {
    snap: RwLock<Option<Arc<Snapshot>>>,
    generation: AtomicU64,
    loaded_at: AtomicU64,
}

impl AclCache {
    pub fn invalidate(&self) {
        // The next `get` sees a newer generation than the snapshot's and reloads.
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn get(&self, db: &Db) -> anyhow::Result<Arc<Snapshot>> {
        let generation = self.generation.load(Ordering::SeqCst);
        if let Some(s) = self.snap.read().await.as_ref()
            && self.loaded_at.load(Ordering::SeqCst) == generation
        {
            return Ok(s.clone());
        }
        let fresh = Arc::new(Snapshot::load(db).await?);
        let mut g = self.snap.write().await;
        // Install only if nothing changed while we read; otherwise the next call reloads.
        if self.generation.load(Ordering::SeqCst) == generation {
            *g = Some(fresh.clone());
            self.loaded_at.store(generation, Ordering::SeqCst);
        }
        Ok(fresh)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// xorshift64*: a tiny deterministic generator for the property tests below.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn chance(&mut self, pct: u64) -> bool {
            self.next() % 100 < pct
        }
        fn role(&mut self) -> Role {
            [Role::View, Role::Comment, Role::Edit, Role::Full][self.below(4)]
        }
    }

    fn random_snapshot(r: &mut Rng) -> Snapshot {
        let mut s = Snapshot::default();
        let users: Vec<String> = (0..6).map(|i| format!("u{i}")).collect();
        let teams = ["t0", "t1"];
        for (i, u) in users.iter().enumerate() {
            let instance = [
                Instance::Owner,
                Instance::Admin,
                Instance::Member,
                Instance::Member,
                Instance::Guest,
            ][r.below(5)];
            s.users.insert(
                u.clone(),
                UserAcl {
                    instance,
                    active: !r.chance(10),
                    teams: teams
                        .iter()
                        .filter(|_| r.chance(40))
                        .map(|t| t.to_string())
                        .collect(),
                },
            );
            if i == 0 {
                s.workspaces.insert(
                    "mine0".into(),
                    WorkspaceAcl {
                        personal_owner: Some(u.clone()),
                        open: false,
                        deleted: false,
                        members: vec![],
                    },
                );
            }
        }
        let principal = |r: &mut Rng| {
            if r.chance(70) {
                Principal::User(format!("u{}", r.below(6)))
            } else {
                Principal::Team(teams[r.below(2)].to_string())
            }
        };
        for w in 0..3 {
            let members = (0..r.below(4)).map(|_| (principal(r), r.role())).collect();
            s.workspaces.insert(
                format!("w{w}"),
                WorkspaceAcl {
                    personal_owner: None,
                    open: r.chance(50),
                    deleted: r.chance(5),
                    members,
                },
            );
        }
        let wss: Vec<String> = s.workspaces.keys().cloned().collect();
        for f in 0..6 {
            let ws = wss[r.below(wss.len())].clone();
            let parent = (f > 0 && r.chance(60)).then(|| format!("f{}", r.below(f)));
            let shares = (0..r.below(3)).map(|_| (principal(r), r.role())).collect();
            s.folders.insert(
                format!("f{f}"),
                FolderAcl {
                    workspace: ws,
                    parent,
                    deleted: false,
                    shares,
                },
            );
        }
        for c in 0..10 {
            let ws = wss[r.below(wss.len())].clone();
            let folder = r.chance(60).then(|| format!("f{}", r.below(6)));
            let shares = (0..r.below(3)).map(|_| (principal(r), r.role())).collect();
            let link = [LinkAccess::None, LinkAccess::Org, LinkAccess::Public][r.below(3)];
            s.canvases.insert(
                format!("c{c}"),
                CanvasAcl {
                    workspace: ws,
                    folder,
                    deleted: r.chance(10),
                    shares,
                    link,
                    link_role: r.role(),
                },
            );
        }
        s
    }

    fn all_roles(s: &Snapshot) -> Vec<((String, String), Option<Role>)> {
        let mut v = vec![];
        for u in s.users.keys() {
            for c in s.canvases.keys() {
                v.push(((u.clone(), c.clone()), s.canvas_role(u, c)));
            }
        }
        v.sort();
        v
    }

    /// Adding a grant anywhere never lowers anyone's access to anything.
    #[test]
    fn grants_are_monotonic() {
        let mut r = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..400 {
            let s = random_snapshot(&mut r);
            let before = all_roles(&s);
            let mut t = s.clone();
            let p = if r.chance(70) {
                Principal::User(format!("u{}", r.below(6)))
            } else {
                Principal::Team("t0".into())
            };
            let role = r.role();
            match r.below(3) {
                0 => t
                    .canvases
                    .get_mut(&format!("c{}", r.below(10)))
                    .unwrap()
                    .shares
                    .push((p, role)),
                1 => t
                    .folders
                    .get_mut(&format!("f{}", r.below(6)))
                    .unwrap()
                    .shares
                    .push((p, role)),
                _ => t
                    .workspaces
                    .get_mut(&format!("w{}", r.below(3)))
                    .unwrap()
                    .members
                    .push((p, role)),
            }
            for ((k, a), (_, b)) in before.iter().zip(all_roles(&t)) {
                assert!(b >= *a, "{k:?}: {a:?} -> {b:?}");
            }
        }
    }

    /// Suspended people have no access; Owners and Admins have full access except to someone
    /// else's private space; guests never get access from an organisation link.
    #[test]
    fn instance_rules_hold() {
        let mut r = Rng(42);
        for _ in 0..400 {
            let s = random_snapshot(&mut r);
            for (u, ua) in &s.users {
                for (c, ca) in &s.canvases {
                    let got = s.canvas_role(u, c);
                    let ws = &s.workspaces[&ca.workspace];
                    if !ua.active || ws.deleted {
                        assert_eq!(got, None);
                        continue;
                    }
                    let other_private = ws.personal_owner.as_ref().is_some_and(|o| o != u);
                    if ua.instance.is_admin() && !other_private {
                        assert_eq!(got, Some(Role::Full), "{u} {c}");
                    }
                    if ua.instance == Instance::Guest && ca.link == LinkAccess::Org {
                        let mut t = s.clone();
                        t.canvases.get_mut(c).unwrap().link = LinkAccess::None;
                        assert_eq!(got, t.canvas_role(u, c), "guest gained from an org link");
                    }
                    if ca.link == LinkAccess::Public {
                        let mut t = s.clone();
                        t.canvases.get_mut(c).unwrap().link = LinkAccess::None;
                        assert_eq!(
                            got,
                            t.canvas_role(u, c),
                            "a public link is not a member grant"
                        );
                    }
                }
            }
        }
    }

    /// With no grants at all, members and guests see nothing.
    #[test]
    fn nothing_without_a_grant() {
        let mut r = Rng(7);
        for _ in 0..200 {
            let mut s = random_snapshot(&mut r);
            for w in s.workspaces.values_mut() {
                w.members.clear();
            }
            for f in s.folders.values_mut() {
                f.shares.clear();
            }
            for c in s.canvases.values_mut() {
                c.shares.clear();
                c.link = LinkAccess::None;
            }
            for (u, ua) in &s.users {
                if ua.instance.is_admin() {
                    continue;
                }
                for (c, ca) in &s.canvases {
                    let own =
                        s.workspaces[&ca.workspace].personal_owner.as_deref() == Some(u.as_str());
                    assert_eq!(s.canvas_role(u, c).is_some(), own && ua.active, "{u} {c}");
                }
            }
        }
    }

    #[test]
    fn folder_cycles_terminate() {
        let mut s = Snapshot::default();
        s.users.insert(
            "u".into(),
            UserAcl {
                instance: Instance::Member,
                active: true,
                teams: vec![],
            },
        );
        s.workspaces.insert(
            "w".into(),
            WorkspaceAcl {
                personal_owner: None,
                open: true,
                deleted: false,
                members: vec![],
            },
        );
        s.folders.insert(
            "a".into(),
            FolderAcl {
                workspace: "w".into(),
                parent: Some("b".into()),
                deleted: false,
                shares: vec![],
            },
        );
        s.folders.insert(
            "b".into(),
            FolderAcl {
                workspace: "w".into(),
                parent: Some("a".into()),
                deleted: false,
                shares: vec![(Principal::User("u".into()), Role::View)],
            },
        );
        s.canvases.insert(
            "c".into(),
            CanvasAcl {
                workspace: "w".into(),
                folder: Some("a".into()),
                deleted: false,
                shares: vec![],
                link: LinkAccess::None,
                link_role: Role::View,
            },
        );
        assert_eq!(s.canvas_role("u", "c"), Some(Role::View));
        assert_eq!(s.canvases_under_folder("b"), vec!["c".to_string()]);
    }
}
