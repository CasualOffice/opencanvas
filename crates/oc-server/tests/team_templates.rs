// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! TPL-01: host-supplied team templates. `GET /v1/templates` lists the host's
//! `GET /templates` (signed, cached per host), `POST /v1/templates/{id}/apply` replaces the
//! canvas with the host's `GET /templates/{id}` file (size and MOD-01 checks, edit role) as
//! one transaction, and `POST /v1/templates/undo` reverts it.
mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use common::*;
use oc_server::SharedState;
use oc_server::grant::Role;
use serde_json::{Value, json};

#[derive(Default)]
struct Tpl {
    /// (path, v2 signature ok, bearer) of every templates call.
    calls: Vec<(String, bool, String)>,
    /// `false`: the host has no templates callback (404).
    implemented: bool,
}
type Shared = Arc<Mutex<Tpl>>;

fn signed_ok(headers: &HeaderMap, path: &str) -> bool {
    let Some(sig) = headers
        .get("x-opencanvas-signature")
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some(t) = sig
        .strip_prefix("t=")
        .and_then(|s| s.split(',').next())
        .and_then(|t| t.parse::<i64>().ok())
    else {
        return false;
    };
    sig == oc_server::host_client::signature_header(SECRET.as_bytes(), t, "GET", path, b"")
}

fn bearer(h: &HeaderMap) -> String {
    h.get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

fn retro_ocanvas() -> Vec<u8> {
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(&doc, oc_model::templates::builtin("retro").unwrap());
    oc_model::write_ocanvas(&doc, &Default::default()).unwrap()
}

fn bad_ocanvas() -> Vec<u8> {
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(
        &doc,
        &json!({"content": [{"type": "heading", "attrs": {"level": 9}, "content": [{"type": "text", "text": "x"}]}]}),
    );
    oc_model::write_ocanvas(&doc, &Default::default()).unwrap()
}

async fn list(State(s): State<Shared>, headers: HeaderMap) -> impl IntoResponse {
    let mut st = s.lock().unwrap();
    st.calls.push((
        "/api/templates".into(),
        signed_ok(&headers, "/api/templates"),
        bearer(&headers),
    ));
    if !st.implemented {
        return (StatusCode::NOT_FOUND, axum::Json(json!({}))).into_response();
    }
    axum::Json(json!([
        {"id": "acme-retro", "name": "Acme retro", "description": "Our retro", "category": "Meetings", "icon": "repeat", "tone": "green", "updatedAt": "2026-11-20T10:00:00Z"},
        {"id": "acme-weekly", "name": "Acme weekly", "description": "Weekly notes", "updatedAt": "2026-11-21T10:00:00Z"}
    ]))
    .into_response()
}

async fn file(
    State(s): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> axum::response::Response {
    let path = format!("/api/templates/{id}");
    let ok = signed_ok(&headers, &path);
    s.lock().unwrap().calls.push((path, ok, bearer(&headers)));
    match id.as_str() {
        "acme-retro" => retro_ocanvas().into_response(),
        "acme-weekly" => (
            [("content-type", "text/markdown")],
            "# Weekly\n\n- [ ] Wins\n- [ ] Risks\n",
        )
            .into_response(),
        "bad" => bad_ocanvas().into_response(),
        "big" => vec![b'a'; 5 * 1024 * 1024 + 10].into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn doc_file() -> impl IntoResponse {
    ([("etag", "\"1\"")], "# Existing\n\nKeep me\n")
}

async fn serve(flag: bool) -> (String, SharedState, Shared) {
    let tpl: Shared = Arc::new(Mutex::new(Tpl {
        implemented: true,
        ..Default::default()
    }));
    let app = Router::new()
        .route("/api/files/{id}", get(doc_file))
        .route("/api/templates", get(list))
        .route("/api/templates/{id}", get(file))
        .with_state(tpl.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/api", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| {
        if flag {
            h.flags
                .insert("team_templates".into(), toml::Value::Boolean(true));
        }
    })
    .await;
    (serve_state(state.clone()).await, state, tpl)
}

async fn ticket(state: &SharedState, user: &str, role: Role) -> String {
    let t = ulid::Ulid::new().to_string();
    let exp = oc_server::util::now_secs() + 600;
    state
        .store
        .insert_session(&t, &grant(user, role), exp, 0)
        .await
        .unwrap();
    t
}

async fn call(method: &str, url: String) -> (u16, Value) {
    let c = reqwest::Client::new();
    let res = if method == "GET" {
        c.get(url)
    } else {
        c.post(url)
    }
    .send()
    .await
    .unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

fn markdown(v: &Value) -> String {
    oc_model::export::to_markdown(v)
}

#[tokio::test]
async fn list_is_signed_cleaned_and_cached_per_host() {
    let (addr, state, tpl) = serve(true).await;
    let a = ticket(&state, "u_a", Role::View).await;
    let b = ticket(&state, "u_b", Role::Edit).await;
    let (s, v) = call("GET", format!("http://{addr}/v1/templates?ticket={a}")).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["enabled"], true);
    assert_eq!(v["templates"][0]["name"], "Acme retro");
    assert_eq!(v["templates"][1]["icon"], "layout-template");
    assert_eq!(v["templates"][1]["tone"], "gray");
    // A second user within the minute gets the cached list: one host call in all.
    let (s, _) = call("GET", format!("http://{addr}/v1/templates?ticket={b}")).await;
    assert_eq!(s, 200);
    let calls = tpl.lock().unwrap().calls.clone();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(calls[0].1, "the list call carries a valid v2 signature");
    assert_eq!(calls[0].2, "Bearer cb-u_a");
    // No ticket, no list.
    let (s, _) = call("GET", format!("http://{addr}/v1/templates?ticket=nope")).await;
    assert_eq!(s, 401);
}

#[tokio::test]
async fn hosts_without_the_flag_or_the_callback_show_no_team_section() {
    let (addr, state, tpl) = serve(false).await;
    let t = ticket(&state, "u_a", Role::Edit).await;
    let (_, v) = call("GET", format!("http://{addr}/v1/templates?ticket={t}")).await;
    assert_eq!(v, json!({"enabled": false, "templates": []}));
    let (s, v) = call(
        "POST",
        format!("http://{addr}/v1/templates/acme-retro/apply?ticket={t}"),
    )
    .await;
    assert_eq!(
        (s, v["error"]["code"].as_str()),
        (403, Some("TEMPLATES_OFF")),
        "{v}"
    );
    assert!(tpl.lock().unwrap().calls.is_empty());

    let (addr, state, tpl) = serve(true).await;
    tpl.lock().unwrap().implemented = false;
    let t = ticket(&state, "u_a", Role::Edit).await;
    let (s, v) = call("GET", format!("http://{addr}/v1/templates?ticket={t}")).await;
    assert_eq!((s, &v), (200, &json!({"enabled": false, "templates": []})));
}

#[tokio::test]
async fn applying_needs_the_edit_role() {
    let (addr, state, tpl) = serve(true).await;
    for role in [Role::View, Role::Comment] {
        let t = ticket(&state, "u_v", role).await;
        let (s, v) = call(
            "POST",
            format!("http://{addr}/v1/templates/acme-retro/apply?ticket={t}"),
        )
        .await;
        assert_eq!(s, 403, "{v}");
    }
    assert!(
        !tpl.lock()
            .unwrap()
            .calls
            .iter()
            .any(|c| c.0.contains("acme-retro")),
        "the template is never fetched for a viewer"
    );
}

#[tokio::test]
async fn apply_replaces_the_canvas_and_undo_restores_it() {
    let (addr, state, tpl) = serve(true).await;
    let mut peer = Peer::join(&state, grant("u_b", Role::Edit)).await;
    peer.settle().await;
    let t = ticket(&state, "u_a", Role::Edit).await;
    let (s, v) = call(
        "POST",
        format!("http://{addr}/v1/templates/acme-retro/apply?ticket={t}"),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["name"], "Acme retro");
    let apply_id = v["applyId"].as_str().unwrap().to_string();
    assert!(!v["blockIds"].as_array().unwrap().is_empty());
    let calls = tpl.lock().unwrap().calls.clone();
    let fetch = calls
        .iter()
        .find(|c| c.0 == "/api/templates/acme-retro")
        .unwrap();
    assert!(fetch.1, "the file call carries a valid v2 signature");

    let j = server_json(&state).await;
    let md = markdown(&j);
    assert!(!md.contains("Keep me"), "{md}");
    assert!(md.contains("Actions"), "{md}");
    assert_eq!(j["meta"]["title"], "Acme retro");
    assert_eq!(j["meta"]["template"], "team:acme-retro");
    assert_eq!(j["databases"].as_object().unwrap().len(), 1);
    assert_eq!(j["boards"].as_object().unwrap().len(), 1);
    // Every client got it (one server transaction, like any edit).
    peer.settle().await;
    assert!(markdown(&json_of(&peer.doc)).contains("Actions"));

    // Someone else cannot undo it.
    let other = ticket(&state, "u_c", Role::Edit).await;
    let (s, _) = call(
        "POST",
        format!("http://{addr}/v1/templates/undo?ticket={other}&applyId={apply_id}"),
    )
    .await;
    assert_eq!(s, 409);
    // The person who applied it can, once.
    let (s, v) = call(
        "POST",
        format!("http://{addr}/v1/templates/undo?ticket={t}&applyId={apply_id}"),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let j = server_json(&state).await;
    let md = markdown(&j);
    assert!(md.contains("Keep me") && !md.contains("Actions"), "{md}");
    assert!(j["databases"].as_object().unwrap().is_empty(), "{j}");
    assert_ne!(j["meta"]["template"], "team:acme-retro");
    let (s, _) = call(
        "POST",
        format!("http://{addr}/v1/templates/undo?ticket={t}&applyId={apply_id}"),
    )
    .await;
    assert_eq!(s, 409);
    peer.settle().await;
    assert!(markdown(&json_of(&peer.doc)).contains("Keep me"));
}

#[tokio::test]
async fn markdown_templates_apply_and_twice_gets_fresh_ids() {
    let (addr, state, _) = serve(true).await;
    let t = ticket(&state, "u_a", Role::Edit).await;
    let (s, v) = call(
        "POST",
        format!("http://{addr}/v1/templates/acme-weekly/apply?ticket={t}"),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert!(markdown(&server_json(&state).await).contains("# Weekly"));
    for _ in 0..2 {
        let (s, _) = call(
            "POST",
            format!("http://{addr}/v1/templates/acme-retro/apply?ticket={t}"),
        )
        .await;
        assert_eq!(s, 200);
    }
    let j = server_json(&state).await;
    assert_eq!(
        j["databases"].as_object().unwrap().len(),
        2,
        "each apply gets its own database"
    );
}

#[tokio::test]
async fn oversized_invalid_and_missing_templates_are_refused() {
    let (addr, state, _) = serve(true).await;
    let t = ticket(&state, "u_a", Role::Edit).await;
    let before = markdown(&server_json(&state).await);
    for (id, status, code) in [
        ("big", 413, "TEMPLATE_TOO_LARGE"),
        ("bad", 422, "TEMPLATE_INVALID"),
        ("gone", 404, "TEMPLATE_NOT_FOUND"),
        ("a%2F..%2Fb", 404, "TEMPLATE_NOT_FOUND"),
    ] {
        let (s, v) = call(
            "POST",
            format!("http://{addr}/v1/templates/{id}/apply?ticket={t}"),
        )
        .await;
        assert_eq!(
            (s, v["error"]["code"].as_str()),
            (status, Some(code)),
            "{id}: {v}"
        );
    }
    assert_eq!(
        markdown(&server_json(&state).await),
        before,
        "nothing changed"
    );
}
