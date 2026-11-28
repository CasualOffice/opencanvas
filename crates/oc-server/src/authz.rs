// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Who is calling the headless API or MCP, and what they may do on a file (docs/27 §4.2,
//! docs/24 §7, ADR-032, ADR-041). One check for both surfaces.
//!
//! A [`Principal`] is either a host's API key (server to server, full access to the host's
//! files) or a user-scoped bearer token the **host** minted (OpenCanvas never issues user
//! tokens, ADR-001): the same claims and keys as MCP tokens, audience-bound to the API
//! (`{base}/api/v1`) or to the host's MCP resource (`{base}/mcp/{hostId}`), at most 15 minutes.
//! Every operation turns the principal into a per-file [`Grant`] through
//! [`Principal::grant`]: effective role = `min(token scope, host role)`, the host role coming
//! from the signed `POST /access` callback when the host has one, else the token's `role` claim
//! for the files its `files` claim lists.

use std::sync::Arc;

use axum::http::{HeaderMap, header};

use crate::SharedState;
use crate::ai::HostAi;
use crate::ai::tools::{Scope, ToolCtx, ToolError, WriteMode};
use crate::grant::{FileRef, Grant, Perms, Role, User, derive_color, room_id};
use crate::hosts::HostConfig;
use crate::jwt::{JwtError, McpClaims};

/// Every scope a token may carry. `canvas:admin` (commit, role, session close, member
/// invalidation) counts only where the host allows it for tokens (`[host.api] token_admin`).
pub const SCOPES: [&str; 5] = [
    "canvas:read",
    "canvas:comment",
    "canvas:write",
    "canvas:write:direct",
    "canvas:admin",
];

/// How the caller proved who it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Via {
    /// `X-OpenCanvas-Host` + `X-OpenCanvas-Key`.
    HostKey,
    /// A user-scoped bearer token for the API (`aud` = `{base}/api/v1`).
    ApiToken,
    /// An MCP access token (`aud` = `{base}/mcp/{hostId}`).
    McpToken,
}

/// An authenticated caller.
#[derive(Clone)]
pub struct Principal {
    pub host: Arc<HostConfig>,
    pub via: Via,
    /// The user (or `svc:<name>`) the calls act for.
    pub sub: String,
    pub name: String,
    /// The highest role the credential allows, before the host's answer for a file.
    pub ceiling: Role,
    /// `canvas:admin`: commit, role changes, closing sessions.
    pub admin: bool,
    /// Tokens: the file ids the token covers (`None`: not limited by the token).
    pub files: Option<Vec<String>>,
    /// Tokens: the `role` claim, used when the host has no `/access` callback.
    pub claimed_role: Role,
    /// Without `/access`, a token with no `files` claim covers every file (host opt-in).
    pub all_files: bool,
    pub client_id: Option<String>,
    /// Host key only: the bearer the host wants on callbacks made for this call. Never a
    /// client's token (docs/24 §7.1 rule 3).
    pub callback_token: String,
}

/// Why a request is not authenticated (401) or not allowed at all (403).
#[derive(Debug, PartialEq)]
pub enum AuthError {
    /// No usable credential, or a wrong host key.
    Unauthenticated(&'static str),
    /// A bearer token that does not verify (signature, issuer, audience, lifetime).
    TokenInvalid(String),
    /// A bearer token past its `exp`.
    TokenExpired,
    /// A valid token without any `canvas:*` scope.
    InsufficientScope,
}

fn header<'a>(headers: &'a HeaderMap, k: &str) -> Option<&'a str> {
    headers.get(k).and_then(|v| v.to_str().ok())
}

/// A user id from a header: printable ASCII, at most 128 bytes.
fn clean_id(v: &str) -> Option<String> {
    let v = v.trim();
    (!v.is_empty() && v.len() <= 128 && v.bytes().all(|b| b.is_ascii_graphic()))
        .then(|| v.to_string())
}

/// The ceiling a token's scopes put on the role (`None`: no canvas scope at all).
pub fn scope_ceiling(scopes: &[&str]) -> Option<Role> {
    if scopes.contains(&"canvas:write") || scopes.contains(&"canvas:write:direct") {
        Some(Role::Edit)
    } else if scopes.contains(&"canvas:comment") {
        Some(Role::Comment)
    } else if scopes.contains(&"canvas:read") || scopes.contains(&"canvas:admin") {
        Some(Role::View)
    } else {
        None
    }
}

pub fn rank(r: Role) -> u8 {
    match r {
        Role::View => 0,
        Role::Comment => 1,
        Role::Edit => 2,
    }
}

fn min_role(a: Role, b: Role) -> Role {
    if rank(a) <= rank(b) { a } else { b }
}

pub fn scope_name(s: Scope) -> &'static str {
    match s {
        Scope::Read => "canvas:read",
        Scope::Comment => "canvas:comment",
        Scope::Write => "canvas:write",
    }
}

/// `[host.api]` settings for user tokens.
pub struct HostApi<'a>(pub &'a HostConfig);

impl HostApi<'_> {
    fn str(&self, key: &str) -> Option<&str> {
        self.0.api.get(key).and_then(|v| v.as_str())
    }

    fn flag(&self, key: &str) -> bool {
        self.0.api.get(key).and_then(|v| v.as_bool()) == Some(true)
    }

    /// `issuer`: the `iss` of this host's API tokens. Default: the host id (like launch tokens).
    pub fn issuer(&self) -> String {
        self.str("issuer")
            .map(str::to_string)
            .unwrap_or_else(|| self.0.id.clone())
    }

    /// The public base URL API tokens are bound to: `audience`, else `OC_PUBLIC_URL`. Never
    /// taken from request headers (as SEC-33); without one, user tokens are off for the host.
    pub fn base(&self, public_url: Option<&str>) -> Option<String> {
        self.str("audience")
            .or(public_url)
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty())
    }

    /// The `aud` an API token must carry.
    pub fn audience(&self, public_url: Option<&str>) -> Option<String> {
        self.base(public_url).map(|b| format!("{b}/api/v1"))
    }

    /// `all_files = true`: without `/access`, a token with no `files` claim covers every file
    /// with its `role` claim (broad; as `[host.ai] mcp_all_files`, SEC-34).
    pub fn all_files(&self) -> bool {
        self.flag("all_files")
    }

    /// `token_admin = true`: tokens with `canvas:admin` may use the admin operations. Off by
    /// default: admin is the host key's (docs/27 §4.2).
    pub fn token_admin(&self) -> bool {
        self.flag("token_admin")
    }
}

impl Principal {
    /// Authenticates an API request: `Authorization: Bearer <token>` (a user-scoped token),
    /// else the host key headers.
    pub async fn from_headers(state: &SharedState, headers: &HeaderMap) -> Result<Self, AuthError> {
        if let Some(auth) = header(headers, header::AUTHORIZATION.as_str()) {
            let token = auth
                .strip_prefix("Bearer ")
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .ok_or(AuthError::Unauthenticated(
                    "Authorization must be Bearer <token>",
                ))?;
            return Self::from_api_token(state, token).await;
        }
        let host = header(headers, "x-opencanvas-host")
            .and_then(|id| state.hosts.get(id))
            .ok_or(AuthError::Unauthenticated("missing or wrong credentials"))?;
        let expected = host.api_key.as_deref().filter(|k| !k.is_empty());
        match (expected, header(headers, "x-opencanvas-key")) {
            (Some(want), Some(got)) if crate::util::same_secret(want, got) => {}
            _ => return Err(AuthError::Unauthenticated("missing or wrong credentials")),
        }
        // The host may name the person a server-to-server call is for (attribution only).
        let sub = header(headers, "x-opencanvas-author")
            .and_then(clean_id)
            .unwrap_or_else(|| format!("svc:{}", host.id));
        Ok(Self {
            name: sub.clone(),
            sub,
            host,
            via: Via::HostKey,
            ceiling: Role::Edit,
            admin: true,
            files: None,
            claimed_role: Role::Edit,
            all_files: true,
            client_id: None,
            callback_token: crate::routes::callback_token_of(headers),
        })
    }

    /// A host-minted API token: the host is the one whose API issuer is the token's `iss`;
    /// signature with that host's launch-token keys, `aud` = its API audience, ≤ 15 min.
    pub async fn from_api_token(state: &SharedState, token: &str) -> Result<Self, AuthError> {
        let bad = |m: &str| AuthError::TokenInvalid(m.to_string());
        let iss = crate::jwt::peek_issuer(token).map_err(|_| bad("malformed token"))?;
        let mut hosts = state.hosts.iter().filter(|h| HostApi(h).issuer() == iss);
        let host = hosts.next().ok_or_else(|| bad("unknown issuer"))?.clone();
        if hosts.next().is_some() {
            // Two hosts share the issuer: the token cannot say which one it is for.
            return Err(bad("issuer is ambiguous"));
        }
        let aud = HostApi(&host)
            .audience(state.cfg.public_url.as_deref())
            .ok_or_else(|| {
                bad("user tokens need a public URL: OC_PUBLIC_URL or [host.api] audience")
            })?;
        let claims = state
            .jwks
            .verify_mcp(
                token,
                &host,
                &HostApi(&host).issuer(),
                &aud,
                crate::util::now_secs(),
            )
            .await
            .map_err(|e| match e {
                JwtError::Expired => AuthError::TokenExpired,
                JwtError::TooLong => bad("token lifetime exceeds 15 minutes"),
                other => {
                    tracing::info!(host = %host.id, error = %other, "API token refused");
                    bad("token rejected")
                }
            })?;
        let all_files = HostApi(&host).all_files();
        let admin_ok = HostApi(&host).token_admin();
        Self::from_claims(host, claims, Via::ApiToken, all_files, admin_ok)
            .ok_or(AuthError::InsufficientScope)
    }

    /// An MCP caller from its verified token (docs/24 §7.1). `None` without a canvas scope.
    pub fn from_mcp(host: Arc<HostConfig>, claims: McpClaims) -> Option<Self> {
        let all_files = HostAi(&host).mcp_all_files();
        Self::from_claims(host, claims, Via::McpToken, all_files, false)
    }

    fn from_claims(
        host: Arc<HostConfig>,
        claims: McpClaims,
        via: Via,
        all_files: bool,
        admin_ok: bool,
    ) -> Option<Self> {
        let scopes: Vec<&str> = claims.scope.split_whitespace().collect();
        let ceiling = scope_ceiling(&scopes)?;
        Some(Self {
            admin: admin_ok && scopes.contains(&"canvas:admin"),
            name: claims.name.clone().unwrap_or_else(|| claims.sub.clone()),
            sub: claims.sub,
            host,
            via,
            ceiling,
            files: claims.files,
            claimed_role: claims
                .role
                .as_deref()
                .and_then(Role::parse)
                .unwrap_or(Role::View),
            all_files,
            client_id: claims.client_id,
            callback_token: String::new(),
        })
    }

    /// The edit origin recorded on transactions: `api:<sub>` or `mcp:<clientId>`.
    pub fn origin(&self) -> String {
        match self.via {
            Via::McpToken => format!("mcp:{}", self.client_id.as_deref().unwrap_or("client")),
            _ => format!("api:{}", self.sub),
        }
    }

    /// Whether the credential's scope covers an operation that needs `scope`.
    pub fn scope_ok(&self, scope: Scope, what: &str) -> Result<(), ToolError> {
        if crate::ai::tools::role_allows(self.ceiling, scope) {
            Ok(())
        } else {
            Err(ToolError::Forbidden(format!(
                "SCOPE_REQUIRED: {what} needs {}",
                scope_name(scope)
            )))
        }
    }

    fn file_allowed(&self, file_id: &str) -> bool {
        self.files
            .as_ref()
            .is_none_or(|f| f.iter().any(|x| x == file_id))
    }

    /// The host's role for this caller on `file_id`: the `POST /access` answer when the host
    /// implements it (cached 30 s, dropped by the role API), else the token's `role` claim.
    /// `None`: no access. SEC-34: without `/access`, the claim only applies to files the token
    /// names, unless the host opts into all files.
    async fn host_role(
        &self,
        state: &SharedState,
        file_id: &str,
    ) -> Result<Option<Role>, ToolError> {
        let answer = state
            .host
            .access(&self.host, file_id, &self.sub)
            .await
            .map_err(|e| {
                tracing::warn!(host = %self.host.id, error = %e, "host access check failed");
                ToolError::Internal("the host access check failed".into())
            })?;
        match answer {
            Some(role) => Ok(role),
            None if self.files.is_none() && !self.all_files => Err(ToolError::Forbidden(
                "FILES_REQUIRED: the host has no /access callback, so the token must list the \
                 files it covers in a `files` claim (or the host allows all files)"
                    .into(),
            )),
            None => Ok(Some(self.claimed_role)),
        }
    }

    /// The grant this caller acts under on `file_id`. The effective role is
    /// `min(credential ceiling, host role)` (docs/24 §7.1 rule 4); `Err` without access.
    pub async fn grant(&self, state: &SharedState, file_id: &str) -> Result<Grant, ToolError> {
        let role = if self.via == Via::HostKey {
            Role::Edit
        } else {
            if !self.file_allowed(file_id) {
                return Err(ToolError::Forbidden(
                    "this token does not cover that file".into(),
                ));
            }
            let Some(host_role) = self.host_role(state, file_id).await? else {
                return Err(ToolError::Forbidden(
                    "ROLE_FORBIDDEN: no access to this file".into(),
                ));
            };
            min_role(host_role, self.ceiling)
        };
        Ok(Grant {
            ext_blocks: false,
            subdoc: false,
            live: Default::default(),
            wopi_history: None,
            host_id: self.host.id.clone(),
            room: room_id(&self.host.id, file_id),
            role,
            user: User {
                id: self.sub.clone(),
                name: self.name.clone(),
                color: derive_color(&self.sub),
                ..Default::default()
            },
            file: FileRef {
                id: file_id.to_string(),
                name: file_id.to_string(),
                version: None,
                app: None,
            },
            perms: Perms {
                history: None,
                restore: true,
                commit_message: true,
                export: true,
                download: true,
                // The role decides; `Perms::default()` would turn comments off for everyone.
                comment: role != Role::View,
                print: true,
                live: false,
                offline: false,
                offline_reason: None,
                automate: false,
            },
            callback_token: self.callback_token.clone(),
            members: vec![],
        })
    }

    /// Where writes to existing content land when the call does not say.
    pub fn mode_default(&self) -> WriteMode {
        match self.via {
            Via::McpToken => HostAi(&self.host).default_mode(),
            _ => self.host.api_default_mode(),
        }
    }

    /// The tool-layer context for an operation on `file_id`.
    pub async fn tool_ctx(&self, state: &SharedState, file_id: &str) -> Result<ToolCtx, ToolError> {
        Ok(ToolCtx {
            host_id: self.host.id.clone(),
            file_id: file_id.to_string(),
            user: self.grant(state, file_id).await?,
            origin: self.origin(),
            mode_default: self.mode_default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_set_the_ceiling() {
        assert_eq!(scope_ceiling(&["canvas:read"]), Some(Role::View));
        assert_eq!(scope_ceiling(&["canvas:comment"]), Some(Role::Comment));
        assert_eq!(
            scope_ceiling(&["canvas:read", "canvas:write"]),
            Some(Role::Edit)
        );
        assert_eq!(scope_ceiling(&["canvas:write:direct"]), Some(Role::Edit));
        assert_eq!(scope_ceiling(&["canvas:admin"]), Some(Role::View));
        assert_eq!(scope_ceiling(&["openid", "profile"]), None);
        assert_eq!(min_role(Role::Edit, Role::View), Role::View);
        assert_eq!(min_role(Role::Comment, Role::Edit), Role::Comment);
    }
}
