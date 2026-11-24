// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The client core against a scripted local HTTP server: requests, retries on an injected
//! wait, typed errors, paging and the events stream. No timers: every wait is recorded.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use opencanvas_client::{
    Auth, CallOptions, Client, Error, EventsOptions, Params, ProblemKind, models, parse_frames,
    parse_rate_limit,
};
use serde_json::{Value, json};

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    uri: String,
    headers: HeaderMap,
    body: Vec<u8>,
}

type Script = Arc<Mutex<(VecDeque<Response>, Vec<Seen>)>>;

async fn serve(answers: Vec<Response>) -> (String, Script) {
    let script: Script = Arc::new(Mutex::new((answers.into(), vec![])));
    let s = script.clone();
    let app = Router::new().fallback(move |m: Method, u: Uri, h: HeaderMap, b: Bytes| {
        let s = s.clone();
        async move {
            let mut g = s.lock().unwrap();
            g.1.push(Seen {
                method: m.to_string(),
                uri: u.to_string(),
                headers: h,
                body: b.to_vec(),
            });
            g.0.pop_front()
                .unwrap_or_else(|| StatusCode::IM_A_TEAPOT.into_response())
        }
    });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (format!("http://{addr}"), script)
}

fn json_answer(status: u16, v: Value, headers: &[(&'static str, &str)]) -> Response {
    let mut r = (StatusCode::from_u16(status).unwrap(), v.to_string()).into_response();
    r.headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    for (k, x) in headers {
        r.headers_mut().insert(*k, x.parse().unwrap());
    }
    r
}

fn problem(status: u16, code: &str, headers: &[(&'static str, &str)]) -> Response {
    let mut r = json_answer(
        status,
        json!({"type": "urn:x", "title": "t", "status": status, "code": code, "detail": "d"}),
        headers,
    );
    r.headers_mut()
        .insert("content-type", "application/problem+json".parse().unwrap());
    r
}

fn sse(text: &str) -> Response {
    let mut r = text.to_string().into_response();
    r.headers_mut()
        .insert("content-type", "text/event-stream".parse().unwrap());
    r
}

fn client(base: &str, waits: Arc<Mutex<Vec<u64>>>) -> Client {
    let n = Arc::new(Mutex::new(0));
    Client::builder(base)
        .auth(Auth::HostKey {
            host_id: "acme".into(),
            key: "k1".into(),
            author: Some("u_7".into()),
            callback_token: None,
        })
        .sleeper(Arc::new(move |d: Duration| {
            waits.lock().unwrap().push(d.as_millis() as u64);
            Box::pin(async {})
        }))
        .idempotency_keys(move || {
            let mut g = n.lock().unwrap();
            *g += 1;
            format!("key-{g}")
        })
        .build()
}

fn h(s: &Seen, k: &str) -> Option<String> {
    s.headers.get(k).map(|v| v.to_str().unwrap().to_string())
}

#[tokio::test]
async fn reads_send_host_key_headers_and_parse_metadata() {
    let (base, script) = serve(vec![json_answer(
        200,
        json!({"rev": "r1", "blocks": []}),
        &[("etag", "\"r1\""), ("ratelimit", "\"subject\";r=29;t=1")],
    )])
    .await;
    let c = client(&base, Arc::default());
    let r = c
        .call(
            "readFile",
            &Params::file("a b/c").query("format", "markdown"),
            &CallOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(r.etag.as_deref(), Some("r1"));
    assert!(!r.replayed);
    assert_eq!(r.rate_limit.unwrap().remaining, 29);
    let seen = script.lock().unwrap().1.clone();
    assert_eq!(seen[0].uri, "/api/v1/files/a%20b%2Fc?format=markdown");
    assert_eq!(seen[0].method, "GET");
    assert_eq!(h(&seen[0], "x-opencanvas-host").as_deref(), Some("acme"));
    assert_eq!(h(&seen[0], "x-opencanvas-key").as_deref(), Some("k1"));
    assert_eq!(h(&seen[0], "x-opencanvas-author").as_deref(), Some("u_7"));
    assert_eq!(h(&seen[0], "idempotency-key"), None);
}

#[tokio::test]
async fn writes_carry_one_key_across_retries_and_if_match() {
    let (base, script) = serve(vec![
        problem(503, "UNAVAILABLE", &[("retry-after", "2")]),
        problem(409, "IDEMPOTENCY_IN_PROGRESS", &[("retry-after", "1")]),
        json_answer(
            200,
            json!({"applied": 1, "blockIds": ["b1"], "rev": "r2"}),
            &[],
        ),
    ])
    .await;
    let waits: Arc<Mutex<Vec<u64>>> = Arc::default();
    let c = client(&base, waits.clone());
    let req = models::BatchRequest {
        ops: vec![models::BatchOp {
            op: "append".into(),
            markdown: Some("x".into()),
            ..Default::default()
        }],
        ..Default::default()
    };
    let out = c
        .batch_blocks("f", &req, &CallOptions::if_match("r9"))
        .await
        .unwrap();
    assert_eq!(out.block_ids.unwrap(), ["b1"]);
    let seen = script.lock().unwrap().1.clone();
    assert_eq!(seen.len(), 3);
    for s in &seen {
        assert_eq!(h(s, "idempotency-key").as_deref(), Some("key-1"));
        assert_eq!(h(s, "if-match").as_deref(), Some("\"r9\""));
    }
    let body: Value = serde_json::from_slice(&seen[0].body).unwrap();
    assert_eq!(body, json!({"ops": [{"op": "append", "markdown": "x"}]}));
    assert_eq!(*waits.lock().unwrap(), [2000, 1000]);
}

#[tokio::test]
async fn rate_limits_retry_after_retry_after_then_raise_typed_errors() {
    let (base, _) = serve(vec![
        problem(429, "RATE_LIMITED", &[("retry-after", "1")]),
        problem(429, "RATE_LIMITED", &[("retry-after", "3")]),
        problem(429, "RATE_LIMITED", &[("retry-after", "1")]),
    ])
    .await;
    let waits: Arc<Mutex<Vec<u64>>> = Arc::default();
    let c = client(&base, waits.clone());
    let opts = CallOptions {
        max_retries: Some(2),
        ..Default::default()
    };
    let err = c
        .call("readFile", &Params::file("f"), &opts)
        .await
        .unwrap_err();
    let e = err.api().unwrap();
    assert_eq!(e.kind, ProblemKind::RateLimited);
    assert_eq!(e.retry_after_secs, Some(1));
    assert_eq!(*waits.lock().unwrap(), [1000, 3000]);
}

#[tokio::test]
async fn backoff_without_retry_after_is_exponential_and_capped() {
    let (base, _) = serve(vec![
        problem(503, "UNAVAILABLE", &[]),
        problem(503, "UNAVAILABLE", &[]),
        problem(503, "UNAVAILABLE", &[]),
        json_answer(200, json!({}), &[]),
    ])
    .await;
    let waits: Arc<Mutex<Vec<u64>>> = Arc::default();
    let w = waits.clone();
    let c = Client::builder(&base)
        .backoff(Duration::from_millis(100), Duration::from_millis(300))
        .sleeper(Arc::new(move |d: Duration| {
            w.lock().unwrap().push(d.as_millis() as u64);
            Box::pin(async {})
        }))
        .build();
    c.read_file("f", None).await.unwrap();
    assert_eq!(*waits.lock().unwrap(), [100, 200, 300]);
}

#[tokio::test]
async fn an_unkeyed_write_is_never_resent() {
    let (base, script) = serve(vec![
        problem(503, "UNAVAILABLE", &[]),
        json_answer(200, json!({}), &[]),
    ])
    .await;
    let c = client(&base, Arc::default());
    let err = c
        .call(
            "addComment",
            &Params::file("f").json(json!({"text": "hi"})),
            &CallOptions::key(""),
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), Some(ProblemKind::Unavailable));
    let seen = script.lock().unwrap().1.clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(h(&seen[0], "idempotency-key"), None);
}

#[tokio::test]
async fn problems_map_to_kinds_by_code_then_status() {
    let (base, _) = serve(vec![
        json_answer(
            412,
            json!({"type": "x", "title": "t", "status": 412, "code": "STALE_BLOCK", "fresh": {"rev": "r2"}}),
            &[],
        ),
        (StatusCode::BAD_GATEWAY, "<html>bad gateway</html>").into_response(),
    ])
    .await;
    let c = client(&base, Arc::default());
    let opts = CallOptions {
        max_retries: Some(0),
        ..Default::default()
    };
    let e = c
        .call("getBlock", &Params::file("f").path("blockId", "b"), &opts)
        .await
        .unwrap_err();
    let e = e.api().unwrap();
    assert_eq!(e.kind, ProblemKind::StaleBlock);
    assert_eq!(e.fresh(), Some(&json!({"rev": "r2"})));
    let e = c
        .call("readFile", &Params::file("f"), &opts)
        .await
        .unwrap_err();
    let e = e.api().unwrap();
    assert_eq!((e.code.as_str(), e.kind), ("HTTP_502", ProblemKind::Server));
    for (status, code, kind) in [
        (410, "CURSOR_EXPIRED", ProblemKind::CursorExpired),
        (
            422,
            "IDEMPOTENCY_KEY_REUSED",
            ProblemKind::IdempotencyKeyReused,
        ),
        (404, "BLOCK_NOT_FOUND", ProblemKind::NotFound),
        (403, "ROLE_FORBIDDEN", ProblemKind::Forbidden),
        (500, "INTERNAL", ProblemKind::Server),
    ] {
        assert_eq!(ProblemKind::of(status, code), kind);
    }
}

#[tokio::test]
async fn a_missing_path_parameter_is_refused_before_sending() {
    let c = Client::builder("http://127.0.0.1:9").build();
    let e = c
        .call("readFile", &Params::new(), &CallOptions::default())
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Invalid(m) if m.contains("fileId is required")));
}

#[tokio::test]
async fn paging_follows_next_cursor() {
    let (base, script) = serve(vec![
        json_answer(
            200,
            json!({"blocks": [{"blockId": "a"}, {"blockId": "b"}], "has_more": true, "next_cursor": "c1"}),
            &[],
        ),
        json_answer(
            200,
            json!({"blocks": [{"blockId": "c"}], "has_more": false, "next_cursor": null}),
            &[],
        ),
    ])
    .await;
    let c = client(&base, Arc::default());
    let ids: Vec<String> = c
        .paginate(
            "listBlocks",
            Params::file("f").query("limit", 2),
            CallOptions::default(),
        )
        .map(|b| b.unwrap()["blockId"].as_str().unwrap().to_string())
        .collect()
        .await;
    assert_eq!(ids, ["a", "b", "c"]);
    let seen = script.lock().unwrap().1.clone();
    assert_eq!(seen[1].uri, "/api/v1/files/f/blocks?limit=2&cursor=c1");
}

fn ev(id: &str, kind: &str) -> String {
    format!(
        "id: {id}\nevent: {kind}\ndata: {}\n\n",
        json!({"id": id, "type": kind, "fileId": "f", "at": 1, "data": {}})
    )
}

#[tokio::test]
async fn events_resume_with_last_event_id_and_after_4008() {
    let (base, script) = serve(vec![
        sse(&format!("{}: ping\n\n", ev("ev_1", "edited"))),
        sse(&format!(
            "{}event: close\ndata: {{\"code\":4008,\"reason\":\"lagged\"}}\n\n",
            ev("ev_2", "edited")
        )),
        sse(&ev("ev_3", "saved")),
    ])
    .await;
    let waits: Arc<Mutex<Vec<u64>>> = Arc::default();
    let c = client(&base, waits.clone());
    let mut o = EventsOptions::new("f");
    o.types = vec!["edited".into(), "saved".into()];
    o.last_event_id = Some("ev_0".into());
    let mut s = c.events(o);
    let mut got = vec![];
    while got.len() < 3 {
        got.push(s.next().await.unwrap().unwrap().id);
    }
    assert_eq!(got, ["ev_1", "ev_2", "ev_3"]);
    assert_eq!(s.last_event_id(), Some("ev_3"));
    let seen = script.lock().unwrap().1.clone();
    let ids: Vec<Option<String>> = seen.iter().map(|x| h(x, "last-event-id")).collect();
    assert_eq!(
        ids,
        [
            Some("ev_0".into()),
            Some("ev_1".into()),
            Some("ev_2".into())
        ]
    );
    assert_eq!(seen[0].uri, "/api/v1/files/f/events?types=edited%2Csaved");
    assert_eq!(h(&seen[0], "accept").as_deref(), Some("text/event-stream"));
    // One drop (after ev_1) waited; the 4008 close reconnected at once.
    assert_eq!(*waits.lock().unwrap(), [1000]);
}

#[tokio::test]
async fn events_end_on_4003_and_after_max_reconnects() {
    let (base, _) = serve(vec![sse(&format!(
        "{}event: close\ndata: {{\"code\":4003,\"reason\":\"revoked\"}}\n\n",
        ev("ev_1", "edited")
    ))])
    .await;
    let c = client(&base, Arc::default());
    let mut s = c.events(EventsOptions::new("f"));
    assert_eq!(s.next().await.unwrap().unwrap().id, "ev_1");
    assert!(matches!(
        s.next().await,
        Some(Err(Error::StreamClosed { code: 4003, .. }))
    ));
    assert!(s.next().await.is_none());

    let (base, _) = serve(vec![sse(""), sse(""), sse("")]).await;
    let waits: Arc<Mutex<Vec<u64>>> = Arc::default();
    let c = client(&base, waits.clone());
    let mut o = EventsOptions::new("f");
    o.max_reconnects = Some(2);
    let mut s = c.events(o);
    assert!(s.next().await.is_none());
    assert_eq!(*waits.lock().unwrap(), [1000, 2000]);
}

#[test]
fn sse_frames_and_rate_limit_headers_parse() {
    let mut buf =
        ": keep-alive\r\n\r\nid: 1\r\nevent: saved\r\ndata: {\"a\":1}\r\n\r\nid: 2\nda".to_string();
    let frames = parse_frames(&mut buf);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].id.as_deref(), Some("1"));
    assert_eq!(frames[0].event, "saved");
    assert_eq!(frames[0].data, "{\"a\":1}");
    assert_eq!(buf, "id: 2\nda");
    let r = parse_rate_limit("\"file-writes\";r=0;t=2").unwrap();
    assert_eq!(
        (r.policy.as_str(), r.remaining, r.reset_secs),
        ("file-writes", 0, 2)
    );
    assert!(parse_rate_limit("garbage").is_none());
}

#[test]
fn params_from_json_take_path_query_and_body() {
    let op = models::operation("queryRows").unwrap();
    let p = Params::from_json(
        op,
        &json!({"fileId": "f", "dbId": "d", "query": {"limit": 3, "fields": ["a", "b"],
            "filter": [{"f": "x", "op": "eq", "v": 1}]}, "body": {"k": 1}}),
    );
    assert_eq!(
        p.path,
        [("fileId".into(), "f".into()), ("dbId".into(), "d".into())]
    );
    assert!(p.query.contains(&("limit".into(), "3".into())));
    assert!(p.query.contains(&("fields".into(), "a,b".into())));
    assert!(p.query.contains(&(
        "filter".into(),
        "[{\"f\":\"x\",\"op\":\"eq\",\"v\":1}]".into()
    )));
    assert_eq!(op.paged, Some("rows"));
}
