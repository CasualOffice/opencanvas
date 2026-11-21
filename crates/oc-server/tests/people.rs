//! docs/21 (ADR-026): users and identity. Per-viewer resolve and search caches, awareness
//! rewritten per recipient (hidden and external people never leak), e-mail only with
//! `perms.showEmail`, the resolve > token > snapshot merge order, and tier 0 with no user
//! callbacks at all.

mod common;

use std::collections::HashMap;
use std::sync::Arc;

use common::*;
use oc_server::grant::{Role, User};
use oc_server::hosts::Coviewers;
use oc_server::room::protocol;
use serde_json::{Value, json};
use yrs::ClientID;
use yrs::sync::AwarenessUpdate;
use yrs::sync::awareness::AwarenessUpdateEntry;
use yrs::{Transact, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

async fn ticket_for(state: &oc_server::SharedState, g: &oc_server::grant::Grant) -> String {
    let t = ulid::Ulid::new().to_string();
    state
        .store
        .insert_session(&t, g, now_secs() + 600, 0)
        .await
        .unwrap();
    t
}

fn person(id: &str, name: &str) -> User {
    User {
        id: id.into(),
        name: name.into(),
        color: "#123456".into(),
        ..Default::default()
    }
}

/// Sends one awareness state for client `client` from `p`.
fn announce(p: &Peer, client: u64) {
    let st = json!({"user": {"name": "whatever"}, "cursor": null}).to_string();
    p.send(protocol::awareness(AwarenessUpdate {
        clients: [(
            ClientID::new(client),
            AwarenessUpdateEntry {
                clock: 1,
                json: Arc::from(st.as_str()),
            },
        )]
        .into(),
    }));
}

/// Everything `p` received in awareness frames, as one string.
fn awareness_text(p: &Peer) -> String {
    p.awareness
        .iter()
        .flat_map(|u| u.clients.values().map(|e| e.json.to_string()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The newest awareness `user` `p` received for `client`.
fn last_user(p: &Peer, client: u64) -> Option<Value> {
    p.awareness.iter().rev().find_map(|u| {
        u.clients
            .get(&ClientID::new(client))
            .and_then(|e| serde_json::from_str::<Value>(&e.json).ok())
            .map(|v| v["user"].clone())
    })
}

/// Tier 3 answers per viewer token: Priya and Sam are not contacts. For Sam, Priya is
/// `external` ("Priya S.") and Ravi is `hidden`. For Priya, everyone is a contact and Ravi
/// has a nickname.
fn networks() -> HashMap<String, Value> {
    HashMap::from([
        (
            "cb-u_sam".to_string(),
            json!([
                {"id": "u_priya", "name": "Priya S.", "relation": "external"},
                {"id": "u_ravi", "name": "Name of u_ravi", "detail": "Ops", "relation": "hidden"}
            ]),
        ),
        (
            "cb-u_priya".to_string(),
            json!({"users": [
                {"id": "u_sam", "name": "Name of u_sam", "relation": "contact"},
                {"id": "u_ravi", "name": "Ravi (ops lead)", "detail": "Ops", "relation": "contact",
                 "email": "ravi@acme.example"}
            ]}),
        ),
        (
            "cb-u_ravi".to_string(),
            json!([{"id": "u_sam", "name": "Name of u_sam", "relation": "member"},
                   {"id": "u_priya", "name": "Name of u_priya", "relation": "member"}]),
        ),
    ])
}

/// docs/21: presence follows the viewer's relation, and the server rewrites it per
/// recipient. Sam never receives Ravi's real name or id, and sees Priya only as the host's
/// external label; Priya sees her nickname for Ravi.
#[tokio::test]
async fn awareness_is_rewritten_per_viewer_and_never_leaks() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().resolve = Some(networks());
    let state = app(&base, room_cfg()).await;
    let mut sam = Peer::join(&state, grant("u_sam", Role::Edit)).await;
    let mut priya = Peer::join(&state, grant("u_priya", Role::Edit)).await;
    let mut ravi = Peer::join(&state, grant("u_ravi", Role::Edit)).await;
    for p in [&mut sam, &mut priya, &mut ravi] {
        p.settle().await;
    }
    announce(&priya, 11);
    announce(&ravi, 12);
    announce(&sam, 13);
    for _ in 0..3 {
        for p in [&mut sam, &mut priya, &mut ravi] {
            p.settle().await;
        }
    }
    // Sam: Priya as the external label, Ravi as "Someone" under a per-viewer id.
    let p = last_user(&sam, 11).expect("Sam sees Priya");
    assert_eq!(p["name"], "Priya S.");
    assert_eq!(p["relation"], "external");
    let r = last_user(&sam, 12).expect("Sam sees someone");
    assert_eq!(r["name"], "Someone");
    assert_eq!(r["relation"], "hidden");
    let all = awareness_text(&sam);
    assert!(!all.contains("Name of u_ravi"), "{all}");
    assert!(!all.contains("u_ravi"), "{all}");
    assert!(!all.contains("Ops"), "{all}");
    assert!(!all.contains("Name of u_priya"), "{all}");
    // The pseudonymous id is per viewer.
    let anon = r["id"].as_str().unwrap().to_string();
    assert!(anon.starts_with("anon_"));
    // Priya: her nickname for Ravi, never an e-mail.
    let r = last_user(&priya, 12).expect("Priya sees Ravi");
    assert_eq!(r["name"], "Ravi (ops lead)");
    assert_eq!(r["detail"], "Ops");
    assert!(!awareness_text(&priya).contains("@acme"));
    // Ravi: plain members.
    assert_eq!(last_user(&ravi, 13).unwrap()["name"], "Name of u_sam");
    // One resolve call per viewer, each with that viewer's own token.
    let calls = host.lock().unwrap().resolve_calls.clone();
    let mut tokens: Vec<_> = calls.iter().map(|(t, _)| t.clone()).collect();
    tokens.sort();
    tokens.dedup();
    assert_eq!(tokens, ["cb-u_priya", "cb-u_ravi", "cb-u_sam"]);
}

/// docs/21: resolve is per viewer, batched and cached 10 minutes per (room, viewer); search
/// is per viewer and never shared between viewers.
#[tokio::test]
async fn resolve_and_search_are_cached_per_viewer() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().resolve = Some(networks());
    let state = app(&base, room_cfg()).await;
    let sam = ticket_for(&state, &grant("u_sam", Role::Edit)).await;
    let priya = ticket_for(&state, &grant("u_priya", Role::Edit)).await;
    let addr = serve_state(state).await;
    let resolve = |t: String| {
        let addr = addr.clone();
        async move {
            http()
                .post(format!("http://{addr}/v1/users/resolve?ticket={t}"))
                .json(&json!({"ids": ["u_priya", "u_ravi"]}))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    };
    let s1 = resolve(sam.clone()).await;
    assert_eq!(s1["resolve"], true);
    let s2 = resolve(sam.clone()).await;
    assert_eq!(s1, s2);
    let ravi = s1["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["relation"] == "hidden")
        .unwrap();
    assert_eq!(ravi["name"], "Someone");
    assert!(!s1.to_string().contains("Name of u_ravi"), "{s1}");
    let p1 = resolve(priya.clone()).await;
    assert_ne!(p1, s1, "Priya gets her own answer");
    let calls = host.lock().unwrap().resolve_calls.clone();
    assert_eq!(
        calls.len(),
        2,
        "one call per viewer, then the cache: {calls:?}"
    );
    assert_eq!(calls[0].0, "cb-u_sam");
    assert_eq!(calls[0].1["ids"], json!(["u_priya", "u_ravi"]));
    assert_eq!(calls[1].0, "cb-u_priya");
    // A new id for Sam: only that id goes to the host.
    let one = http()
        .post(format!("http://{addr}/v1/users/resolve?ticket={sam}"))
        .json(&json!({"ids": ["u_priya", "u_new"]}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        one["users"].as_array().unwrap().len(),
        1,
        "unlisted ids fall back: {one}"
    );
    let calls = host.lock().unwrap().resolve_calls.clone();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[2].1["ids"], json!(["u_new"]));

    // Search: per viewer token, cached per viewer.
    for t in [&sam, &sam, &priya] {
        let r = http()
            .get(format!("http://{addr}/v1/users?ticket={t}&q=as"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
    }
    let users = host.lock().unwrap().users_calls.clone();
    assert_eq!(users, ["cb-u_sam", "cb-u_priya"]);
}

/// docs/21: "No email is shown unless perms.showEmail" — not in the session, participants,
/// search, resolve or the document's `people` map.
#[tokio::test]
async fn email_is_never_sent_without_show_email() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().resolve = Some(networks());
    let state = app(&base, room_cfg()).await;
    let mut g = grant("u_priya", Role::Edit);
    g.user.email = Some("priya@acme.example".into());
    g.participants = vec![User {
        email: Some("sam@acme.example".into()),
        ..person("u_sam", "Sam Ortiz")
    }];
    let t = ticket_for(&state, &g).await;
    let mut shown = g.clone();
    shown.perms.show_email = true;
    shown.user.id = "u_priya2".into();
    let t2 = ticket_for(&state, &shown).await;
    let mut p = Peer::join(&state, g.clone()).await;
    p.settle().await;
    let addr = serve_state(state.clone()).await;
    let get = |url: String| async move {
        http()
            .get(url)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
    };
    let session = get(format!("http://{addr}/v1/sessions/{t}")).await;
    let search = get(format!("http://{addr}/v1/users?ticket={t}&q=a")).await;
    let resolved = http()
        .post(format!("http://{addr}/v1/users/resolve?ticket={t}"))
        .json(&json!({"ids": ["u_ravi"]}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    for body in [session.to_string(), search.to_string(), resolved] {
        assert!(!body.contains("@acme"), "{body}");
    }
    assert_eq!(search[0]["detail"], "Design");
    assert_eq!(search[0]["access"], true);
    assert!(!json_of(&p.doc).to_string().contains("@acme"));
    assert_eq!(
        json_of(&p.doc)["people"]["u_priya"]["name"],
        "Name of u_priya"
    );
    // With perms.showEmail the same viewer data carries it.
    let session = get(format!("http://{addr}/v1/sessions/{t2}")).await;
    assert_eq!(session["user"]["email"], "priya@acme.example");
    assert_eq!(session["participants"][0]["email"], "sam@acme.example");
    assert_eq!(session["perms"]["showEmail"], true);
}

fn mention(doc: &yrs::Doc, id: &str, label: &str) {
    let frag = doc.get_or_insert_xml_fragment("content");
    let mut txn = doc.transact_mut();
    let p = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.push_back(&mut txn, XmlTextPrelim::new("Ask "));
    let m = p.push_back(&mut txn, XmlElementPrelim::empty("mention"));
    m.insert_attribute(&mut txn, "id", id);
    m.insert_attribute(&mut txn, "label", label);
}

/// docs/21: "host-resolved beats token beats document snapshot", for exports too.
#[tokio::test]
async fn exports_merge_resolve_over_token_over_snapshot() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().resolve = Some(HashMap::from([(
        "cb-u_priya".to_string(),
        json!([{"id": "u_a", "name": "Resolved A", "relation": "contact"},
               {"id": "u_h", "name": "Real H", "relation": "hidden"}]),
    )]));
    let state = app(&base, room_cfg()).await;
    let mut g = grant("u_priya", Role::Edit);
    g.participants = vec![person("u_a", "Token A"), person("u_b", "Token B")];
    let mut p = Peer::join(&state, g.clone()).await;
    p.settle().await;
    p.edit(|d| {
        mention(d, "u_a", "Snapshot A");
        mention(d, "u_b", "Snapshot B");
        mention(d, "u_c", "Snapshot C");
        mention(d, "u_h", "Real H");
    });
    p.settle().await;
    let t = ticket_for(&state, &g).await;
    let addr = serve_state(state.clone()).await;
    let md = |t: String| {
        let addr = addr.clone();
        async move {
            http()
                .get(format!("http://{addr}/v1/export/md?ticket={t}"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        }
    };
    let out = md(t.clone()).await;
    assert!(out.contains("@Resolved A"), "resolve wins: {out}");
    assert!(out.contains("@Token B"), "then the token: {out}");
    assert!(out.contains("@Snapshot C"), "then the snapshot: {out}");
    assert!(out.contains("@Someone") && !out.contains("Real H"), "{out}");

    // Without a resolve callback: token, then snapshot.
    host.lock().unwrap().resolve = None;
    state.directory.forget_viewer(&g.room, &g.user.id);
    let out = md(t).await;
    assert!(out.contains("@Token A"), "{out}");
    assert!(out.contains("@Real H"), "{out}");
}

/// Tier 0 (docs/21): no users or resolve callbacks at all. Everyone who opens the file lands
/// in the `people` map, search answers `[]`, resolve says it isn't there, and presence
/// shows names (with `coviewers = "contacts"` the server can't tell, so it doesn't hide).
#[tokio::test]
async fn tier_zero_works_without_user_callbacks() {
    let (base, host) = mock_host().await;
    host.lock().unwrap().users_off = true;
    let state = app(&base, room_cfg()).await;
    let mut a = Peer::join(&state, {
        let mut g = grant("u_a", Role::View);
        g.user.detail = Some("Design".into());
        g.user.avatar = Some("https://cdn.acme.example/a.png".into());
        g
    })
    .await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    let people = json_of(&b.doc)["people"].clone();
    assert_eq!(people["u_a"]["name"], "Name of u_a");
    assert_eq!(people["u_a"]["detail"], "Design");
    assert_eq!(people["u_a"]["avatar"], "https://cdn.acme.example/a.png");
    assert!(people["u_a"]["lastSeen"].as_i64().unwrap() > 0);
    assert_eq!(people["u_b"]["name"], "Name of u_b");
    announce(&a, 21);
    b.settle().await;
    b.settle().await;
    let u = last_user(&b, 21).expect("presence relayed");
    assert_eq!(u["name"], "Name of u_a");
    assert_eq!(u["detail"], "Design");
    // A visit alone is not a save.
    assert!(host.lock().unwrap().puts.is_empty());

    let t = ticket_for(&state, &grant("u_b", Role::Edit)).await;
    let addr = serve_state(state.clone()).await;
    let search: Value = http()
        .get(format!("http://{addr}/v1/users?ticket={t}&q=a"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(search, json!([]));
    let r: Value = http()
        .post(format!("http://{addr}/v1/users/resolve?ticket={t}"))
        .json(&json!({"ids": ["u_a"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r["resolve"], false);
    let s: Value = http()
        .get(format!("http://{addr}/v1/sessions/{t}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(s["directory"]["coviewers"], "contacts");
}

/// `directory.coviewers = "none"` with no resolve: co-viewers are "Someone", and nobody is
/// written into the `people` map.
#[tokio::test]
async fn coviewers_none_hides_people_without_resolve() {
    let (base, _host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| {
        h.directory.coviewers = Coviewers::None;
    })
    .await;
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    let mut b = Peer::join(&state, grant("u_b", Role::Edit)).await;
    a.settle().await;
    b.settle().await;
    announce(&a, 31);
    b.settle().await;
    b.settle().await;
    assert_eq!(last_user(&b, 31).unwrap()["name"], "Someone");
    assert!(!awareness_text(&b).contains("u_a"));
    assert!(json_of(&b.doc).get("people").is_none());
}
