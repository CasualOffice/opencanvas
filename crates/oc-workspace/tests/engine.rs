// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The Workspace and the real engine in one process on one port, like the image (ADR-085 §2):
//! the launch, the callbacks with real signatures, the role API and a bot edit that the engine
//! loads from and saves to the Workspace.

use std::net::SocketAddr;

use oc_workspace::config::WsConfig;
use oc_workspace::secrets::Secrets;
use serde_json::{Value, json};

async fn start() -> (String, oc_workspace::Ws, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("ws-engine-{}", oc_workspace::util::token(8)));
    std::fs::create_dir_all(&dir).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = WsConfig::for_tests(&dir);
    cfg.bind = addr.to_string();
    cfg.engine_url = format!("http://{addr}");
    cfg.callback_base = format!("http://{addr}/api/ws/oc");
    let secrets = Secrets::for_tests();
    // SAFETY: this test binary runs one test; set before the engine reads its configuration.
    unsafe {
        std::env::set_var("OC_KEK", &secrets.kek_b64);
        std::env::set_var(
            "DATABASE_URL",
            format!("sqlite://{}/engine.db?mode=rwc", dir.display()),
        );
    }
    let mut ecfg = oc_server::config::Config::from_env().unwrap();
    ecfg.bind = addr.to_string();
    let hosts =
        oc_server::hosts::Hosts::parse(&oc_workspace::engine::host_toml(&cfg, &secrets, ""), None)
            .unwrap();
    let engine = oc_server::build(ecfg, hosts).await.unwrap();
    let ws = oc_workspace::WsState::new(cfg, secrets).await.unwrap();
    let app = oc_workspace::router(ws.clone()).fallback_service(oc_server::app(engine));
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (format!("http://{addr}"), ws, dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_and_engine_speak_the_contract() {
    let (base, ws, _dir) = start().await;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let h = |r: reqwest::RequestBuilder| r.header("x-requested-with", "opencanvas-workspace");
    // Both halves answer on one port.
    assert_eq!(
        http.get(format!("{base}/healthz"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        http.get(format!("{base}/api/ws/healthz"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "ok"
    );
    // Setup from the same machine needs no code.
    let st: Value = http
        .get(format!("{base}/api/ws/setup"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(st["codeRequired"], false);
    let r = h(http.post(format!("{base}/api/ws/setup")))
        .json(&json!({"orgName": "Acme", "adminName": "Priya Nair", "adminEmail": "priya@acme.example", "adminPassword": "plum orbit lantern", "workspaceName": "Product", "sample": false}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let cookie = r.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let home: Value = http
        .get(format!("{base}/api/ws/home"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let wid = home["workspaces"][0]["id"].as_str().unwrap().to_string();
    let c: Value = h(http.post(format!("{base}/api/ws/canvases")))
        .header("cookie", &cookie)
        .json(&json!({"workspaceId": wid, "name": "Launch"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cid = c["id"].as_str().unwrap().to_string();
    // Launch: our token, the engine's ticket.
    let l: Value = h(http.post(format!("{base}/api/ws/canvases/{cid}/launch")))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let r = http
        .post(format!("{base}/v1/launch"))
        .header("accept", "application/json")
        .form(&[("token", l["token"].as_str().unwrap())])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    let ticket = r.json::<Value>().await.unwrap()["ticket"]
        .as_str()
        .unwrap()
        .to_string();
    let s = http
        .get(format!("{base}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap();
    assert_eq!(s.status(), 200);
    let sess: Value = s.json().await.unwrap();
    assert_eq!(sess["role"], "edit", "{sess}");
    // The Workspace draws the file header, so the editor shows no top bar (FTY-03).
    assert_eq!(sess["editor"]["chrome"], "host", "{sess}");
    // A bot edit through the host API: the engine loads from us (new file) and saves to us with
    // a real v2 signature, which our save handler checks.
    let p = http
        .post(format!("{base}/v1/files/{cid}/patch"))
        .header("x-opencanvas-host", "workspace")
        .header("x-opencanvas-key", &ws.secrets.host_api_key)
        .json(&json!({"ops": [{"op": "append", "markdown": "# Launch\n\nThe zebra ships in January."}], "author": {"id": "bot", "name": "Bot"}}))
        .send()
        .await
        .unwrap();
    let pst = p.status();
    let pj: Value = p.json().await.unwrap();
    assert!(pst.is_success(), "{pst} {pj}");
    // Saved through the callback (now or by the room on its next commit).
    let commit = http
        .post(format!("{base}/v1/files/{cid}/commit"))
        .header("x-opencanvas-host", "workspace")
        .header("x-opencanvas-key", &ws.secrets.host_api_key)
        .send()
        .await
        .unwrap();
    assert!(
        commit.status().is_success(),
        "{}",
        commit.text().await.unwrap()
    );
    let card: Value = http
        .get(format!("{base}/api/ws/canvases/{cid}"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(card["canvas"]["version"].as_i64().unwrap() >= 1, "{card}");
    // The save carried search.json: the Workspace's search finds the text.
    let found: Value = http
        .get(format!("{base}/api/ws/search?q=zebra"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(found["items"][0]["fileId"], cid, "{found}");
    // The role API accepts the Workspace's key (revocation path, docs/05 §7).
    let r = http
        .post(format!("{base}/v1/files/{cid}/role"))
        .header("x-opencanvas-host", "workspace")
        .header("x-opencanvas-key", &ws.secrets.host_api_key)
        .json(&json!({"userId": "u_nobody", "role": "none"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    // The editor's "Search all canvases" goes through our signed search callback.
    let r = http
        .get(format!("{base}/v1/search?ticket={ticket}&q=zebra"))
        .send()
        .await
        .unwrap();
    let st = r.status();
    let body = r.text().await.unwrap();
    assert!(st.is_success() && body.contains(&cid), "{st} {body}");
}
