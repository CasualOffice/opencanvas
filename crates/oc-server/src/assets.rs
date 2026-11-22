// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Images for exports (DOCX, board PNG, PDF) are fetched only from origins the host allows:
//! its `callback_base` origin (signed, with the callback token), the original `callback_base`
//! origin while `OC_CALLBACK_BASE_OVERRIDE` is active (fetched through the override), and the
//! host's `asset_origins` (plain GET, no token). No redirects, ≤ 10 MB, `image/*` only.

use std::collections::HashMap;

use reqwest::Url;

use crate::SharedState;
use crate::hosts::HostConfig;

/// Most images fetched for one export.
pub const MAX_IMAGES: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetUrl {
    pub url: Url,
    /// Signed callback (HMAC + bearer): only for the host's own callback origin.
    pub signed: bool,
}

fn web_url(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https") && u.username().is_empty() && u.password().is_none()
}

/// Whether `u` is on the origin of the configured URL `s`.
fn same_origin(u: &Url, s: &str) -> bool {
    Url::parse(s)
        .ok()
        .filter(web_url)
        .is_some_and(|o| o.origin() == u.origin())
}

/// Where to fetch an image `src` from, or `None` when its origin is not allowed (never fetch
/// arbitrary URLs). Relative `/…` paths resolve against `callback_base`.
pub fn resolve(host: &HostConfig, src: &str) -> Option<AssetUrl> {
    let base = Url::parse(&host.callback_base).ok()?;
    let src = src.trim();
    let mut url = if src.starts_with('/') && !src.starts_with("//") {
        base.join(src).ok()?
    } else {
        Url::parse(src).ok()?
    };
    if !web_url(&url) {
        return None;
    }
    if url.origin() == base.origin() {
        return Some(AssetUrl { url, signed: true });
    }
    if host
        .original_callback_base
        .as_deref()
        .is_some_and(|o| same_origin(&url, o))
    {
        // The browser-facing origin; this server reaches the host through the override.
        url.set_scheme(base.scheme()).ok()?;
        url.set_host(base.host_str()).ok()?;
        url.set_port(base.port()).ok()?;
        return Some(AssetUrl { url, signed: true });
    }
    let allowed = host.asset_origins.iter().any(|o| same_origin(&url, o));
    allowed.then_some(AssetUrl { url, signed: false })
}

/// Fetches the given image sources that resolve to an allowed origin; failures are skipped.
pub async fn fetch_images(
    state: &SharedState,
    host: &HostConfig,
    token: &str,
    srcs: impl IntoIterator<Item = String>,
) -> HashMap<String, Vec<u8>> {
    let wanted: Vec<(String, AssetUrl)> = srcs
        .into_iter()
        .filter_map(|src| resolve(host, &src).map(|u| (src, u)))
        .take(MAX_IMAGES)
        .collect();
    let fetches = wanted.into_iter().map(|(src, a)| async move {
        match state.host.get_asset(host, token, a.url, a.signed).await {
            Ok(bytes) => Some((src, bytes.to_vec())),
            Err(e) => {
                tracing::debug!(error = %e, "export image not fetched");
                None
            }
        }
    });
    futures::future::join_all(fetches)
        .await
        .into_iter()
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> HostConfig {
        toml::from_str(
            r#"
            id = "h"
            name = "H"
            jwt_secret = "s"
            callback_base = "http://internal:4000/api/opencanvas"
            asset_origins = ["https://cdn.example.com"]
            "#,
        )
        .unwrap()
    }

    #[test]
    fn allowed_origins() {
        let h = host();
        let r = resolve(&h, "/files/a.png").unwrap();
        assert_eq!(r.url.as_str(), "http://internal:4000/files/a.png");
        assert!(r.signed);
        assert!(resolve(&h, "http://internal:4000/x.png").unwrap().signed);
        let cdn = resolve(&h, "https://cdn.example.com/i/1.png").unwrap();
        assert!(!cdn.signed, "no callback token to a CDN");
        // Disallowed: other origins, other ports/schemes, userinfo, protocol-relative, odd schemes.
        for bad in [
            "https://evil.example/x.png",
            "http://cdn.example.com/i/1.png",
            "http://internal:4001/x.png",
            "http://user:pw@internal:4000/x.png",
            "//evil.example/x.png",
            "file:///etc/passwd",
            "data:image/png;base64,AAAA",
            "javascript:alert(1)",
        ] {
            assert_eq!(resolve(&h, bad), None, "{bad}");
        }
    }

    #[test]
    fn override_keeps_the_original_origin() {
        let mut h = host();
        h.original_callback_base = Some("http://localhost:4000/api/opencanvas".into());
        let r = resolve(&h, "http://localhost:4000/files/a.png?v=1").unwrap();
        assert_eq!(r.url.as_str(), "http://internal:4000/files/a.png?v=1");
        assert!(r.signed);
        assert_eq!(resolve(&h, "http://localhost:4001/files/a.png"), None);
    }
}
