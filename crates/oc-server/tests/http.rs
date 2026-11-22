mod common;

use std::time::Duration;

use common::*;
use futures::{SinkExt, StreamExt};
use jsonwebtoken::{EncodingKey, Header, encode};
use oc_server::room::protocol;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{Doc, ReadTxn, Transact, Update, Xml, XmlFragment, XmlTextPrelim};

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn token(role: &str) -> String {
    let claims = json!({
        "iss": "sample", "aud": "opencanvas", "exp": now() + 600, "jti": ulid::Ulid::new().to_string(),
        "file": {"id": FILE, "name": "Doc one", "version": "0"},
        "user": {"id": "u_1", "name": "Asha Rao"},
        "role": role, "perms": {"export": true, "download": true, "comment": true},
        "callbackToken": "cb-u_1"
    });
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

async fn serve(base: &str) -> String {
    let state = app(base, room_cfg()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, oc_server::router(state))
            .await
            .unwrap()
    });
    format!("127.0.0.1:{}", addr.port())
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

async fn launch(addr: &str, tok: &str) -> reqwest::Response {
    http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", tok)])
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn launch_session_websocket_and_export() {
    let (base, host) = mock_host().await;
    let addr = serve(&base).await;
    let client = http();

    assert_eq!(
        client
            .get(format!("http://{addr}/healthz"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    let tok = token("edit");
    let res = launch(&addr, &tok).await;
    assert_eq!(res.status(), 303);
    let loc = res.headers()["location"].to_str().unwrap().to_string();
    let ticket = loc
        .strip_prefix("/app/#t=")
        .expect("ticket in fragment")
        .to_string();
    let csp = res.headers()["content-security-policy"].to_str().unwrap();
    assert!(
        csp.ends_with("; frame-ancestors 'self' http://localhost:4000"),
        "{csp}"
    );

    let reused = launch(&addr, &tok).await;
    assert_eq!(reused.status(), 401);
    assert_eq!(
        reused.json::<Value>().await.unwrap()["error"]["code"],
        "TOKEN_REUSED"
    );
    let mut bad = tok.clone();
    bad.push('x');
    assert_eq!(launch(&addr, &bad).await.status(), 401);

    let s: Value = client
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(s["role"], "edit");
    assert_eq!(s["isNew"], true);
    assert_eq!(s["user"]["name"], "Asha Rao");
    assert_eq!(s["file"]["name"], "Doc one");
    assert_eq!(s["host"]["id"], "sample");
    assert_eq!(s["wsUrl"], format!("ws://{addr}/v1/collab"));
    let room = s["room"].as_str().unwrap().to_string();
    let missing = client
        .get(format!("http://{addr}/v1/sessions/nope"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 401);
    assert_eq!(
        missing.json::<Value>().await.unwrap()["error"]["code"],
        "TICKET_INVALID"
    );

    // WebSocket with the y-websocket URL shape: {wsUrl}/{room}?ticket=
    let (mut ws, _) =
        tokio_tungstenite::connect_async(format!("ws://{addr}/v1/collab/{room}?ticket={ticket}"))
            .await
            .unwrap();
    let doc = Doc::new();
    ws.send(WsMessage::Binary(
        protocol::step1(doc.transact().state_vector()).into(),
    ))
    .await
    .unwrap();
    let mut controls = Vec::new();
    while let Ok(Some(Ok(WsMessage::Binary(data)))) =
        tokio::time::timeout(Duration::from_millis(300), ws.next()).await
    {
        let mut d = DecoderV1::new(Cursor::new(&data));
        for m in MessageReader::new(&mut d)
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        {
            match m {
                Message::Sync(SyncMessage::SyncStep1(sv)) => {
                    let diff = doc.transact().encode_state_as_update_v1(&sv);
                    ws.send(WsMessage::Binary(protocol::step2(diff).into()))
                        .await
                        .unwrap();
                }
                Message::Sync(SyncMessage::SyncStep2(u)) => doc
                    .transact_mut()
                    .apply_update(Update::decode_v1(&u).unwrap())
                    .unwrap(),
                Message::Custom(100, b) => {
                    controls.push(serde_json::from_slice::<Value>(&b).unwrap())
                }
                _ => {}
            }
        }
    }
    assert!(controls.iter().any(|c| c["t"] == "role"), "{controls:?}");

    let sv = doc.transact().state_vector();
    {
        let content = doc.get_or_insert_xml_fragment("content");
        let mut txn = doc.transact_mut();
        let p = content.push_back(&mut txn, yrs::XmlElementPrelim::empty("heading"));
        p.insert_attribute(&mut txn, "level", 2);
        p.push_back(&mut txn, XmlTextPrelim::new("Over the wire"));
    }
    let update = doc.transact().encode_state_as_update_v1(&sv);
    ws.send(WsMessage::Binary(protocol::update(update).into()))
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(200)).await;
    let md = client
        .get(format!("http://{addr}/v1/export/md?ticket={ticket}"))
        .send()
        .await
        .unwrap();
    assert_eq!(md.status(), 200);
    assert!(
        md.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("Doc one.md")
    );
    assert_eq!(md.text().await.unwrap(), "## Over the wire\n");
    let html = client
        .get(format!("http://{addr}/v1/export/html?ticket={ticket}"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(html.contains("<h2>Over the wire</h2>"));
    let oc = client
        .get(format!("http://{addr}/v1/export/ocanvas?ticket={ticket}"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(oc_model::read_ocanvas(&oc).is_ok());
    let pdf = client
        .get(format!("http://{addr}/v1/export/pdf?ticket={ticket}"))
        .send()
        .await
        .unwrap();
    assert_eq!(pdf.status(), 501, "no PDF renderer configured");
    let rtf = client
        .get(format!("http://{addr}/v1/export/rtf?ticket={ticket}"))
        .send()
        .await
        .unwrap();
    assert_eq!(rtf.status(), 404);

    host.lock().unwrap().members = Some(serde_json::json!([{"id": "u_1", "name": "Asha Rao"}]));
    let members: Value = client
        .get(format!("http://{addr}/v1/members?ticket={ticket}&q=as"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(members["members"][0]["name"], "Asha Rao");

    // An oversized frame closes the socket with 1009.
    let big = vec![0u8; 1024 * 1024 + 10];
    ws.send(WsMessage::Binary(big.into())).await.unwrap();
    let closed = loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(WsMessage::Close(Some(f))))) => break Some(u16::from(f.code)),
            Ok(Some(Ok(_))) => continue,
            _ => break None,
        }
    };
    assert_eq!(closed, Some(1009));
    assert!(host.lock().unwrap().puts.is_empty());
}

#[tokio::test]
async fn websocket_rejects_wrong_room_and_bad_ticket() {
    let (base, _host) = mock_host().await;
    let addr = serve(&base).await;
    let res = launch(&addr, &token("view")).await;
    let ticket = res.headers()["location"]
        .to_str()
        .unwrap()
        .trim_start_matches("/app/#t=")
        .to_string();
    assert!(
        tokio_tungstenite::connect_async(format!("ws://{addr}/v1/collab/r_other?ticket={ticket}"))
            .await
            .is_err()
    );
    assert!(
        tokio_tungstenite::connect_async(format!("ws://{addr}/v1/collab/r_x?ticket=bogus"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn frame_flood_closes_the_socket_with_4429() {
    let (base, _host) = mock_host().await;
    let addr = serve(&base).await;
    let loc = launch(&addr, &token("edit")).await.headers()["location"]
        .to_str()
        .unwrap()
        .to_string();
    let ticket = loc.trim_start_matches("/app/#t=").to_string();
    let s: Value = http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let room = s["room"].as_str().unwrap();
    let (mut ws, _) =
        tokio_tungstenite::connect_async(format!("ws://{addr}/v1/collab/{room}?ticket={ticket}"))
            .await
            .unwrap();
    // 200 frames at once: more than the burst of 120 (refill 60/s).
    for _ in 0..200 {
        if ws.send(WsMessage::Binary(vec![3u8].into())).await.is_err() {
            break;
        }
    }
    let closed = loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(WsMessage::Close(Some(f))))) => break Some(u16::from(f.code)),
            Ok(Some(Ok(_))) => continue,
            _ => break None,
        }
    };
    assert_eq!(closed, Some(4429), "rate limit has its own close code");
}

/// Fast typing: one update plus one awareness (caret) frame per keystroke, 150 keystrokes in
/// about 2 s. Awareness has its own bucket, so this must not trip the rate limit.
#[tokio::test]
async fn fast_typing_with_awareness_is_not_rate_limited() {
    let (base, _host) = mock_host().await;
    let addr = serve(&base).await;
    let loc = launch(&addr, &token("edit")).await.headers()["location"]
        .to_str()
        .unwrap()
        .to_string();
    let ticket = loc.trim_start_matches("/app/#t=").to_string();
    let s: Value = http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let room = s["room"].as_str().unwrap();
    let (ws, _) =
        tokio_tungstenite::connect_async(format!("ws://{addr}/v1/collab/{room}?ticket={ticket}"))
            .await
            .unwrap();
    let (mut sink, mut stream) = ws.split();
    // Drain server frames in the background; report a close code if one arrives.
    let closed = tokio::spawn(async move {
        while let Some(Ok(m)) = stream.next().await {
            if let WsMessage::Close(f) = m {
                return f.map(|f| u16::from(f.code));
            }
        }
        None
    });
    let doc = Doc::new();
    let text = {
        let content = doc.get_or_insert_xml_fragment("content");
        let mut txn = doc.transact_mut();
        content.push_back(&mut txn, XmlTextPrelim::new(""))
    };
    for i in 0..150u32 {
        let sv = doc.transact().state_vector();
        yrs::Text::push(&text, &mut doc.transact_mut(), "x");
        let update = doc.transact().encode_state_as_update_v1(&sv);
        sink.send(WsMessage::Binary(protocol::update(update).into()))
            .await
            .unwrap();
        // Raw awareness frame: [type 1, len, {count 1, client 42, clock, varString json}].
        let json = format!("{{\"cursor\":{}}}", i % 10);
        let mut payload = vec![1u8, 42, (i % 120) as u8 + 1, json.len() as u8];
        payload.extend_from_slice(json.as_bytes());
        let mut frame = vec![1u8, payload.len() as u8];
        frame.extend(payload);
        sink.send(WsMessage::Binary(frame.into())).await.unwrap();
        tokio::time::sleep(Duration::from_micros(13_300)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!closed.is_finished(), "socket closed: {:?}", closed.await);
}

#[tokio::test]
async fn readyz_reports_unavailable_while_draining() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = state.clone();
    tokio::spawn(async move {
        axum::serve(listener, oc_server::router(served))
            .await
            .unwrap()
    });
    let url = format!("http://127.0.0.1:{}/readyz", addr.port());

    let ready = http().get(&url).send().await.unwrap();
    assert_eq!(ready.status(), 200);

    // SIGTERM path: load balancers must stop routing new users here before rooms are handed off.
    state.rooms.shutdown_all().await;
    let draining = http().get(&url).send().await.unwrap();
    assert_eq!(draining.status(), 503);
    let body: Value = draining.json().await.unwrap();
    assert_eq!(body["draining"], true);
}

/// docs/22 §8 weakness 7: a draining node refuses the WebSocket upgrade itself (HTTP 503 with
/// `Retry-After`) instead of accepting it and closing it, so clients go to another node.
#[tokio::test]
async fn draining_node_refuses_websocket_upgrades_with_503() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let addr = serve_state(state.clone()).await;
    let res = launch(&addr, &token("edit")).await;
    let loc = res.headers()["location"].to_str().unwrap().to_string();
    let ticket = loc.strip_prefix("/app/#t=").unwrap().to_string();
    let s: Value = http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let room = s["room"].as_str().unwrap().to_string();

    state.rooms.shutdown_all().await;
    let err =
        tokio_tungstenite::connect_async(format!("ws://{addr}/v1/collab/{room}?ticket={ticket}"))
            .await
            .expect_err("a draining node must not accept the upgrade");
    let tokio_tungstenite::tungstenite::Error::Http(res) = err else {
        panic!("expected an HTTP refusal, got {err:?}");
    };
    assert_eq!(res.status(), 503);
    assert!(
        res.headers().get("retry-after").is_some(),
        "{:?}",
        res.headers()
    );
}

/// UX-02: a launch may name a block to open at (`block` form field or query); it travels in
/// the app fragment next to the ticket. Anything that is not a plain id is dropped.
#[tokio::test]
async fn launch_carries_a_block_to_open_at() {
    let (base, _host) = mock_host().await;
    let addr = serve(&base).await;
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", token("edit").as_str()), ("block", "b_01jdx")])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 303);
    let loc = res.headers()["location"].to_str().unwrap();
    assert!(
        loc.starts_with("/app/#t=") && loc.ends_with("&block=b_01jdx"),
        "{loc}"
    );
    let res = http()
        .post(format!("http://{addr}/v1/launch?block=b_q"))
        .form(&[("token", token("edit").as_str())])
        .send()
        .await
        .unwrap();
    assert!(
        res.headers()["location"]
            .to_str()
            .unwrap()
            .ends_with("&block=b_q")
    );
    let res = http()
        .post(format!("http://{addr}/v1/launch"))
        .form(&[("token", token("edit").as_str()), ("block", "x\"&t=evil")])
        .send()
        .await
        .unwrap();
    let loc = res.headers()["location"].to_str().unwrap();
    assert!(!loc.contains("block") && !loc.contains("evil"), "{loc}");
}

/// UX-02: an idle connection still hears from the server every `heartbeat` (control
/// `{"t":"ping"}`), so the client can tell a silent network drop from a quiet room.
#[tokio::test]
async fn idle_connections_get_a_heartbeat() {
    let (base, _host) = mock_host().await;
    let state = app(
        &base,
        oc_server::config::RoomConfig {
            heartbeat: Duration::from_millis(200),
            ..room_cfg()
        },
    )
    .await;
    let addr = serve_state(state).await;
    let loc = launch(&addr, &token("view")).await.headers()["location"]
        .to_str()
        .unwrap()
        .to_string();
    let ticket = loc.trim_start_matches("/app/#t=").to_string();
    let s: Value = http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let room = s["room"].as_str().unwrap();
    let (mut ws, _) =
        tokio_tungstenite::connect_async(format!("ws://{addr}/v1/collab/{room}?ticket={ticket}"))
            .await
            .unwrap();
    let mut pings = 0;
    let end = tokio::time::Instant::now() + Duration::from_millis(1100);
    while let Ok(Some(Ok(m))) = tokio::time::timeout_at(end, ws.next()).await {
        let WsMessage::Binary(data) = m else { continue };
        let mut d = DecoderV1::new(Cursor::new(&data));
        for m in MessageReader::new(&mut d).flatten() {
            if let Message::Custom(100, b) = m
                && serde_json::from_slice::<Value>(&b).unwrap()["t"] == "ping"
            {
                pings += 1;
            }
        }
    }
    assert!((3..=7).contains(&pings), "{pings} pings in 1.1 s at 200 ms");
}

async fn session_ai(addr: &str, role: &str) -> Value {
    let res = launch(addr, &token(role)).await;
    let loc = res.headers()["location"].to_str().unwrap().to_string();
    let ticket = loc.strip_prefix("/app/#t=").unwrap().to_string();
    let s: Value = http()
        .get(format!("http://{addr}/v1/sessions/{ticket}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    s["ai"].clone()
}

async fn serve_with(base: &str, tweak: fn(&mut oc_server::hosts::HostConfig)) -> String {
    serve_state(app_ai(base, room_cfg(), &temp_db(), tweak).await).await
}

fn host_ai_all_on(h: &mut oc_server::hosts::HostConfig) {
    h.ai.insert("enabled".into(), toml::Value::Boolean(true));
    h.ai.insert("provider".into(), toml::Value::String("claude".into()));
    h.ai.insert("mcp".into(), toml::Value::Boolean(true));
}

/// The server-wide switch (docs/24 §7.3) beats `[host.ai]`: session flag, MCP and ai-run.
#[tokio::test]
async fn server_ai_switch_off_overrides_host_ai() {
    for off in [
        oc_server::ai::config::AiConfig::off("OC_AI=off"),
        oc_server::ai::config::AiConfig::default(),
    ] {
        let (base, _h) = mock_host().await;
        let state = app_full(&base, room_cfg(), &temp_db(), host_ai_all_on, |c| {
            c.ai = Some(off.clone())
        })
        .await;
        let addr = serve_state(state.clone()).await;
        assert_eq!(
            session_ai(&addr, "edit").await,
            json!({"enabled": false, "modes": [], "mcp": false})
        );
        let res = http()
            .post(format!("http://{addr}/mcp/sample"))
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        let res = http()
            .get(format!(
                "http://{addr}/.well-known/oauth-protected-resource/mcp/sample"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        let mut p = Peer::join(&state, grant("u_a", oc_server::grant::Role::Edit)).await;
        p.settle().await;
        p.send(oc_server::room::protocol::control(
            &json!({"t": "ai-run", "runId": "r1", "prompt": "hi", "mode": "answer"}),
        ));
        p.settle().await;
        let done = p
            .controls
            .iter()
            .find(|c| c["t"] == "ai-done")
            .cloned()
            .unwrap_or_default();
        assert_eq!(done["outcome"], "refused", "{:?}", p.controls);
        assert_eq!(done["reason"], "ai_disabled", "{:?}", p.controls);
        let ready: Value = http()
            .get(format!("http://{addr}/readyz"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ready["ai"], off.status());
    }
}

/// The session says whether the assistant shows (docs/15 §2): from `[host.ai]` and the role.
#[tokio::test]
async fn session_carries_the_ai_flag_from_host_ai_and_the_role() {
    let (base, _h) = mock_host().await;
    let addr = serve_with(&base, |h| {
        h.ai.insert("enabled".into(), toml::Value::Boolean(true));
        h.ai.insert("provider".into(), toml::Value::String("claude".into()));
        h.ai.insert("mcp".into(), toml::Value::Boolean(true));
    })
    .await;
    assert_eq!(
        session_ai(&addr, "edit").await,
        json!({"enabled": true, "modes": ["edit", "comment", "answer"], "mcp": true})
    );
    assert_eq!(
        session_ai(&addr, "comment").await,
        json!({"enabled": true, "modes": ["answer", "comment"], "mcp": true})
    );
    assert_eq!(
        session_ai(&addr, "view").await,
        json!({"enabled": false, "modes": [], "mcp": true})
    );
    // No `[host.ai]`: off for everyone.
    let (base, _h) = mock_host().await;
    let addr = serve(&base).await;
    assert_eq!(
        session_ai(&addr, "edit").await,
        json!({"enabled": false, "modes": [], "mcp": false})
    );
}
