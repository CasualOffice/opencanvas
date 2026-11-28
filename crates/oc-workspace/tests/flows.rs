// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Workspace flows through the HTTP API and the signed callbacks, without the engine
//! (its role and session calls go nowhere and are logged). The engine round trip is in
//! `tests/engine.rs`.

use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use oc_workspace::config::WsConfig;
use oc_workspace::secrets::Secrets;
use oc_workspace::{Ws, WsState};
use serde_json::{Value, json};
use tower::ServiceExt;

struct T {
    app: Router,
    ws: Ws,
    _dir: std::path::PathBuf,
}

struct Res {
    status: StatusCode,
    cookie: Option<String>,
    json: Value,
    bytes: Vec<u8>,
}

impl T {
    async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("ws-flow-{}", oc_workspace::util::token(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let ws = WsState::new(WsConfig::for_tests(&dir), Secrets::for_tests())
            .await
            .unwrap();
        T {
            app: oc_workspace::router(ws.clone()),
            ws,
            _dir: dir,
        }
    }

    async fn req(
        &self,
        method: &str,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
        peer: &str,
    ) -> Res {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header("x-requested-with", "opencanvas-workspace")
            .header(header::HOST, "localhost");
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, format!("ws_session={c}"));
        }
        let body = match body {
            Some(v) => {
                b = b.header(header::CONTENT_TYPE, "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let mut r = b.body(body).unwrap();
        r.extensions_mut()
            .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        let res = self.app.clone().oneshot(r).await.unwrap();
        let status = res.status();
        let cookie = res
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("ws_session="))
            .map(|v| v.split(';').next().unwrap().to_string());
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 26)
            .await
            .unwrap()
            .to_vec();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Res {
            status,
            cookie,
            json,
            bytes,
        }
    }

    async fn get(&self, path: &str, c: &str) -> Res {
        self.req("GET", path, Some(c), None, "127.0.0.1:5000").await
    }
    async fn post(&self, path: &str, c: &str, body: Value) -> Res {
        self.req("POST", path, Some(c), Some(body), "127.0.0.1:5000")
            .await
    }
    async fn put(&self, path: &str, c: &str, body: Value) -> Res {
        self.req("PUT", path, Some(c), Some(body), "127.0.0.1:5000")
            .await
    }

    /// A signed callback from "the engine".
    async fn callback(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Vec<u8>,
        headers: &[(&str, &str)],
    ) -> Res {
        let sig = oc_workspace::engine::sign(&self.ws.secrets.host_secret, method, path, &body);
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header("x-opencanvas-signature", sig);
        if let Some(t) = token {
            b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let res = self
            .app
            .clone()
            .oneshot(b.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 26)
            .await
            .unwrap()
            .to_vec();
        Res {
            status,
            cookie: None,
            json: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            bytes,
        }
    }

    async fn setup(&self) -> String {
        let r = self
            .req(
                "POST",
                "/api/ws/setup",
                None,
                Some(json!({"orgName": "Acme", "adminName": "Priya Nair", "adminEmail": "priya@acme.example", "adminPassword": "plum orbit lantern", "workspaceName": "Product", "sample": true})),
                "127.0.0.1:5000",
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json);
        r.cookie.unwrap()
    }

    /// Invites someone to the organisation and signs them up; returns (cookie, user id).
    async fn member(&self, owner: &str, name: &str, email: &str, role: &str) -> (String, String) {
        let inv = self
            .post(
                "/api/ws/invites",
                owner,
                json!({"kind": "org", "role": role, "email": email}),
            )
            .await;
        assert_eq!(inv.status, StatusCode::OK, "{:?}", inv.json);
        let r = self
            .req("POST", "/api/ws/auth/signup", None, Some(json!({"invite": inv.json["token"], "name": name, "password": "quiet harbor seven"})), "10.1.1.1:1")
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json);
        (
            r.cookie.unwrap(),
            r.json["userId"].as_str().unwrap().to_string(),
        )
    }

    fn cb_token(&self, file: &str, user: &str) -> String {
        oc_workspace::engine::callback_token(&self.ws.secrets.token_key, file, user)
    }
}

fn ocanvas(title: &str, text: &str) -> Vec<u8> {
    use std::io::Write;
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("manifest.json", o).unwrap();
        z.write_all(b"{\"format\":1}").unwrap();
        z.start_file("search.json", o).unwrap();
        let sj = json!({"v": 1, "title": title, "blocks": [{"id": "b_1", "type": "paragraph", "path": ["Plan"], "text": text}], "databases": [], "boards": [], "truncated": false});
        z.write_all(sj.to_string().as_bytes()).unwrap();
        z.finish().unwrap();
    }
    buf.into_inner()
}

async fn product_ws(t: &T, c: &str) -> String {
    let home = t.get("/api/ws/home", c).await;
    home.json["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["name"] == "Product")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn setup_needs_the_code_from_afar_and_happens_once() {
    let t = T::new().await;
    let st = t
        .req("GET", "/api/ws/setup", None, None, "203.0.113.5:1")
        .await;
    assert_eq!(st.json["needsSetup"], true);
    assert_eq!(st.json["codeRequired"], true);
    let body = json!({"orgName": "Acme", "adminName": "P", "adminEmail": "p@acme.example", "adminPassword": "plum orbit lantern", "workspaceName": "Product", "code": "wrong words here at all"});
    let r = t
        .req(
            "POST",
            "/api/ws/setup",
            None,
            Some(body.clone()),
            "203.0.113.5:1",
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let code = t.ws.setup_code.lock().unwrap().clone().unwrap();
    let mut ok = body.clone();
    ok["code"] = json!(code.to_uppercase());
    let r = t
        .req(
            "POST",
            "/api/ws/setup",
            None,
            Some(ok.clone()),
            "203.0.113.5:1",
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json);
    let again = t
        .req("POST", "/api/ws/setup", None, Some(ok), "127.0.0.1:1")
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    // Loopback but behind a proxy still needs the code: X-Forwarded-For means "not this machine".
    assert!(t.ws.setup_code.lock().unwrap().is_none());
}

#[tokio::test]
async fn sign_in_lockout_and_csrf() {
    let t = T::new().await;
    let owner = t.setup().await;
    let me = t.get("/api/ws/me", &owner).await;
    assert_eq!(me.json["role"], "owner");
    assert_eq!(me.json["org"]["name"], "Acme");
    // A state change without the custom header is refused.
    let mut r = Request::builder()
        .method("POST")
        .uri("/api/ws/workspaces")
        .header(header::COOKIE, format!("ws_session={owner}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{\"name\":\"X\"}"))
        .unwrap();
    r.extensions_mut()
        .insert(ConnectInfo("127.0.0.1:1".parse::<SocketAddr>().unwrap()));
    assert_eq!(
        t.app.clone().oneshot(r).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    // Ten wrong passwords lock the account for 15 minutes, even with the right one.
    for i in 0..10 {
        let r = t
            .req(
                "POST",
                "/api/ws/auth/login",
                None,
                Some(json!({"email": "priya@acme.example", "password": "wrong wrong wrong"})),
                &format!("10.0.0.{}:1", i + 1),
            )
            .await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }
    let r = t
        .req(
            "POST",
            "/api/ws/auth/login",
            None,
            Some(json!({"email": "priya@acme.example", "password": "plum orbit lantern"})),
            "10.0.1.1:1",
        )
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // An unknown e-mail gets the same answer as a wrong password.
    let r = t
        .req(
            "POST",
            "/api/ws/auth/login",
            None,
            Some(json!({"email": "nobody@acme.example", "password": "x"})),
            "10.0.2.1:1",
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // Sign out ends the session.
    let out = t.post("/api/ws/auth/logout", &owner, json!({})).await;
    assert_eq!(out.status, StatusCode::OK);
    assert_eq!(
        t.get("/api/ws/me", &owner).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn invites_are_single_use_and_guests_see_only_what_is_shared() {
    let t = T::new().await;
    let owner = t.setup().await;
    let wid = product_ws(&t, &owner).await;
    let c = t
        .post(
            "/api/ws/canvases",
            &owner,
            json!({"workspaceId": wid, "name": "Q1 launch plan"}),
        )
        .await;
    assert_eq!(c.status, StatusCode::CREATED);
    let cid = c.json["id"].as_str().unwrap().to_string();
    let secret = t
        .post(
            "/api/ws/canvases",
            &owner,
            json!({"workspaceId": wid, "name": "Secret plan", "type": "spreadsheet"}),
        )
        .await;
    let sid = secret.json["id"].as_str().unwrap().to_string();
    assert_eq!(secret.json["type"], "spreadsheet");
    // A canvas invite makes a guest with access to that canvas only.
    let inv = t
        .post(
            "/api/ws/invites",
            &owner,
            json!({"kind": "canvas", "targetId": cid, "role": "comment"}),
        )
        .await;
    let token = inv.json["token"].as_str().unwrap().to_string();
    let preview = t
        .req(
            "GET",
            &format!("/api/ws/invites/{token}"),
            None,
            None,
            "10.0.0.1:1",
        )
        .await;
    assert_eq!(preview.json["invitedBy"], "Priya Nair");
    assert_eq!(preview.json["targetName"], "Q1 launch plan");
    let g = t.req("POST", "/api/ws/auth/signup", None, Some(json!({"invite": token, "name": "Mei Chen", "email": "mei@partner.example", "password": "quiet harbor seven"})), "10.0.0.1:1").await;
    assert_eq!(g.status, StatusCode::OK, "{:?}", g.json);
    let guest = g.cookie.unwrap();
    let again = t.req("POST", "/api/ws/auth/signup", None, Some(json!({"invite": token, "name": "X", "email": "x@partner.example", "password": "quiet harbor seven"})), "10.0.0.1:1").await;
    assert_eq!(again.status, StatusCode::GONE);
    assert_eq!(t.get("/api/ws/me", &guest).await.json["role"], "guest");
    assert_eq!(
        t.get(&format!("/api/ws/canvases/{cid}"), &guest).await.json["role"],
        "comment"
    );
    // Not a 403 that leaks the title: a 404.
    let other = t.get(&format!("/api/ws/canvases/{sid}"), &guest).await;
    assert_eq!(other.status, StatusCode::NOT_FOUND);
    assert!(!String::from_utf8_lossy(&other.bytes).contains("Secret"));
    // An organisation link does not reach guests.
    t.put(
        &format!("/api/ws/canvases/{sid}/link"),
        &owner,
        json!({"access": "org", "role": "view"}),
    )
    .await;
    assert_eq!(
        t.get(&format!("/api/ws/canvases/{sid}"), &guest)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.get("/api/ws/people?q=", &guest).await.status,
        StatusCode::FORBIDDEN
    );
    // But a member sees it through the org link.
    let (lena, _) = t
        .member(&owner, "Lena Park", "lena@acme.example", "member")
        .await;
    assert_eq!(
        t.get(&format!("/api/ws/canvases/{sid}"), &lena).await.json["role"],
        "view"
    );
}

#[tokio::test]
async fn saves_version_index_and_search_respects_access() {
    let t = T::new().await;
    let owner = t.setup().await;
    let wid = product_ws(&t, &owner).await;
    let me = t.get("/api/ws/me", &owner).await.json["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (lena, lena_id) = t
        .member(&owner, "Lena Park", "lena@acme.example", "member")
        .await;
    let a = t
        .post(
            "/api/ws/canvases",
            &owner,
            json!({"workspaceId": wid, "name": "Launch"}),
        )
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Load of a new file: 404 = a new empty canvas.
    let tok = t.cb_token(&a, &me);
    let r = t
        .callback(
            "GET",
            &format!("/api/ws/oc/files/{a}"),
            Some(&tok),
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // A bad signature is refused.
    let mut bad = Request::builder()
        .method("GET")
        .uri(format!("/api/ws/oc/files/{a}"))
        .header(header::AUTHORIZATION, format!("Bearer {tok}"))
        .header("x-opencanvas-signature", "t=1,v2=00")
        .body(Body::empty())
        .unwrap();
    bad.extensions_mut()
        .insert(ConnectInfo("127.0.0.1:1".parse::<SocketAddr>().unwrap()));
    assert_eq!(
        t.app.clone().oneshot(bad).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    // Save v1, then a stale If-Match is a 409.
    let body = ocanvas("Launch", "We launch the Workspace beta in January");
    let r = t
        .callback(
            "PUT",
            &format!("/api/ws/oc/files/{a}"),
            Some(&tok),
            body.clone(),
            &[
                ("if-match", "\"0\""),
                ("idempotency-key", "k1"),
                ("x-opencanvas-autosave", "1"),
                ("x-opencanvas-authors", &format!("[\"{me}\"]")),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json);
    assert_eq!(r.json["version"], "1");
    let again = t
        .callback(
            "PUT",
            &format!("/api/ws/oc/files/{a}"),
            Some(&tok),
            body.clone(),
            &[("if-match", "\"0\""), ("idempotency-key", "k1")],
        )
        .await;
    assert_eq!(
        again.json["version"], "1",
        "same Idempotency-Key, same answer"
    );
    let stale = t
        .callback(
            "PUT",
            &format!("/api/ws/oc/files/{a}"),
            Some(&tok),
            body.clone(),
            &[("if-match", "\"0\""), ("idempotency-key", "k2")],
        )
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    assert_eq!(stale.json["version"], "1");
    // A named version.
    let r = t
        .callback(
            "PUT",
            &format!("/api/ws/oc/files/{a}"),
            Some(&tok),
            body.clone(),
            &[
                ("if-match", "\"1\""),
                ("x-opencanvas-autosave", "0"),
                ("x-opencanvas-commit-message", "Before%20review"),
            ],
        )
        .await;
    assert_eq!(r.json["version"], "2");
    let load = t
        .callback(
            "GET",
            &format!("/api/ws/oc/files/{a}"),
            Some(&tok),
            vec![],
            &[],
        )
        .await;
    assert_eq!(load.status, StatusCode::OK);
    assert_eq!(load.bytes, body, "byte-identical .ocanvas");
    let vs = t
        .callback(
            "GET",
            &format!("/api/ws/oc/files/{a}/versions"),
            Some(&tok),
            vec![],
            &[],
        )
        .await;
    assert_eq!(vs.json["versions"][0]["version"], "2");
    assert_eq!(vs.json["versions"][0]["kind"], "named");
    assert_eq!(vs.json["versions"][0]["name"], "Before review");
    let v1 = t
        .callback(
            "GET",
            &format!("/api/ws/oc/files/{a}/versions/1"),
            Some(&tok),
            vec![],
            &[],
        )
        .await;
    assert_eq!(v1.bytes, body);
    // Search: the owner finds it at the block; Lena (member, not in the private canvas) does not.
    let s = t.get("/api/ws/search?q=launch%20beta", &owner).await;
    assert_eq!(s.json["items"][0]["fileId"], a);
    assert_eq!(s.json["items"][0]["blockId"], "b_1");
    let s = t.get("/api/ws/search?q=beta", &lena).await;
    assert_eq!(
        s.json["items"].as_array().unwrap().len(),
        0,
        "never a canvas they cannot open"
    );
    // The engine's search callback answers for a user id it signs.
    let s = t
        .callback(
            "GET",
            &format!("/api/ws/oc/search?q=beta&userId={lena_id}"),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(s.json["items"].as_array().unwrap().len(), 0);
    // Share with Lena: now she finds it and her callback token works.
    let sh = t
        .put(
            &format!("/api/ws/canvases/{a}/shares"),
            &owner,
            json!({"principalKind": "user", "principalId": lena_id, "role": "view"}),
        )
        .await;
    assert_eq!(sh.status, StatusCode::OK, "{:?}", sh.json);
    assert_eq!(
        t.get("/api/ws/search?q=beta", &lena).await.json["items"][0]["fileId"],
        a
    );
    // A viewer cannot save.
    let lt = t.cb_token(&a, &lena_id);
    let r = t
        .callback(
            "PUT",
            &format!("/api/ws/oc/files/{a}"),
            Some(&lt),
            body.clone(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // Members callback: everyone with access, never e-mail.
    let m = t
        .callback(
            "GET",
            &format!("/api/ws/oc/files/{a}/members"),
            Some(&lt),
            vec![],
            &[],
        )
        .await;
    let names: Vec<&str> = m
        .json
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Lena Park", "Priya Nair"]);
    assert!(!String::from_utf8_lossy(&m.bytes).contains('@'));
}

#[tokio::test]
async fn trash_restore_and_purge() {
    let t = T::new().await;
    let owner = t.setup().await;
    let wid = product_ws(&t, &owner).await;
    let me = t.get("/api/ws/me", &owner).await.json["id"]
        .as_str()
        .unwrap()
        .to_string();
    let f = t
        .post(
            "/api/ws/folders",
            &owner,
            json!({"workspaceId": wid, "name": "Roadmaps"}),
        )
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();
    let a = t
        .post(
            "/api/ws/canvases",
            &owner,
            json!({"workspaceId": wid, "folderId": f, "name": "Plan"}),
        )
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();
    let tok = t.cb_token(&a, &me);
    let body = ocanvas("Plan", "unique zebra words");
    t.callback(
        "PUT",
        &format!("/api/ws/oc/files/{a}"),
        Some(&tok),
        body.clone(),
        &[],
    )
    .await;
    // Delete the folder: the canvas goes with it, and is gone from lists and search.
    let d = t
        .req(
            "DELETE",
            &format!("/api/ws/folders/{f}"),
            Some(&owner),
            None,
            "127.0.0.1:1",
        )
        .await;
    assert_eq!(d.status, StatusCode::NO_CONTENT);
    assert_eq!(
        t.get(&format!("/api/ws/canvases/{a}"), &owner).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.get("/api/ws/search?q=zebra", &owner).await.json["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let r = t
        .callback(
            "GET",
            &format!("/api/ws/oc/files/{a}"),
            Some(&tok),
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::GONE);
    let tr = t.get("/api/ws/trash", &owner).await;
    let items = tr.json["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "the folder lists once: {items:?}");
    assert_eq!(items[0]["kind"], "folder");
    assert_eq!(items[0]["files"], 1);
    // Restore puts both back, with history.
    let r = t
        .post(
            &format!("/api/ws/trash/folder/{f}/restore"),
            &owner,
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let c = t.get(&format!("/api/ws/canvases/{a}"), &owner).await;
    assert_eq!(c.json["canvas"]["folderId"], f);
    assert_eq!(
        t.callback(
            "GET",
            &format!("/api/ws/oc/files/{a}"),
            Some(&tok),
            vec![],
            &[]
        )
        .await
        .bytes,
        body
    );
    // Trash the canvas alone and let the retention job purge it: files leave the disk.
    t.req(
        "DELETE",
        &format!("/api/ws/canvases/{a}"),
        Some(&owner),
        None,
        "127.0.0.1:1",
    )
    .await;
    assert!(t.ws.files.canvas_dir_exists(&a));
    let report = oc_workspace::jobs::sweep(&t.ws, oc_workspace::util::now_ms() + 31 * 86_400_000)
        .await
        .unwrap();
    assert_eq!(report.purged, 1);
    assert!(!t.ws.files.canvas_dir_exists(&a));
    // 31 days on, the canvas row is gone too (and the 30-day session with it).
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM canvases WHERE id = ?")
        .bind(&a)
        .fetch_one(&t.ws.db.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn public_links_follow_the_admin_settings() {
    let t = T::new().await;
    let owner = t.setup().await;
    let wid = product_ws(&t, &owner).await;
    let a = t
        .post(
            "/api/ws/canvases",
            &owner,
            json!({"workspaceId": wid, "name": "Public notes"}),
        )
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Off by default.
    let r = t
        .put(
            &format!("/api/ws/canvases/{a}/link"),
            &owner,
            json!({"access": "public", "role": "view"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let mut s = t.get("/api/ws/admin/settings", &owner).await.json["settings"].clone();
    s["publicLinks"]["allowed"] = json!(true);
    s["publicLinks"]["maxRole"] = json!("comment");
    assert_eq!(
        t.put("/api/ws/admin/settings", &owner, s.clone())
            .await
            .status,
        StatusCode::OK
    );
    // Above the admin's maximum: refused.
    let r = t
        .put(
            &format!("/api/ws/canvases/{a}/link"),
            &owner,
            json!({"access": "public", "role": "edit"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t.put(&format!("/api/ws/canvases/{a}/link"), &owner, json!({"access": "public", "role": "comment", "password": "open sesame", "expiresDays": 7})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json);
    let url = t
        .get(&format!("/api/ws/canvases/{a}/shares"), &owner)
        .await
        .json["link"]["url"]
        .as_str()
        .unwrap()
        .to_string();
    let token = url.rsplit('/').next().unwrap().to_string();
    let info = t
        .req(
            "GET",
            &format!("/api/ws/links/{token}"),
            None,
            None,
            "198.51.100.1:1",
        )
        .await;
    assert_eq!(info.json["needsPassword"], true);
    assert_eq!(info.json["role"], "comment");
    let wrong = t
        .req(
            "POST",
            &format!("/api/ws/links/{token}/open"),
            None,
            Some(json!({"password": "nope"})),
            "198.51.100.1:1",
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let open = t
        .req(
            "POST",
            &format!("/api/ws/links/{token}/open"),
            None,
            Some(json!({"password": "open sesame", "name": "Sam"})),
            "198.51.100.1:1",
        )
        .await;
    assert_eq!(open.status, StatusCode::OK);
    assert_eq!(open.json["role"], "comment");
    // Lowering the admin maximum lowers live links at once.
    s["publicLinks"]["maxRole"] = json!("view");
    t.put("/api/ws/admin/settings", &owner, s.clone()).await;
    assert_eq!(
        t.req(
            "GET",
            &format!("/api/ws/links/{token}"),
            None,
            None,
            "198.51.100.1:1"
        )
        .await
        .json["role"],
        "view"
    );
    // Turning public links off ends every link.
    s["publicLinks"]["allowed"] = json!(false);
    t.put("/api/ws/admin/settings", &owner, s).await;
    assert_eq!(
        t.req(
            "GET",
            &format!("/api/ws/links/{token}"),
            None,
            None,
            "198.51.100.1:1"
        )
        .await
        .status,
        StatusCode::GONE
    );
}

#[tokio::test]
async fn sharing_roles_teams_and_inheritance() {
    let t = T::new().await;
    let owner = t.setup().await;
    let wid = product_ws(&t, &owner).await;
    let (lena, lena_id) = t
        .member(&owner, "Lena Park", "lena@acme.example", "member")
        .await;
    let f = t
        .post(
            "/api/ws/folders",
            &owner,
            json!({"workspaceId": wid, "name": "Specs"}),
        )
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();
    let a = t
        .post(
            "/api/ws/canvases",
            &owner,
            json!({"workspaceId": wid, "folderId": f, "name": "Spec"}),
        )
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        t.get(&format!("/api/ws/canvases/{a}"), &lena).await.status,
        StatusCode::NOT_FOUND
    );
    // A team share on the folder reaches the canvas inside.
    let team = t
        .post("/api/ws/admin/teams", &owner, json!({"name": "Design"}))
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();
    t.put(
        &format!("/api/ws/admin/teams/{team}/members/{lena_id}"),
        &owner,
        json!({}),
    )
    .await;
    let r = t
        .put(
            &format!("/api/ws/folders/{f}/shares"),
            &owner,
            json!({"principalKind": "team", "principalId": team, "role": "edit"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        t.get(&format!("/api/ws/canvases/{a}"), &lena).await.json["role"],
        "edit"
    );
    let sh = t.get(&format!("/api/ws/canvases/{a}/shares"), &owner).await;
    assert!(
        sh.json["inherited"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["from"] == "the Specs folder" && g["grant"]["name"] == "Design")
    );
    // Editors can't share; Full access can.
    let r = t
        .put(
            &format!("/api/ws/canvases/{a}/shares"),
            &lena,
            json!({"principalKind": "user", "principalId": lena_id, "role": "full"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // Removing the team member removes the access.
    t.req(
        "DELETE",
        &format!("/api/ws/admin/teams/{team}/members/{lena_id}"),
        Some(&owner),
        None,
        "127.0.0.1:1",
    )
    .await;
    assert_eq!(
        t.get(&format!("/api/ws/canvases/{a}"), &lena).await.status,
        StatusCode::NOT_FOUND
    );
    // Suspension signs out at once; the last Owner can't be demoted.
    let me = t.get("/api/ws/me", &owner).await.json["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = t
        .req(
            "PATCH",
            &format!("/api/ws/admin/users/{me}"),
            Some(&owner),
            Some(json!({"role": "member"})),
            "127.0.0.1:1",
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    t.req(
        "PATCH",
        &format!("/api/ws/admin/users/{lena_id}"),
        Some(&owner),
        Some(json!({"status": "suspended"})),
        "127.0.0.1:1",
    )
    .await;
    assert_eq!(
        t.get("/api/ws/me", &lena).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn admin_reset_link_works_once_and_signs_everyone_out() {
    let t = T::new().await;
    let owner = t.setup().await;
    let (lena, lena_id) = t
        .member(&owner, "Lena Park", "lena@acme.example", "member")
        .await;
    let link = t
        .post(
            &format!("/api/ws/admin/users/{lena_id}/reset-link"),
            &owner,
            json!({}),
        )
        .await;
    let token = link.json["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    let r = t
        .req(
            "POST",
            "/api/ws/auth/reset",
            None,
            Some(json!({"token": token, "password": "new lantern valley"})),
            "10.0.0.9:1",
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        t.get("/api/ws/me", &lena).await.status,
        StatusCode::UNAUTHORIZED
    );
    let again = t
        .req(
            "POST",
            "/api/ws/auth/reset",
            None,
            Some(json!({"token": token, "password": "another lantern valley"})),
            "10.0.0.9:1",
        )
        .await;
    assert_eq!(again.status, StatusCode::GONE);
    let login = t
        .req(
            "POST",
            "/api/ws/auth/login",
            None,
            Some(json!({"email": "lena@acme.example", "password": "new lantern valley"})),
            "10.0.0.9:1",
        )
        .await;
    assert_eq!(login.status, StatusCode::OK);
}

#[tokio::test]
async fn sample_content_and_routes_stay_in_their_lane() {
    let t = T::new().await;
    let owner = t.setup().await;
    let home = t.get("/api/ws/home", &owner).await;
    let names: Vec<&str> = home.json["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Product", "Welcome", "My canvases"]);
    let welcome = home.json["workspaces"][1]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let list = t
        .get(&format!("/api/ws/canvases?workspace={welcome}"), &owner)
        .await;
    assert_eq!(list.json["canvases"].as_array().unwrap().len(), 3);
    // Sample files load as Markdown until their first save.
    let me = t.get("/api/ws/me", &owner).await.json["id"]
        .as_str()
        .unwrap()
        .to_string();
    let cid = list.json["canvases"][0]["id"].as_str().unwrap().to_string();
    let r = t
        .callback(
            "GET",
            &format!("/api/ws/oc/files/{cid}"),
            Some(&t.cb_token(&cid, &me)),
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(String::from_utf8_lossy(&r.bytes).starts_with("# "));
    // The Workspace answers only its own paths (docs/40 §8).
    for p in ["/", "/ws/", "/api/ws/healthz", "/api/ws/oc/files/x"] {
        assert!(oc_workspace::owns_path(p), "{p}");
    }
    for p in [
        "/app/",
        "/v1/launch",
        "/healthz",
        "/api/v1/files",
        "/mcp/workspace",
        "/wsx",
        "/api/wsx",
    ] {
        assert!(!oc_workspace::owns_path(p), "{p}");
    }
}
