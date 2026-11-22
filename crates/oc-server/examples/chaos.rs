// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Chaos client for `scripts/chaos-cluster.sh` (CLU-02).
//!
//!   chaos run <wsBase> <room> <typeSecs> <out.json> <label>:<ticket>...
//!       Each client joins the room like y-websocket, appends a paragraph "<label>-<n>" every
//!       150 ms while connected, and reconnects (same ticket) whenever the socket drops.
//!       An edit counts as acknowledged once another client has received it (the owner logs
//!       to the WAL before it fans out). After typing stops, waits until every client holds
//!       every edit, then writes the run (sent, acknowledged, reconnect gaps) as JSON.
//!   chaos verify <file.ocanvas> <run.json>
//!       Fails unless the host's saved file contains every acknowledged (and every sent) edit.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use oc_server::room::protocol;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{Doc, ReadTxn, Transact, Update, XmlElementPrelim, XmlFragment, XmlTextPrelim};

#[derive(Default)]
struct Client {
    label: String,
    /// Edits this client sent, in order.
    sent: Vec<String>,
    /// Text of the client's document (JSON), refreshed after every change.
    text: String,
    /// Seconds from losing the socket to being synced again, per reconnect.
    gaps: Vec<f64>,
    connects: usize,
    closes: Vec<String>,
}

type Shared = Arc<Mutex<Client>>;

fn doc_text(doc: &Doc) -> String {
    oc_model::doc_to_json(doc)["content"].to_string()
}

async fn client(
    base: String,
    room: String,
    ticket: String,
    me: Shared,
    typing: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    let doc = Doc::new();
    let label = me.lock().unwrap().label.clone();
    let mut down_since: Option<Instant> = None;
    let mut n = 0usize;
    while !stop.load(Ordering::SeqCst) {
        let url = format!("{base}/{room}?ticket={ticket}");
        let mut ws = match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => ws,
            Err(_) => {
                down_since.get_or_insert_with(Instant::now);
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        me.lock().unwrap().connects += 1;
        let sv = doc.transact().state_vector();
        if ws
            .send(WsMessage::Binary(protocol::step1(sv).into()))
            .await
            .is_err()
        {
            continue;
        }
        let mut synced = false;
        let mut tick = tokio::time::interval(Duration::from_millis(150));
        loop {
            if stop.load(Ordering::SeqCst) {
                let _ = ws.close(None).await;
                return;
            }
            tokio::select! {
                msg = ws.next() => {
                    let data = match msg {
                        Some(Ok(WsMessage::Binary(b))) => b,
                        Some(Ok(WsMessage::Close(cf))) => {
                            me.lock().unwrap().closes.push(format!("{cf:?}"));
                            break;
                        }
                        Some(Ok(_)) => continue,
                        Some(Err(e)) => {
                            me.lock().unwrap().closes.push(format!("error: {e}"));
                            break;
                        }
                        None => {
                            me.lock().unwrap().closes.push("eof".into());
                            break;
                        }
                    };
                    let mut d = DecoderV1::new(Cursor::new(&data));
                    let Ok(msgs) = MessageReader::new(&mut d).collect::<Result<Vec<_>, _>>() else { continue };
                    let mut changed = false;
                    for m in msgs {
                        match m {
                            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                                // Also resends anything the server lost (Yjs sync is idempotent).
                                let diff = doc.transact().encode_state_as_update_v1(&sv);
                                let _ = ws.send(WsMessage::Binary(protocol::step2(diff).into())).await;
                            }
                            Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                                if let Ok(u) = Update::decode_v1(&u) {
                                    let _ = doc.transact_mut().apply_update(u);
                                    changed = true;
                                }
                            }
                            Message::Custom(100, body) => {
                                let c: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                                if c["t"] == "role" && !synced {
                                    synced = true;
                                    if let Some(t) = down_since.take() {
                                        let gap = t.elapsed().as_secs_f64();
                                        println!("{label}: resynced after {gap:.2}s");
                                        me.lock().unwrap().gaps.push(gap);
                                    }
                                }
                                if c["t"] == "reconnect" {
                                    println!("{label}: server asked to reconnect");
                                }
                            }
                            _ => {}
                        }
                    }
                    if changed {
                        me.lock().unwrap().text = doc_text(&doc);
                    }
                }
                _ = tick.tick() => {
                    if !synced || !typing.load(Ordering::SeqCst) {
                        continue;
                    }
                    n += 1;
                    let token = format!("{label}-{n:04}");
                    let sv = doc.transact().state_vector();
                    {
                        let content = doc.get_or_insert_xml_fragment("content");
                        let mut txn = doc.transact_mut();
                        let p = content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                        p.push_back(&mut txn, XmlTextPrelim::new(token.as_str()));
                    }
                    let update = doc.transact().encode_state_as_update_v1(&sv);
                    {
                        let mut m = me.lock().unwrap();
                        m.sent.push(token);
                        m.text = doc_text(&doc);
                    }
                    if ws.send(WsMessage::Binary(protocol::update(update).into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        println!("{label}: socket lost; reconnecting");
        down_since.get_or_insert_with(Instant::now);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn run(args: &[String]) -> anyhow::Result<()> {
    let [base, room, secs, out, peers @ ..] = args else {
        anyhow::bail!("usage: chaos run <wsBase> <room> <typeSecs> <out.json> <label>:<ticket>...");
    };
    let secs: u64 = secs.parse()?;
    let typing = Arc::new(AtomicBool::new(true));
    let stop = Arc::new(AtomicBool::new(false));
    let mut clients: Vec<Shared> = Vec::new();
    let mut tasks = Vec::new();
    for p in peers {
        let (label, ticket) = p
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("bad peer {p}"))?;
        let c: Shared = Arc::new(Mutex::new(Client {
            label: label.into(),
            ..Client::default()
        }));
        clients.push(c.clone());
        tasks.push(tokio::spawn(client(
            base.clone(),
            room.clone(),
            ticket.into(),
            c,
            typing.clone(),
            stop.clone(),
        )));
    }
    // Acknowledged = seen by another client; record when, so edits acked before the kill show.
    let started = Instant::now();
    let mut acked: BTreeMap<String, f64> = BTreeMap::new();
    let scan = |clients: &[Shared], acked: &mut BTreeMap<String, f64>| {
        let snap: Vec<(String, Vec<String>, String)> = clients
            .iter()
            .map(|c| {
                let c = c.lock().unwrap();
                (c.label.clone(), c.sent.clone(), c.text.clone())
            })
            .collect();
        for (label, sent, _) in &snap {
            for t in sent {
                if acked.contains_key(t) {
                    continue;
                }
                if snap
                    .iter()
                    .any(|(l, _, text)| l != label && text.contains(&format!("\"{t}\"")))
                {
                    acked.insert(t.clone(), started.elapsed().as_secs_f64());
                }
            }
        }
        snap
    };
    while started.elapsed() < Duration::from_secs(secs) {
        scan(&clients, &mut acked);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    typing.store(false, Ordering::SeqCst);
    println!("typing stopped; waiting for convergence");
    let deadline = Instant::now() + Duration::from_secs(60);
    let converged = loop {
        let snap = scan(&clients, &mut acked);
        let all: BTreeSet<&String> = snap.iter().flat_map(|(_, s, _)| s).collect();
        let every = snap
            .iter()
            .all(|(_, _, text)| all.iter().all(|t| text.contains(&format!("\"{t}\""))));
        let same = snap.windows(2).all(|w| w[0].2 == w[1].2);
        if every && same {
            break true;
        }
        if Instant::now() > deadline {
            break false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    stop.store(true, Ordering::SeqCst);
    for t in tasks {
        let _ = tokio::time::timeout(Duration::from_secs(2), t).await;
    }
    let report: Vec<Value> = clients
        .iter()
        .map(|c| {
            let c = c.lock().unwrap();
            json!({"label": c.label, "sent": c.sent, "gaps": c.gaps, "connects": c.connects, "closes": c.closes})
        })
        .collect();
    let sent: usize = clients.iter().map(|c| c.lock().unwrap().sent.len()).sum();
    let max_gap = clients
        .iter()
        .flat_map(|c| c.lock().unwrap().gaps.clone())
        .fold(0.0f64, f64::max);
    std::fs::write(
        out,
        serde_json::to_vec_pretty(&json!({
            "converged": converged, "clients": report, "acked": acked, "maxGapSecs": max_gap,
        }))?,
    )?;
    println!(
        "run: {} clients, {sent} edits sent, {} acknowledged, converged={converged}, max reconnect gap {max_gap:.2}s",
        clients.len(),
        acked.len()
    );
    if !converged {
        anyhow::bail!("clients did not converge");
    }
    Ok(())
}

fn verify(args: &[String]) -> anyhow::Result<()> {
    let [file, run] = args else {
        anyhow::bail!("usage: chaos verify <file.ocanvas> <run.json>");
    };
    let doc = oc_model::read_ocanvas(&std::fs::read(file)?)?.doc;
    let text = doc_text(&doc);
    let run: Value = serde_json::from_slice(&std::fs::read(run)?)?;
    let acked: Vec<String> = run["acked"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let sent: Vec<String> = run["clients"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|c| c["sent"].as_array().cloned().unwrap_or_default())
        .filter_map(|s| s.as_str().map(String::from))
        .collect();
    let missing = |list: &[String]| -> Vec<String> {
        list.iter()
            .filter(|t| !text.contains(&format!("\"{t}\"")))
            .cloned()
            .collect()
    };
    let (ma, ms) = (missing(&acked), missing(&sent));
    println!(
        "verify: host file has {}/{} acknowledged and {}/{} sent edits",
        acked.len() - ma.len(),
        acked.len(),
        sent.len() - ms.len(),
        sent.len()
    );
    if !ma.is_empty() {
        anyhow::bail!("acknowledged edits missing from the host's file: {ma:?}");
    }
    if !ms.is_empty() {
        anyhow::bail!("sent edits missing from the host's file: {ms:?}");
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("run") => run(&args[1..]).await,
        Some("verify") => verify(&args[1..]),
        _ => anyhow::bail!("usage: chaos run … | chaos verify …"),
    }
}
