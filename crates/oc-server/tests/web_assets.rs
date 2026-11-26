// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The editor's static files (BENCH-03 finding): the build writes a `.gz` next to each text
//! asset and `/app/` serves it to a browser that accepts gzip. Before, the 294 KB (gzip) initial
//! JS went over the wire as 955 KB in every documented deployment (no proxy compresses it).

mod common;

use common::*;

#[tokio::test]
async fn app_assets_are_served_gzip_when_accepted() {
    let web = std::env::temp_dir().join(format!("oc-web-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(web.join("assets")).unwrap();
    let js = "console.log('the initial chunk');\n".repeat(200);
    std::fs::write(web.join("assets/index-x.js"), &js).unwrap();
    std::fs::write(web.join("assets/index-x.js.gz"), b"gzip bytes").unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html><title>app</title>").unwrap();
    std::fs::write(web.join("index.html.gz"), b"gzip html").unwrap();
    let (base, _) = mock_host().await;
    let w = web.clone();
    let state = app_full(
        &base,
        room_cfg(),
        &temp_db(),
        |_| {},
        move |c| c.web_dir = w,
    )
    .await;
    let addr = serve_state(state).await;
    let http = reqwest::Client::new();

    let r = http
        .get(format!("http://{addr}/app/assets/index-x.js"))
        .header("accept-encoding", "gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        r.headers()
            .get("content-encoding")
            .map(|v| v.to_str().unwrap()),
        Some("gzip")
    );
    assert_eq!(&r.bytes().await.unwrap()[..], b"gzip bytes");

    // A client without gzip gets the plain file.
    let r = http
        .get(format!("http://{addr}/app/assets/index-x.js"))
        .send()
        .await
        .unwrap();
    assert!(r.headers().get("content-encoding").is_none());
    assert_eq!(r.text().await.unwrap(), js);

    // The SPA fallback (a deep link) is the compressed index.html too.
    let r = http
        .get(format!("http://{addr}/app/some/route"))
        .header("accept-encoding", "gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.headers()
            .get("content-encoding")
            .map(|v| v.to_str().unwrap()),
        Some("gzip")
    );
    let _ = std::fs::remove_dir_all(web);
}
