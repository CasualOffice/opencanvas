// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Partial sync in the room (PSYNC-02, ADR-076, docs/15 §3.2).
//!
//! With `[host.flags] partial_sync` (and a database WAL, not memory durability, not a temporary
//! canvas) the room splits the canvas when it opens: `doc` becomes the **main document** (text,
//! outline, meta, comments, …) and every `databases`/`boards` entry becomes a **part**
//! ([`oc_model::parts`], item ids kept), stored as its own snapshot and WAL rows. A part is
//! loaded when a connection asks for it (message type 101 with a sync step 1), the role checked
//! on every request, and evicted once nobody has held it for `part_evict` (30 s).
//!
//! Anything on the server that needs the whole canvas (a save, the API, MCP, history,
//! templates, icons, AI tools, automation, the conflict policy) first makes a **whole view**:
//! the parts are flattened back into `doc` ([`Room::ensure_whole`]). While whole, every update
//! is cut by owner ([`oc_model::parts::route`]) so each part's WAL rows and holders stay
//! right; after `whole_release` (20 s) without such work the room splits again
//! ([`Room::release_whole`]). Saves therefore flatten to `.ocanvas` format v1 with the original
//! item ids.
//!
//! Connections without `caps=subdoc` are closed with 4426 on a split room (owner decision).

use std::collections::BTreeMap;

use oc_model::parts::{self, MAIN, OwnerIndex};
use yrs::encoding::read::Read;

use super::*;
use crate::host_client::Fetched;

pub(super) use protocol::MSG_SUBDOC;
/// Longest part key the WAL stores (`room_part_snapshots.doc_id`).
const KEY_MAX: usize = 191;

pub(super) struct SplitState {
    pub owners: OwnerIndex,
    /// Every document's state (`""` main): fillers for routed updates and the client id rule.
    pub svs: HashMap<String, HashMap<u64, u32>>,
    /// Known parts and their headers.
    pub headers: BTreeMap<String, Value>,
    pub loaded: HashMap<String, Part>,
    pub holders: HashMap<String, HashSet<ConnId>>,
    /// `doc` is the whole canvas (since then, refreshed by whole-canvas work).
    pub whole_since: Option<Instant>,
    /// Parts changed since their last snapshot. Under memory durability (no WAL rows) these
    /// are written when a whole view splits again and on every dump.
    pub dirty_parts: HashSet<String>,
}

pub(super) struct Part {
    pub doc: Doc,
    pub unheld_since: Option<Instant>,
    /// Written since loaded: snapshotted on eviction.
    pub dirty: bool,
}

/// A subdocument frame.
pub(super) fn sub_frame(guid: &str, inner: &[u8]) -> Vec<u8> {
    protocol::subdoc(guid, inner)
}

fn encode(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn doc_of(bytes: &[u8]) -> anyhow::Result<Doc> {
    let doc = oc_model::new_doc();
    oc_model::ocanvas::apply_update_bytes(&doc, bytes)?;
    Ok(doc)
}

fn sv_of(doc: &Doc) -> HashMap<u64, u32> {
    doc.transact()
        .state_vector()
        .iter()
        .map(|(c, k)| (c.get(), *k))
        .collect()
}

/// The placeholder header of a part: `{kind, name, count}`.
pub(super) fn header_of(key: &str, doc: &Doc) -> Value {
    let Some((root, id)) = parts::part_root(key) else {
        return Value::Null;
    };
    header_json(root, &oc_model::doc_to_json(doc)[root][id])
}

/// A part's block kind from its root (the editor's `PartHeader.kind`).
fn kind_of(root: &str) -> &'static str {
    match root {
        oc_model::roots::DATABASES => "database",
        _ => "board",
    }
}

/// The header of a block from its logical JSON.
fn header_json(root: &str, v: &Value) -> Value {
    let count = ["order", "rows", "items"]
        .iter()
        .find_map(|k| match &v[k] {
            Value::Array(a) => Some(a.len()),
            Value::Object(o) => Some(o.len()),
            _ => None,
        })
        .unwrap_or(0);
    json!({"kind": kind_of(root), "name": v.get("name").cloned().unwrap_or(Value::Null), "count": count})
}

/// A canvas cut while the room loads it from the host (PSYNC-02 fast open): the file's
/// `ydoc.bin` is split as it is, so the room never builds the whole canvas.
pub(super) struct Presplit {
    split: parts::Split,
    headers: BTreeMap<String, Value>,
}

/// What the fast open gives the room: the main document, the host version, the in-file
/// history and the cut canvas.
pub(super) type Opened = (Doc, Option<String>, FileHist, Presplit);

/// The fast open: `None` when the file is not a `.ocanvas` with a usable `ydoc.bin` and a
/// `document.json` (the room then loads it whole and splits after). The main document is
/// validated (MOD-01) here; a part is validated when it is first loaded.
pub(super) fn open_split(fetched: &Fetched) -> anyhow::Result<Option<Opened>> {
    let Fetched::Found { bytes, etag, .. } = fetched else {
        return Ok(None);
    };
    if bytes.starts_with(crate::hosts::TEMPLATE_JSON_TAG) || !oc_model::ocanvas::is_zip(bytes) {
        return Ok(None);
    }
    let Some(raw) = oc_model::ocanvas::read_ocanvas_raw(bytes)? else {
        return Ok(None);
    };
    let Some(document) = raw.document.as_deref() else {
        return Ok(None);
    };
    let split = parts::split(&raw.state)?;
    if split.parts.keys().any(|k| k.len() > KEY_MAX) {
        return Ok(None);
    }
    drop(raw.state);
    let main = doc_of(&split.parts[MAIN])?;
    let live_file = {
        let txn = main.transact();
        txn.get_map(oc_model::roots::META)
            .and_then(|m| m.get(&txn, "kind"))
            .is_some_and(|k| k.to_string(&txn) == "live")
    };
    if live_file {
        return Ok(None);
    }
    let report = oc_model::validate::record(oc_model::validate(&main));
    if let Some(e) = report.first_error() {
        anyhow::bail!("{e}");
    }
    // The file's own logical JSON: the history's starting point and the parts' headers.
    let prev: Value = serde_json::from_slice(document)?;
    let mut headers = BTreeMap::new();
    for k in split.parts.keys().filter(|k| !k.is_empty()) {
        if let Some((root, id)) = parts::part_root(k) {
            headers.insert(k.clone(), header_json(root, &prev[root][id]));
        }
    }
    let hist = FileHist {
        history: raw.history,
        prev,
        prev_meta: oc_model::history::VersionMeta::from_manifest(&raw.manifest),
        keep_prev: true,
    };
    Ok(Some((
        main,
        etag.clone(),
        hist,
        Presplit { split, headers },
    )))
}

impl Room {
    pub(super) fn split_enabled(&self) -> bool {
        self.host.partial_sync() && self.ctx.store.supports_parts() && !self.ephemeral
    }

    fn guid(&self, key: &str) -> String {
        let id = parts::part_root(key).map_or(key, |(_, id)| id);
        format!("{}/block/{id}", self.file_id)
    }

    /// Swaps the room's document (main, or a whole view), keeping what observes it in step.
    fn install_doc(&mut self, doc: Doc) {
        self.watch = super::super::changes::Watch::attach(&doc);
        self.mentions = Some(super::super::mentions::Tracker::new(&doc));
        self.doc_bytes = encoded_len(&doc);
        self.doc = doc;
    }

    /// After load: split the canvas (flag on), pick up the parts a recovered WAL holds, or fold
    /// parts back in (flag turned off since).
    pub(super) async fn split_on_open(&mut self) -> anyhow::Result<()> {
        let keys = self.ctx.store.part_keys(&self.id).await?;
        // A live block's own file (LIVE-01) stays whole: it is small, and the canvases that
        // embed it read its blocks from its document.
        let live_file = self
            .doc
            .transact()
            .get_map(oc_model::roots::META)
            .and_then(|m| m.get(&self.doc.transact(), "kind"))
            .is_some_and(|k| k.to_string(&self.doc.transact()) == "live");
        if live_file && keys.is_empty() {
            self.presplit = None;
            return Ok(());
        }
        let recovered = self.dirty_since.is_some() && !keys.is_empty();
        if !self.split_enabled() {
            if recovered {
                let mut blobs = vec![encode(&self.doc)];
                for (k, _) in &keys {
                    blobs.push(encode(&self.load_part_doc(k).await?));
                }
                let whole = doc_of(&parts::flatten(&blobs)?)?;
                self.ctx
                    .store
                    .compact(&self.id, self.epoch, self.seq, &encode(&whole), now_ms())
                    .await?;
                self.ctx.store.drop_parts(&self.id, self.epoch).await?;
                self.compacted_seq = self.seq;
                self.install_doc(whole);
                self.awareness = Awareness::new(self.doc.clone());
                tracing::info!(room = %self.id, parts = keys.len(), "partial sync off: parts folded back into the document");
            }
            return Ok(());
        }
        let mut st = SplitState {
            owners: OwnerIndex::default(),
            svs: HashMap::new(),
            headers: BTreeMap::new(),
            loaded: HashMap::new(),
            holders: HashMap::new(),
            whole_since: None,
            dirty_parts: HashSet::new(),
        };
        if let Some(pre) = self.presplit.take() {
            // Fast open: every part starts at the original state vector (fillers).
            let sv = sv_of(&self.doc);
            let mut rows = Vec::new();
            for (k, b) in pre.split.parts.iter().filter(|(k, _)| !k.is_empty()) {
                st.svs.insert(k.clone(), sv.clone());
                let header = pre.headers.get(k).cloned().unwrap_or(Value::Null);
                st.headers.insert(k.clone(), header.clone());
                rows.push((k.clone(), b.clone(), header));
            }
            st.svs.insert(MAIN.into(), sv);
            self.ctx
                .store
                .compact_parts(&self.id, self.epoch, self.seq, &rows, now_ms())
                .await?;
            drop(rows);
            self.ctx
                .store
                .compact(
                    &self.id,
                    self.epoch,
                    self.seq,
                    &pre.split.parts[MAIN],
                    now_ms(),
                )
                .await?;
            self.compacted_seq = self.seq;
            st.owners = pre.split.owners;
        } else if recovered {
            st.svs.insert(MAIN.into(), sv_of(&self.doc));
            st.owners.record_update(MAIN, &encode(&self.doc))?;
            for (k, header) in keys {
                let doc = self.load_part_doc(&k).await?;
                let bytes = encode(&doc);
                st.owners.record_update(&k, &bytes)?;
                st.svs.insert(k.clone(), sv_of(&doc));
                let header = if header.is_null() {
                    header_of(&k, &doc)
                } else {
                    header
                };
                st.headers.insert(k, header);
            }
            tracing::info!(room = %self.id, parts = st.headers.len(), "split room recovered from the WAL");
        } else {
            if !keys.is_empty() {
                self.ctx.store.drop_parts(&self.id, self.epoch).await?;
            }
            let s = parts::split(&encode(&self.doc))?;
            if s.parts.keys().any(|k| k.len() > KEY_MAX) {
                tracing::warn!(room = %self.id, "a block id is too long for partial sync; the room stays whole");
                return Ok(());
            }
            for (k, b) in &s.parts {
                let doc = doc_of(b)?;
                st.svs.insert(k.clone(), sv_of(&doc));
                if k == MAIN {
                    continue;
                }
                let header = header_of(k, &doc);
                drop(doc);
                self.ctx
                    .store
                    .compact_part(&self.id, self.epoch, k, self.seq, b, &header, now_ms())
                    .await?;
                st.headers.insert(k.clone(), header);
            }
            let main = &s.parts[MAIN];
            self.ctx
                .store
                .compact(&self.id, self.epoch, self.seq, main, now_ms())
                .await?;
            self.compacted_seq = self.seq;
            let main = doc_of(main)?;
            st.owners = s.owners;
            self.install_doc(main);
        }
        // Awareness keeps a handle on its document: never the whole canvas.
        self.awareness = Awareness::new(self.doc.clone());
        self.split = Some(st);
        Ok(())
    }

    /// A part from its snapshot and rows. The room's `seq` covers every document's rows (a
    /// room recovered from the WAL resumes after the highest seq of any part, or its next rows
    /// would collide with a part's).
    async fn load_part_doc(&mut self, key: &str) -> anyhow::Result<Doc> {
        let wal = self.ctx.store.load_part(&self.id, key).await?;
        if wal.last_seq() > self.seq {
            self.seq = wal.last_seq();
            self.compacted_seq = self.compacted_seq.min(self.seq);
        }
        let doc = oc_model::new_doc();
        if let Some((_, s)) = &wal.snapshot {
            oc_model::ocanvas::apply_update_bytes(&doc, s)?;
        }
        for (_, u) in &wal.updates {
            oc_model::ocanvas::apply_update_bytes(&doc, u)?;
        }
        Ok(doc)
    }

    /// Loads a part into the room (on demand).
    async fn ensure_loaded(&mut self, key: &str) -> anyhow::Result<()> {
        if self
            .split
            .as_ref()
            .is_some_and(|s| s.loaded.contains_key(key))
        {
            return Ok(());
        }
        let doc = self.load_part_doc(key).await?;
        // MOD-01 for a part the fast open did not validate.
        let report = oc_model::validate::record(oc_model::validate(&doc));
        if let Some(e) = report.first_error() {
            anyhow::bail!("part {key} is invalid: {e}");
        }
        if let Some(s) = self.split.as_mut() {
            s.loaded.insert(
                key.to_string(),
                Part {
                    doc,
                    unheld_since: None,
                    dirty: false,
                },
            );
        }
        Ok(())
    }

    pub(super) fn parts_control(&self) -> Option<Vec<u8>> {
        let s = self.split.as_ref()?;
        let list: Vec<Value> = s
            .headers
            .iter()
            .map(|(k, h)| {
                let mut h = h.clone();
                h["id"] = Value::String(self.guid(k));
                h
            })
            .collect();
        Some(protocol::control(&json!({"t": "parts", "parts": list})))
    }

    fn deny_sub(&self, conn: ConnId, guid: &str, reason: &str) {
        Metrics::inc(&self.ctx.metrics.updates_rejected_total);
        self.send(
            conn,
            protocol::control(&json!({"t": "sub-denied", "id": guid, "reason": reason})),
        );
    }

    /// The part a guid names: same file only, and a block the canvas has.
    fn part_for(&self, guid: &str) -> Option<String> {
        let s = self.split.as_ref()?;
        let id = guid.strip_prefix(&format!("{}/block/", self.file_id))?;
        oc_model::parts::SPLIT_ROOTS
            .iter()
            .filter_map(|r| parts::part_key(r, id))
            .find(|k| s.headers.contains_key(k) || s.svs.contains_key(k))
    }

    /// A subdocument frame from a client: load (sync step 1), edits (step 2, update).
    pub(super) async fn on_subdoc(&mut self, conn: ConnId, body: &[u8]) {
        let mut d = DecoderV1::new(Cursor::new(body));
        let Ok(guid) = d.read_string().map(str::to_string) else {
            return;
        };
        let Ok(msg) = Message::decode(&mut d) else {
            return;
        };
        if self.split.is_none() {
            return self.deny_sub(conn, &guid, "this canvas is not split");
        }
        // The role, checked on every request: a revoked connection is gone from `peers`.
        let Some(grant) = self.peers.get(&conn).map(|p| p.grant.clone()) else {
            return;
        };
        if grant.file.id != self.file_id {
            return self.deny_sub(conn, &guid, "not a block of this canvas");
        }
        let Some(key) = self.part_for(&guid) else {
            tracing::info!(room = %self.id, "subdocument refused: not a block of this canvas");
            return self.deny_sub(conn, &guid, "not a block of this canvas");
        };
        match msg {
            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                if !self.flush_wal().await {
                    return;
                }
                let Some((diff, server_sv)) = self.part_diff(&key, &sv).await else {
                    return self.deny_sub(conn, &guid, "block unavailable");
                };
                self.send(conn, sub_frame(&guid, &protocol::step2(diff)));
                self.send(conn, sub_frame(&guid, &protocol::step1(server_sv)));
                if let Some(s) = self.split.as_mut() {
                    s.holders.entry(key.clone()).or_default().insert(conn);
                    if let Some(p) = s.loaded.get_mut(&key) {
                        p.unheld_since = None;
                    }
                }
            }
            Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                let held = self
                    .split
                    .as_ref()
                    .is_some_and(|s| s.holders.get(&key).is_some_and(|h| h.contains(&conn)));
                if !held {
                    return self.deny_sub(conn, &guid, "load the block first");
                }
                self.apply_part(conn, &grant, &key, &guid, u).await;
            }
            _ => {}
        }
    }

    /// What a client lacks of a part, and the part's state vector.
    async fn part_diff(&mut self, key: &str, sv: &StateVector) -> Option<(Vec<u8>, StateVector)> {
        let whole = self.split.as_ref()?.whole_since.is_some();
        if whole {
            let diff = self.doc.transact().encode_state_as_update_v1(sv);
            let s = self.split.as_ref()?;
            let routed = parts::route(&diff, &s.owners, &|_, c| {
                sv.get(&yrs::block::ClientID::new(c))
            })
            .ok()?;
            let share = routed.parts.get(key).cloned().unwrap_or_else(|| vec![0, 0]);
            let mut part_sv = StateVector::default();
            for (c, k) in s.svs.get(key).into_iter().flatten() {
                part_sv.set_max(yrs::block::ClientID::new(*c), *k);
            }
            return Some((share, part_sv));
        }
        if let Err(e) = self.ensure_loaded(key).await {
            tracing::error!(room = %self.id, part = key, error = %e, "part load failed");
            return None;
        }
        let p = self.split.as_ref()?.loaded.get(key)?;
        let txn = p.doc.transact();
        Some((txn.encode_state_as_update_v1(sv), txn.state_vector()))
    }

    /// PSYNC-BUG-4, one client id per document: an item of `bytes` (sent to document `key`)
    /// at a clock another document was given. Each document owns the clock ranges recorded for
    /// it in `owners` (at the split, and as each write is applied); a write may claim clocks no
    /// other document knows yet, echo what it was given, and carry fillers anywhere. Anything
    /// else reuses a client id across documents and would collide in the flatten. `Err` when
    /// the update is malformed.
    pub(super) fn foreign_write(&self, key: &str, bytes: &[u8]) -> Result<bool, parts::Error> {
        let Some(s) = &self.split else {
            return Ok(false);
        };
        let mine = s.svs.get(key);
        let hit = parts::foreign_item(
            bytes,
            key,
            &s.owners,
            &|c| mine.and_then(|m| m.get(&c)).copied().unwrap_or(0),
            &|c| {
                s.svs
                    .iter()
                    .filter(|(k, _)| k.as_str() != key)
                    .filter_map(|(_, sv)| sv.get(&c))
                    .copied()
                    .max()
                    .unwrap_or(0)
            },
        )?;
        Ok(hit.is_some())
    }

    /// Records updates applied while split, including server writes such as the people map.
    pub(super) fn note_main_update(&mut self, bytes: &[u8]) {
        if let Some(s) = self.split.as_mut() {
            let _ = s.owners.record_update(MAIN, bytes);
            s.svs.insert(MAIN.into(), sv_of(&self.doc));
        }
    }

    /// A read-only peer can echo the deletions it received in the sync reply.
    async fn part_delete_echo(&mut self, key: &str, bytes: &[u8]) -> bool {
        if bytes.first() != Some(&0) {
            return false;
        }
        let Some(s) = &self.split else {
            return false;
        };
        let filtered;
        let (doc, bytes) = if s.whole_since.is_some() {
            // The peer saw fillers where the whole view has another part's live items.
            let Ok(share) = parts::own_share(bytes, key, &s.owners) else {
                return false;
            };
            filtered = share;
            (&self.doc, filtered.as_slice())
        } else {
            if self.ensure_loaded(key).await.is_err() {
                return false;
            }
            let Some(p) = self.split.as_ref().and_then(|s| s.loaded.get(key)) else {
                return false;
            };
            (&p.doc, bytes)
        };
        let Ok(deletes) = parts::delete_set(bytes) else {
            return false;
        };
        if deletes.keys().any(|&client| client >= (1 << 53)) {
            return false;
        }
        let deletes = yrs::IdSet::from_iter(deletes.into_iter().map(|(client, ranges)| {
            (
                ClientID::new(client),
                ranges.into_iter().map(|(start, end)| start..end),
            )
        }));
        let current = doc.transact().snapshot().delete_set;
        deletes.client_ids().all(|client| {
            deletes
                .get(&client)
                .zip(current.get(&client))
                .is_some_and(|(echo, known)| echo.subset_of(known))
        })
    }

    /// A client's edit of a part: the role, then the client id rule, then the part (or the
    /// whole view) and the WAL under the part's id.
    async fn apply_part(&mut self, conn: ConnId, grant: &Grant, key: &str, guid: &str, u: Vec<u8>) {
        if u == Update::EMPTY_V1 {
            return;
        }
        if (grant.role != Role::Edit || self.conflict.is_some())
            && self.part_delete_echo(key, &u).await
        {
            return;
        }
        if grant.role == Role::View || self.conflict.is_some() {
            if grant.role == Role::View {
                return self.deny(conn, "read-only session");
            }
            return self.deny(
                conn,
                "the file changed elsewhere; this session is read-only",
            );
        }
        if grant.role == Role::Comment {
            return self.deny(conn, "comment role may only change comments");
        }
        // SEC-V4: part edits count against the document size limit, as main edits do.
        if self.doc_bytes + u.len() > self.ctx.cfg.max_doc_bytes {
            tracing::info!(room = %self.id, size = self.doc_bytes, update = u.len(), "part update refused: document size limit");
            return self.deny_sub(conn, guid, "document size limit reached");
        }
        // Clocks of one client id live in one document: a client id reused across documents
        // would collide in the flatten (Yjs subdocuments have their own client ids).
        match self.foreign_write(key, &u) {
            Ok(false) => {}
            Ok(true) => {
                tracing::info!(room = %self.id, "part update refused: client id used in another document");
                return self.deny_sub(conn, guid, "one client id per document");
            }
            Err(_) => return self.deny_sub(conn, guid, "malformed update"),
        }
        // Automation rules watch blocks: with rules, edits go through the whole view.
        let has_rules = self
            .doc
            .transact()
            .get_map(oc_model::roots::AUTOMATIONS)
            .is_some_and(|m| m.len(&self.doc.transact()) > 0);
        if has_rules && !self.ensure_whole().await {
            return self.deny_sub(conn, guid, "block unavailable");
        }
        let whole = self.split.as_ref().is_some_and(|s| s.whole_since.is_some());
        if whole {
            // Only what the part owns: its delete set names its fillers too.
            let own = self
                .split
                .as_ref()
                .map(|s| parts::own_share(&u, key, &s.owners));
            let Some(Ok(u)) = own else {
                return self.deny_sub(conn, guid, "malformed update");
            };
            let Ok(update) = Update::decode_v1(&u) else {
                return self.deny_sub(conn, guid, "malformed update");
            };
            let changed = {
                let mut txn = self.doc.transact_mut();
                if oc_model::sync::apply_update(&mut txn, update).is_err() {
                    drop(txn);
                    return self.deny_sub(conn, guid, "update could not be applied");
                }
                txn.commit();
                txn.has_changes()
            };
            if changed {
                self.queue(u, &grant.user.id, Some(conn), true);
            }
            return;
        }
        if let Err(e) = self.ensure_loaded(key).await {
            tracing::error!(room = %self.id, part = key, error = %e, "part load failed");
            return self.deny_sub(conn, guid, "block unavailable");
        }
        let Some(s) = self.split.as_mut() else {
            return;
        };
        let Some(p) = s.loaded.get_mut(key) else {
            return;
        };
        let Ok(update) = Update::decode_v1(&u) else {
            return self.deny_sub(conn, guid, "malformed update");
        };
        let (changed, pending) = {
            let mut txn = p.doc.transact_mut();
            if oc_model::sync::apply_update(&mut txn, update).is_err() {
                drop(txn);
                return self.deny_sub(conn, guid, "update could not be applied");
            }
            txn.commit();
            let pending =
                txn.store().pending_update().is_some() || txn.store().pending_ds().is_some();
            (txn.has_changes() || pending, pending)
        };
        if !changed {
            return;
        }
        if pending {
            self.batch_in_order = false;
        }
        p.dirty = true;
        let sv = sv_of(&p.doc);
        let _ = s.owners.record_update(key, &u);
        s.svs.insert(key.to_string(), sv);
        self.queue_doc(key, u, &grant.user.id, Some(conn));
    }

    /// Makes `doc` the whole canvas (flattened from the main document and every part).
    pub(super) async fn ensure_whole(&mut self) -> bool {
        let Some(s) = self.split.as_mut() else {
            return true;
        };
        if s.whole_since.is_some() {
            s.whole_since = Some(Instant::now());
            return true;
        }
        if !self.flush_wal().await {
            return false;
        }
        let started = Instant::now();
        let Some(s) = self.split.as_ref() else {
            return true;
        };
        let mut keys: BTreeSet<String> = s.headers.keys().cloned().collect();
        keys.extend(s.svs.keys().filter(|k| !k.is_empty()).cloned());
        let mut blobs = vec![encode(&self.doc)];
        for k in &keys {
            let loaded = self
                .split
                .as_ref()
                .and_then(|s| s.loaded.get(k))
                .map(|p| encode(&p.doc));
            let bytes = match loaded {
                Some(b) => b,
                None => match self.load_part_doc(k).await {
                    Ok(d) => encode(&d),
                    Err(e) => {
                        tracing::error!(room = %self.id, part = %k, error = %e, "part load failed");
                        return false;
                    }
                },
            };
            blobs.push(bytes);
        }
        let whole = match parts::flatten(&blobs)
            .map_err(anyhow::Error::from)
            .and_then(|b| doc_of(&b))
        {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(room = %self.id, error = %e, "flattening the parts failed");
                return false;
            }
        };
        drop(blobs);
        // Snapshot dirty loaded parts first: their rows stay valid either way, this only keeps
        // the WAL short.
        if let Some(s) = self.split.as_mut() {
            s.loaded.clear();
            s.whole_since = Some(Instant::now());
        }
        self.install_doc(whole);
        tracing::info!(room = %self.id, parts = keys.len(), ms = started.elapsed().as_millis() as u64, "whole view for server work");
        true
    }

    /// Back to parts after whole-canvas work: re-split the whole view, snapshot what moved.
    pub(super) async fn release_whole(&mut self) {
        let Some(s) = self.split.as_ref() else {
            return;
        };
        let Some(since) = s.whole_since else {
            return;
        };
        if since.elapsed() < self.ctx.cfg.whole_release
            || self.save.in_flight
            || self.conflict.is_some()
            || !self.wal_queue.is_empty()
            || !self.ai_undo.is_empty()
        {
            return;
        }
        let split = match parts::split(&encode(&self.doc)) {
            Ok(x) => x,
            Err(e) => {
                tracing::error!(room = %self.id, error = %e, "splitting the whole view failed; it stays whole");
                return;
            }
        };
        if split.parts.keys().any(|k| k.len() > KEY_MAX) {
            return;
        }
        let mut headers_changed = false;
        for (k, b) in &split.parts {
            if k == MAIN {
                continue;
            }
            let Some(s) = self.split.as_ref() else {
                return;
            };
            // A part's WAL already has every routed edit; only a part that is new or whose
            // items moved (a block made in the main document) needs a snapshot.
            // Under memory durability nothing reached the WAL: every changed part is written.
            if s.headers.contains_key(k)
                && s.owners.ranges_of(k) == split.owners.ranges_of(k)
                && !(self.memory && s.dirty_parts.contains(k))
            {
                continue;
            }
            let doc = match doc_of(b) {
                Ok(d) => d,
                Err(_) => return,
            };
            let header = header_of(k, &doc);
            let sv = sv_of(&doc);
            drop(doc);
            if let Err(e) = self
                .ctx
                .store
                .compact_part(&self.id, self.epoch, k, self.seq, b, &header, now_ms())
                .await
            {
                if crate::store::is_fenced(&e) {
                    self.fail(&e, "part snapshot failed");
                }
                tracing::error!(room = %self.id, part = %k, error = %e, "part snapshot failed; the room stays whole");
                return;
            }
            if let Some(s) = self.split.as_mut() {
                s.headers.insert(k.clone(), header);
                s.svs.insert(k.clone(), sv);
            }
            headers_changed = true;
        }
        let main = &split.parts[MAIN];
        if let Err(e) = self
            .ctx
            .store
            .compact(&self.id, self.epoch, self.seq, main, now_ms())
            .await
        {
            if crate::store::is_fenced(&e) {
                self.fail(&e, "compaction failed");
            }
            tracing::error!(room = %self.id, error = %e, "main snapshot failed; the room stays whole");
            return;
        }
        self.compacted_seq = self.seq;
        self.last_compact = Instant::now();
        let Ok(main) = doc_of(main) else {
            return;
        };
        if let Some(s) = self.split.as_mut() {
            s.svs.insert(MAIN.into(), sv_of(&main));
            s.owners = split.owners;
            s.whole_since = None;
            s.dirty_parts.clear();
        }
        self.install_doc(main);
        if headers_changed && let Some(frame) = self.parts_control() {
            let frame = Bytes::from(frame);
            for p in self.peers.values() {
                let _ = p.tx.send(Outbound::Frame(frame.clone()));
            }
        }
        tracing::info!(room = %self.id, "whole view released to parts");
    }

    /// Memory durability's dump (ADR-029) for a split room: every written loaded part goes to
    /// its snapshot too. `false`: a whole view, whose parts are written when it splits again
    /// (the main snapshot must not get the whole canvas).
    pub(super) fn dump_parts(&mut self) -> bool {
        let Some(s) = self.split.as_mut() else {
            return true;
        };
        if s.whole_since.is_some() {
            return false;
        }
        let mut out = Vec::new();
        for (k, p) in s.loaded.iter_mut().filter(|(_, p)| p.dirty) {
            p.dirty = false;
            s.dirty_parts.remove(k);
            out.push((k.clone(), encode(&p.doc), header_of(k, &p.doc)));
        }
        if out.is_empty() {
            return true;
        }
        let (ctx, id, epoch, seq) = (self.ctx.clone(), self.id.clone(), self.epoch, self.seq);
        tokio::spawn(async move {
            for (k, state, header) in out {
                if let Err(e) = ctx
                    .store
                    .compact_part(&id, epoch, &k, seq, &state, &header, now_ms())
                    .await
                {
                    tracing::warn!(room = %id, part = %k, error = %e, "part dump failed");
                }
            }
        });
        true
    }

    /// Parts nobody held for `part_evict` (30 s) leave memory (snapshotted when written).
    pub(super) async fn evict_parts(&mut self) {
        let evict = self.ctx.cfg.part_evict;
        let Some(s) = self.split.as_mut() else {
            return;
        };
        let now = Instant::now();
        let mut out = Vec::new();
        for (k, p) in s.loaded.iter_mut() {
            if s.holders.get(k).is_some_and(|h| !h.is_empty()) {
                p.unheld_since = None;
                continue;
            }
            let since = *p.unheld_since.get_or_insert(now);
            if now - since >= evict {
                out.push(k.clone());
            }
        }
        for k in out {
            let Some(p) = self.split.as_mut().and_then(|s| s.loaded.remove(&k)) else {
                continue;
            };
            if p.dirty {
                let header = header_of(&k, &p.doc);
                let bytes = encode(&p.doc);
                if let Err(e) = self
                    .ctx
                    .store
                    .compact_part(
                        &self.id,
                        self.epoch,
                        &k,
                        self.seq,
                        &bytes,
                        &header,
                        now_ms(),
                    )
                    .await
                {
                    tracing::warn!(room = %self.id, part = %k, error = %e, "part snapshot on eviction failed; its rows stay");
                } else if let Some(s) = self.split.as_mut() {
                    s.headers.insert(k.clone(), header);
                }
            }
            tracing::debug!(room = %self.id, part = %k, "part evicted");
        }
    }

    /// The whole canvas as one update without a whole view: the main document and every
    /// part's bytes merged (`Cmd::State`).
    pub(super) async fn flat_state(&mut self) -> Vec<u8> {
        let mut blobs = vec![encode(&self.doc)];
        let keys: Vec<String> = self
            .split
            .as_ref()
            .map(|s| {
                s.headers
                    .keys()
                    .chain(s.svs.keys())
                    .filter(|k| !k.is_empty())
                    .cloned()
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect()
            })
            .unwrap_or_default();
        for k in keys {
            let loaded = self
                .split
                .as_ref()
                .and_then(|s| s.loaded.get(&k))
                .map(|p| encode(&p.doc));
            match loaded {
                Some(b) => blobs.push(b),
                None => match self.load_part_doc(&k).await {
                    Ok(d) => blobs.push(encode(&d)),
                    Err(e) => {
                        tracing::error!(room = %self.id, part = %k, error = %e, "part load failed")
                    }
                },
            }
        }
        parts::flatten(&blobs).unwrap_or_else(|e| {
            tracing::error!(room = %self.id, error = %e, "flatten failed; main document only");
            blobs.swap_remove(0)
        })
    }

    pub(super) fn forget_holder(&mut self, conn: ConnId, guid: Option<&str>) {
        let key = guid.and_then(|g| self.part_for(g));
        if let Some(s) = self.split.as_mut() {
            for (k, h) in s.holders.iter_mut() {
                if key.as_ref().is_none_or(|x| x == k) {
                    h.remove(&conn);
                }
            }
        }
    }

    /// An update of a part, queued under the part's id.
    fn queue_doc(&mut self, key: &str, bytes: Vec<u8>, user_id: &str, from: Option<ConnId>) {
        if self.lost.is_some() {
            return;
        }
        if let Some(s) = self.split.as_mut() {
            s.dirty_parts.insert(key.to_string());
        }
        self.seq += 1;
        self.doc_bytes += bytes.len();
        self.wal_queue.push(Queued {
            seq: self.seq,
            bytes,
            user_id: user_id.to_string(),
            from,
            edit: true,
            doc: key.to_string(),
        });
    }

    /// In a whole view every update is cut by owner before it is queued: each share goes to
    /// its document's WAL rows and holders. `None` when the update is queued as it is.
    pub(super) fn route_queued(
        &mut self,
        bytes: &[u8],
        user_id: &str,
        from: Option<ConnId>,
        edit: bool,
    ) -> Option<()> {
        let s = self.split.as_mut()?;
        s.whole_since?;
        let routed = {
            let svs = &s.svs;
            parts::route(bytes, &s.owners, &|k, c| {
                svs.get(k).and_then(|m| m.get(&c)).copied().unwrap_or(0)
            })
        };
        let routed = match routed {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(room = %self.id, error = %e, "routing an update failed");
                self.lost = Some("routing an update failed");
                return Some(());
            }
        };
        for (c, a, b, k) in &routed.owned {
            s.owners.record(*c, *a, *b, k);
        }
        for (k, share) in routed.parts {
            if let Ok(st) = parts::update_state(&share) {
                let m = s.svs.entry(k.clone()).or_default();
                for (c, e) in st {
                    let v = m.entry(c).or_default();
                    *v = (*v).max(e);
                }
            }
            if !k.is_empty() {
                s.dirty_parts.insert(k.clone());
            }
            if !k.is_empty() && !s.headers.contains_key(&k) {
                s.headers.insert(k.clone(), json!({"kind": kind_of(parts::part_root(&k).map_or("", |r| r.0)), "name": null, "count": 0}));
            }
            self.seq += 1;
            self.doc_bytes += share.len();
            self.wal_queue.push(Queued {
                seq: self.seq,
                bytes: share,
                user_id: user_id.to_string(),
                from,
                edit,
                doc: k,
            });
        }
        Some(())
    }

    /// A main-document update that reaches into a part: an editor that has not seen the parts
    /// list yet edits a block (made in its main document) that the last split moved into a part.
    /// Applied to the main document it would meet fillers and be lost; it goes through a whole
    /// view instead, which routes it into the part.
    pub(super) fn main_update_touches_parts(&self, bytes: &[u8]) -> bool {
        let Some(s) = self.split.as_ref().filter(|s| s.whole_since.is_none()) else {
            return false;
        };
        parts::route(bytes, &s.owners, &|_, _| u32::MAX)
            .map(|r| r.parts.keys().any(|k| !k.is_empty()))
            .unwrap_or(false)
    }

    /// Fans a part's durable update out to its holders.
    pub(super) fn fan_out_part(&self, key: &str, bytes: &[u8], except: Option<ConnId>) {
        let Some(s) = &self.split else {
            return;
        };
        let frame = Bytes::from(sub_frame(
            &self.guid(key),
            &protocol::update(bytes.to_vec()),
        ));
        for c in s.holders.get(key).into_iter().flatten() {
            if Some(*c) == except {
                continue;
            }
            if let Some(p) = self.peers.get(c) {
                let _ = p.tx.send(Outbound::Frame(frame.clone()));
            }
        }
    }
}
