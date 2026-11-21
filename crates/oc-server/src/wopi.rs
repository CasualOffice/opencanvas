//! WOPI-compatible mode (docs/05 §6, ADR-021). OpenCanvas is the WOPI *client* (the editor);
//! the integrating app (Nextcloud, ownCloud, Seafile…) is the WOPI *host* (the storage).
//!
//! - `WOPISrc` is checked against the host's `wopi_allowlist` before anything is fetched.
//! - The `access_token` is opaque, travels only in the query string of calls to the host (as
//!   WOPI requires), is sealed at rest like a callback token and never logged: every
//!   `reqwest` error is stripped of its URL.
//! - Redirects are never followed.

use std::time::Duration;

use base64::Engine;
use bytes::Bytes;
use reqwest::{StatusCode, Url, header};
use serde_json::Value;

use crate::grant::{FileRef, Grant, Perms, Role, User, derive_color, room_id};
use crate::host_client::HostError;

/// Longest accepted `WOPISrc` (it is the file id, stored in `VARCHAR(255)` columns).
pub const MAX_SRC_LEN: usize = 255;
/// Session lifetime when the host sends no (or a zero) `access_token_ttl`.
pub const DEFAULT_TTL_SECS: i64 = 10 * 3600;
/// Largest single asset uploaded in WOPI mode (inlined into the `.ocanvas`).
pub const MAX_ASSET_BYTES: usize = 10 * 1024 * 1024;
/// Largest total of the assets of one file in WOPI mode.
pub const MAX_ASSETS_TOTAL: usize = 50 * 1024 * 1024;
/// Largest file accepted from GetFile.
pub const MAX_FILE_BYTES: usize = 100 * 1024 * 1024;
/// Prefix of a `file.version` taken from CheckFileInfo `Version` (no `LastModifiedTime`): it
/// is shown as the host version but never sent as `X-COOL-WOPI-Timestamp`.
pub const VERSION_PREFIX: &str = "v:";

fn net(e: reqwest::Error) -> HostError {
    HostError::Http(e.without_url())
}

// ---------------------------------------------------------------- allowlist (SSRF guard)

/// One `wopi_allowlist` entry: scheme, host and port must match exactly; a path, when given,
/// must be a prefix of the `WOPISrc` path at a segment boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowEntry {
    scheme: String,
    host: String,
    port: u16,
    path: String,
}

impl AllowEntry {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        let u = Url::parse(s.trim())?;
        if !matches!(u.scheme(), "http" | "https") {
            anyhow::bail!("scheme must be http or https");
        }
        if !u.username().is_empty() || u.password().is_some() {
            anyhow::bail!("no userinfo allowed");
        }
        if u.query().is_some() || u.fragment().is_some() {
            anyhow::bail!("no query or fragment allowed");
        }
        let host = u.host_str().ok_or_else(|| anyhow::anyhow!("no host"))?;
        Ok(Self {
            scheme: u.scheme().to_string(),
            host: host.to_string(),
            port: u.port_or_known_default().unwrap_or(0),
            path: u.path().trim_end_matches('/').to_string(),
        })
    }

    fn admits(&self, u: &Url) -> bool {
        if u.scheme() != self.scheme
            || u.host_str() != Some(self.host.as_str())
            || u.port_or_known_default() != Some(self.port)
        {
            return false;
        }
        let path = u.path();
        self.path.is_empty()
            || path == self.path
            || path
                .strip_prefix(self.path.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    }
}

/// The normalized `WOPISrc` when the allowlist admits it. Refused: other schemes, userinfo,
/// queries, fragments, over-long URLs and anything not matching an entry exactly.
pub fn check_src(allowlist: &[String], src: &str) -> Option<Url> {
    if src.is_empty() || src.len() > MAX_SRC_LEN {
        return None;
    }
    let u = Url::parse(src.trim()).ok()?;
    if !matches!(u.scheme(), "http" | "https")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.host_str().is_none()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.as_str().len() > MAX_SRC_LEN
    {
        return None;
    }
    allowlist
        .iter()
        .filter_map(|e| AllowEntry::parse(e).ok())
        .any(|e| e.admits(&u))
        .then_some(u)
}

// ---------------------------------------------------------------- CheckFileInfo

/// What OpenCanvas reads from CheckFileInfo.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileInfo {
    pub base_file_name: String,
    pub size: Option<u64>,
    pub version: Option<String>,
    pub last_modified_time: Option<String>,
    pub user_id: String,
    pub user_friendly_name: Option<String>,
    pub avatar: Option<String>,
    pub user_can_write: bool,
    pub read_only: bool,
    pub user_can_not_write_relative: bool,
    /// Extension `OpenCanvas_UserCanComment`.
    pub user_can_comment: bool,
    pub disable_export: bool,
    pub disable_print: bool,
    pub hide_export_option: bool,
}

fn text(v: &Value, k: &str) -> Option<String> {
    match v.get(k)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn flag(v: &Value, k: &str) -> bool {
    match v.get(k) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

impl FileInfo {
    pub fn from_json(v: &Value) -> Result<Self, HostError> {
        let missing = |k: &str| HostError::Body(format!("CheckFileInfo without {k}"));
        // `UserExtraInfo` is an object (Nextcloud) or a JSON string (some hosts).
        let extra = match v.get("UserExtraInfo") {
            Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
            Some(o) => o.clone(),
            None => Value::Null,
        };
        let avatar = text(&extra, "avatar")
            .filter(|a| a.starts_with("https://") || a.starts_with("http://"));
        Ok(Self {
            base_file_name: text(v, "BaseFileName").ok_or_else(|| missing("BaseFileName"))?,
            size: v.get("Size").and_then(Value::as_u64),
            version: text(v, "Version"),
            last_modified_time: text(v, "LastModifiedTime"),
            user_id: text(v, "UserId").ok_or_else(|| missing("UserId"))?,
            user_friendly_name: text(v, "UserFriendlyName"),
            avatar,
            user_can_write: flag(v, "UserCanWrite"),
            read_only: flag(v, "ReadOnly"),
            user_can_not_write_relative: flag(v, "UserCanNotWriteRelative"),
            user_can_comment: flag(v, "OpenCanvas_UserCanComment"),
            disable_export: flag(v, "DisableExport"),
            disable_print: flag(v, "DisablePrint"),
            hide_export_option: flag(v, "HideExportOption"),
        })
    }

    /// `UserCanWrite` and not `ReadOnly` → edit; else `OpenCanvas_UserCanComment` → comment;
    /// else view.
    pub fn role(&self) -> Role {
        if self.user_can_write && !self.read_only {
            Role::Edit
        } else if self.user_can_comment {
            Role::Comment
        } else {
            Role::View
        }
    }

    /// `DisableExport` → no export, download or print; `HideExportOption` → no export;
    /// `DisablePrint` → no print (PDF). Comments follow the role.
    pub fn perms(&self) -> Perms {
        Perms {
            export: !(self.disable_export || self.hide_export_option),
            download: !self.disable_export,
            comment: self.role() != Role::View,
            print: !(self.disable_export || self.disable_print),
        }
    }

    /// The version OpenCanvas tracks: `LastModifiedTime` (sent back as
    /// `X-COOL-WOPI-Timestamp`), else `v:<Version>` (display only).
    pub fn stamp(&self) -> Option<String> {
        self.last_modified_time.clone().or_else(|| {
            self.version
                .as_ref()
                .map(|v| format!("{VERSION_PREFIX}{v}"))
        })
    }

    /// The session grant for a WOPI launch. The file id is the normalized `WOPISrc`.
    pub fn grant(&self, host_id: &str, src: &Url, access_token: &str) -> Grant {
        let role = self.role();
        Grant {
            host_id: host_id.to_string(),
            room: room_id(host_id, src.as_str()),
            role,
            user: User {
                id: self.user_id.clone(),
                name: self
                    .user_friendly_name
                    .clone()
                    .unwrap_or_else(|| self.user_id.clone()),
                color: derive_color(&self.user_id),
                avatar: self.avatar.clone(),
            },
            file: FileRef {
                id: src.as_str().to_string(),
                name: self.base_file_name.clone(),
                version: self.stamp(),
            },
            perms: self.perms(),
            callback_token: access_token.to_string(),
        }
    }
}

/// Whether the host file is Markdown (saved back as Markdown, not `.ocanvas`).
pub fn is_markdown(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".md") || n.ends_with(".markdown")
}

// ---------------------------------------------------------------- discovery

fn xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `GET /hosting/discovery`: `ocanvas` (edit, view) and `md` (edit, view, convert → ocanvas).
/// `urlsrc` is `{public}/v1/launch?`; hosts append `WOPISrc=<encoded>&…` (Collabora style) and
/// POST `access_token` + `access_token_ttl`.
pub fn discovery_xml(public: &str) -> String {
    let zone = if public.starts_with("https://") {
        "external-https"
    } else {
        "external-http"
    };
    let launch = xml_attr(&format!("{public}/v1/launch?"));
    let caps = xml_attr(&format!("{public}/hosting/capabilities"));
    let action = |name: &str, ext: &str, extra: &str| {
        format!(r#"      <action name="{name}" ext="{ext}" {extra}urlsrc="{launch}"/>"#)
    };
    let lines = [
        r#"<?xml version="1.0" encoding="utf-8"?>"#.to_string(),
        "<wopi-discovery>".into(),
        format!(r#"  <net-zone name="{zone}">"#),
        r#"    <app name="application/vnd.opencanvas+zip">"#.into(),
        action("edit", "ocanvas", r#"default="true" "#),
        action("view", "ocanvas", ""),
        "    </app>".into(),
        r#"    <app name="text/markdown">"#.into(),
        action("edit", "md", r#"default="true" "#),
        action("view", "md", ""),
        action("convert", "md", r#"targetext="ocanvas" "#),
        "    </app>".into(),
        r#"    <app name="Capabilities">"#.into(),
        format!(r#"      <action name="getinfo" ext="" urlsrc="{caps}"/>"#),
        "    </app>".into(),
        "  </net-zone>".into(),
        "</wopi-discovery>".into(),
    ];
    lines.join("\n") + "\n"
}

/// `GET /hosting/capabilities` (Collabora-compatible; Nextcloud asks for it).
pub fn capabilities() -> Value {
    serde_json::json!({
        "productName": "OpenCanvas",
        "productVersion": env!("CARGO_PKG_VERSION"),
        "hasMobileSupport": true,
        "hasProxyPrefix": false,
        "hasTemplateSaveAs": false,
        "hasTemplateSource": false,
        "hasWASMSupport": false,
        "hasZoteroSupport": false,
        "convert-to": {"available": false},
    })
}

// ---------------------------------------------------------------- UTF-7 (X-WOPI-SuggestedTarget)

/// RFC 2152 UTF-7, as WOPI requires for `X-WOPI-SuggestedTarget`.
pub fn utf7(s: &str) -> String {
    fn flush(out: &mut String, buf: &mut Vec<u16>) {
        if buf.is_empty() {
            return;
        }
        let bytes: Vec<u8> = buf.iter().flat_map(|u| u.to_be_bytes()).collect();
        out.push('+');
        out.push_str(&base64::engine::general_purpose::STANDARD_NO_PAD.encode(bytes));
        out.push('-');
        buf.clear();
    }
    let mut out = String::new();
    let mut buf = Vec::new();
    for c in s.chars() {
        if c == '+' {
            flush(&mut out, &mut buf);
            out.push_str("+-");
        } else if (' '..='~').contains(&c) && c != '\\' && c != '~' {
            flush(&mut out, &mut buf);
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            buf.extend_from_slice(c.encode_utf16(&mut units));
        }
    }
    flush(&mut out, &mut buf);
    out
}

// ---------------------------------------------------------------- calls to the WOPI host

fn with_token(src: &Url, contents: bool, token: &str) -> Url {
    let mut u = src.clone();
    if contents && let Ok(mut segs) = u.path_segments_mut() {
        segs.pop_if_empty().push("contents");
    }
    u.query_pairs_mut().append_pair("access_token", token);
    u
}

/// The response body, at most `limit` bytes.
async fn body(mut res: reqwest::Response, limit: usize) -> Result<Bytes, HostError> {
    if res.content_length().is_some_and(|l| l > limit as u64) {
        return Err(HostError::Body("file too large".into()));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(net)? {
        buf.extend_from_slice(&chunk);
        if buf.len() > limit {
            return Err(HostError::Body("file too large".into()));
        }
    }
    Ok(buf.into())
}

/// `GET {WOPISrc}?access_token=` → CheckFileInfo.
pub async fn check_file_info(
    http: &reqwest::Client,
    src: &Url,
    token: &str,
) -> Result<FileInfo, HostError> {
    let res = http
        .get(with_token(src, false, token))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(net)?;
    if !res.status().is_success() {
        return Err(HostError::Status(res.status()));
    }
    let bytes = body(res, 1024 * 1024).await?;
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|_| HostError::Body("CheckFileInfo is not JSON".into()))?;
    FileInfo::from_json(&v)
}

/// `GET {WOPISrc}/contents?access_token=` → GetFile: (bytes, content type).
pub async fn get_contents(
    http: &reqwest::Client,
    src: &Url,
    token: &str,
) -> Result<(Bytes, String), HostError> {
    let res = http
        .get(with_token(src, true, token))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(net)?;
    if !res.status().is_success() {
        return Err(HostError::Status(res.status()));
    }
    let ctype = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    Ok((body(res, MAX_FILE_BYTES).await?, ctype))
}

/// Result of a PutFile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutResult {
    /// Saved; `LastModifiedTime` when the host returned it.
    Saved(Option<String>),
    /// `409` with `COOLStatusCode` 1010: the file changed outside the session.
    Conflict,
}

/// The headers of a PutFile (besides the body): `X-WOPI-Override: PUT`, the timestamp the
/// session started from, and the Collabora autosave flags.
pub fn put_headers(timestamp: Option<&str>) -> Vec<(&'static str, String)> {
    let mut h = vec![
        ("X-WOPI-Override", "PUT".to_string()),
        ("X-COOL-WOPI-IsAutosave", "true".to_string()),
        ("X-COOL-WOPI-IsModifiedByUser", "true".to_string()),
    ];
    if let Some(t) = timestamp.filter(|t| !t.starts_with(VERSION_PREFIX)) {
        h.push(("X-COOL-WOPI-Timestamp", t.to_string()));
    }
    h
}

/// `POST {WOPISrc}/contents?access_token=` with `X-WOPI-Override: PUT` → PutFile.
pub async fn put_contents(
    http: &reqwest::Client,
    src: &Url,
    token: &str,
    body_bytes: Vec<u8>,
    timestamp: Option<&str>,
) -> Result<PutResult, HostError> {
    let mut rb = http
        .post(with_token(src, true, token))
        .timeout(Duration::from_secs(10))
        .header(header::CONTENT_TYPE, "application/octet-stream");
    for (k, v) in put_headers(timestamp) {
        rb = rb.header(k, v);
    }
    let res = rb.body(body_bytes).send().await.map_err(net)?;
    let status = res.status();
    let answer: Value = body(res, 1024 * 1024)
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if status == StatusCode::CONFLICT {
        let code = answer
            .get("COOLStatusCode")
            .or_else(|| answer.get("LOOLStatusCode"))
            .and_then(Value::as_i64);
        return if code == Some(1010) {
            Ok(PutResult::Conflict)
        } else {
            Err(HostError::Status(status))
        };
    }
    if !status.is_success() {
        return Err(HostError::Status(status));
    }
    Ok(PutResult::Saved(text(&answer, "LastModifiedTime")))
}

/// `POST {WOPISrc}?access_token=` with `X-WOPI-Override: PUT_RELATIVE` (conflict policy
/// `copy`). Returns the new file's `WOPISrc` (without its token) and a URL for people
/// (`HostEditUrl`, else `HostViewUrl`, else empty).
pub async fn put_relative(
    http: &reqwest::Client,
    src: &Url,
    token: &str,
    body_bytes: Vec<u8>,
    suggested: &str,
) -> Result<(String, String), HostError> {
    let res = http
        .post(with_token(src, false, token))
        .timeout(Duration::from_secs(10))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header("X-WOPI-Override", "PUT_RELATIVE")
        .header("X-WOPI-SuggestedTarget", utf7(suggested))
        .header("X-WOPI-Size", body_bytes.len().to_string())
        .body(body_bytes)
        .send()
        .await
        .map_err(net)?;
    if !res.status().is_success() {
        return Err(HostError::Status(res.status()));
    }
    let v: Value = serde_json::from_slice(&body(res, 1024 * 1024).await?)
        .map_err(|_| HostError::Body("PutRelativeFile answer is not JSON".into()))?;
    let mut new_src = text(&v, "Url")
        .and_then(|u| Url::parse(&u).ok())
        .ok_or_else(|| HostError::Body("PutRelativeFile answer without Url".into()))?;
    new_src.set_query(None);
    let url = text(&v, "HostEditUrl")
        .or_else(|| text(&v, "HostViewUrl"))
        .unwrap_or_default();
    Ok((new_src.to_string(), url))
}

/// The name for a conflict copy of `name`.
pub fn copy_name(name: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s).trim();
    if stem.is_empty() {
        ".ocanvas".into()
    } else {
        format!("{stem} (conflict copy).ocanvas")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn allow() -> Vec<String> {
        vec![
            "http://localhost:4300".into(),
            "https://cloud.example.com/index.php/apps/richdocuments/wopi".into(),
        ]
    }

    #[test]
    fn allowlist_admits_configured_origins_only() {
        let a = allow();
        let ok = check_src(&a, "http://localhost:4300/wopi/files/doc_1").unwrap();
        assert_eq!(ok.as_str(), "http://localhost:4300/wopi/files/doc_1");
        // Host names are case-insensitive and normalized.
        assert!(check_src(&a, "http://LOCALHOST:4300/wopi/files/doc_1").is_some());
        assert!(
            check_src(
                &a,
                "https://cloud.example.com/index.php/apps/richdocuments/wopi/files/12_oc"
            )
            .is_some()
        );
        assert!(
            check_src(
                &a,
                "https://cloud.example.com:443/index.php/apps/richdocuments/wopi/files/1"
            )
            .is_some()
        );
        for bad in [
            // Other origins.
            "https://evil.example/wopi/files/1",
            "http://localhost:4301/wopi/files/1",
            "https://localhost:4300/wopi/files/1",
            "http://127.0.0.1:4300/wopi/files/1",
            "http://[::1]:4300/wopi/files/1",
            "http://0.0.0.0:4300/wopi/files/1",
            // localhost tricks.
            "http://localhost:4300@evil.example/wopi/files/1",
            "http://user:pw@localhost:4300/wopi/files/1",
            "http://localhost:4300.evil.example/wopi/files/1",
            "http://localhost.evil.example:4300/wopi/files/1",
            "http://evil.example/?u=http://localhost:4300/wopi/files/1",
            "http://evil.example/http://localhost:4300/wopi",
            "http://localhost:43000/wopi/files/1",
            "//localhost:4300/wopi/files/1",
            "localhost:4300/wopi/files/1",
            // Path prefix must hold at a segment boundary, also after normalization.
            "https://cloud.example.com/index.php/apps/richdocuments/wopiX/files/1",
            "https://cloud.example.com/index.php/apps/richdocuments/wopi/../../../admin",
            "https://cloud.example.com/admin",
            // No query / fragment / odd schemes.
            "http://localhost:4300/wopi/files/1?access_token=x",
            "http://localhost:4300/wopi/files/1#x",
            "file:///etc/passwd",
            "ftp://localhost:4300/x",
            "",
        ] {
            assert_eq!(check_src(&a, bad), None, "{bad}");
        }
        let long = format!("http://localhost:4300/{}", "a".repeat(300));
        assert_eq!(check_src(&a, &long), None);
    }

    fn info(v: Value) -> FileInfo {
        FileInfo::from_json(&v).unwrap()
    }

    #[test]
    fn check_file_info_maps_roles_and_perms() {
        let base = json!({"BaseFileName": "Plan.ocanvas", "UserId": "u1"});
        let with = |extra: Value| {
            let mut v = base.clone();
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            info(v)
        };
        assert_eq!(with(json!({"UserCanWrite": true})).role(), Role::Edit);
        assert_eq!(
            with(json!({"UserCanWrite": true, "ReadOnly": true})).role(),
            Role::View
        );
        assert_eq!(
            with(
                json!({"UserCanWrite": true, "ReadOnly": true, "OpenCanvas_UserCanComment": true})
            )
            .role(),
            Role::Comment
        );
        assert_eq!(
            with(json!({"OpenCanvas_UserCanComment": true})).role(),
            Role::Comment
        );
        assert_eq!(with(json!({})).role(), Role::View);
        assert_eq!(with(json!({"UserCanWrite": "true"})).role(), Role::Edit);

        let p = with(json!({"UserCanWrite": true})).perms();
        assert!(p.export && p.download && p.print && p.comment);
        let p = with(json!({"DisableExport": true})).perms();
        assert!(!p.export && !p.download && !p.print && !p.comment);
        let p = with(json!({"UserCanWrite": true, "HideExportOption": true})).perms();
        assert!(!p.export && p.download && p.print);
        let p = with(json!({"UserCanWrite": true, "DisablePrint": true})).perms();
        assert!(p.export && p.download && !p.print);

        let i = with(json!({
            "UserCanWrite": true, "Size": 42, "Version": 7,
            "LastModifiedTime": "2026-11-21T10:00:00.0000000Z",
            "UserFriendlyName": "Asha Rao",
            "UserExtraInfo": {"avatar": "https://cloud.example.com/a.png"}
        }));
        let src = Url::parse("http://localhost:4300/wopi/files/doc_1").unwrap();
        let g = i.grant("wopi-sample", &src, "tok");
        assert_eq!(g.user.name, "Asha Rao");
        assert_eq!(
            g.user.avatar.as_deref(),
            Some("https://cloud.example.com/a.png")
        );
        assert_eq!(g.file.id, src.as_str());
        assert_eq!(g.file.name, "Plan.ocanvas");
        assert_eq!(
            g.file.version.as_deref(),
            Some("2026-11-21T10:00:00.0000000Z")
        );
        assert_eq!(i.size, Some(42));
        assert_eq!(i.version.as_deref(), Some("7"));
        assert_eq!(g.room, room_id("wopi-sample", src.as_str()));
        assert_eq!(g.callback_token, "tok");
        // UserExtraInfo as a JSON string; non-http avatars are dropped.
        let i = with(json!({"UserExtraInfo": "{\"avatar\":\"javascript:alert(1)\"}"}));
        assert_eq!(i.avatar, None);
        assert!(FileInfo::from_json(&json!({"BaseFileName": "x"})).is_err());
        // Without LastModifiedTime the version is display-only and never sent as a timestamp.
        let i = with(json!({"Version": "9"}));
        assert_eq!(i.stamp().as_deref(), Some("v:9"));
        assert!(
            put_headers(i.stamp().as_deref())
                .iter()
                .all(|(k, _)| *k != "X-COOL-WOPI-Timestamp")
        );
    }

    #[test]
    fn discovery_advertises_ocanvas_and_md() {
        let xml = discovery_xml("https://canvas.example.com");
        assert!(xml.starts_with("<?xml"));
        assert!(xml.contains("<wopi-discovery>") && xml.ends_with("</wopi-discovery>\n"));
        assert!(xml.contains(r#"<net-zone name="external-https">"#));
        let launch = r#"urlsrc="https://canvas.example.com/v1/launch?""#;
        for action in [
            r#"<action name="edit" ext="ocanvas" default="true" "#,
            r#"<action name="view" ext="ocanvas" "#,
            r#"<action name="edit" ext="md" default="true" "#,
            r#"<action name="view" ext="md" "#,
            r#"<action name="convert" ext="md" targetext="ocanvas" "#,
        ] {
            let line = xml
                .lines()
                .find(|l| l.contains(action))
                .unwrap_or_else(|| panic!("missing {action}"));
            assert!(line.contains(launch), "{line}");
        }
        assert!(xml.contains(r#"<app name="Capabilities">"#));
        assert!(xml.contains("https://canvas.example.com/hosting/capabilities"));
        assert!(discovery_xml("http://localhost:8380").contains(r#"name="external-http""#));
        assert!(discovery_xml("http://x/?a&b").contains("a&amp;b"));
    }

    #[test]
    fn put_headers_carry_the_cool_flags() {
        let h = put_headers(Some("2026-11-21T10:00:00Z"));
        let get = |k: &str| h.iter().find(|(n, _)| *n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("X-WOPI-Override"), Some("PUT"));
        assert_eq!(get("X-COOL-WOPI-Timestamp"), Some("2026-11-21T10:00:00Z"));
        assert_eq!(get("X-COOL-WOPI-IsAutosave"), Some("true"));
        assert_eq!(get("X-COOL-WOPI-IsModifiedByUser"), Some("true"));
        assert_eq!(put_headers(None).len(), 3);
    }

    #[test]
    fn utf7_and_copy_names() {
        assert_eq!(
            utf7("Plan (conflict copy).ocanvas"),
            "Plan (conflict copy).ocanvas"
        );
        assert_eq!(utf7("a+b"), "a+-b");
        assert_eq!(utf7("Hi Mom -☺-!"), "Hi Mom -+Jjo--!");
        assert_eq!(utf7("日本語"), "+ZeVnLIqe-");
        assert_eq!(copy_name("Plan.ocanvas"), "Plan (conflict copy).ocanvas");
        assert_eq!(copy_name("notes.md"), "notes (conflict copy).ocanvas");
        assert_eq!(copy_name(""), ".ocanvas");
    }
}
