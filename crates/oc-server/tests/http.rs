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
    assert_eq!(csp, "frame-ancestors 'self' http://localhost:4000");

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
    assert_eq!(pdf.status(), 404);

    let users: Value = client
        .get(format!("http://{addr}/v1/users?ticket={ticket}&q=as"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(users[0]["name"], "Asha Rao");

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
async fn frame_flood_closes_the_socket_with_1008() {
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
    assert_eq!(closed, Some(1008));
}
