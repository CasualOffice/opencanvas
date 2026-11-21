//! @mention notifications (UX-02, docs/05 §5): finds mentions that are new in the room's doc
//! and turns them into `POST {callback_base}/mentions` calls.
//!
//! - Comment messages (`comments/<thread>/messages[i]`) carry `mentions` (user ids) and `text`;
//!   one call per message.
//! - Canvas text carries inline `mention(id,label)` nodes; one call per block per edit.
//!
//! "New" means the item (a message map or a mention node) was not in the doc when the room
//! loaded and arrived in an update the room accepted, which also names who wrote it (`by`).
//! The editor re-creates a mention node when its paragraph is split, joined or moved, so a text
//! mention is news only while the number of mentions of that person in the canvas goes above
//! the highest count seen so far. Updates that cannot contain a mention (no `mention` string in
//! the bytes) are not even decoded.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use yrs::branch::Branch;
use yrs::types::text::{Diff, YChange};
use yrs::types::xml::XmlOut;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Array, Doc, ID, IdSet, Map, Out, ReadTxn, Text, Transact, Update, Xml, XmlElementRef,
    XmlFragment,
};

/// Excerpts are cut to this many characters.
pub const EXCERPT_CHARS: usize = 280;
/// At most this many people per call.
pub const MAX_MENTIONED: usize = 50;
const NEEDLE: &[u8] = b"mention";

#[derive(Debug, Clone, PartialEq)]
pub struct MentionEvent {
    /// Stable per message: the ids of the items that carried the mention(s).
    pub key: String,
    pub block_id: Option<String>,
    pub thread_id: Option<String>,
    pub mentioned: Vec<String>,
    pub by: String,
    pub excerpt: String,
}

impl MentionEvent {
    /// The callback body: `{fileId, blockId?, threadId?, mentioned, by, excerpt}`.
    pub fn body(&self, file_id: &str) -> Value {
        let mut v = json!({
            "fileId": file_id,
            "mentioned": self.mentioned,
            "by": self.by,
            "excerpt": self.excerpt,
        });
        if let Some(b) = &self.block_id {
            v["blockId"] = json!(b);
        }
        if let Some(t) = &self.thread_id {
            v["threadId"] = json!(t);
        }
        v
    }
}

enum Found {
    /// A mention node in the canvas.
    Text {
        id: ID,
        user: String,
        block_id: Option<String>,
        /// The text block that holds it (groups mentions of one block into one call).
        block: ID,
        excerpt: String,
    },
    /// A comment message with a non-empty `mentions` list.
    Comment {
        id: ID,
        thread: String,
        users: Vec<String>,
        excerpt: String,
    },
}

impl Found {
    fn id(&self) -> ID {
        match self {
            Found::Text { id, .. } | Found::Comment { id, .. } => *id,
        }
    }
}

#[derive(Default)]
pub struct Tracker {
    known: HashSet<ID>,
    /// Highest number of text mentions per person seen in the canvas.
    high: HashMap<String, usize>,
    /// What each accepted update inserted, and who sent it.
    pending: Vec<(IdSet, String)>,
}

/// The id of the item that created a nested type (stable across edits of its content).
fn nested_id(t: &impl AsRef<Branch>) -> Option<ID> {
    match t.as_ref().id() {
        yrs::BranchID::Nested(id) => Some(id),
        yrs::BranchID::Root(_) => None,
    }
}

fn attr_str<T: ReadTxn>(txn: &T, el: &XmlElementRef, name: &str) -> Option<String> {
    match el.get_attribute(txn, name)? {
        Out::Any(Any::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

fn cut(s: &str) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    match s.char_indices().nth(EXCERPT_CHARS) {
        Some((i, _)) => format!("{}…", s[..i].trim_end()),
        None => s,
    }
}

/// Plain text of an element: text runs, `@label` for mentions, the date text of a date chip.
fn plain<T: ReadTxn>(txn: &T, el: &XmlElementRef, out: &mut String) {
    for child in el.children(txn) {
        match child {
            XmlOut::Text(t) => {
                for d in t.diff(txn, |_: YChange| ()) as Vec<Diff<()>> {
                    if let Out::Any(Any::String(s)) = d.insert {
                        out.push_str(&s);
                    }
                }
            }
            XmlOut::Element(e) => match e.tag().as_ref() {
                "mention" => {
                    out.push('@');
                    out.push_str(
                        &attr_str(txn, &e, "label")
                            .or_else(|| attr_str(txn, &e, "id"))
                            .unwrap_or_default(),
                    );
                }
                "dateMention" => out.push_str(&attr_str(txn, &e, "date").unwrap_or_default()),
                _ => plain(txn, &e, out),
            },
            XmlOut::Fragment(_) => {}
        }
    }
}

fn walk<T: ReadTxn>(txn: &T, el: &XmlElementRef, block_id: Option<String>, out: &mut Vec<Found>) {
    let block_id = attr_str(txn, el, "blockId").or(block_id);
    let mut excerpt: Option<String> = None;
    for child in el.children(txn) {
        let XmlOut::Element(c) = child else { continue };
        if c.tag().as_ref() == "mention" {
            let (Some(id), Some(block), Some(user)) =
                (nested_id(&c), nested_id(el), attr_str(txn, &c, "id"))
            else {
                continue;
            };
            let excerpt = excerpt
                .get_or_insert_with(|| {
                    let mut s = String::new();
                    plain(txn, el, &mut s);
                    cut(&s)
                })
                .clone();
            out.push(Found::Text {
                id,
                user,
                block_id: block_id.clone(),
                block,
                excerpt,
            });
        } else {
            walk(txn, &c, block_id.clone(), out);
        }
    }
}

fn scan(doc: &Doc) -> Vec<Found> {
    let txn = doc.transact();
    let mut out = Vec::new();
    if let Some(content) = txn.get_xml_fragment(oc_model::roots::CONTENT) {
        for child in content.children(&txn) {
            if let XmlOut::Element(el) = child {
                walk(&txn, &el, None, &mut out);
            }
        }
    }
    if let Some(comments) = txn.get_map(oc_model::roots::COMMENTS) {
        for (thread, t) in comments.iter(&txn) {
            let Out::YMap(t) = t else { continue };
            let Some(Out::YArray(msgs)) = t.get(&txn, "messages") else {
                continue;
            };
            for m in msgs.iter(&txn) {
                let Out::YMap(m) = m else { continue };
                let users: Vec<String> = match m.get(&txn, "mentions") {
                    Some(Out::Any(Any::Array(a))) => a
                        .iter()
                        .filter_map(|v| match v {
                            Any::String(s) if !s.is_empty() && s.len() <= 255 => {
                                Some(s.to_string())
                            }
                            _ => None,
                        })
                        .collect(),
                    _ => continue,
                };
                let Some(id) = nested_id(&m) else {
                    continue;
                };
                let text = match m.get(&txn, "text") {
                    Some(Out::Any(Any::String(s))) => s.to_string(),
                    _ => String::new(),
                };
                out.push(Found::Comment {
                    id,
                    thread: thread.to_string(),
                    users,
                    excerpt: cut(&text),
                });
            }
        }
    }
    out
}

fn text_counts(found: &[Found]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for f in found {
        if let Found::Text { user, .. } = f {
            *counts.entry(user.clone()).or_default() += 1;
        }
    }
    counts
}

fn key_of(ids: &[ID]) -> String {
    ids.iter()
        .map(|i| format!("{}:{}", i.client, i.clock))
        .collect::<Vec<_>>()
        .join(",")
}

impl Tracker {
    /// Everything already in `doc` (the file as loaded) counts as seen.
    pub fn new(doc: &Doc) -> Self {
        let found = scan(doc);
        Self {
            high: text_counts(&found),
            known: found.iter().map(Found::id).collect(),
            pending: Vec::new(),
        }
    }

    /// Records what an accepted update inserted and who sent it. Cheap for updates that
    /// cannot hold a mention.
    pub fn note(&mut self, update: &[u8], by: &str) {
        if !update.windows(NEEDLE.len()).any(|w| w == NEEDLE) {
            return;
        }
        if let Ok(u) = Update::decode_v1(update) {
            self.pending.push((u.insertions(false), by.to_string()));
        }
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// The new mentions since the last call, one event per comment message and one per block.
    pub fn collect(&mut self, doc: &Doc) -> Vec<MentionEvent> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let pending = std::mem::take(&mut self.pending);
        let author = |id: &ID| {
            pending
                .iter()
                .rev()
                .find(|(set, _)| set.contains(id))
                .map(|(_, by)| by.clone())
        };
        let found = scan(doc);
        let counts = text_counts(&found);
        // How many new text mentions of each person are news.
        let mut allowance: HashMap<String, usize> = counts
            .iter()
            .map(|(u, n)| (u.clone(), n.saturating_sub(*self.high.get(u).unwrap_or(&0))))
            .collect();
        let mut events = Vec::new();
        // Text mentions grouped by (block, author), in document order.
        let mut blocks: Vec<(ID, String, MentionEvent, Vec<ID>)> = Vec::new();
        for f in &found {
            let id = f.id();
            if !self.known.insert(id) {
                continue;
            }
            let Some(by) = author(&id) else { continue };
            match f {
                Found::Comment {
                    thread,
                    users,
                    excerpt,
                    ..
                } => {
                    let mut mentioned: Vec<String> = Vec::new();
                    for u in users {
                        if *u != by && !mentioned.contains(u) && mentioned.len() < MAX_MENTIONED {
                            mentioned.push(u.clone());
                        }
                    }
                    if !mentioned.is_empty() {
                        events.push(MentionEvent {
                            key: format!("c:{}", key_of(&[id])),
                            block_id: None,
                            thread_id: Some(thread.clone()),
                            mentioned,
                            by,
                            excerpt: excerpt.clone(),
                        });
                    }
                }
                Found::Text {
                    user,
                    block_id,
                    block,
                    excerpt,
                    ..
                } => {
                    let left = allowance.entry(user.clone()).or_default();
                    if *left == 0 || *user == by {
                        continue;
                    }
                    *left -= 1;
                    let at = match blocks.iter().position(|(b, a, ..)| b == block && *a == by) {
                        Some(i) => i,
                        None => {
                            blocks.push((
                                *block,
                                by.clone(),
                                MentionEvent {
                                    key: String::new(),
                                    block_id: block_id.clone(),
                                    thread_id: None,
                                    mentioned: Vec::new(),
                                    by: by.clone(),
                                    excerpt: excerpt.clone(),
                                },
                                Vec::new(),
                            ));
                            blocks.len() - 1
                        }
                    };
                    let slot = &mut blocks[at];
                    if !slot.2.mentioned.contains(user) && slot.2.mentioned.len() < MAX_MENTIONED {
                        slot.2.mentioned.push(user.clone());
                    }
                    slot.3.push(id);
                }
            }
        }
        for (_, _, mut ev, ids) in blocks {
            ev.key = format!("t:{}", key_of(&ids));
            events.push(ev);
        }
        for (u, n) in counts {
            let h = self.high.entry(u).or_default();
            *h = (*h).max(n);
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

    fn para(doc: &Doc, text: &str, who: &[&str]) -> Vec<u8> {
        let sv = doc.transact().state_vector();
        {
            let content = doc.get_or_insert_xml_fragment("content");
            let mut txn = doc.transact_mut();
            let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new(text));
            for w in who {
                let m = p.push_back(&mut txn, XmlElementPrelim::empty("mention"));
                m.insert_attribute(&mut txn, "id", *w);
                m.insert_attribute(&mut txn, "label", w.to_uppercase());
            }
        }
        doc.transact().encode_state_as_update_v1(&sv)
    }

    #[test]
    fn groups_a_block_and_skips_the_author_and_plain_updates() {
        let doc = oc_model::new_doc();
        let mut t = Tracker::new(&doc);
        let plain_update = para(&doc, "nothing here", &[]);
        t.note(&plain_update, "u_a");
        assert!(!t.has_pending(), "no `mention` bytes, nothing decoded");
        let u = para(&doc, "Hi ", &["u_b", "u_c", "u_a", "u_b"]);
        t.note(&u, "u_a");
        let ev = t.collect(&doc);
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!(ev[0].mentioned, vec!["u_b", "u_c"]);
        assert_eq!(ev[0].excerpt, "Hi @U_B@U_C@U_A@U_B");
        assert!(ev[0].key.starts_with("t:"));
        assert!(t.collect(&doc).is_empty(), "seen once");
    }

    #[test]
    fn excerpts_are_cut_on_a_character_boundary() {
        let long = "é".repeat(400);
        let c = cut(&long);
        assert_eq!(c.chars().count(), EXCERPT_CHARS + 1);
        assert!(c.ends_with('…'));
    }
}
