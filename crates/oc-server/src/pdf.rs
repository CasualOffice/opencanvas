//! PDF export through a Gotenberg sidecar (ADR-010): the self-contained print HTML is posted to
//! `/forms/chromium/convert/html` and the PDF is streamed back to the caller.

use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::http::StatusCode;

use crate::routes::ApiError;

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("opencanvas/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client")
    })
}

/// A4 with ~15 mm margins, backgrounds printed (callout shading, board fills).
const FIELDS: [(&str, &str); 7] = [
    ("paperWidth", "8.27"),
    ("paperHeight", "11.7"),
    ("marginTop", "0.6"),
    ("marginBottom", "0.6"),
    ("marginLeft", "0.6"),
    ("marginRight", "0.6"),
    ("printBackground", "true"),
];

/// `multipart/form-data` body: the form fields plus `files` = `index.html`.
pub fn form(boundary: &str, html: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(html.len() + 1024);
    for (name, value) in FIELDS {
        out.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    out.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"index.html\"\r\n\
             Content-Type: text/html; charset=utf-8\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(html.as_bytes());
    out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    out
}

fn failed(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, "PDF_RENDERER_FAILED", message)
}

/// Converts `html` with Gotenberg at `base` and returns the PDF as a streaming body.
pub async fn gotenberg(base: &str, html: String) -> Result<Body, ApiError> {
    let boundary = format!("oc-{}", ulid::Ulid::new());
    let res = client()
        .post(format!("{base}/forms/chromium/convert/html"))
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(form(&boundary, &html))
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "PDF renderer unreachable");
            failed("PDF renderer unreachable")
        })?;
    if !res.status().is_success() {
        tracing::warn!(status = %res.status(), "PDF renderer failed");
        return Err(failed(format!("PDF renderer answered {}", res.status())));
    }
    Ok(Body::from_stream(res.bytes_stream()))
}
