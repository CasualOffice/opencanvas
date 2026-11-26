// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Offline copies, server side (OFF-01/02/07, ADR-063/064, docs/34 §3): `[host.offline]`
//! checked at start-up, `perms.offline` and `offlineReason`, the ES256 offline grant in the
//! session answer, the generation number and the host-wide revoke per person, and the
//! `/v1/offline/clear` sign-out page. The server keeps a number per host and user, no content.
mod common;

use common::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_server::hosts::Hosts;
use serde_json::{Value, json};

const KEY: &str = "offline-key";

fn now() -> i64 {
    oc_server::util::now_secs()
}

fn on(h: &mut oc_server::hosts::HostConfig) {
    h.api_key = Some(KEY.into());
    h.flags.insert("api_v1".into(), toml::Value::Boolean(true));
    h.api
        .insert("rate_per_sec".into(), toml::Value::Integer(100_000));
    h.api.insert("burst".into(), toml::Value::Integer(100_000));
    h.offline = toml::from_str("enabled = true\ngrant_days = 7\nmax_role = \"comment\"").unwrap();
}

fn token(user: &str, extra: Value) -> String {
    let mut claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now() + 600,
        "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Sprint 42 planning", "version": "0"},
        "user": {"id": user, "name": "Priya Raman"},
        "role": "edit", "perms": {"export": true, "download": true, "comment": true},
        "callbackToken": format!("cb-{user}")
    });
    for (k, v) in extra.as_object().unwrap() {
        claims[k] = v.clone();
    }
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

/// Launches and returns the session answer.
async fn session(addr: &str, tok: String) -> Value {
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", tok)])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 303);
    let loc = res.headers()["location"].to_str().unwrap().to_string();
    let ticket = loc.split("#t=").nth(1).unwrap().split('&').next().unwrap();
    let res = http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

async fn revoke(addr: &str, key: &str, body: Value) -> (u16, Value) {
    let res = http()
        .post(format!("http://{addr}/api/v1/offline/revoke"))
        .header("x-opencanvas-host", "sample")
        .header("x-opencanvas-key", key)
        .json(&body)
        .send()
        .await
        .unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

async fn serve(
    tweak: impl FnOnce(&mut oc_server::hosts::HostConfig),
) -> (String, oc_server::SharedState, std::path::PathBuf) {
    let (base, _host) = mock_host().await;
    let db = temp_db();
    let state = app_custom(&base, room_cfg(), &db, tweak).await;
    (serve_state(state.clone()).await, state, db)
}

const HOSTS: &str = r#"
[[host]]
id = "acme"
name = "Acme"
jwt_secret = "s"
callback_base = "http://127.0.0.1:1"
"#;

/// OFF-01: `[host.offline]` is checked at start-up: unknown settings, out-of-range limits,
/// a bad `max_role`, and offline on a WOPI-only host (JWT hosts only in v0.3) stop the server.
#[test]
fn host_offline_is_checked_at_start_up() {
    let ok = format!("{HOSTS}[host.offline]\nenabled = true\ngrant_days = 30\nauto_recent = 3\n");
    Hosts::parse(&ok, None).unwrap();
    for (bad, why) in [
        ("grant_days = 31", "grant_days"),
        ("grant_days = 0", "grant_days"),
        ("max_role = \"admin\"", "max_role"),
        ("unsent_mb = 0", "unsent_mb"),
        ("max_mb = 9000", "max_mb"),
        ("cache = true", "no setting"),
        ("enabled = 1", "enabled"),
    ] {
        let src = format!("{HOSTS}[host.offline]\n{bad}\n");
        let err = format!("{:#}", Hosts::parse(&src, None).unwrap_err());
        assert!(err.contains(why), "{bad}: {err}");
    }
    let wopi = r#"
[[host]]
id = "nc"
name = "Nextcloud"
mode = "wopi"
wopi_allowlist = ["https://cloud.example"]
callback_base = "https://cloud.example"
[host.offline]
enabled = true
"#;
    let err = format!("{:#}", Hosts::parse(wopi, None).unwrap_err());
    assert!(err.contains("JWT host"), "{err}");
}

/// OFF-01: a host without `[host.offline]` says so in every session answer and mints nothing.
#[tokio::test]
async fn off_by_default() {
    let (addr, _st, _db) = serve(|_| {}).await;
    let s = session(&addr, token("u_1", json!({"perms": {"offline": true}}))).await;
    assert_eq!(
        s["offline"],
        json!({"enabled": false, "allowed": false}),
        "{s}"
    );
}

/// OFF-01: with the host on, `perms.offline` decides per launch; without it the answer says
/// why (`offlineReason`) and carries the generation but no grant.
#[tokio::test]
async fn perms_offline_decides_per_launch() {
    let (addr, _st, _db) = serve(on).await;
    let s = session(
        &addr,
        token("u_1", json!({"offlineReason": "shared-device"})),
    )
    .await;
    let o = &s["offline"];
    assert_eq!(o["enabled"], true, "{o}");
    assert_eq!(o["allowed"], false, "{o}");
    assert_eq!(o["reason"], "shared-device");
    assert_eq!(o["gen"], 0);
    assert!(o.get("grant").is_none(), "{o}");
    assert_eq!(o["limits"]["maxCanvases"], 50);
    assert_eq!(o["limits"]["maxMb"], 200);
    assert_eq!(o["limits"]["uploadsFiles"], 20);
    assert_eq!(o["limits"]["uploadsMb"], 50);
    assert_eq!(o["limits"]["unsentMb"], 5);
    let s = session(&addr, token("u_1", json!({}))).await;
    assert_eq!(s["offline"]["reason"], "not-allowed");
}

/// OFF-01 (ADR-063): the grant is an ES256 JWS over host, user, file, role (capped by
/// `max_role`), expiry (`grant_days`) and generation, verifiable with the JWK in the answer;
/// a changed claim fails.
#[tokio::test]
async fn the_grant_is_signed_and_capped() {
    let (addr, st, _db) = serve(on).await;
    let s = session(
        &addr,
        token("u_1", json!({"perms": {"offline": true, "download": true}})),
    )
    .await;
    let o = &s["offline"];
    assert_eq!(o["allowed"], true, "{o}");
    let jws = o["grant"].as_str().unwrap();
    let c = st.offline_key.verify(jws).expect("a valid grant");
    assert_eq!(c["host"], "sample");
    assert_eq!(c["sub"], "u_1");
    assert_eq!(c["file"], FILE);
    assert_eq!(c["role"], "comment", "edit capped by max_role = comment");
    assert_eq!(c["gen"], 0);
    let exp = c["exp"].as_i64().unwrap();
    assert!((exp - (now() + 7 * 86_400)).abs() < 60, "{exp}");
    assert_eq!(o["exp"], c["exp"]);
    assert_eq!(o["key"]["kty"], "EC");
    assert_eq!(o["key"]["crv"], "P-256");
    assert_eq!(o["key"], *st.offline_key.jwk());
    // A grant is not a credential anywhere: the session route answers by ticket only.
    let res = http()
        .get(format!("http://{addr}/v1/sessions/{jws}"))
        .send()
        .await
        .unwrap();
    assert_ne!(res.status(), 200);
    // Tampering breaks the signature.
    let mut parts: Vec<&str> = jws.split('.').collect();
    use base64::Engine;
    let forged = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(c.to_string().replace("\"comment\"", "\"edit\""));
    parts[1] = &forged;
    assert!(st.offline_key.verify(&parts.join(".")).is_none());
}

/// OFF-01 (ADR-064): `POST /api/v1/offline/revoke` raises the person's generation (host key
/// or `canvas:admin`); the next session answer, and the next grant, carry it. Other people
/// keep theirs.
#[tokio::test]
async fn revoke_raises_the_generation() {
    let (addr, st, _db) = serve(on).await;
    let (s, v) = revoke(&addr, KEY, json!({"userId": "u_1"})).await;
    assert_eq!((s, &v), (200, &json!({"gen": 1})));
    let (s, v) = revoke(&addr, KEY, json!({"userId": "u_1"})).await;
    assert_eq!((s, &v), (200, &json!({"gen": 2})));
    let o =
        session(&addr, token("u_1", json!({"perms": {"offline": true}}))).await["offline"].clone();
    assert_eq!(o["gen"], 2);
    assert_eq!(
        st.offline_key.verify(o["grant"].as_str().unwrap()).unwrap()["gen"],
        2
    );
    let o =
        session(&addr, token("u_2", json!({"perms": {"offline": true}}))).await["offline"].clone();
    assert_eq!(o["gen"], 0, "another person");
    // Wrong key, bad bodies.
    let (s, _) = revoke(&addr, "nope", json!({"userId": "u_1"})).await;
    assert_eq!(s, 401);
    let (s, v) = revoke(&addr, KEY, json!({"user": "u_1"})).await;
    assert_eq!((s, v["code"].as_str()), (400, Some("BAD_INPUT")));
    let (s, _) = revoke(&addr, KEY, json!({"userId": ""})).await;
    assert_eq!(s, 400);
    let (s, _) = revoke(&addr, KEY, json!({"userId": "u".repeat(256)})).await;
    assert_eq!(s, 400);
}

/// OFF-01: a user API token without `canvas:admin` cannot revoke.
#[tokio::test]
async fn revoke_needs_admin() {
    let (addr, _st, _db) = serve(|h| {
        on(h);
        h.api.insert(
            "audience".into(),
            toml::Value::String("https://oc.example".into()),
        );
    })
    .await;
    let t = encode(
        &Header::default(),
        &json!({"iss": "sample", "aud": "https://oc.example/api/v1", "sub": "u_9", "name": "Asha",
                "exp": now() + 600, "scope": "canvas:read canvas:write", "role": "edit"}),
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let res = http()
        .post(format!("http://{addr}/api/v1/offline/revoke"))
        .bearer_auth(t)
        .json(&json!({"userId": "u_1"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let v: Value = res.json().await.unwrap();
    assert_eq!(v["code"], "SCOPE_REQUIRED");
}

/// OFF-07: the sign-out page for a hidden iframe: a script from this origin (no inline script
/// under the CSP), framable by the host's own origins, naming the host and person; an unknown
/// host or a bad id is refused.
#[tokio::test]
async fn the_clear_page() {
    let (addr, _st, _db) = serve(on).await;
    let res = http()
        .get(format!(
            "http://{addr}/v1/offline/clear?host=sample&user=u_1"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let csp = res.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(csp.contains("script-src 'self'"), "{csp}");
    assert!(
        csp.contains("frame-ancestors 'self' http://localhost:4000"),
        "{csp}"
    );
    assert!(!csp.contains("unsafe-inline"), "{csp}");
    assert_eq!(res.headers()["cache-control"], "no-store");
    let html = res.text().await.unwrap();
    assert!(
        html.contains(r#"src="/v1/offline/clear.js" data-host="sample" data-user="u_1""#),
        "{html}"
    );
    let res = http()
        .get(format!("http://{addr}/v1/offline/clear.js"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/javascript")
    );
    let js = res.text().await.unwrap();
    assert!(js.contains("OC_OfflineCleared") && js.contains("deleteDatabase"));
    for q in ["host=nope", "", "host=sample&user=a%22b", "host=a%3Cb"] {
        let res = http()
            .get(format!("http://{addr}/v1/offline/clear?{q}"))
            .send()
            .await
            .unwrap();
        assert!(
            matches!(res.status().as_u16(), 400 | 404),
            "{q}: {}",
            res.status()
        );
    }
}

/// ADR-001: the only offline state on the server is the number; the database never holds a
/// title, a user name or a grant.
#[tokio::test]
async fn the_server_keeps_only_a_number() {
    let (addr, _st, db) = serve(on).await;
    let s = session(&addr, token("u_1", json!({"perms": {"offline": true}}))).await;
    let jws = s["offline"]["grant"].as_str().unwrap().to_string();
    revoke(&addr, KEY, json!({"userId": "u_1"})).await;
    let url = format!("sqlite://{}", db.display());
    sqlx::any::install_default_drivers();
    let pool = sqlx::AnyPool::connect(&url).await.unwrap();
    let rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT host_id, user_id, gen FROM offline_generation")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows, vec![("sample".into(), "u_1".into(), 1)]);
    pool.close().await;
    let mut bytes = std::fs::read(&db).unwrap();
    for ext in ["-wal", "-shm"] {
        if let Ok(b) = std::fs::read(format!("{}{ext}", db.display())) {
            bytes.extend(b);
        }
    }
    let sig = jws.rsplit('.').next().unwrap();
    assert!(
        !bytes.windows(sig.len()).any(|w| w == sig.as_bytes()),
        "no grant stored"
    );
}
