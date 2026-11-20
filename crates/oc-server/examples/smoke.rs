//! Smoke client: joins a room like y-websocket, types a paragraph, waits for autosave.
//!
//!   cargo run -p oc-server --example smoke -- ws://localhost:8080/v1/collab <room> <ticket> "text"

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use oc_server::room::protocol;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::MessageReader;
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{Doc, ReadTxn, Transact, Update, XmlElementPrelim, XmlFragment, XmlTextPrelim};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, ws_url, room, ticket, text] = &args[..] else {
        anyhow::bail!("usage: smoke <wsUrl> <room> <ticket> <text>");
    };
    let (mut ws, _) =
        tokio_tungstenite::connect_async(format!("{ws_url}/{room}?ticket={ticket}")).await?;
    let doc = Doc::new();
    ws.send(WsMessage::Binary(
        protocol::step1(doc.transact().state_vector()).into(),
    ))
    .await?;
    let mut edited = false;
    let mut saving = false;
    loop {
        let msg = match tokio::time::timeout(Duration::from_secs(15), ws.next()).await {
            Ok(Some(Ok(WsMessage::Binary(b)))) => b,
            Ok(Some(Ok(_))) => continue,
            other => anyhow::bail!("socket ended: {other:?}"),
        };
        let mut d = DecoderV1::new(Cursor::new(&msg));
        for m in MessageReader::new(&mut d).collect::<Result<Vec<_>, _>>()? {
            match m {
                Message::Sync(SyncMessage::SyncStep1(sv)) => {
                    let diff = doc.transact().encode_state_as_update_v1(&sv);
                    ws.send(WsMessage::Binary(protocol::step2(diff).into()))
                        .await?;
                }
                Message::Sync(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) => {
                    doc.transact_mut().apply_update(Update::decode_v1(&u)?)?;
                }
                Message::Custom(100, body) => {
                    let control: serde_json::Value = serde_json::from_slice(&body)?;
                    println!("control {control}");
                    saving |= control["t"] == "saving";
                    if control["t"] == "saved" && saving {
                        println!("document now: {}", oc_model::doc_to_json(&doc)["content"]);
                        return Ok(());
                    }
                    if control["t"] == "role" && !edited {
                        edited = true;
                        let sv = doc.transact().state_vector();
                        {
                            let content = doc.get_or_insert_xml_fragment("content");
                            let mut txn = doc.transact_mut();
                            let p =
                                content.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                            p.push_back(&mut txn, XmlTextPrelim::new(text.as_str()));
                        }
                        let update = doc.transact().encode_state_as_update_v1(&sv);
                        ws.send(WsMessage::Binary(protocol::update(update).into()))
                            .await?;
                        println!("sent edit");
                    }
                }
                Message::Auth(Some(reason)) => println!("denied: {reason}"),
                _ => {}
            }
        }
    }
}
