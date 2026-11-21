mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use oc_server::grant::Role;
use oc_server::room::protocol;
use serde_json::{Value, json};
use yrs::sync::AwarenessUpdate;
use yrs::sync::awareness::AwarenessUpdateEntry;
use yrs::{ClientID, Doc, Map, Text, Transact, XmlFragment, XmlTextPrelim, XmlTextRef};

fn type_text(doc: &Doc, s: &str) {
    let content = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let first: Option<XmlTextRef> = content.get(&txn, 0).and_then(|n| n.into_xml_text());
    match first {
        Some(t) => t.push(&mut txn, s),
        None => {
            content.push_back(&mut txn, XmlTextPrelim::new(s));
        }
    }
}

fn add_comment(doc: &Doc, id: &str, text: &str) {
    let comments = doc.get_or_insert_map("comments");
    comments.insert(&mut doc.transact_mut(), id, text);
}

fn content_text(v: &Value) -> String {
    v["content"]
        .as_array()
        .map(|a| a.iter().filter_map(|n| n["text"].as_str()).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn two_clients_converge_through_a_room() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;

    a.edit(|d| type_text(d, "hello "));
    a.settle().await;
    b.settle().await;
    // Concurrent edits from both sides, before either sees the other.
    a.edit(|d| type_text(d, "from A"));
    b.edit(|d| type_text(d, "from B"));
    b.edit(|d| add_comment(d, "t1", "nice"));
    a.settle().await;
    b.settle().await;
    a.settle().await;

    let (ja, jb, js) = (json_of(&a.doc), json_of(&b.doc), server_json(&state).await);
    assert_eq!(ja, jb);
    assert_eq!(ja, js);
    let text = content_text(&ja);
    assert!(
        text.starts_with("hello ") && text.contains("from A") && text.contains("from B"),
        "{text}"
    );
    assert_eq!(js["comments"]["t1"], "nice");
    assert!(
        a.controls
            .iter()
            .any(|c| c["t"] == "role" && c["role"] == "edit")
    );
    assert!(
        a.controls.iter().any(|c| c["t"] == "saved"),
        "save state sent after handshake"
    );
}

#[tokio::test]
async fn view_role_cannot_write() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut editor = Peer::join(&state, grant("u_e", Role::Edit)).await;
    let mut viewer = Peer::join(&state, grant("u_v", Role::View)).await;
    editor.settle().await;
    viewer.settle().await;

    viewer.edit(|d| type_text(d, "vandalism"));
    viewer.edit(|d| add_comment(d, "c", "also no"));
    viewer.settle().await;
    editor.settle().await;

    assert_eq!(viewer.denied, 1, "auth frame sent once");
    assert_eq!(content_text(&server_json(&state).await), "");
    assert_eq!(server_json(&state).await["comments"], json!({}));
    assert_eq!(content_text(&json_of(&editor.doc)), "");
}

#[tokio::test]
async fn comment_role_cannot_change_content() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut editor = Peer::join(&state, grant("u_e", Role::Edit)).await;
    let mut commenter = Peer::join(&state, grant("u_c", Role::Comment)).await;
    editor.settle().await;
    commenter.settle().await;
    editor.edit(|d| type_text(d, "original"));
    editor.settle().await;
    commenter.settle().await;

    commenter.edit(|d| type_text(d, " tampered"));
    commenter.edit(|d| {
        d.get_or_insert_map("meta")
            .insert(&mut d.transact_mut(), "title", "pwned");
    });
    commenter.settle().await;
    editor.settle().await;

    assert!(commenter.denied >= 1);
    let server = server_json(&state).await;
    assert_eq!(content_text(&server), "original");
    assert_eq!(server["meta"], json!({}));
    assert_eq!(content_text(&json_of(&editor.doc)), "original");
}

#[tokio::test]
async fn comment_role_can_write_comments() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut editor = Peer::join(&state, grant("u_e", Role::Edit)).await;
    let mut commenter = Peer::join(&state, grant("u_c", Role::Comment)).await;
    editor.settle().await;
    commenter.settle().await;

    commenter.edit(|d| add_comment(d, "t1", "looks good"));
    commenter.settle().await;
    editor.settle().await;

    assert_eq!(commenter.denied, 0);
    assert_eq!(server_json(&state).await["comments"]["t1"], "looks good");
    assert_eq!(json_of(&editor.doc)["comments"]["t1"], "looks good");
}

#[tokio::test]
async fn awareness_user_is_stamped_from_the_grant() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    let spoof =
        json!({"user": {"name": "Mallory", "color": "#000000"}, "cursor": null}).to_string();
    let update = AwarenessUpdate {
        clients: [(
            ClientID::new(42),
            AwarenessUpdateEntry {
                clock: 1,
                json: Arc::from(spoof.as_str()),
            },
        )]
        .into(),
    };
    a.send(protocol::awareness(update));
    b.settle().await;
    let got = b.awareness.last().expect("awareness relayed");
    let state_json: Value = serde_json::from_str(&got.clients[&ClientID::new(42)].json).unwrap();
    assert_eq!(state_json["user"]["name"], "Name of u_a");
    assert_eq!(state_json["user"]["id"], "u_a");
    assert_eq!(state_json["user"]["color"], "#123456");
}

#[tokio::test]
async fn unsaved_edits_survive_a_crashed_room() {
    let (base, host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    for word in ["one ", "two ", "three"] {
        a.edit(|d| type_text(d, word));
    }
    a.settle().await;
    let room = grant("u_a", Role::Edit).room;
    state.rooms.crash(&room);
    a.leave();

    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    b.settle().await;
    assert_eq!(content_text(&json_of(&b.doc)), "one two three");
    let h = host.lock().unwrap();
    assert!(h.puts.is_empty(), "nothing was saved to the host");
    assert_eq!(h.gets, 1, "recovery came from the WAL, not the host");
}

#[tokio::test]
async fn autosave_puts_a_signed_ocanvas() {
    let (base, host) = mock_host().await;
    let cfg = oc_server::config::RoomConfig {
        autosave_debounce: Duration::from_millis(100),
        ..room_cfg()
    };
    let state = app(&base, cfg).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| type_text(d, "saved text"));
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    a.settle().await;

    let put = host.lock().unwrap().puts[0].clone();
    assert!(put.signature_ok, "HMAC signature verifies");
    let h = |k: &str| {
        put.headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };
    assert_eq!(h("authorization"), "Bearer cb-u_a");
    assert_eq!(h("if-match"), "\"0\"");
    assert_eq!(h("x-opencanvas-autosave"), "1");
    assert_eq!(h("x-opencanvas-authors"), "[\"u_a\"]");
    assert!(!h("idempotency-key").is_empty());
    let loaded = oc_model::read_ocanvas(&put.body).unwrap();
    assert_eq!(
        content_text(&oc_model::doc_to_json(&loaded.doc)),
        "saved text"
    );
    assert!(a.controls.iter().any(|c| c["t"] == "saving"));
    assert!(
        a.controls
            .iter()
            .any(|c| c["t"] == "saved" && c["version"] == "1")
    );

    // A second edit saves against the new version.
    a.edit(|d| type_text(d, "!"));
    wait_until(|| host.lock().unwrap().puts.len() == 2).await;
    assert_eq!(host.lock().unwrap().puts[1].headers["if-match"], "\"1\"");
}

#[tokio::test]
async fn conflict_stops_autosave_and_tells_clients() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().conflict = true;
    let cfg = oc_server::config::RoomConfig {
        autosave_debounce: Duration::from_millis(50),
        ..room_cfg()
    };
    let state = app(&base, cfg).await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| type_text(d, "x"));
    wait_until(|| !host.lock().unwrap().puts.is_empty()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    a.edit(|d| type_text(d, "y"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    a.settle().await;
    assert!(a.controls.iter().any(|c| c["t"] == "conflict"));
    assert_eq!(
        host.lock().unwrap().puts.len(),
        1,
        "no further saves after a conflict"
    );
}

#[tokio::test]
async fn last_leave_saves_and_reopen_loads_from_host() {
    let (base, host) = mock_host().await;
    let state = app(
        &base,
        oc_server::config::RoomConfig {
            room_ttl: Duration::from_millis(200),
            ..room_cfg()
        },
    )
    .await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| type_text(d, "keep me"));
    a.settle().await;
    a.leave();
    wait_until(|| host.lock().unwrap().puts.len() == 1).await;
    wait_until(|| state.rooms.live_rooms() == 0).await;

    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    b.settle().await;
    assert_eq!(content_text(&json_of(&b.doc)), "keep me");
    assert_eq!(host.lock().unwrap().gets, 2);
}

/// docs/22 §7: the room's fan-out shares one buffer between peers instead of copying every
/// frame once per peer. Two viewers receive the same update in the same allocation.
#[tokio::test]
async fn fan_out_shares_one_buffer_between_peers() {
    use oc_server::room::Outbound;
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let host = state.hosts.get("sample").unwrap();
    let mut viewers = vec![];
    for u in ["u_v1", "u_v2"] {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let m = state
            .rooms
            .join(&host, Arc::new(grant(u, Role::View)), tx)
            .await
            .unwrap();
        viewers.push((m, rx));
    }
    let editor = Peer::join(&state, grant("u_e", Role::Edit)).await;
    // Drain the join traffic (sync step 1, status, presence).
    tokio::time::sleep(Duration::from_millis(200)).await;
    for (_, rx) in &mut viewers {
        while rx.try_recv().is_ok() {}
    }
    editor.edit(|d| type_text(d, "shared"));
    let mut got = vec![];
    for (_, rx) in &mut viewers {
        let frame = loop {
            match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
                Ok(Some(Outbound::Frame(f))) if f.first() == Some(&0) => break f,
                Ok(Some(_)) => continue,
                other => panic!("no update: {other:?}"),
            }
        };
        got.push(frame);
    }
    assert_eq!(got[0][..], got[1][..]);
    assert_eq!(
        got[0].as_ptr(),
        got[1].as_ptr(),
        "each peer got its own copy of the frame"
    );
}
