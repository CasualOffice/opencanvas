// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! UX-02: @mentions in comments and canvas text reach the host's `POST /mentions` callback,
//! once per message, signed like every callback, retried through the notification outbox.
mod common;

use common::*;
use oc_server::grant::Role;
use serde_json::{Value, json};
use yrs::{
    Any, Array, ArrayPrelim, Doc, Map, MapPrelim, Out, Transact, Xml, XmlElementPrelim,
    XmlFragment, XmlTextPrelim,
};

/// `<paragraph blockId>text @label please review</paragraph>`, like y-prosemirror writes it.
fn mention_para(doc: &Doc, block: &str, text: &str, who: &str, label: &str) {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.insert_attribute(&mut txn, "blockId", block);
    p.push_back(&mut txn, XmlTextPrelim::new(text));
    let m = p.push_back(&mut txn, XmlElementPrelim::empty("mention"));
    m.insert_attribute(&mut txn, "id", who);
    m.insert_attribute(&mut txn, "label", label);
    p.push_back(&mut txn, XmlTextPrelim::new(" please review"));
}

fn plain_para(doc: &Doc, text: &str) {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.push_back(&mut txn, XmlTextPrelim::new(text));
}

fn comment(doc: &Doc, thread: &str, text: &str, mentions: &[&str]) {
    let comments = doc.get_or_insert_map("comments");
    let mut txn = doc.transact_mut();
    let t = match comments.get(&txn, thread) {
        Some(Out::YMap(m)) => m,
        _ => {
            let m = comments.insert(&mut txn, thread, MapPrelim::default());
            m.insert(&mut txn, "quote", "the quote");
            m.insert(&mut txn, "messages", ArrayPrelim::default());
            m
        }
    };
    let Some(Out::YArray(msgs)) = t.get(&txn, "messages") else {
        panic!("messages")
    };
    let msg = msgs.push_back(&mut txn, MapPrelim::default());
    msg.insert(&mut txn, "user", "u_1");
    msg.insert(&mut txn, "text", text);
    msg.insert(&mut txn, "at", 1.0);
    if !mentions.is_empty() {
        msg.insert(
            &mut txn,
            "mentions",
            Any::from(mentions.iter().map(|m| Any::from(*m)).collect::<Vec<_>>()),
        );
    }
}

fn calls(host: &Shared) -> Vec<Value> {
    host.lock()
        .unwrap()
        .mentions
        .iter()
        .map(|c| serde_json::from_slice(&c.body).unwrap())
        .collect()
}

async fn settle_mentions() {
    // Mentions are collected once the room has been quiet for a moment, then sent.
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
}

#[tokio::test]
async fn a_comment_mention_calls_the_host_once() {
    let (base, host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut asha = Peer::join(&state, grant("u_1", Role::Comment)).await;
    asha.settle().await;

    asha.edit(|d| comment(d, "t_1", "Over to @Sam Ortiz, and me", &["u_sam", "u_1"]));
    wait_until(|| !host.lock().unwrap().mentions.is_empty()).await;
    asha.settle().await;
    settle_mentions().await;

    let got = calls(&host);
    assert_eq!(got.len(), 1, "{got:?}");
    // The author is never notified about themselves.
    assert_eq!(
        got[0],
        json!({"fileId": FILE, "threadId": "t_1", "mentioned": ["u_sam"], "by": "u_1",
               "excerpt": "Over to @Sam Ortiz, and me"})
    );
    let rec = host.lock().unwrap().mentions[0].clone();
    assert!(rec.signature_ok, "v2 signature binds POST /api/mentions");
    assert_eq!(rec.headers["authorization"], "Bearer cb-u_1");
    assert_eq!(rec.headers["content-type"], "application/json");
    assert!(rec.headers.contains_key("idempotency-key"));

    // Unrelated edits and a reply without mentions don't repeat it.
    asha.edit(|d| comment(d, "t_1", "No mentions here", &[]));
    asha.settle().await;
    settle_mentions().await;
    assert_eq!(calls(&host).len(), 1);

    // A new message with a mention is a new notification.
    asha.edit(|d| comment(d, "t_1", "@Ravi Menon too", &["u_ravi"]));
    wait_until(|| host.lock().unwrap().mentions.len() == 2).await;
    assert_eq!(calls(&host)[1]["mentioned"], json!(["u_ravi"]));
}

#[tokio::test]
async fn a_text_mention_calls_the_host_with_the_block() {
    let (base, host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut priya = Peer::join(&state, grant("u_priya", Role::Edit)).await;
    priya.settle().await;

    priya.edit(|d| plain_para(d, "Agenda"));
    priya.edit(|d| mention_para(d, "b_review", "Ask ", "u_sam", "Sam Ortiz"));
    wait_until(|| !host.lock().unwrap().mentions.is_empty()).await;
    priya.settle().await;
    settle_mentions().await;
    let got = calls(&host);
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(
        got[0],
        json!({"fileId": FILE, "blockId": "b_review", "mentioned": ["u_sam"], "by": "u_priya",
               "excerpt": "Ask @Sam Ortiz please review"})
    );

    // The editor re-creates a mention node when its paragraph is split or moved: same people,
    // same count, so nobody is notified again.
    priya.edit(|d| {
        let content = d.get_or_insert_xml_fragment("content");
        let mut txn = d.transact_mut();
        content.remove_range(&mut txn, 1, 1);
        let p = content.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        let m = p.push_back(&mut txn, XmlElementPrelim::empty("mention"));
        m.insert_attribute(&mut txn, "id", "u_sam");
        m.insert_attribute(&mut txn, "label", "Sam Ortiz");
    });
    priya.settle().await;
    settle_mentions().await;
    assert_eq!(calls(&host).len(), 1, "moved mention is not new");

    // A second @Sam elsewhere is.
    priya.edit(|d| mention_para(d, "b_two", "Also ", "u_sam", "Sam Ortiz"));
    wait_until(|| host.lock().unwrap().mentions.len() == 2).await;
    assert_eq!(calls(&host)[1]["blockId"], "b_two");
}

#[tokio::test]
async fn existing_mentions_are_not_sent_when_the_room_loads() {
    let (base, host) = mock_host().await;
    // A file that already has a mention in it.
    let doc = oc_model::new_doc();
    mention_para(&doc, "b_old", "Ping ", "u_sam", "Sam Ortiz");
    comment(&doc, "t_old", "@Sam Ortiz hi", &["u_sam"]);
    let bytes = oc_model::write_ocanvas(
        &doc,
        &oc_model::CommitInfo {
            id: "c1".into(),
            authors: vec![],
            at: "2026-11-21T00:00:00Z".into(),
            ..Default::default()
        },
    )
    .unwrap();
    host.lock().unwrap().files.insert(FILE.into(), (bytes, 3));
    let state = app(&base, room_cfg()).await;
    let mut p = Peer::join(&state, grant("u_priya", Role::Edit)).await;
    p.settle().await;
    p.edit(|d| plain_para(d, "a new line"));
    p.settle().await;
    settle_mentions().await;
    assert!(calls(&host).is_empty(), "{:?}", calls(&host));
}

#[tokio::test]
async fn a_failed_mention_call_is_retried_from_the_outbox() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().mentions_fail = 1;
    let state = app(&base, room_cfg()).await;
    let mut asha = Peer::join(&state, grant("u_1", Role::Edit)).await;
    asha.settle().await;
    asha.edit(|d| comment(d, "t_9", "@Sam Ortiz look", &["u_sam"]));
    wait_until(|| host.lock().unwrap().mentions.len() == 1).await;
    settle_mentions().await;
    assert_eq!(host.lock().unwrap().mentions.len(), 1, "no hot retry loop");

    // The sweeper resends it later, with the same idempotency key, and only once.
    let later = oc_server::util::now_ms() + 3_600_000;
    assert_eq!(state.deliver_notifications(later).await.unwrap(), 1);
    assert_eq!(state.deliver_notifications(later).await.unwrap(), 0);
    let h = host.lock().unwrap();
    assert_eq!(h.mentions.len(), 2);
    assert_eq!(
        h.mentions[0].headers["idempotency-key"],
        h.mentions[1].headers["idempotency-key"]
    );
    assert_eq!(h.mentions[0].body, h.mentions[1].body);
}
