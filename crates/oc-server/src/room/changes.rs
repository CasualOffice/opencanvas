// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! What each transaction changed, by id, for change events (HAPI-05): deep observers on the
//! `content`, `databases`, `boards` and `comments` roots record the touched block, database and
//! board ids as transactions commit. O(size of the change), never a walk of the document.
//!
//! A block is the deepest element on the change's path that carries a `blockId` (a list item
//! inside a list, a paragraph inside a column). Removed top-level blocks are named from a list
//! of top-level ids kept in step with the `content` root; removed nested blocks report their
//! parent as edited.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use yrs::types::xml::XmlOut;
use yrs::types::{Change, Event, PathSegment};
use yrs::{Any, DeepObservable, Doc, Out, ReadTxn, Transact, TransactionMut, Xml, XmlFragment};

const KEY: &str = "oc-events";

/// Ids touched since the last [`Watch::take`].
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Touched {
    pub blocks: BTreeSet<String>,
    pub removed: BTreeSet<String>,
    pub databases: BTreeSet<String>,
    pub boards: BTreeSet<String>,
    /// The `comments` root changed (threads are compared in the room).
    pub comments: bool,
    /// Content changed where no block carries a `blockId` (re-read to see what).
    pub untracked: bool,
}

impl Touched {
    /// No block, database or board changed (comments are reported separately).
    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
            && self.removed.is_empty()
            && self.databases.is_empty()
            && self.boards.is_empty()
            && !self.untracked
    }
}

#[derive(Default)]
struct State {
    touched: Touched,
    /// `blockId` of each top-level block, in order (`None`: the block has none).
    top: Vec<Option<String>>,
}

/// The observers on one doc. Re-attach when the room replaces its doc.
pub struct Watch {
    state: Arc<Mutex<State>>,
}

fn block_id_of<T: ReadTxn>(txn: &T, node: &XmlOut) -> Option<String> {
    let XmlOut::Element(el) = node else {
        return None;
    };
    match el.get_attribute(txn, oc_model::patch::BLOCK_ID)? {
        Out::Any(Any::String(s)) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    }
}

fn top_ids<T: ReadTxn>(txn: &T, content: &yrs::XmlFragmentRef) -> Vec<Option<String>> {
    content
        .children(txn)
        .map(|c| block_id_of(txn, &c))
        .collect()
}

/// The deepest `blockId` on the way from `content` along `path` (then the target itself).
fn deepest(
    txn: &TransactionMut,
    content: &yrs::XmlFragmentRef,
    path: &yrs::types::Path,
    target: &Out,
) -> Option<String> {
    let mut found = None;
    let mut node: Option<XmlOut> = None;
    for seg in path {
        let PathSegment::Index(i) = seg else { break };
        let next = match &node {
            None => content.get(txn, *i),
            Some(XmlOut::Element(e)) => e.get(txn, *i),
            Some(XmlOut::Fragment(f)) => f.get(txn, *i),
            Some(XmlOut::Text(_)) => None,
        };
        let Some(next) = next else { break };
        if let Some(id) = block_id_of(txn, &next) {
            found = Some(id);
        }
        node = Some(next);
    }
    if let Out::YXmlElement(e) = target
        && let Some(id) = block_id_of(txn, &XmlOut::Element(e.clone()))
    {
        found = Some(id);
    }
    found
}

impl Watch {
    pub fn attach(doc: &Doc) -> Self {
        let content = doc.get_or_insert_xml_fragment(oc_model::roots::CONTENT);
        let state = Arc::new(Mutex::new(State {
            top: top_ids(&doc.transact(), &content),
            ..State::default()
        }));
        let s = state.clone();
        let root = content.clone();
        content.observe_deep(KEY, move |txn, events| {
            let mut st = s.lock().expect("changes");
            for ev in events.iter() {
                let path = ev.path();
                if path.is_empty() {
                    if let Event::XmlFragment(xe) = ev {
                        // Top-level blocks added or removed: keep `top` in step.
                        let mut at = 0usize;
                        for change in xe.delta(txn) {
                            match change {
                                Change::Retain(n) => at += *n as usize,
                                Change::Added(items) => {
                                    for item in items {
                                        let id = match item {
                                            Out::YXmlElement(e) => {
                                                block_id_of(txn, &XmlOut::Element(e.clone()))
                                            }
                                            _ => None,
                                        };
                                        match &id {
                                            Some(id) => {
                                                st.touched.blocks.insert(id.clone());
                                            }
                                            None => st.touched.untracked = true,
                                        }
                                        let at_ = at.min(st.top.len());
                                        st.top.insert(at_, id);
                                        at += 1;
                                    }
                                }
                                Change::Removed(n) => {
                                    let end = (at + *n as usize).min(st.top.len());
                                    let start = at.min(end);
                                    let gone: Vec<_> = st.top.drain(start..end).collect();
                                    for id in gone {
                                        match id {
                                            Some(id) => {
                                                st.touched.blocks.remove(&id);
                                                st.touched.removed.insert(id);
                                            }
                                            None => st.touched.untracked = true,
                                        }
                                    }
                                }
                            }
                        }
                    }
                    continue;
                }
                match deepest(txn, &root, &path, &ev.target()) {
                    Some(id) => {
                        st.touched.blocks.insert(id);
                    }
                    None => st.touched.untracked = true,
                }
                // A blockId set or changed on a top-level block: keep `top` right.
                if path.len() == 1
                    && let Some(PathSegment::Index(i)) = path.front()
                    && let Some(slot) = st.top.get_mut(*i as usize)
                    && let Some(node) = root.get(txn, *i)
                {
                    *slot = block_id_of(txn, &node);
                }
            }
            // Self-heal: if `top` drifted (should not happen), rebuild it.
            if st.top.len() != root.len(txn) as usize {
                st.top = top_ids(txn, &root);
            }
        });
        for (name, databases) in [
            (oc_model::roots::DATABASES, true),
            (oc_model::roots::BOARDS, false),
        ] {
            let map = doc.get_or_insert_map(name);
            let s = state.clone();
            map.observe_deep(KEY, move |txn, events| {
                let mut st = s.lock().expect("changes");
                for ev in events.iter() {
                    let path = ev.path();
                    let keys: Vec<String> = match path.front() {
                        Some(PathSegment::Key(k)) => vec![k.to_string()],
                        Some(PathSegment::Index(_)) => vec![],
                        None => match ev {
                            Event::Map(me) => me.keys(txn).keys().map(|k| k.to_string()).collect(),
                            _ => vec![],
                        },
                    };
                    let set = if databases {
                        &mut st.touched.databases
                    } else {
                        &mut st.touched.boards
                    };
                    set.extend(keys);
                }
            });
        }
        let comments = doc.get_or_insert_map(oc_model::roots::COMMENTS);
        let s = state.clone();
        comments.observe_deep(KEY, move |_, _| {
            s.lock().expect("changes").touched.comments = true;
        });
        Self { state }
    }

    /// What changed since the last call.
    pub fn take(&self) -> Touched {
        std::mem::take(&mut self.state.lock().expect("changes").touched)
    }
}

/// Messages per comment thread, with the thread's block: `thread → (count, blockId)`.
pub fn comment_counts(doc: &Doc) -> std::collections::HashMap<String, (u32, Option<String>)> {
    use yrs::Map;
    let txn = doc.transact();
    let mut out = std::collections::HashMap::new();
    let Some(comments) = txn.get_map(oc_model::roots::COMMENTS) else {
        return out;
    };
    for (thread, t) in comments.iter(&txn) {
        let Out::YMap(t) = t else { continue };
        let n = match t.get(&txn, "messages") {
            Some(Out::YArray(a)) => yrs::Array::len(&a, &txn),
            _ => 0,
        };
        let block = match t.get(&txn, "blockId") {
            Some(Out::Any(Any::String(s))) if !s.is_empty() => Some(s.to_string()),
            _ => None,
        };
        out.insert(thread.to_string(), (n, block));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Map, Text, XmlElementPrelim, XmlTextPrelim};

    fn para(doc: &Doc, id: &str, text: &str) {
        let content = doc.get_or_insert_xml_fragment("content");
        let mut txn = doc.transact_mut();
        let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        p.insert_attribute(&mut txn, "blockId", id);
        p.push_back(&mut txn, XmlTextPrelim::new(text));
    }

    fn set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn names_inserted_edited_and_removed_blocks() {
        let doc = oc_model::new_doc();
        para(&doc, "b_1", "one");
        let w = Watch::attach(&doc);
        assert!(w.take().is_empty(), "what was there before is not news");
        para(&doc, "b_2", "two");
        para(&doc, "b_3", "three");
        assert_eq!(w.take().blocks, set(&["b_2", "b_3"]));
        // Typing in b_1: the text's path leads through b_1.
        {
            let content = doc.get_or_insert_xml_fragment("content");
            let mut txn = doc.transact_mut();
            let Some(XmlOut::Element(p)) = content.get(&txn, 0) else {
                panic!()
            };
            let Some(XmlOut::Text(t)) = p.get(&txn, 0) else {
                panic!()
            };
            t.insert(&mut txn, 3, "!");
        }
        assert_eq!(w.take().blocks, set(&["b_1"]));
        // Removing b_2 (index 1).
        {
            let content = doc.get_or_insert_xml_fragment("content");
            let mut txn = doc.transact_mut();
            content.remove_range(&mut txn, 1, 1);
        }
        let t = w.take();
        assert_eq!((t.blocks, t.removed), (set(&[]), set(&["b_2"])));
        // The list of top-level ids stayed right: removing index 1 now removes b_3.
        {
            let content = doc.get_or_insert_xml_fragment("content");
            let mut txn = doc.transact_mut();
            content.remove_range(&mut txn, 1, 1);
        }
        assert_eq!(w.take().removed, set(&["b_3"]));
    }

    #[test]
    fn nested_blocks_report_the_deepest_id_and_other_roots_their_keys() {
        let doc = oc_model::new_doc();
        {
            let content = doc.get_or_insert_xml_fragment("content");
            let mut txn = doc.transact_mut();
            let list = content.push_back(&mut txn, XmlElementPrelim::empty("bulletList"));
            list.insert_attribute(&mut txn, "blockId", "b_list");
            let item = list.push_back(&mut txn, XmlElementPrelim::empty("listItem"));
            item.insert_attribute(&mut txn, "blockId", "b_item");
            let p = item.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new("x"));
        }
        let w = Watch::attach(&doc);
        {
            let content = doc.get_or_insert_xml_fragment("content");
            let mut txn = doc.transact_mut();
            let Some(XmlOut::Element(list)) = content.get(&txn, 0) else {
                panic!()
            };
            let Some(XmlOut::Element(item)) = list.get(&txn, 0) else {
                panic!()
            };
            let Some(XmlOut::Element(p)) = item.get(&txn, 0) else {
                panic!()
            };
            let Some(XmlOut::Text(t)) = p.get(&txn, 0) else {
                panic!()
            };
            t.insert(&mut txn, 1, "y");
        }
        assert_eq!(w.take().blocks, set(&["b_item"]));
        {
            let dbs = doc.get_or_insert_map("databases");
            let mut txn = doc.transact_mut();
            dbs.insert(&mut txn, "db_1", yrs::MapPrelim::default());
        }
        assert_eq!(w.take().databases, set(&["db_1"]));
        {
            let dbs = doc.get_or_insert_map("databases");
            let mut txn = doc.transact_mut();
            let Some(Out::YMap(db)) = dbs.get(&txn, "db_1") else {
                panic!()
            };
            db.insert(&mut txn, "title", "T");
        }
        let t = w.take();
        assert_eq!(t.databases, set(&["db_1"]));
        assert!(t.blocks.is_empty() && !t.comments);
        {
            let c = doc.get_or_insert_map("comments");
            let mut txn = doc.transact_mut();
            c.insert(&mut txn, "t_1", yrs::MapPrelim::default());
        }
        let t = w.take();
        assert!(t.comments && t.is_empty());
        assert_eq!(comment_counts(&doc).get("t_1"), Some(&(0, None)));
    }
}
