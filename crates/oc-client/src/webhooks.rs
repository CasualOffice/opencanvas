// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Verifies `X-OpenCanvas-Signature: t=<ts>,v1=<hex>,v2=<hex>` on webhook deliveries
//! (docs/05 §7c): v2 = HMAC-SHA256(secret, `"<ts>.<METHOD>.<path?query>.<body>"`), compared in
//! constant time, with the timestamp within `tolerance_secs` of now.

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// The default window: 5 minutes either way.
pub const TOLERANCE_SECS: i64 = 300;

/// One delivery to check.
#[derive(Debug, Clone, Copy)]
pub struct WebhookRequest<'a> {
    /// The `X-OpenCanvas-Signature` header.
    pub signature: &'a str,
    /// `POST` for deliveries.
    pub method: &'a str,
    /// The request path and query as your server received it.
    pub path_query: &'a str,
    /// The raw body, before any JSON parsing.
    pub body: &'a [u8],
}

/// Whether a delivery is authentic and recent: `secret` is `[host.webhooks] secret`, else
/// the host's callback secret; `now_secs` is Unix seconds.
pub fn verify_webhook(secret: &[u8], req: WebhookRequest<'_>, now_secs: i64) -> bool {
    verify_webhook_within(secret, req, now_secs, TOLERANCE_SECS)
}

/// [`verify_webhook`] with another time window.
pub fn verify_webhook_within(
    secret: &[u8],
    req: WebhookRequest<'_>,
    now_secs: i64,
    tolerance_secs: i64,
) -> bool {
    let mut t = None;
    let mut v2 = None;
    for part in req.signature.split(',') {
        match part.trim().split_once('=') {
            Some(("t", x)) if t.is_none() => t = x.trim().parse::<i64>().ok(),
            Some(("v2", x)) if v2.is_none() => v2 = hex::decode(x.trim()).ok(),
            _ => {}
        }
    }
    let (Some(t), Some(v2)) = (t, v2) else {
        return false;
    };
    // `t` is not authenticated yet: no arithmetic that can overflow on it (SEC-52).
    if now_secs.abs_diff(t) > tolerance_secs.max(0).unsigned_abs() {
        return false;
    }
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret) else {
        return false;
    };
    mac.update(
        format!(
            "{t}.{}.{}.",
            req.method.to_ascii_uppercase(),
            req.path_query
        )
        .as_bytes(),
    );
    mac.update(req.body);
    mac.verify_slice(&v2).is_ok()
}
