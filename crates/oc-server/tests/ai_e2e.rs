//! The assistant end to end over real WebSockets (AI-01 + AI-02, docs/24 §10.5): a local mock
//! model server speaking the Anthropic or the OpenAI-compatible SSE format is scripted to call
//! `canvas_read`, `db_create` and `db_upsert_rows` through the real canvas tool layer. A second
//! client sees the database appear, the agent's awareness shows, the plan-approval gate holds
//! writes back, `ai-cancel` stops a long run, `ai-undo` reverts it, and a viewer is refused.
mod common;

use std::sync::OnceLock;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::Response;
use axum::routing::post;
use common::*;
use futures::{SinkExt, StreamExt};
use oc_server::SharedState;
use oc_server::grant::Role;
use oc_server::room::protocol;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{Doc, ReadTxn, Transact, Update};

// ---------- the mock model server ----------

/// What the scripted model does next, from the request it got.
enum Step {
    Text(String),
    Tool(&'static str, Value),
}

fn next_step(body: &str, openai: bool) -> (Step, Duration) {
    if body.contains("capability probe") {
        return (Step::Tool("probe", json!({"ok": true})), Duration::ZERO);
    }
    if body.contains("First write a short plan") {
        return (
            Step::Text(
                "1. Read the canvas\n2. Create a Tasks database\n3. Add the task rows".into(),
            ),
            Duration::ZERO,
        );
    }
    if body.contains("LONGRUN") {
        return (
            Step::Tool("canvas_read", json!({})),
            Duration::from_millis(150),
        );
    }
    let done = body
        .matches(if openai {
            "\"role\":\"tool\""
        } else {
            "\"tool_result\""
        })
        .count();
    let step = match done {
        0 => Step::Tool("canvas_read", json!({})),
        1 => Step::Tool(
            "db_create",
            json!({"name": "Tasks", "fields": [
                {"name": "Task", "type": "title"},
                {"name": "Status", "type": "status", "options": ["Todo", "Done"]}]}),
        ),
        2 => Step::Tool(
            "db_upsert_rows",
            json!({"dbId": db_id(body), "rows": [
                {"values": {"Task": "Write the e2e test", "Status": "Todo"}},
                {"values": {"Task": "Ship the assistant", "Status": "Done"}}]}),
        ),
        _ => Step::Text("Created Tasks with 2 rows.".into()),
    };
    (step, Duration::ZERO)
}

/// The `dbId` from the `db_create` result in the conversation (escaped JSON in a string).
fn db_id(body: &str) -> String {
    let at = body.find("dbId").expect("db_create result in the request") + 4;
    body[at..]
        .trim_start_matches(['\\', '"', ':', ' '])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

fn sse(events: &[(&str, Value)]) -> String {
    events
        .iter()
        .map(|(e, d)| {
            if e.is_empty() {
                format!("data: {d}\n\n")
            } else {
                format!("event: {e}\ndata: {d}\n\n")
            }
        })
        .collect()
}

fn anthropic_sse(step: &Step) -> String {
    let block = match step {
        Step::Text(t) => vec![
            (
                "content_block_start",
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            ),
            (
                "content_block_delta",
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":t}}),
            ),
        ],
        Step::Tool(name, input) => vec![
            (
                "content_block_start",
                json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":format!("toolu_{}", ulid::Ulid::new()),"name":name,"input":{}}}),
            ),
            (
                "content_block_delta",
                json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":input.to_string()}}),
            ),
        ],
    };
    let stop = if matches!(step, Step::Tool(..)) {
        "tool_use"
    } else {
        "end_turn"
    };
    let mut ev = vec![(
        "message_start",
        json!({"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}),
    )];
    ev.extend(block);
    ev.push((
        "content_block_stop",
        json!({"type":"content_block_stop","index":0}),
    ));
    ev.push((
        "message_delta",
        json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":5}}),
    ));
    ev.push(("message_stop", json!({"type":"message_stop"})));
    sse(&ev)
}

fn openai_sse(step: &Step) -> String {
    let (delta, finish) = match step {
        Step::Text(t) => (json!({"role":"assistant","content":t}), "stop"),
        Step::Tool(name, input) => (
            json!({"tool_calls":[{"index":0,"id":format!("call_{}", ulid::Ulid::new()),"type":"function","function":{"name":name,"arguments":input.to_string()}}]}),
            "tool_calls",
        ),
    };
    sse(&[
        ("", json!({"choices":[{"index":0,"delta":delta}]})),
        (
            "",
            json!({"choices":[{"index":0,"delta":{},"finish_reason":finish}]}),
        ),
        (
            "",
            json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}),
        ),
    ]) + "data: [DONE]\n\n"
}

async fn answer(body: String, openai: bool) -> Response<Body> {
    let (step, delay) = next_step(&body, openai);
    tokio::time::sleep(delay).await;
    let text = if openai {
        openai_sse(&step)
    } else {
        anthropic_sse(&step)
    };
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(text))
        .unwrap()
}

/// One mock model server for the whole test binary (on its own runtime, so it outlives each
/// test's), and the `OC_AI_CONFIG` pointing at it, set before any `AppState` reads it.
fn model_server() -> &'static str {
    static BASE: OnceLock<String> = OnceLock::new();
    BASE.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let app = Router::new()
                    .route(
                        "/v1/messages",
                        post(|body: String| async move { answer(body, false).await }),
                    )
                    .route(
                        "/v1/chat/completions",
                        post(|body: String| async move { answer(body, true).await }),
                    );
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(format!("http://{}", listener.local_addr().unwrap()))
                    .unwrap();
                axum::serve(listener, app).await.unwrap();
            });
        });
        let base = rx.recv().unwrap();
        let cfg = format!(
            "[ai]\nenabled = true\n\
             [ai.providers.claude]\nkind = \"anthropic\"\nbase_url = \"{base}\"\n\
             api_key_env = \"OC_TEST_E2E_AI_KEY\"\nmodel_agent = \"claude-opus-5-5\"\n\
             timeout_secs = 10\n\
             [ai.providers.local]\nkind = \"openai-compatible\"\nbase_url = \"{base}/v1\"\n\
             model_agent = \"qwen3\"\ntimeout_secs = 10\n"
        );
        let path = std::env::temp_dir().join(format!("oc-ai-e2e-{}.toml", ulid::Ulid::new()));
        std::fs::write(&path, cfg).unwrap();
        // SAFETY: set once, before any test of this binary builds an AppState (they all call
        // this first), and nothing else in this process writes the environment.
        unsafe {
            std::env::set_var("OC_TEST_E2E_AI_KEY", "sk-test-e2e");
            std::env::set_var("OC_AI_CONFIG", &path);
        }
        base
    })
}

// ---------- a y-websocket client ----------

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Client {
    ws: Ws,
    doc: Doc,
    controls: Vec<Value>,
    awareness: Vec<String>,
}

impl Client {
    async fn connect(addr: &str, state: &SharedState, user: &str, role: Role) -> Client {
        let g = grant(user, role);
        let ticket = format!("01TICKET{}{}", user.to_uppercase(), ulid::Ulid::new());
        state
            .store
            .insert_session(&ticket, &g, i64::MAX / 2, 0)
            .await
            .unwrap();
        let (ws, _) = tokio_tungstenite::connect_async(format!(
            "ws://{addr}/v1/collab/{}?ticket={ticket}",
            g.room
        ))
        .await
        .unwrap();
        let mut c = Client {
            ws,
            doc: Doc::new(),
            controls: vec![],
            awareness: vec![],
        };
        let sv = c.doc.transact().state_vector();
        c.ws.send(WsMessage::Binary(protocol::step1(sv).into()))
            .await
            .unwrap();
        c.pump(Duration::from_millis(300)).await;
        c
    }

    /// Reads frames until the line is quiet for `quiet`.
    async fn pump(&mut self, quiet: Duration) {
        while let Ok(Some(Ok(msg))) = tokio::time::timeout(quiet, self.ws.next()).await {
            let WsMessage::Binary(data) = msg else {
                continue;
            };
            let mut d = DecoderV1::new(Cursor::new(&data));
            let msgs: Vec<Message> = MessageReader::new(&mut d)
                .collect::<Result<_, _>>()
                .unwrap();
            for m in msgs {
                match m {
                    Message::Sync(SyncMessage::SyncStep1(sv)) => {
                        let diff = self.doc.transact().encode_state_as_update_v1(&sv);
                        let _ = self
                            .ws
                            .send(WsMessage::Binary(protocol::step2(diff).into()))
                            .await;
                    }
                    Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                        self.doc
                            .transact_mut()
                            .apply_update(Update::decode_v1(&u).unwrap())
                            .unwrap();
                    }
                    Message::Custom(100, b) => {
                        self.controls.push(serde_json::from_slice(&b).unwrap())
                    }
                    Message::Awareness(a) => self.awareness.push(format!("{a:?}")),
                    _ => {}
                }
            }
        }
    }

    async fn control(&mut self, v: Value) {
        self.ws
            .send(WsMessage::Binary(protocol::control(&v).into()))
            .await
            .unwrap();
    }

    /// Pumps until `f` holds (10 s at most).
    async fn until(&mut self, what: &str, f: impl Fn(&Client) -> bool) {
        for _ in 0..100 {
            if f(self) {
                return;
            }
            self.pump(Duration::from_millis(100)).await;
        }
        panic!(
            "timed out waiting for {what}; controls: {:?}",
            self.controls
        );
    }

    fn event(&self, t: &str, run: &str) -> Option<&Value> {
        self.controls
            .iter()
            .find(|v| v["t"] == t && v["runId"] == run)
    }

    fn steps(&self, run: &str) -> usize {
        self.controls
            .iter()
            .filter(|v| v["t"] == "ai-step" && v["runId"] == run)
            .count()
    }

    fn canvas(&self) -> String {
        json_of(&self.doc)["databases"].to_string()
    }
}

async fn setup(provider: &str) -> (SharedState, String) {
    model_server();
    let (base, _host) = mock_host().await;
    let ai: toml::Table = toml::from_str(&format!(
        "enabled = true\nprovider = \"{provider}\"\ndefault_mode = \"direct\"\n"
    ))
    .unwrap();
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| h.ai = ai).await;
    let addr = serve_state(state.clone()).await;
    (state, addr)
}

/// Sends `ai-run`, retrying while the start-up tool probe has not answered yet.
async fn start(c: &mut Client, mut run: Value) {
    let id = run["runId"].as_str().unwrap().to_string();
    run["t"] = json!("ai-run");
    for _ in 0..50 {
        c.control(run.clone()).await;
        c.until("a first event", |c| {
            c.controls.iter().any(|v| v["runId"] == id.as_str())
        })
        .await;
        let refused_for_probe = c.event("ai-done", &id).is_some_and(|d| {
            d["reason"]
                .as_str()
                .is_some_and(|r| r.contains("tool calling"))
        });
        if !refused_for_probe {
            return;
        }
        c.controls.retain(|v| v["runId"] != id.as_str());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the provider probe never succeeded");
}

async fn builds_a_database_after_approval_seen_live_then_undone(provider: &str) {
    let (state, addr) = setup(provider).await;
    let mut alice = Client::connect(&addr, &state, "u_alice", Role::Edit).await;
    let mut bob = Client::connect(&addr, &state, "u_bob", Role::Edit).await;

    // Edit mode confirms by default: the plan arrives, structured, and nothing is written.
    start(
        &mut alice,
        json!({"runId": "run1", "prompt": "Turn my notes into a Tasks database"}),
    )
    .await;
    alice
        .until("ai-plan", |c| c.event("ai-plan", "run1").is_some())
        .await;
    let plan = alice.event("ai-plan", "run1").unwrap().clone();
    assert_eq!(plan["awaitingApproval"], true);
    let kinds: Vec<&str> = plan["plan"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["read", "create", "create"], "{plan}");
    alice.pump(Duration::from_millis(400)).await;
    bob.pump(Duration::from_millis(400)).await;
    assert_eq!(alice.steps("run1"), 0, "no tool call before approval");
    assert!(!bob.canvas().contains("Tasks"), "no edit before approval");

    // Approve: read, create, upsert, all through the real tools.
    alice
        .control(json!({"t": "ai-approve", "runId": "run1"}))
        .await;
    alice
        .until("ai-done", |c| c.event("ai-done", "run1").is_some())
        .await;
    let done = alice.event("ai-done", "run1").unwrap().clone();
    assert_eq!(done["outcome"], "done", "{done}");
    assert_eq!(done["summary"], "Created Tasks with 2 rows.");
    assert_eq!(
        (done["steps"].as_u64(), done["writes"].as_u64()),
        (Some(3), Some(2))
    );
    assert_eq!(done["undoable"], true);
    let tools: Vec<&str> = alice
        .controls
        .iter()
        .filter(|v| v["t"] == "ai-step")
        .map(|v| v["tool"].as_str().unwrap())
        .collect();
    assert_eq!(tools, ["canvas_read", "db_create", "db_upsert_rows"]);
    assert!(
        alice
            .controls
            .iter()
            .filter(|v| v["t"] == "ai-step")
            .all(|v| v["ok"] == true)
    );

    // Bob, the other client, sees the database and its rows, and the agent as a collaborator.
    bob.until("the database and rows", |c| {
        let s = c.canvas();
        s.contains("Tasks") && s.contains("Write the e2e test") && s.contains("Ship the assistant")
    })
    .await;
    assert!(
        bob.awareness
            .iter()
            .any(|a| a.contains("Assistant") && a.contains("ai:run1")),
        "agent awareness: {:?}",
        bob.awareness
    );

    // Undo removes the run's edits for everyone.
    alice
        .control(json!({"t": "ai-undo", "runId": "run1"}))
        .await;
    alice
        .until("undone", |c| {
            c.controls
                .iter()
                .any(|v| v["runId"] == "run1" && v["outcome"] == "undone")
        })
        .await;
    bob.until("the database gone", |c| {
        let s = c.canvas();
        !s.contains("Tasks") && !s.contains("Write the e2e test")
    })
    .await;
}

#[tokio::test]
async fn anthropic_run_builds_a_database_after_approval_then_undo() {
    builds_a_database_after_approval_seen_live_then_undone("claude").await;
}

#[tokio::test]
async fn openai_compatible_run_builds_a_database_after_approval_then_undo() {
    builds_a_database_after_approval_seen_live_then_undone("local").await;
}

#[tokio::test]
async fn cancel_while_waiting_for_approval_leaves_nothing() {
    let (state, addr) = setup("claude").await;
    let mut alice = Client::connect(&addr, &state, "u_alice", Role::Edit).await;
    let mut bob = Client::connect(&addr, &state, "u_bob", Role::Edit).await;
    start(
        &mut alice,
        json!({"runId": "run2", "prompt": "Make tasks", "confirm": true}),
    )
    .await;
    alice
        .until("ai-plan", |c| c.event("ai-plan", "run2").is_some())
        .await;
    alice
        .control(json!({"t": "ai-cancel", "runId": "run2"}))
        .await;
    alice
        .until("ai-done", |c| c.event("ai-done", "run2").is_some())
        .await;
    let done = alice.event("ai-done", "run2").unwrap().clone();
    assert_eq!(done["outcome"], "cancelled", "{done}");
    assert_eq!(
        (done["steps"].as_u64(), done["writes"].as_u64()),
        (Some(0), Some(0))
    );
    // A late approval does nothing.
    alice
        .control(json!({"t": "ai-approve", "runId": "run2"}))
        .await;
    alice.pump(Duration::from_millis(400)).await;
    bob.pump(Duration::from_millis(400)).await;
    assert_eq!(alice.steps("run2"), 0);
    assert!(!bob.canvas().contains("Tasks"));
    assert_eq!(server_json(&state).await["databases"], json!({}));
}

#[tokio::test]
async fn cancel_stops_a_long_run() {
    let (state, addr) = setup("local").await;
    let mut alice = Client::connect(&addr, &state, "u_alice", Role::Edit).await;
    start(
        &mut alice,
        json!({"runId": "run3", "prompt": "LONGRUN: keep reading", "confirm": false}),
    )
    .await;
    alice.until("two steps", |c| c.steps("run3") >= 2).await;
    alice
        .control(json!({"t": "ai-cancel", "runId": "run3"}))
        .await;
    alice
        .until("ai-done", |c| c.event("ai-done", "run3").is_some())
        .await;
    let done = alice.event("ai-done", "run3").unwrap().clone();
    assert_eq!(done["outcome"], "cancelled", "{done}");
    let steps = alice.steps("run3");
    assert!(steps < 25, "stopped before the step limit: {steps}");
    alice.pump(Duration::from_millis(600)).await;
    assert_eq!(alice.steps("run3"), steps, "no step after cancel");
}

#[tokio::test]
async fn a_viewers_run_is_refused() {
    let (state, addr) = setup("claude").await;
    let mut vic = Client::connect(&addr, &state, "u_vic", Role::View).await;
    vic.control(json!({"t": "ai-run", "runId": "run4", "prompt": "Make tasks", "mode": "answer"}))
        .await;
    vic.until("ai-done", |c| c.event("ai-done", "run4").is_some())
        .await;
    let done = vic.event("ai-done", "run4").unwrap();
    assert_eq!(done["outcome"], "refused", "{done}");
    assert_eq!(vic.steps("run4"), 0);
    assert!(vic.event("ai-plan", "run4").is_none());
}
