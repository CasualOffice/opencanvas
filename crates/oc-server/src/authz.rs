// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Who is calling the headless API (docs/27 §4.2, ADR-041), and what they may do on a file.
//!
//! A [`Principal`] is a host's API key (server to server, full access to the host's files).
//! Every operation turns it into a per-file [`Grant`] through [`Principal::grant`], the one
//! place that decides the effective role.

use std::sync::Arc;

use axum::http::HeaderMap;

use crate::SharedState;
use crate::ai::tools::{ToolCtx, ToolError};
use crate::grant::{FileRef, Grant, Perms, Role, User, derive_color, room_id};
use crate::hosts::HostConfig;

/// How the caller proved who it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Via {
    /// `X-OpenCanvas-Host` + `X-OpenCanvas-Key`.
    HostKey,
}

/// An authenticated API caller.
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
    /// Host key only: the bearer the host wants on callbacks made for this call.
    pub callback_token: String,
}

/// Why a request is not authenticated (401) or not allowed (403).
#[derive(Debug)]
pub enum AuthError {
    /// No usable credential, or a wrong one.
    Unauthenticated(&'static str),
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

impl Principal {
    /// Authenticates a request: the host key headers.
    pub async fn from_headers(state: &SharedState, headers: &HeaderMap) -> Result<Self, AuthError> {
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
            callback_token: crate::routes::callback_token_of(headers),
        })
    }

    /// The edit origin recorded on transactions: `api:<sub>` (ADR-033 style).
    pub fn origin(&self) -> String {
        format!("api:{}", self.sub)
    }

    /// The grant this caller acts under on `file_id`: the effective role is
    /// `min(credential ceiling, host role)`. `Err` when the caller has no access at all.
    pub async fn grant(&self, _state: &SharedState, file_id: &str) -> Result<Grant, ToolError> {
        let role = self.ceiling;
        Ok(Grant {
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
            },
            perms: Perms {
                export: true,
                download: true,
                comment: role != Role::View,
                print: true,
            },
            callback_token: self.callback_token.clone(),
            members: vec![],
        })
    }

    /// The tool-layer context for an operation on `file_id`.
    pub async fn tool_ctx(&self, state: &SharedState, file_id: &str) -> Result<ToolCtx, ToolError> {
        Ok(ToolCtx {
            host_id: self.host.id.clone(),
            file_id: file_id.to_string(),
            user: self.grant(state, file_id).await?,
            origin: self.origin(),
            mode_default: self.host.api_default_mode(),
        })
    }
}
