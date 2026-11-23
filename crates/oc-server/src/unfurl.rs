// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! SSRF-safe link unfurl (UNF-01, docs/07 §2).
//!
//! `GET /v1/unfurl?url=` fetches a page and reads its Open Graph / Twitter / `<title>` /
//! `<meta name=description>` tags; `GET /v1/unfurl/image?url=` proxies the card image so the
//! browser never talks to the third party. Both go through [`Unfurler::fetch`]:
//!
//! - only `http` / `https`, no userinfo, URL ≤ 2048 bytes;
//! - the host is resolved here and **every** address checked by [`blocked`] (private,
//!   loopback, link-local, CGNAT, multicast, reserved, documentation, unique-local and
//!   site-local IPv6, IPv4-mapped / -compatible / NAT64 / 6to4 / Teredo IPv6, cloud metadata);
//!   the connection then goes to the address that was checked (`ClientBuilder::resolve`), so
//!   a second DNS answer cannot rebind it;
//! - redirects are not followed by the client: each `Location` is a new hop with the same
//!   checks, at most [`MAX_REDIRECTS`];
//! - no cookies, no credentials, no proxy from the environment, no compression;
//! - connect 3 s, whole fetch (all hops) 5 s; bodies are read up to a cap and cut there (HTML
//!   stops at `</head>`);
//! - pages must be `text/html` / `application/xhtml+xml`, images PNG, JPEG, GIF, WebP or ICO
//!   (never SVG) with matching magic bytes.
//!
//! Operators may let private ranges through with `OC_UNFURL_ALLOW_PRIVATE=<CIDR,...>` (off by
//! default); metadata addresses stay blocked even then. `OC_UNFURL=off` turns it all off.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures::StreamExt;
use reqwest::Url;
use serde::Serialize;

/// Redirect hops after the first request.
pub const MAX_REDIRECTS: usize = 3;
/// Connect timeout per hop.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Deadline for a whole fetch, every hop and the body included.
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(5);
/// Most HTML read (the head is all we need).
pub const MAX_HTML_BYTES: usize = 512 * 1024;
/// Largest proxied image.
pub const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
/// Longest URL accepted or returned.
pub const MAX_URL_LEN: usize = 2048;
/// Text limits of the preview, in characters.
pub const MAX_TITLE: usize = 200;
pub const MAX_DESCRIPTION: usize = 500;
pub const MAX_SITE: usize = 100;

const CACHE_CAP: usize = 512;
const CACHE_TTL: Duration = Duration::from_secs(3600);
const CACHE_TTL_ERR: Duration = Duration::from_secs(300);
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// An IPv4 or IPv6 network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    addr: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// `10.0.0.0/8`, `fd00::/8`, or a bare address (a /32 or /128).
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let (a, p) = match s.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (s, None),
        };
        let addr: IpAddr = a.parse().ok()?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match p {
            Some(p) => p.parse::<u8>().ok().filter(|p| *p <= max)?,
            None => max,
        };
        Some(Self { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(n), IpAddr::V4(i)) => {
                let mask = u32::MAX.checked_shl(32 - self.prefix as u32).unwrap_or(0);
                u32::from(n) & mask == u32::from(i) & mask
            }
            (IpAddr::V6(n), IpAddr::V6(i)) => {
                let mask = u128::MAX.checked_shl(128 - self.prefix as u32).unwrap_or(0);
                u128::from(n) & mask == u128::from(i) & mask
            }
            _ => false,
        }
    }
}

fn v4_in(ip: Ipv4Addr, net: [u8; 4], prefix: u32) -> bool {
    let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
    u32::from(ip) & mask == u32::from(Ipv4Addr::from(net)) & mask
}

fn v6_in(ip: Ipv6Addr, net: Ipv6Addr, prefix: u32) -> bool {
    let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
    u128::from(ip) & mask == u128::from(net) & mask
}

/// Cloud metadata endpoints: blocked even when an operator allows private ranges.
pub fn is_metadata(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4 == Ipv4Addr::new(169, 254, 169, 254),
        IpAddr::V6(v6) => {
            v6 == "fd00:ec2::254".parse::<Ipv6Addr>().expect("literal")
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_metadata(IpAddr::V4(v4)))
        }
    }
}

/// Whether the unfurl fetcher must refuse to connect to `ip` (before any allow-list).
/// IPv4: anything but public unicast. IPv6: anything outside global unicast `2000::/3`, and
/// inside it the ranges that embed or reach IPv4 (6to4, Teredo, NAT64) or are documentation.
/// IPv4-mapped and IPv4-compatible IPv6 are refused outright.
pub fn blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            const NETS: &[([u8; 4], u32)] = &[
                ([0, 0, 0, 0], 8),       // "this network"
                ([10, 0, 0, 0], 8),      // private
                ([100, 64, 0, 0], 10),   // CGNAT
                ([127, 0, 0, 0], 8),     // loopback
                ([169, 254, 0, 0], 16),  // link-local, metadata
                ([172, 16, 0, 0], 12),   // private
                ([192, 0, 0, 0], 24),    // IETF protocol assignments
                ([192, 0, 2, 0], 24),    // TEST-NET-1
                ([192, 88, 99, 0], 24),  // 6to4 relay anycast
                ([192, 168, 0, 0], 16),  // private
                ([198, 18, 0, 0], 15),   // benchmarking
                ([198, 51, 100, 0], 24), // TEST-NET-2
                ([203, 0, 113, 0], 24),  // TEST-NET-3
                ([224, 0, 0, 0], 4),     // multicast
                ([240, 0, 0, 0], 4),     // reserved, broadcast
            ];
            NETS.iter().any(|(n, p)| v4_in(v4, *n, *p))
        }
        IpAddr::V6(v6) => {
            let global = v6_in(v6, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3);
            if !global {
                // ::, ::1, ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96, 100::/64, fc00::/7
                // (incl. fd00:ec2::254), fe80::/10, fec0::/10, ff00::/8 all land here.
                return true;
            }
            const NETS: &[(Ipv6Addr, u32)] = &[
                (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 32), // Teredo
                (Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32), // documentation
                (Ipv6Addr::new(0x2001, 0x0010, 0, 0, 0, 0, 0, 0), 28), // ORCHID
                (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16), // 6to4
                (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20), // documentation (2024)
            ];
            NETS.iter().any(|(n, p)| v6_in(v6, *n, *p))
        }
    }
}

/// Server-wide unfurl settings (`OC_UNFURL`, `OC_UNFURL_ALLOW_PRIVATE`).
#[derive(Debug, Clone)]
pub struct UnfurlConfig {
    /// `OC_UNFURL=off`: off for every host.
    pub off: bool,
    /// `OC_UNFURL_ALLOW_PRIVATE`: blocked ranges an operator lets through (metadata never).
    pub allow_private: Vec<Cidr>,
    /// Requests (pages and images) per session ticket per minute.
    pub per_ticket_per_min: u32,
    /// Outbound fetches (cache misses) per server node per minute.
    pub per_node_per_min: u32,
}

impl Default for UnfurlConfig {
    fn default() -> Self {
        Self {
            off: false,
            allow_private: vec![],
            per_ticket_per_min: 60,
            per_node_per_min: 300,
        }
    }
}

impl UnfurlConfig {
    /// Parses `OC_UNFURL` and `OC_UNFURL_ALLOW_PRIVATE`; an unparsable CIDR stops start-up.
    pub fn parse(switch: Option<&str>, allow: Option<&str>) -> anyhow::Result<Self> {
        let off = switch.is_some_and(|v| v.trim().eq_ignore_ascii_case("off"));
        let mut allow_private = vec![];
        for part in allow
            .unwrap_or("")
            .split(',')
            .filter(|p| !p.trim().is_empty())
        {
            allow_private.push(Cidr::parse(part).ok_or_else(|| {
                anyhow::anyhow!("OC_UNFURL_ALLOW_PRIVATE: {part:?} is not a CIDR")
            })?);
        }
        Ok(Self {
            off,
            allow_private,
            ..Self::default()
        })
    }

    /// Whether the fetcher may connect to `ip`.
    pub fn allowed(&self, ip: IpAddr) -> bool {
        if is_metadata(ip) {
            return false;
        }
        !blocked(ip) || self.allow_private.iter().any(|c| c.contains(ip))
    }
}

/// Why a fetch failed. The variants map to API error codes; none carries the URL or body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// Not an http(s) URL, userinfo, too long, no host.
    Invalid(&'static str),
    /// The host resolves to an address the policy refuses (or a redirect does).
    Blocked,
    TooManyRedirects,
    /// DNS failed, connect failed, timeout, HTTP error status.
    Unavailable(&'static str),
    /// Content type not HTML (pages) or not an allowed image (images).
    WrongType,
    /// Image larger than the cap (HTML is cut instead).
    TooLarge,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid URL: {m}"),
            Self::Blocked => f.write_str("this address is not allowed"),
            Self::TooManyRedirects => f.write_str("too many redirects"),
            Self::Unavailable(m) => write!(f, "the page could not be fetched: {m}"),
            Self::WrongType => f.write_str("unsupported content type"),
            Self::TooLarge => f.write_str("too large"),
        }
    }
}

/// What to fetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Html,
    Image,
}

/// A fetched body.
#[derive(Debug, Clone)]
pub struct Fetched {
    /// Where the body came from (after redirects).
    pub url: Url,
    /// Normalised content type (`text/html`, `image/png`, …).
    pub mime: String,
    pub body: Vec<u8>,
    /// The body was cut at the cap.
    pub truncated: bool,
}

/// Checks the URL's shape: http(s), a host, no userinfo, ≤ [`MAX_URL_LEN`].
pub fn check_url(raw: &str) -> Result<Url, FetchError> {
    if raw.len() > MAX_URL_LEN {
        return Err(FetchError::Invalid("too long"));
    }
    let mut url = Url::parse(raw.trim()).map_err(|_| FetchError::Invalid("not a URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(FetchError::Invalid("only http and https"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::Invalid("credentials in the URL"));
    }
    if url.host().is_none() {
        return Err(FetchError::Invalid("no host"));
    }
    url.set_fragment(None);
    Ok(url)
}

fn image_mime(ct: &str) -> Option<&'static str> {
    match ct {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" | "image/pjpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("image/x-icon"),
        _ => None,
    }
}

/// The body really is the image type it claims (no HTML or SVG behind an image type).
fn magic_ok(mime: &str, b: &[u8]) -> bool {
    match mime {
        "image/png" => b.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => b.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a"),
        "image/webp" => b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP",
        "image/x-icon" => b.starts_with(&[0, 0, 1, 0]),
        _ => false,
    }
}

/// The preview `GET /v1/unfurl` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Preview {
    pub url: String,
    pub title: String,
    pub description: String,
    #[serde(rename = "siteName")]
    pub site_name: String,
    /// Absolute http(s) URL of the card image; the editor loads it through
    /// `GET /v1/unfurl/image`.
    pub image: String,
    pub favicon: String,
}

struct CacheEntry {
    at: Instant,
    used: u64,
    value: Result<Preview, FetchError>,
}

#[derive(Default)]
struct Windows {
    map: HashMap<String, (Instant, u32)>,
}

impl Windows {
    /// Fixed one-minute window per key; `true` when the request is within `limit`.
    fn hit(&mut self, key: &str, limit: u32, now: Instant) -> bool {
        if self.map.len() > 10_000 {
            self.map
                .retain(|_, (t, _)| now.duration_since(*t) < RATE_WINDOW);
        }
        let e = self.map.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(e.0) >= RATE_WINDOW {
            *e = (now, 0);
        }
        if e.1 >= limit {
            return false;
        }
        e.1 += 1;
        true
    }
}

/// Fetcher, cache and rate limits of one server node.
pub struct Unfurler {
    pub cfg: UnfurlConfig,
    cache: Mutex<(HashMap<String, CacheEntry>, u64)>,
    rate: Mutex<Windows>,
}

/// Which limit refused a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limited {
    Ticket,
    Node,
}

impl Unfurler {
    pub fn new(cfg: UnfurlConfig) -> Self {
        Self {
            cfg,
            cache: Mutex::default(),
            rate: Mutex::default(),
        }
    }

    /// Counts one request of a session ticket.
    pub fn allow_ticket(&self, ticket: &str) -> Result<(), Limited> {
        let mut r = self.rate.lock().unwrap_or_else(|e| e.into_inner());
        if r.hit(
            &format!("t:{ticket}"),
            self.cfg.per_ticket_per_min,
            Instant::now(),
        ) {
            Ok(())
        } else {
            Err(Limited::Ticket)
        }
    }

    /// Counts one outbound fetch of this node.
    fn allow_node(&self) -> Result<(), Limited> {
        let mut r = self.rate.lock().unwrap_or_else(|e| e.into_inner());
        if r.hit("node", self.cfg.per_node_per_min, Instant::now()) {
            Ok(())
        } else {
            Err(Limited::Node)
        }
    }

    fn cached(&self, key: &str) -> Option<Result<Preview, FetchError>> {
        let mut g = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let (map, clock) = &mut *g;
        *clock += 1;
        let now = Instant::now();
        let tick = *clock;
        let e = map.get_mut(key)?;
        let ttl = if e.value.is_ok() {
            CACHE_TTL
        } else {
            CACHE_TTL_ERR
        };
        if now.duration_since(e.at) > ttl {
            map.remove(key);
            return None;
        }
        e.used = tick;
        Some(e.value.clone())
    }

    fn store(&self, key: String, value: Result<Preview, FetchError>) {
        let mut g = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let (map, clock) = &mut *g;
        *clock += 1;
        if map.len() >= CACHE_CAP && !map.contains_key(&key) {
            // Least recently used goes.
            if let Some(k) = map
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
            {
                map.remove(&k);
            }
        }
        map.insert(
            key,
            CacheEntry {
                at: Instant::now(),
                used: *clock,
                value,
            },
        );
    }

    /// Number of cached previews (tests).
    pub fn cache_len(&self) -> usize {
        self.cache.lock().map(|g| g.0.len()).unwrap_or(0)
    }

    /// The preview of `raw`, from the cache or fetched. Rate limits apply to fetches only.
    pub async fn preview(&self, raw: &str) -> Result<Result<Preview, FetchError>, Limited> {
        let url = match check_url(raw) {
            Ok(u) => u,
            Err(e) => return Ok(Err(e)),
        };
        let key = url.to_string();
        if let Some(hit) = self.cached(&key) {
            return Ok(hit);
        }
        self.allow_node()?;
        let res = self.fetch(url, Kind::Html).await.map(|f| {
            let html = String::from_utf8_lossy(&f.body);
            extract(&html, &f.url)
        });
        // Transient failures are not cached; refusals and parsed pages are.
        if !matches!(res, Err(FetchError::Unavailable(_))) {
            self.store(key, res.clone());
        }
        Ok(res)
    }

    /// An image for a card, fetched with the same rules (not cached here: the browser caches).
    pub async fn image(&self, raw: &str) -> Result<Result<Fetched, FetchError>, Limited> {
        let url = match check_url(raw) {
            Ok(u) => u,
            Err(e) => return Ok(Err(e)),
        };
        self.allow_node()?;
        Ok(self.fetch(url, Kind::Image).await)
    }

    /// Resolves `url`'s host and checks every address; returns the one to connect to.
    async fn pin(&self, url: &Url, deadline: Instant) -> Result<SocketAddr, FetchError> {
        let port = url
            .port_or_known_default()
            .ok_or(FetchError::Invalid("no port"))?;
        let addrs: Vec<SocketAddr> = match url.host() {
            Some(url::Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
            Some(url::Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
            Some(url::Host::Domain(d)) => {
                let left = deadline.saturating_duration_since(Instant::now());
                match tokio::time::timeout(left, tokio::net::lookup_host((d, port))).await {
                    Ok(Ok(a)) => a.collect(),
                    Ok(Err(_)) => return Err(FetchError::Unavailable("DNS lookup failed")),
                    Err(_) => return Err(FetchError::Unavailable("timeout")),
                }
            }
            None => return Err(FetchError::Invalid("no host")),
        };
        if addrs.is_empty() {
            return Err(FetchError::Unavailable("DNS lookup failed"));
        }
        // Every answer must pass: a mixed answer is how rebinding attacks start.
        if addrs.iter().any(|a| !self.cfg.allowed(a.ip())) {
            return Err(FetchError::Blocked);
        }
        Ok(addrs[0])
    }

    /// Fetches `url` hop by hop with the checks in the module docs.
    pub async fn fetch(&self, mut url: Url, kind: Kind) -> Result<Fetched, FetchError> {
        let deadline = Instant::now() + TOTAL_TIMEOUT;
        for hop in 0..=MAX_REDIRECTS {
            if hop > 0 {
                // Redirect targets get the URL checks again.
                url = check_url(url.as_str())?;
            }
            let addr = self.pin(&url, deadline).await?;
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(FetchError::Unavailable("timeout"));
            }
            let mut b = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(left)
                .user_agent("OpenCanvas-Unfurl/1.0 (link preview)");
            if let Some(url::Host::Domain(d)) = url.host() {
                // Connect to the checked address; TLS still verifies the name.
                b = b.resolve(d, addr);
            }
            let client = b.build().map_err(|_| FetchError::Unavailable("client"))?;
            let accept = match kind {
                Kind::Html => "text/html,application/xhtml+xml;q=0.9",
                Kind::Image => "image/png,image/jpeg,image/gif,image/webp,image/x-icon;q=0.8",
            };
            let res = client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, accept)
                .send()
                .await
                .map_err(|e| {
                    FetchError::Unavailable(if e.is_timeout() {
                        "timeout"
                    } else {
                        "connect failed"
                    })
                })?;
            let status = res.status();
            if status.is_redirection() {
                let loc = res
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or(FetchError::Unavailable("redirect without a location"))?;
                url = url
                    .join(loc)
                    .map_err(|_| FetchError::Invalid("bad redirect"))?;
                continue;
            }
            if !status.is_success() {
                return Err(FetchError::Unavailable("HTTP error"));
            }
            let ct = res
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let (mime, cap) = match kind {
                Kind::Html if ct == "text/html" || ct == "application/xhtml+xml" => {
                    (ct.clone(), MAX_HTML_BYTES)
                }
                Kind::Image => match image_mime(&ct) {
                    Some(m) => (m.to_string(), MAX_IMAGE_BYTES),
                    None => return Err(FetchError::WrongType),
                },
                Kind::Html => return Err(FetchError::WrongType),
            };
            if kind == Kind::Image
                && res
                    .content_length()
                    .is_some_and(|n| n > MAX_IMAGE_BYTES as u64)
            {
                return Err(FetchError::TooLarge);
            }
            let mut body = Vec::new();
            let mut truncated = false;
            let mut stream = res.bytes_stream();
            let read = async {
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|_| FetchError::Unavailable("read failed"))?;
                    let room = cap - body.len();
                    if chunk.len() > room {
                        body.extend_from_slice(&chunk[..room]);
                        truncated = true;
                        break;
                    }
                    body.extend_from_slice(&chunk);
                    if kind == Kind::Html && head_done(&body) {
                        break;
                    }
                }
                Ok::<(), FetchError>(())
            };
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, read).await {
                Ok(r) => r?,
                Err(_) if kind == Kind::Html && !body.is_empty() => truncated = true,
                Err(_) => return Err(FetchError::Unavailable("timeout")),
            }
            if kind == Kind::Image {
                if truncated {
                    return Err(FetchError::TooLarge);
                }
                if !magic_ok(&mime, &body) {
                    return Err(FetchError::WrongType);
                }
            }
            return Ok(Fetched {
                url,
                mime,
                body,
                truncated,
            });
        }
        Err(FetchError::TooManyRedirects)
    }
}

/// `</head>` (any case) was read: the rest of the page has no metadata we use.
fn head_done(body: &[u8]) -> bool {
    let tail = &body[body.len().saturating_sub(64 * 1024)..];
    tail.windows(7).any(|w| w.eq_ignore_ascii_case(b"</head>"))
}

// ---------- parsing ----------

/// Attributes of one tag (`name` lowercased, values entity-decoded).
fn attrs(tag: &str) -> Vec<(String, String)> {
    let b = tag.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    // Skip the tag name.
    while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'/' && b[i] != b'>' {
        i += 1;
    }
    loop {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        if i >= b.len() || b[i] == b'>' {
            break;
        }
        let ns = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'/') {
            i += 1;
        }
        let name = tag[ns..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                i += 1;
                let vs = i;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                value = tag[vs..i].to_string();
                i = (i + 1).min(b.len());
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                    i += 1;
                }
                value = tag[vs..i].to_string();
            }
        }
        if !name.is_empty() {
            out.push((name, decode_entities(&value)));
        }
    }
    out
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        rest = &rest[p..];
        let end = rest[..rest.len().min(12)].find(';');
        let decoded = end.and_then(|e| {
            let ent = &rest[1..e];
            let c = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                    u32::from_str_radix(&ent[2..], 16)
                        .ok()
                        .and_then(char::from_u32)
                }
                _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
                _ => None,
            };
            c.map(|c| (c, e))
        });
        match decoded {
            Some((c, e)) => {
                out.push(c);
                rest = &rest[e + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Collapses whitespace, drops control characters and cuts to `max` characters.
pub fn clean(s: &str, max: usize) -> String {
    let words = s
        .chars()
        .filter(|c| {
            !(c.is_control() && !c.is_whitespace())
                && !matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect::<String>();
    let joined = words.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() <= max {
        return joined;
    }
    let mut out: String = joined.chars().take(max.saturating_sub(1)).collect();
    out.truncate(out.trim_end().len());
    out.push('…');
    out
}

/// An absolute http(s) URL for `v` relative to `base`, or empty.
fn abs_url(base: &Url, v: &str) -> String {
    let v = v.trim();
    if v.is_empty() || v.len() > MAX_URL_LEN {
        return String::new();
    }
    match base.join(v) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.username().is_empty() => {
            let s = u.to_string();
            if s.len() <= MAX_URL_LEN {
                s
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// Reads the preview out of a page's HTML (only the head matters). Open Graph first, then
/// Twitter cards, then `<title>` and `<meta name=description>`.
pub fn extract(html: &str, base: &Url) -> Preview {
    let lower = html.to_ascii_lowercase();
    let mut meta: HashMap<String, String> = HashMap::new();
    let mut icon = String::new();
    let mut title_tag = String::new();
    let mut i = 0;
    while let Some(p) = lower[i..].find('<') {
        let start = i + p;
        let Some(len) = lower[start..].find('>') else {
            break;
        };
        let end = start + len;
        let tag = &html[start + 1..end];
        let ltag = &lower[start + 1..end];
        i = end + 1;
        if ltag.starts_with("meta") && ltag[4..].starts_with(|c: char| c.is_ascii_whitespace()) {
            let a = attrs(tag);
            let get = |k: &str| a.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
            let key = get("property").or_else(|| get("name"));
            if let (Some(k), Some(c)) = (key, get("content")) {
                meta.entry(k.trim().to_ascii_lowercase()).or_insert(c);
            }
        } else if ltag.starts_with("link")
            && ltag[4..].starts_with(|c: char| c.is_ascii_whitespace())
        {
            let a = attrs(tag);
            let get = |k: &str| a.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
            let rel = get("rel").unwrap_or_default().to_ascii_lowercase();
            if icon.is_empty()
                && rel
                    .split_whitespace()
                    .any(|r| r == "icon" || r == "apple-touch-icon")
            {
                icon = get("href").unwrap_or_default();
            }
        } else if title_tag.is_empty() && (ltag == "title" || ltag.starts_with("title ")) {
            if let Some(close) = lower[i..].find("</title") {
                title_tag = decode_entities(&html[i..i + close]);
            }
        } else if ltag.starts_with("/head") || ltag.starts_with("body") {
            break;
        }
    }
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| meta.get(*k).filter(|v| !v.trim().is_empty()).cloned())
            .unwrap_or_default()
    };
    let mut title = pick(&["og:title", "twitter:title"]);
    if title.trim().is_empty() {
        title = title_tag;
    }
    let description = pick(&["og:description", "twitter:description", "description"]);
    let mut site = pick(&["og:site_name", "application-name"]);
    if site.trim().is_empty() {
        site = base
            .host_str()
            .unwrap_or_default()
            .trim_start_matches("www.")
            .to_string();
    }
    let image = abs_url(
        base,
        &pick(&[
            "og:image:secure_url",
            "og:image",
            "og:image:url",
            "twitter:image",
            "twitter:image:src",
        ]),
    );
    let favicon = abs_url(
        base,
        if icon.is_empty() {
            "/favicon.ico"
        } else {
            &icon
        },
    );
    Preview {
        url: base.to_string(),
        title: clean(&title, MAX_TITLE),
        description: clean(&description, MAX_DESCRIPTION),
        site_name: clean(&site, MAX_SITE),
        image,
        favicon,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn every_blocked_range_is_blocked() {
        for s in [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "10.255.255.255",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.1",
            "127.255.0.1",
            "169.254.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.8",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:8.8.8.8",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "100::1",
            "fc00::1",
            "fd00::1",
            "fd00:ec2::254",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001::1",
            "2001:db8::1",
            "2002:7f00:1::1",
            "2001:10::1",
            "3fff::1",
        ] {
            assert!(blocked(ip(s)), "{s} must be blocked");
        }
    }

    #[test]
    fn public_addresses_pass() {
        for s in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.215.14",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.255.255",
            "172.32.0.1",
            "2606:4700::1111",
            "2a00:1450:4001::200e",
        ] {
            assert!(!blocked(ip(s)), "{s} must pass");
        }
    }

    #[test]
    fn decimal_octal_and_hex_ipv4_forms_are_normalised_then_blocked() {
        let cfg = UnfurlConfig::default();
        for raw in [
            "http://2130706433/",
            "http://0177.0.0.1/",
            "http://0x7f.0.0.1/",
            "http://0x7f000001/",
            "http://127.1/",
            "http://017700000001/",
            "http://[::ffff:7f00:1]/",
            "http://[::ffff:169.254.169.254]/",
            "http://0xa9.0xfe.0xa9.0xfe/",
        ] {
            let u = check_url(raw).unwrap();
            let host_ip = match u.host() {
                Some(url::Host::Ipv4(v)) => IpAddr::V4(v),
                Some(url::Host::Ipv6(v)) => IpAddr::V6(v),
                h => panic!("{raw}: host {h:?} is not an IP"),
            };
            assert!(!cfg.allowed(host_ip), "{raw} ({host_ip}) must be refused");
        }
    }

    #[test]
    fn the_allow_list_opens_private_ranges_but_never_metadata() {
        let cfg = UnfurlConfig::parse(None, Some("127.0.0.1/32, 169.254.0.0/16,fd00::/8")).unwrap();
        assert!(cfg.allowed(ip("127.0.0.1")));
        assert!(!cfg.allowed(ip("127.0.0.2")));
        assert!(cfg.allowed(ip("169.254.1.1")));
        assert!(!cfg.allowed(ip("169.254.169.254")));
        assert!(!cfg.allowed(ip("fd00:ec2::254")));
        assert!(!cfg.allowed(ip("::ffff:169.254.169.254")));
        assert!(cfg.allowed(ip("fd00::5")));
        assert!(UnfurlConfig::parse(None, Some("10.0.0.0/33")).is_err());
        assert!(UnfurlConfig::parse(None, Some("nope")).is_err());
        assert!(UnfurlConfig::parse(Some("OFF"), None).unwrap().off);
        assert!(UnfurlConfig::default().allow_private.is_empty());
    }

    #[test]
    fn only_http_and_https_without_credentials() {
        for bad in [
            "file:///etc/passwd",
            "ftp://example.com/",
            "gopher://example.com/",
            "javascript:alert(1)",
            "data:text/html,x",
            "http://user:pw@example.com/",
            "http://user@example.com/",
            "not a url",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        assert!(check_url(&format!("https://example.com/{}", "a".repeat(MAX_URL_LEN))).is_err());
        let u = check_url("https://example.com/a#frag").unwrap();
        assert_eq!(u.as_str(), "https://example.com/a");
    }

    fn base() -> Url {
        Url::parse("https://www.example.com/post/1").unwrap()
    }

    #[test]
    fn open_graph_wins_over_twitter_and_title() {
        let html = r#"<html><head><title>Tag title</title>
            <meta name="twitter:title" content="Twitter title">
            <meta property="og:title" content="OG &amp; title">
            <meta name="description" content="plain">
            <meta name="twitter:description" content="tw desc">
            <meta property='og:description' content='OG desc'>
            <meta property="og:site_name" content="Example">
            <meta property="og:image" content="/img/card.png">
            <link rel="shortcut icon" href="/fav.png">
            </head><body><meta property="og:title" content="late"></body></html>"#;
        let p = extract(html, &base());
        assert_eq!(p.title, "OG & title");
        assert_eq!(p.description, "OG desc");
        assert_eq!(p.site_name, "Example");
        assert_eq!(p.image, "https://www.example.com/img/card.png");
        assert_eq!(p.favicon, "https://www.example.com/fav.png");
    }

    #[test]
    fn twitter_then_title_and_description_fallbacks() {
        let html = r#"<head><TITLE> Page
            title </TITLE><meta name=twitter:title content="TW">
            <meta name="twitter:image" content="https://cdn.example.net/x.jpg">
            <meta content="Described" name="description"></head>"#;
        let p = extract(html, &base());
        assert_eq!(p.title, "TW");
        assert_eq!(p.description, "Described");
        assert_eq!(p.image, "https://cdn.example.net/x.jpg");
        assert_eq!(p.site_name, "example.com");
        assert_eq!(p.favicon, "https://www.example.com/favicon.ico");
        let p = extract("<title>Only &#x41;&#66; title</title>", &base());
        assert_eq!(p.title, "Only AB title");
        assert_eq!(p.description, "");
        assert_eq!(p.image, "");
    }

    #[test]
    fn returned_text_is_cleaned_and_limited() {
        let long = "word ".repeat(400);
        let html = format!(
            r#"<meta property="og:title" content="{long}"><meta property="og:description" content="a&#0;b{long}"><meta property="og:site_name" content="{long}"><meta property="og:image" content="javascript:alert(1)">"#
        );
        let p = extract(&html, &base());
        assert!(p.title.chars().count() <= MAX_TITLE, "{}", p.title.len());
        assert!(p.title.ends_with('…'));
        assert!(p.description.chars().count() <= MAX_DESCRIPTION);
        assert!(p.site_name.chars().count() <= MAX_SITE);
        assert!(!p.description.contains('\0'));
        assert_eq!(p.image, "", "script URLs are dropped");
        assert_eq!(clean("  a \n\t b\u{202e}c  ", 50), "a bc");
    }

    #[test]
    fn image_magic_must_match() {
        assert!(magic_ok("image/png", b"\x89PNG\r\n\x1a\nrest"));
        assert!(!magic_ok("image/png", b"<svg onload=alert(1)>"));
        assert!(!magic_ok("image/jpeg", b"<html>"));
        assert!(image_mime("image/svg+xml").is_none());
        assert!(image_mime("text/html").is_none());
    }

    #[test]
    fn rate_limit_per_ticket_and_node() {
        let u = Unfurler::new(UnfurlConfig {
            per_ticket_per_min: 2,
            per_node_per_min: 3,
            ..UnfurlConfig::default()
        });
        assert!(u.allow_ticket("a").is_ok());
        assert!(u.allow_ticket("a").is_ok());
        assert_eq!(u.allow_ticket("a"), Err(Limited::Ticket));
        assert!(u.allow_ticket("b").is_ok(), "tickets are counted apart");
        for _ in 0..3 {
            assert!(u.allow_node().is_ok());
        }
        assert_eq!(u.allow_node(), Err(Limited::Node));
        let mut w = Windows::default();
        let t0 = Instant::now();
        assert!(w.hit("k", 1, t0));
        assert!(!w.hit("k", 1, t0));
        assert!(
            w.hit("k", 1, t0 + RATE_WINDOW),
            "a new window starts after a minute"
        );
    }

    #[test]
    fn the_cache_evicts_the_least_recently_used() {
        let u = Unfurler::new(UnfurlConfig::default());
        for i in 0..CACHE_CAP {
            u.store(format!("k{i}"), Ok(Preview::default()));
        }
        assert!(u.cached("k0").is_some()); // k0 is now recent; k1 is the oldest
        u.store("new".into(), Ok(Preview::default()));
        assert_eq!(u.cache_len(), CACHE_CAP);
        assert!(u.cached("k0").is_some());
        assert!(u.cached("k1").is_none());
        assert!(u.cached("new").is_some());
    }
}
