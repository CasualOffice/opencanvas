// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The shared conformance suite (`crates/oc-server/api/conformance.json`, grammar in docs/05
//! §7d) run by this client against a real OpenCanvas server started in-process. The
//! TypeScript client runs the same file (`web/packages/client/test/conformance.test.ts`).
//! Waits are for events to arrive (bounded at 10 s), never fixed sleeps; retry waits move the
//! server clock.

#[path = "../../oc-server/tests/common/mod.rs"]
mod common;
#[path = "../../oc-server/tests/conformance/server.rs"]
mod server;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use opencanvas_client::{
    Auth, CallOptions, Client, Error, EventStream, EventsOptions, Params, WebhookRequest, models,
    verify_webhook,
};
use serde_json::{Value, json};

const SUITE: &str = include_str!("../../oc-server/api/conformance.json");

/// Replaces "{name}" (whole string: the saved JSON value) and "…{name}…" (text) by variables.
fn subst(v: &Value, vars: &HashMap<String, Value>) -> Value {
    match v {
        Value::String(s) => {
            if let Some(name) = s.strip_prefix('{').and_then(|x| x.strip_suffix('}'))
                && let Some(x) = vars.get(name)
            {
                return x.clone();
            }
            let mut out = s.clone();
            for (k, x) in vars {
                let text = x.as_str().map_or(x.to_string(), String::from);
                out = out.replace(&format!("{{{k}}}"), &text);
            }
            Value::String(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| subst(x, vars)).collect()),
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, x)| (k.clone(), subst(x, vars))).collect())
        }
        other => other.clone(),
    }
}

fn check(body: &Value, matchers: &Value, at: &str) {
    let Some(m) = matchers.as_object() else {
        return;
    };
    for (p, want) in m {
        let got = body.pointer(p);
        let ctx = format!(
            "{at} {p} in {}",
            &body.to_string()[..body.to_string().len().min(400)]
        );
        match want {
            Value::Object(o) => {
                if let Some(n) = o.get("length") {
                    let len = got.and_then(Value::as_array).map(Vec::len);
                    assert_eq!(len, n.as_u64().map(|n| n as usize), "{ctx}");
                }
                if let Some(s) = o.get("contains") {
                    let text = got.map(|g| g.as_str().map_or(g.to_string(), String::from));
                    assert!(
                        text.as_deref()
                            .unwrap_or_default()
                            .contains(s.as_str().unwrap()),
                        "{ctx}: contains {s}"
                    );
                }
                if let Some(e) = o.get("exists") {
                    assert_eq!(
                        got.is_some_and(|g| !g.is_null()),
                        e.as_bool().unwrap(),
                        "{ctx}"
                    );
                }
                if let Some(n) = o.get("notEquals") {
                    assert_ne!(got, Some(n), "{ctx}");
                }
            }
            w => assert_eq!(got, Some(w), "{ctx}"),
        }
    }
}

fn save(body: &Value, spec: &Value, vars: &mut HashMap<String, Value>) {
    for (name, p) in spec.as_object().into_iter().flatten() {
        let v = body
            .pointer(p.as_str().unwrap())
            .unwrap_or_else(|| panic!("save {name} from {p} in {body}"));
        vars.insert(name.clone(), v.clone());
    }
}

async fn control(base: &str, path: &str, body: Value) -> Value {
    let res = reqwest::Client::new()
        .post(format!("{base}/__conformance/{path}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());
    res.json().await.unwrap()
}

async fn within<T>(f: impl std::future::Future<Output = T>, what: &str) -> T {
    tokio::time::timeout(Duration::from_secs(10), f)
        .await
        .unwrap_or_else(|_| panic!("{what}: nothing within 10 s"))
}

fn options(v: &Value) -> CallOptions {
    CallOptions {
        idempotency_key: v["idempotencyKey"].as_str().map(String::from),
        if_match: v["ifMatch"].as_str().map(String::from),
        max_retries: v["maxRetries"].as_u64().map(|n| n as u32),
    }
}

async fn run_scenario(info: &Value, sc: &Value) {
    let base = info["baseUrl"].as_str().unwrap().to_string();
    let name = sc["name"].as_str().unwrap();
    let host = &info["hosts"][sc["host"].as_str().unwrap()];
    let host_id = host["id"].as_str().unwrap().to_string();
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let mut vars: HashMap<String, Value> = HashMap::new();
    vars.insert(
        "file".into(),
        json!(format!(
            "rs-{slug}-{}",
            &ulid::Ulid::new().to_string()[18..]
        )),
    );
    let mut streams: HashMap<String, EventStream> = HashMap::new();
    let slept: Arc<Mutex<Vec<u64>>> = Arc::default();
    for (i, raw) in sc["steps"].as_array().unwrap().iter().enumerate() {
        let step = subst(raw, &vars);
        let at = format!("{name} step {}", i + 1);
        slept.lock().unwrap().clear();
        let client = {
            let auth = if let Some(t) = step["auth"].get("token") {
                let mut req = t.clone();
                req["host"] = json!(host_id);
                let tok = control(&base, "token", req).await;
                Auth::Token(tok["token"].as_str().unwrap().to_string())
            } else {
                let key = step["auth"]["hostKey"]
                    .as_str()
                    .unwrap_or(host["key"].as_str().unwrap());
                Auth::host_key(&host_id, key)
            };
            let (slept, base) = (slept.clone(), base.clone());
            Client::builder(&base)
                .auth(auth)
                .sleeper(Arc::new(move |d: Duration| {
                    let (slept, base) = (slept.clone(), base.clone());
                    Box::pin(async move {
                        slept.lock().unwrap().push(d.as_millis() as u64);
                        control(&base, "clock", json!({"advanceMs": d.as_millis() as u64})).await;
                    })
                }))
                .build()
        };
        let expect = &step["expect"];
        if let Some(op_id) = step["call"].as_str() {
            let op = models::operation(op_id).unwrap_or_else(|| panic!("{at}: unknown op"));
            let params = Params::from_json(op, &step["params"]);
            let res = client
                .call(op_id, &params, &options(&step["options"]))
                .await;
            let want_err = expect.get("error");
            match (res, want_err) {
                (Ok(r), None) => {
                    let body = r.value().unwrap();
                    if let Some(e) = expect.get("etag") {
                        assert_eq!(r.etag.as_deref(), e.as_str(), "{at}");
                    }
                    if let Some(x) = expect.get("replayed") {
                        assert_eq!(r.replayed, x.as_bool().unwrap(), "{at}");
                    }
                    if let Some(x) = expect.get("sleptMs") {
                        assert_eq!(json!(*slept.lock().unwrap()), *x, "{at}");
                    }
                    check(&body, &expect["body"], &at);
                    save(&body, &step["save"], &mut vars);
                }
                (Err(Error::Api(e)), Some(w)) => {
                    assert_eq!(json!(e.status), w["status"], "{at}");
                    assert_eq!(json!(e.code), w["code"], "{at}");
                    assert_eq!(json!(e.kind.as_str()), w["kind"], "{at}");
                    if let Some(r) = w.get("retryAfterSecs") {
                        assert_eq!(json!(e.retry_after_secs), *r, "{at}");
                    }
                    check(&e.problem, &expect["body"], &at);
                    save(&e.problem, &step["save"], &mut vars);
                }
                (Ok(r), Some(_)) => panic!("{at}: expected an error, got {:?}", r.value()),
                (Err(e), _) => panic!("{at}: {e}"),
            }
        } else if let Some(op_id) = step["paginate"].as_str() {
            let op = models::operation(op_id).unwrap();
            let params = Params::from_json(op, &step["params"]);
            let pages: Vec<Value> = client
                .pages(op_id, params.clone(), CallOptions::default())
                .map(|p| p.unwrap())
                .collect()
                .await;
            let items: Vec<Value> = pages
                .iter()
                .flat_map(|p| p[op.paged.unwrap()].as_array().unwrap().clone())
                .collect();
            let via: Vec<Value> = client
                .paginate(op_id, params, CallOptions::default())
                .map(|p| p.unwrap())
                .collect()
                .await;
            assert_eq!(via, items, "{at}");
            if let Some(n) = expect["count"].as_u64() {
                assert_eq!(items.len() as u64, n, "{at}");
            }
            if let Some(n) = expect["pages"].as_u64() {
                assert_eq!(pages.len() as u64, n, "{at}");
            }
            if let Some(k) = expect["uniqueBy"].as_str() {
                let keys: std::collections::HashSet<String> = items
                    .iter()
                    .map(|x| x.pointer(k).unwrap().to_string())
                    .collect();
                assert_eq!(keys.len(), items.len(), "{at}");
            }
            save(&json!(items), &step["save"], &mut vars);
        } else if let Some(action) = step["events"].as_str() {
            let sname = step["stream"].as_str().unwrap().to_string();
            match action {
                "open" => {
                    let p = &step["params"];
                    let mut o = EventsOptions::new(p["fileId"].as_str().unwrap());
                    o.types = p["types"]
                        .as_array()
                        .map(|a| a.iter().map(|t| t.as_str().unwrap().to_string()).collect())
                        .unwrap_or_default();
                    o.last_event_id = p["lastEventId"].as_str().map(String::from);
                    o.no_reconnect = true;
                    let mut s = client.events(o);
                    within(s.ready(), &at).await.unwrap();
                    streams.insert(sname, s);
                }
                "next" => {
                    let s = streams.get_mut(&sname).unwrap();
                    let ev = within(s.next(), &at).await.expect("an event").unwrap();
                    let body = serde_json::to_value(&ev).unwrap();
                    check(&body, &expect["body"], &at);
                    save(&body, &step["save"], &mut vars);
                    assert_eq!(s.last_event_id(), Some(ev.id.as_str()), "{at}");
                }
                "close" => {
                    streams.remove(&sname).unwrap().close();
                }
                other => panic!("{at}: events {other}"),
            }
        } else if let Some(kind) = step["webhook"].as_str() {
            let got = control(
                &base,
                "webhooks",
                json!({"type": kind, "fileId": vars["file"]}),
            )
            .await;
            let list = got["deliveries"].as_array().unwrap();
            assert!(!list.is_empty(), "{at}: a {kind} delivery");
            let secret = info["webhookSecret"].as_str().unwrap().as_bytes();
            let now = got["nowSecs"].as_i64().unwrap();
            for d in list {
                let body = d["body"].as_str().unwrap();
                let req = WebhookRequest {
                    signature: d["signature"].as_str().unwrap(),
                    method: "POST",
                    path_query: d["pathQuery"].as_str().unwrap(),
                    body: body.as_bytes(),
                };
                let want = expect["verified"].as_bool().unwrap_or(true);
                assert_eq!(verify_webhook(secret, req, now), want, "{at}");
                let tampered = body.replace(vars["file"].as_str().unwrap(), "another-file");
                let req2 = WebhookRequest {
                    body: tampered.as_bytes(),
                    ..req
                };
                assert!(!verify_webhook(secret, req2, now), "{at}: tampered");
                check(&serde_json::from_str(body).unwrap(), &expect["body"], &at);
            }
        } else if let Some(ms) = step["clock"].as_i64() {
            control(&base, "clock", json!({"advanceMs": ms})).await;
        } else {
            panic!("{at}: unknown step {step}");
        }
    }
}

#[test]
fn webhook_vectors() {
    let suite: Value = serde_json::from_str(SUITE).unwrap();
    for v in suite["webhookVectors"].as_array().unwrap() {
        let req = WebhookRequest {
            signature: v["signature"].as_str().unwrap(),
            method: v["method"].as_str().unwrap(),
            path_query: v["pathQuery"].as_str().unwrap(),
            body: v["body"].as_str().unwrap().as_bytes(),
        };
        let ok = verify_webhook(
            v["secret"].as_str().unwrap().as_bytes(),
            req,
            v["nowSecs"].as_i64().unwrap(),
        );
        assert_eq!(ok, v["valid"].as_bool().unwrap(), "{}", v["name"]);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scenarios_against_a_real_server() {
    let suite: Value = serde_json::from_str(SUITE).unwrap();
    let c = server::start().await;
    for sc in suite["scenarios"].as_array().unwrap() {
        run_scenario(&c.info, sc).await;
    }
}
