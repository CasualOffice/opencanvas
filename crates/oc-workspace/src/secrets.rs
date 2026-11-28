// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Generated secrets (ADR-085 §2): written on first start into `<data>/secrets` with mode 0600,
//! unless the operator gives them in the environment. Losing them makes the engine's saved
//! callback tokens unreadable and signs everyone out, so backups include them (encrypted).

use std::path::Path;

use anyhow::Context;

#[derive(Clone)]
pub struct Secrets {
    /// `jwt_secret` of the Workspace's `[[host]]`: signs launch tokens; the engine signs
    /// callbacks with it too (docs/05 §5).
    pub host_secret: String,
    /// `api_key` of the `[[host]]`: the role and session API (docs/05 §7).
    pub host_api_key: String,
    /// The engine's `OC_KEK` (base64 of 32 bytes).
    pub kek_b64: String,
    /// HMAC key for callback tokens and link tokens; never leaves this process.
    pub token_key: Vec<u8>,
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secrets(..)")
    }
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Reads `name` from the environment, else from `dir/name`, else generates it there (0600).
fn one(dir: &Path, name: &str, env: &str, make: impl FnOnce() -> String) -> anyhow::Result<String> {
    if let Ok(v) = std::env::var(env)
        && !v.trim().is_empty()
    {
        return Ok(v.trim().to_string());
    }
    let path = dir.join(name);
    if path.exists() {
        return Ok(std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?
            .trim()
            .to_string());
    }
    let v = make();
    write_private(&path, &v)?;
    tracing::info!(file = %path.display(), "generated secret");
    Ok(v)
}

fn write_private(path: &Path, v: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    f.write_all(v.as_bytes())?;
    f.sync_all()?;
    Ok(())
}

impl Secrets {
    pub fn load_or_create(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let rnd = |n| crate::util::random_bytes(n);
        let host_secret = one(dir, "host_secret", "WS_HOST_SECRET", || {
            hex::encode(rnd(32))
        })?;
        anyhow::ensure!(
            host_secret.len() >= 32,
            "WS_HOST_SECRET must be at least 32 characters"
        );
        let host_api_key = one(dir, "host_api_key", "WS_HOST_API_KEY", || {
            hex::encode(rnd(32))
        })?;
        let kek_b64 = one(dir, "oc_kek", "OC_KEK", || b64(&rnd(32)))?;
        let token_key = hex::decode(one(dir, "token_key", "WS_TOKEN_KEY", || {
            hex::encode(rnd(32))
        })?)
        .context("token_key is not hex")?;
        Ok(Self {
            host_secret,
            host_api_key,
            kek_b64,
            token_key,
        })
    }

    /// Fixed secrets for tests.
    pub fn for_tests() -> Self {
        Self {
            host_secret: "test-host-secret-0123456789abcdef0123456789".into(),
            host_api_key: "test-api-key".into(),
            kek_b64: b64(&[7u8; 32]),
            token_key: vec![9u8; 32],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_generated_once_and_private() {
        let dir = std::env::temp_dir().join(format!("ws-secrets-{}", crate::util::token(6)));
        let a = Secrets::load_or_create(&dir).unwrap();
        let b = Secrets::load_or_create(&dir).unwrap();
        assert_eq!(a.host_secret, b.host_secret);
        assert_eq!(a.kek_b64, b.kek_b64);
        assert_ne!(a.host_secret, a.host_api_key);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let m = std::fs::metadata(dir.join("host_secret"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(m & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
