//! Board SVG/PNG export, PDF through a (mock) Gotenberg, and the asset-origin policy for
//! images in exports (docs/15 §6, ADR-010).
mod common;

use std::io::{Cursor, Read};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use common::*;
use oc_server::config::PdfRenderer;
use oc_server::grant::Role;
use serde_json::{Value, json};

const API_KEY: &str = "test-api-key";
const TICKET: &str = "01TESTTICKETEXPORTS0000000";

fn unzip(bytes: &[u8]) -> std::collections::HashMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..z.len())
        .map(|i| {
            let mut f = z.by_index(i).unwrap();
            let mut b = Vec::new();
            f.read_to_end(&mut b).unwrap();
            (f.name().unwrap().to_string(), b)
        })
        .collect()
}

async fn convert(addr: &str, from: &str, to: &str, body: Vec<u8>) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://{addr}/v1/convert?from={from}&to={to}"))
        .header("X-OpenCanvas-Host", "sample")
        .header("X-OpenCanvas-Key", API_KEY)
        .body(body)
        .send()
        .await
        .unwrap()
}

/// A canvas with a paragraph, a board (sticky + image) and two images, as `.ocanvas`.
fn canvas(origin: &str, cdn: &str, evil: &str) -> Vec<u8> {
    let doc = oc_model::new_doc();
    oc_model::import::apply_document_json(
        &doc,
        &json!({
            "meta": {"title": "Export test"},
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Quarterly plan body text"}]},
                {"type": "board", "attrs": {"boardId": "bd1"}},
                {"type": "image", "attrs": {"src": format!("{cdn}/assets/c1"), "alt": "cdn"}},
                {"type": "image", "attrs": {"src": format!("{evil}/assets/x"), "alt": "evil"}}
            ],
            "boards": {"bd1": {"order": ["s1", "i1"], "shapes": {
                "s1": {"type": "sticky", "x": 0, "y": 0, "w": 150, "h": 110, "fill": "b", "text": "Board idea"},
                "i1": {"type": "image", "x": 200, "y": 0, "w": 60, "h": 60, "src": format!("{origin}/assets/b1")}
            }}}
        }),
    );
    oc_model::write_ocanvas(&doc, &oc_model::CommitInfo::default()).unwrap()
}

#[derive(Default)]
struct Gotenberg {
    bodies: Vec<(HeaderMap, Vec<u8>)>,
}

async fn mock_gotenberg() -> (String, Arc<Mutex<Gotenberg>>) {
    let st: Arc<Mutex<Gotenberg>> = Arc::default();
    let app = Router::new()
        .route(
            "/forms/chromium/convert/html",
            post(
                |State(s): State<Arc<Mutex<Gotenberg>>>, h: HeaderMap, body: Bytes| async move {
                    s.lock().unwrap().bodies.push((h, body.to_vec()));
                    (
                        [("content-type", "application/pdf")],
                        b"%PDF-1.7 mock".to_vec(),
                    )
                },
            ),
        )
        .with_state(st.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), st)
}

#[tokio::test]
async fn pdf_without_a_renderer_is_501() {
    let (base, _host) = mock_host().await;
    let state = app_custom(&base, room_cfg(), &temp_db(), |h| {
        h.api_key = Some(API_KEY.into())
    })
    .await;
    let addr = serve_state(state.clone()).await;
    let res = convert(&addr, "md", "pdf", b"# Hi".to_vec()).await;
    assert_eq!(res.status(), 501);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"]["code"], "PDF_RENDERER_NOT_CONFIGURED");
    state
        .store
        .insert_session(TICKET, &grant("u_a", Role::Edit), i64::MAX / 2, 0)
        .await
        .unwrap();
    let res = reqwest::get(format!("http://{addr}/v1/export/pdf?ticket={TICKET}"))
        .await
        .unwrap();
    assert_eq!(res.status(), 501);
}

#[tokio::test]
async fn pdf_goes_through_gotenberg_with_inlined_images_only() {
    let (base, host) = mock_host().await;
    let (cdn_base, cdn) = mock_host().await;
    let (evil_base, evil) = mock_host().await;
    let (gotenberg, gb) = mock_gotenberg().await;
    let (origin, cdn_origin, evil_origin) = (
        base.trim_end_matches("/api").to_string(),
        cdn_base.trim_end_matches("/api").to_string(),
        evil_base.trim_end_matches("/api").to_string(),
    );
    let cdn_o = cdn_origin.clone();
    let state = app_full(
        &base,
        room_cfg(),
        &temp_db(),
        move |h| {
            h.api_key = Some(API_KEY.into());
            h.asset_origins = vec![cdn_o];
        },
        |c| c.pdf_renderer = Some(PdfRenderer::Gotenberg(gotenberg)),
    )
    .await;
    let addr = serve_state(state.clone()).await;
    let res = convert(
        &addr,
        "ocanvas",
        "pdf",
        canvas(&origin, &cdn_origin, &evil_origin),
    )
    .await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "application/pdf");
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"%PDF-1.7 mock");

    let (headers, body) = gb.lock().unwrap().bodies.pop().expect("gotenberg called");
    let ct = headers["content-type"].to_str().unwrap().to_string();
    assert!(ct.starts_with("multipart/form-data; boundary="), "{ct}");
    let body = String::from_utf8_lossy(&body).to_string();
    assert!(body.contains("filename=\"index.html\""));
    assert!(body.contains("name=\"printBackground\""));
    assert!(body.contains("Quarterly plan body text"));
    assert!(
        body.contains("<figure class=\"board\"><svg"),
        "board inlined as SVG"
    );
    assert!(body.contains(">Board idea</text>"));
    assert!(
        body.contains("<image href=\"data:image/png;base64,"),
        "board image inlined"
    );
    assert!(
        body.contains("<img src=\"data:image/png;base64,"),
        "CDN image inlined"
    );
    assert!(body.contains("default-src 'none'"));
    // Nothing the renderer could fetch: the foreign image is only a link.
    assert!(!body.contains(&format!("src=\"{evil_origin}")));
    assert!(!body.contains(&format!("href=\"{origin}")));
    assert!(evil.lock().unwrap().asset_gets.is_empty());
    assert_eq!(host.lock().unwrap().asset_gets.len(), 1);
    assert_eq!(cdn.lock().unwrap().asset_gets.len(), 1);
}

#[tokio::test]
async fn image_fetch_policy() {
    let (base, host) = mock_host().await;
    let (cdn_base, cdn) = mock_host().await;
    let (evil_base, evil) = mock_host().await;
    let origin = base.trim_end_matches("/api").to_string();
    let cdn_origin = cdn_base.trim_end_matches("/api").to_string();
    let evil_origin = evil_base.trim_end_matches("/api").to_string();
    host.lock().unwrap().redirect_to = Some(format!("{evil_origin}/assets/leak"));
    let cdn_o = cdn_origin.clone();
    let state = app_custom(&base, room_cfg(), &temp_db(), move |h| {
        h.api_key = Some(API_KEY.into());
        h.asset_origins = vec![cdn_o];
    })
    .await;
    let addr = serve_state(state.clone()).await;
    let page = format!(
        "<p>x</p><img src=\"{origin}/assets/ok\"><img src=\"{cdn_origin}/assets/cdn\">\
         <img src=\"{evil_origin}/assets/x\"><img src=\"{origin}/assets/redirect\">\
         <img src=\"{origin}/assets/big\"><img src=\"{origin}/assets/text\">"
    );
    let res = convert(&addr, "html", "docx", page.into()).await;
    assert_eq!(res.status(), 200);
    let parts = unzip(&res.bytes().await.unwrap());
    let media: Vec<&String> = parts
        .keys()
        .filter(|k| k.starts_with("word/media/"))
        .collect();
    assert_eq!(
        media.len(),
        2,
        "only the allowed, small, image/* answers: {media:?}"
    );
    let gets = host.lock().unwrap().asset_gets.clone();
    let ids: Vec<&str> = gets.iter().map(|(id, _)| id.as_str()).collect();
    for id in ["ok", "redirect", "big", "text"] {
        assert!(ids.contains(&id), "{id} requested: {ids:?}");
    }
    assert!(
        gets.iter().all(|(_, signed)| *signed),
        "own origin is signed"
    );
    let cdn_gets = cdn.lock().unwrap().asset_gets.clone();
    assert_eq!(
        cdn_gets,
        vec![("cdn".to_string(), false)],
        "CDN gets no signature"
    );
    assert!(
        evil.lock().unwrap().asset_gets.is_empty(),
        "disallowed + redirect never fetched"
    );
}

#[tokio::test]
async fn board_svg_png_and_markdown_embeds_without_ticket() {
    let (base, _host) = mock_host().await;
    let state = app_full(
        &base,
        room_cfg(),
        &temp_db(),
        |_| {},
        |c| c.public_url = Some("https://oc.example".into()),
    )
    .await;
    let addr = serve_state(state.clone()).await;
    state
        .store
        .insert_session(TICKET, &grant("u_a", Role::Edit), i64::MAX / 2, 0)
        .await
        .unwrap();
    let origin = base.trim_end_matches("/api").to_string();
    let loaded = oc_model::read_ocanvas(&canvas(
        &origin,
        "https://cdn.example",
        "https://evil.example",
    ))
    .unwrap()
    .doc;
    let json = oc_model::doc_to_json(&loaded);
    let mut a = Peer::join(&state, grant("u_a", Role::Edit)).await;
    a.settle().await;
    a.edit(|d| oc_model::import::apply_document_json(d, &json));
    a.settle().await;

    let a = addr.as_str();
    let get =
        |path: String| async move { reqwest::get(format!("http://{a}{path}")).await.unwrap() };
    let res = get(format!("/v1/export/board/bd1.svg?ticket={TICKET}")).await;
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("image/svg+xml")
    );
    let svg = res.text().await.unwrap();
    assert!(
        svg.starts_with("<svg") && svg.contains(">Board idea</text>"),
        "{svg}"
    );

    let res = get(format!("/v1/export/board/bd1.png?ticket={TICKET}")).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/png");
    let png = res.bytes().await.unwrap();
    assert!(png.starts_with(b"\x89PNG"));

    assert_eq!(
        get(format!("/v1/export/board/nope.svg?ticket={TICKET}"))
            .await
            .status(),
        404
    );
    assert_eq!(
        get(format!("/v1/export/board/bd1.gif?ticket={TICKET}"))
            .await
            .status(),
        404
    );
    assert_eq!(
        get("/v1/export/board/bd1.svg?ticket=bad".into())
            .await
            .status(),
        401
    );

    let md = get(format!("/v1/export/md?ticket={TICKET}"))
        .await
        .text()
        .await
        .unwrap();
    // Exported files get shared: the board travels inline, never as a link carrying the ticket.
    assert!(
        md.contains("![Whiteboard](data:image/svg+xml;base64,"),
        "{md}"
    );
    assert!(!md.contains(TICKET), "{md}");
    let html = get(format!("/v1/export/html?ticket={TICKET}"))
        .await
        .text()
        .await
        .unwrap();
    assert!(html.contains("<figure class=\"board\"><svg"), "{html}");

    let docx = get(format!("/v1/export/docx?ticket={TICKET}"))
        .await
        .bytes()
        .await
        .unwrap();
    let parts = unzip(&docx);
    let doc_xml = String::from_utf8(parts["word/document.xml"].clone()).unwrap();
    assert!(
        doc_xml.contains("descr=\"Whiteboard: Board idea\""),
        "board embedded as a picture"
    );
    assert!(
        parts
            .keys()
            .any(|k| k.starts_with("word/media/") && k.ends_with(".png"))
    );
}

#[tokio::test]
async fn board_export_needs_the_export_permission() {
    let (base, _host) = mock_host().await;
    let state = app(&base, room_cfg()).await;
    let addr = serve_state(state.clone()).await;
    let mut g = grant("u_a", Role::View);
    g.perms.export = false;
    state
        .store
        .insert_session(TICKET, &g, i64::MAX / 2, 0)
        .await
        .unwrap();
    let res = reqwest::get(format!(
        "http://{addr}/v1/export/board/bd1.png?ticket={TICKET}"
    ))
    .await
    .unwrap();
    assert_eq!(res.status(), 403);
}

/// Against a real Gotenberg: `OC_TEST_GOTENBERG=http://localhost:3301 cargo test -p oc-server
/// --test exports real_gotenberg -- --ignored` (`docker run -d -p 3301:3000 gotenberg/gotenberg:8`).
#[tokio::test]
#[ignore]
async fn real_gotenberg() {
    let url = std::env::var("OC_TEST_GOTENBERG").expect("OC_TEST_GOTENBERG");
    let (base, _host) = mock_host().await;
    let origin = base.trim_end_matches("/api").to_string();
    let state = app_full(
        &base,
        room_cfg(),
        &temp_db(),
        |h| h.api_key = Some(API_KEY.into()),
        |c| c.pdf_renderer = Some(PdfRenderer::Gotenberg(url)),
    )
    .await;
    let addr = serve_state(state.clone()).await;
    let res = convert(
        &addr,
        "ocanvas",
        "pdf",
        canvas(&origin, "https://cdn.example", "https://evil.example"),
    )
    .await;
    assert_eq!(res.status(), 200);
    let pdf = res.bytes().await.unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    let path = std::env::temp_dir().join(format!("oc-real-{}.pdf", ulid::Ulid::new()));
    std::fs::write(&path, &pdf).unwrap();
    if let Ok(out) = std::process::Command::new("pdftotext")
        .arg(&path)
        .arg("-")
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("Quarterly plan body text"), "{text}");
        assert!(
            text.contains("Board idea"),
            "board SVG text in the PDF: {text}"
        );
    }
    let _ = std::fs::remove_file(path);
}
