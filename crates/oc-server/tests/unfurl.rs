// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SSRF-safe link unfurl (UNF-01): `GET /v1/unfurl` and `GET /v1/unfurl/image` against
//! a local page server. Loopback is blocked by default, so most tests let `127.0.0.1/32`
//! through with the operator allow-list (`OC_UNFURL_ALLOW_PRIVATE`), as an operator could.
mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use common::*;
use oc_server::SharedState;
use oc_server::grant::Role;
use oc_server::unfurl::{Cidr, UnfurlConfig};
use serde_json::Value;

const PNG: &[u8] =
    b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

type Seen = Arc<Mutex<Vec<HeaderMap>>>;

/// The page server: every request's headers are recorded.
async fn pages() -> (String, Seen) {
    let seen: Seen = Arc::default();
    let s = seen.clone();
    let html = |body: String| ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body);
    let app = Router::new()
        .route(
            "/og",
            get(move || async move {
                html(
                    r#"<!doctype html><html><head><title>Fallback</title>
                <meta property="og:title" content="Quarterly plan &amp; goals">
                <meta property="og:description" content="What we ship this quarter.">
                <meta property="og:site_name" content="Acme Notes">
                <meta property="og:image" content="/card.png">
                </head><body>hello</body></html>"#
                        .to_string(),
                )
            }),
        )
        .route(
            "/card.png",
            get(|| async { ([(header::CONTENT_TYPE, "image/png")], PNG) }),
        )
        .route(
            "/fake.png",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "image/png")],
                    "<html>not an image</html>",
                )
            }),
        )
        .route(
            "/logo.svg",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "image/svg+xml")],
                    "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>",
                )
            }),
        )
        .route(
            "/huge.png",
            get(|| async {
                let mut b = PNG.to_vec();
                b.resize(3 * 1024 * 1024, 0);
                ([(header::CONTENT_TYPE, "image/png")], b)
            }),
        )
        .route(
            "/json",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    "{\"title\":\"x\"}",
                )
            }),
        )
        .route(
            "/big",
            get(move || async move {
                // 4 MiB, no </head>: the title is at the start, the rest must not be read.
                let mut b = String::from("<html><head><title>Big page</title>");
                b.push_str(&"<!-- padding -->".repeat(4 * 1024 * 1024 / 16));
                html(b)
            }),
        )
        .route(
            "/to-metadata",
            get(|| async {
                (
                    StatusCode::FOUND,
                    [(header::LOCATION, "http://169.254.169.254/latest/meta-data/")],
                )
            }),
        )
        .route(
            "/to-private",
            get(|| async { (StatusCode::FOUND, [(header::LOCATION, "http://10.0.0.1/")]) }),
        )
        .route(
            "/to-v6-loopback",
            get(|| async {
                (
                    StatusCode::MOVED_PERMANENTLY,
                    [(header::LOCATION, "http://[::1]/")],
                )
            }),
        )
        .route(
            "/hop/{n}",
            get(
                |axum::extract::Path(n): axum::extract::Path<u32>| async move {
                    let to = if n == 0 {
                        "/og".to_string()
                    } else {
                        format!("/hop/{}", n - 1)
                    };
                    (StatusCode::FOUND, [(header::LOCATION, to)]).into_response()
                },
            ),
        )
        .layer(axum::middleware::map_request(
            move |req: axum::extract::Request| {
                let s = s.clone();
                async move {
                    s.lock().unwrap().push(req.headers().clone());
                    req
                }
            },
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen)
}

fn loopback_allowed(c: &mut oc_server::config::Config) {
    c.unfurl.allow_private = vec![Cidr::parse("127.0.0.1/32").unwrap()];
}

async fn serve_with(
    tweak_host: impl FnOnce(&mut oc_server::hosts::HostConfig),
    tweak_cfg: impl FnOnce(&mut oc_server::config::Config),
) -> (String, SharedState) {
    let (base, _h) = mock_host().await;
    let state = app_full(&base, room_cfg(), &temp_db(), tweak_host, tweak_cfg).await;
    (serve_state(state.clone()).await, state)
}

async fn ticket(state: &SharedState, role: Role) -> String {
    let t = ulid::Ulid::new().to_string();
    let exp = oc_server::util::now_secs() + 600;
    state
        .store
        .insert_session(&t, &grant("u_a", role), exp, 0)
        .await
        .unwrap();
    t
}

async fn get_json(addr: &str, path: &str, t: &str, url: &str) -> (u16, Value) {
    let res = reqwest::Client::new()
        .get(format!("http://{addr}{path}"))
        .query(&[("ticket", t), ("url", url)])
        .send()
        .await
        .unwrap();
    let s = res.status().as_u16();
    (s, res.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_page_with_open_graph_tags_is_unfurled() {
    let (pages, seen) = pages().await;
    let (addr, state) = serve_with(|_| {}, loopback_allowed).await;
    let t = ticket(&state, Role::Edit).await;
    let (s, v) = get_json(&addr, "/v1/unfurl", &t, &format!("{pages}/og#frag")).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["title"], "Quarterly plan & goals");
    assert_eq!(v["description"], "What we ship this quarter.");
    assert_eq!(v["siteName"], "Acme Notes");
    assert_eq!(v["image"], format!("{pages}/card.png"));
    assert_eq!(v["favicon"], format!("{pages}/favicon.ico"));
    // No credentials, cookies or session ticket leave the server.
    let h = seen.lock().unwrap()[0].clone();
    for k in ["cookie", "authorization", "x-opencanvas-signature"] {
        assert!(!h.contains_key(k), "{k} was sent");
    }
    assert!(!format!("{h:?}").contains(&t), "the ticket leaked");
    // The second call is served from the cache.
    let n = seen.lock().unwrap().len();
    let (s, _) = get_json(&addr, "/v1/unfurl", &t, &format!("{pages}/og")).await;
    assert_eq!(s, 200);
    assert_eq!(seen.lock().unwrap().len(), n, "cache hit must not fetch");

    // The card image comes through the image proxy, sandboxed and never sniffed.
    let res = reqwest::Client::new()
        .get(format!("http://{addr}/v1/unfurl/image"))
        .query(&[
            ("ticket", t.as_str()),
            ("url", &format!("{pages}/card.png")),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/png");
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert!(
        res.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("sandbox")
    );
    assert_eq!(&res.bytes().await.unwrap()[..], PNG);
}

#[tokio::test]
async fn loopback_is_blocked_without_the_allow_list() {
    let (pages, seen) = pages().await;
    let (addr, state) = serve_with(|_| {}, |_| {}).await;
    let t = ticket(&state, Role::Edit).await;
    for url in [
        format!("{pages}/og"),
        pages.replace("127.0.0.1", "localhost") + "/og",
        pages.replace("127.0.0.1", "2130706433") + "/og",
        pages.replace("127.0.0.1", "0x7f.1") + "/og",
        pages.replace("127.0.0.1", "[::ffff:127.0.0.1]") + "/og",
    ] {
        let (s, v) = get_json(&addr, "/v1/unfurl", &t, &url).await;
        assert_eq!(
            (s, v["error"]["code"].as_str()),
            (403, Some("UNFURL_BLOCKED")),
            "{url}"
        );
    }
    let (s, v) = get_json(&addr, "/v1/unfurl/image", &t, &format!("{pages}/card.png")).await;
    assert_eq!(
        (s, v["error"]["code"].as_str()),
        (403, Some("UNFURL_BLOCKED"))
    );
    let (s, _) = get_json(&addr, "/v1/unfurl", &t, "http://169.254.169.254/latest/").await;
    assert_eq!(s, 403);
    let (s, _) = get_json(&addr, "/v1/unfurl", &t, "file:///etc/passwd").await;
    assert_eq!(s, 400);
    assert!(
        seen.lock().unwrap().is_empty(),
        "nothing may reach the blocked server"
    );
}

#[tokio::test]
async fn redirects_to_private_addresses_are_blocked_and_hops_are_capped() {
    let (pages, seen) = pages().await;
    let (addr, state) = serve_with(|_| {}, loopback_allowed).await;
    let t = ticket(&state, Role::Edit).await;
    for p in ["/to-metadata", "/to-private", "/to-v6-loopback"] {
        let (s, v) = get_json(&addr, "/v1/unfurl", &t, &format!("{pages}{p}")).await;
        assert_eq!(
            (s, v["error"]["code"].as_str()),
            (403, Some("UNFURL_BLOCKED")),
            "{p}"
        );
    }
    // Three redirects are followed, a fourth is not.
    let (s, v) = get_json(&addr, "/v1/unfurl", &t, &format!("{pages}/hop/2")).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["title"], "Quarterly plan & goals");
    let before = seen.lock().unwrap().len();
    let (s, v) = get_json(&addr, "/v1/unfurl", &t, &format!("{pages}/hop/3")).await;
    assert_eq!(
        (s, v["error"]["code"].as_str()),
        (502, Some("UNFURL_FAILED")),
        "{v}"
    );
    assert_eq!(
        seen.lock().unwrap().len() - before,
        4,
        "first request + 3 hops, no more"
    );
}

#[tokio::test]
async fn oversize_pages_are_cut_and_wrong_types_refused() {
    let (pages, _seen) = pages().await;
    let (addr, state) = serve_with(|_| {}, loopback_allowed).await;
    let t = ticket(&state, Role::Edit).await;
    let (s, v) = get_json(&addr, "/v1/unfurl", &t, &format!("{pages}/big")).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["title"], "Big page");
    let (s, v) = get_json(&addr, "/v1/unfurl", &t, &format!("{pages}/json")).await;
    assert_eq!((s, v["error"]["code"].as_str()), (415, Some("UNFURL_TYPE")));
    let (s, v) = get_json(&addr, "/v1/unfurl", &t, &format!("{pages}/card.png")).await;
    assert_eq!((s, v["error"]["code"].as_str()), (415, Some("UNFURL_TYPE")));
    for (p, code) in [
        ("/logo.svg", "UNFURL_TYPE"),
        ("/fake.png", "UNFURL_TYPE"),
        ("/og", "UNFURL_TYPE"),
        ("/huge.png", "UNFURL_TOO_LARGE"),
    ] {
        let (s, v) = get_json(&addr, "/v1/unfurl/image", &t, &format!("{pages}{p}")).await;
        assert_eq!(v["error"]["code"].as_str(), Some(code), "{p} ({s})");
    }
}

#[tokio::test]
async fn the_unfurler_cuts_html_at_the_cap() {
    let (pages, _seen) = pages().await;
    let u = oc_server::unfurl::Unfurler::new(UnfurlConfig {
        allow_private: vec![Cidr::parse("127.0.0.1").unwrap()],
        ..UnfurlConfig::default()
    });
    let f = u
        .fetch(
            reqwest::Url::parse(&format!("{pages}/big")).unwrap(),
            oc_server::unfurl::Kind::Html,
        )
        .await
        .unwrap();
    assert!(f.truncated);
    assert_eq!(f.body.len(), oc_server::unfurl::MAX_HTML_BYTES);
}

#[tokio::test]
async fn roles_switches_and_rate_limits() {
    let (pages, _seen) = pages().await;
    let (addr, state) = serve_with(
        |_| {},
        |c| {
            loopback_allowed(c);
            c.unfurl.per_ticket_per_min = 3;
        },
    )
    .await;
    let url = format!("{pages}/og");
    let viewer = ticket(&state, Role::View).await;
    let (s, _) = get_json(&addr, "/v1/unfurl", &viewer, &url).await;
    assert_eq!(s, 403, "viewers do not insert link cards");
    let (s, _) = get_json(
        &addr,
        "/v1/unfurl/image",
        &viewer,
        &format!("{pages}/card.png"),
    )
    .await;
    assert_eq!(s, 200, "every role sees card images");
    let (s, _) = get_json(&addr, "/v1/unfurl", "nope", &url).await;
    assert_eq!(s, 401);

    let t = ticket(&state, Role::Edit).await;
    for _ in 0..3 {
        assert_eq!(get_json(&addr, "/v1/unfurl", &t, &url).await.0, 200);
    }
    let res = reqwest::Client::new()
        .get(format!("http://{addr}/v1/unfurl"))
        .query(&[("ticket", t.as_str()), ("url", url.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429);
    assert_eq!(res.headers()["retry-after"], "60");
    let other = ticket(&state, Role::Edit).await;
    assert_eq!(get_json(&addr, "/v1/unfurl", &other, &url).await.0, 200);

    // Per node: fetches (not cache hits) are counted.
    let (addr, state) = serve_with(
        |_| {},
        |c| {
            loopback_allowed(c);
            c.unfurl.per_node_per_min = 1;
        },
    )
    .await;
    let t = ticket(&state, Role::Edit).await;
    assert_eq!(get_json(&addr, "/v1/unfurl", &t, &url).await.0, 200);
    assert_eq!(
        get_json(&addr, "/v1/unfurl", &t, &url).await.0,
        200,
        "cached"
    );
    let (s, v) = get_json(&addr, "/v1/unfurl", &t, &format!("{pages}/hop/0")).await;
    assert_eq!(
        (s, v["error"]["code"].as_str()),
        (429, Some("UNFURL_RATE_LIMITED"))
    );

    // OC_UNFURL=off and the host flag.
    let (addr, state) = serve_with(
        |_| {},
        |c| {
            loopback_allowed(c);
            c.unfurl.off = true;
        },
    )
    .await;
    let t = ticket(&state, Role::Edit).await;
    let (s, v) = get_json(&addr, "/v1/unfurl", &t, &url).await;
    assert_eq!((s, v["error"]["code"].as_str()), (403, Some("UNFURL_OFF")));
    let (s, _) = get_json(&addr, "/v1/unfurl/image", &t, &format!("{pages}/card.png")).await;
    assert_eq!(s, 403);
    let (addr, state) = serve_with(
        |h| {
            h.flags.insert("unfurl".into(), toml::Value::Boolean(false));
        },
        loopback_allowed,
    )
    .await;
    let t = ticket(&state, Role::Edit).await;
    let (s, v) = get_json(&addr, "/v1/unfurl", &t, &url).await;
    assert_eq!((s, v["error"]["code"].as_str()), (403, Some("UNFURL_OFF")));
}

#[test]
fn a_non_boolean_unfurl_flag_is_refused_at_load() {
    let src = r#"
[[host]]
id = "h"
name = "H"
jwt_secret = "0123456789abcdef0123456789abcdef"
callback_base = "http://h"
allowed_origins = ["http://h"]
[host.flags]
unfurl = "yes"
"#;
    let Err(e) = oc_server::hosts::Hosts::parse(src, None) else {
        panic!("a non-boolean unfurl flag must be refused")
    };
    assert!(e.to_string().contains("unfurl"), "{e}");
}
