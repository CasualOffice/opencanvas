//! Secrets at rest (docs/07 §2): AES-256-GCM under the key-encryption key `OC_KEK`.
//!
//! Sealed values look like `enc:v1:<base64(nonce ‖ ciphertext ‖ tag)>`. The caller passes
//! associated data (e.g. the session id) so a sealed value cannot be moved to another row.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

const PREFIX: &str = "enc:v1:";

#[derive(Clone)]
pub struct Kek(Aes256Gcm);

impl std::fmt::Debug for Kek {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Kek(..)")
    }
}

impl Kek {
    /// Parses a base64 32-byte key.
    pub fn from_b64(value: &str) -> anyhow::Result<Self> {
        let bytes = STANDARD
            .decode(value.trim())
            .context("OC_KEK is not valid base64")?;
        if bytes.len() != 32 {
            bail!("OC_KEK must decode to 32 bytes, got {}", bytes.len());
        }
        Ok(Self(
            Aes256Gcm::new_from_slice(&bytes).map_err(|_| anyhow!("bad key length"))?,
        ))
    }

    pub fn seal(&self, plaintext: &str, aad: &str) -> String {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ct = self
            .0
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .expect("AES-GCM encryption does not fail for in-memory buffers");
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        format!("{PREFIX}{}", STANDARD.encode(out))
    }

    pub fn open(&self, sealed: &str, aad: &str) -> anyhow::Result<String> {
        let raw = sealed
            .strip_prefix(PREFIX)
            .ok_or_else(|| anyhow!("value is not sealed"))?;
        let bytes = STANDARD.decode(raw).context("sealed value is not base64")?;
        if bytes.len() < 12 + 16 {
            bail!("sealed value too short");
        }
        let (nonce, ct) = bytes.split_at(12);
        let nonce: [u8; 12] = nonce.try_into().expect("split at 12");
        let pt = self
            .0
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: ct,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| anyhow!("cannot decrypt (wrong OC_KEK or tampered row)"))?;
        String::from_utf8(pt).context("decrypted value is not UTF-8")
    }
}

pub fn is_sealed(value: &str) -> bool {
    value.starts_with(PREFIX)
}

/// Optional KEK: seals when present, passes through (dev only) when absent.
pub fn seal(kek: Option<&Kek>, plaintext: &str, aad: &str) -> String {
    match kek {
        Some(k) if !plaintext.is_empty() => k.seal(plaintext, aad),
        _ => plaintext.to_string(),
    }
}

pub fn open(kek: Option<&Kek>, value: &str, aad: &str) -> anyhow::Result<String> {
    if !is_sealed(value) {
        return Ok(value.to_string());
    }
    kek.ok_or_else(|| anyhow!("encrypted value but OC_KEK is not set"))?
        .open(value, aad)
}

/// Startup rule: `OC_KEK` is required unless `OC_DEV=1`.
pub fn load_kek(value: Option<&str>, dev: bool) -> anyhow::Result<Option<Kek>> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => Kek::from_b64(v).map(Some),
        None if dev => Ok(None),
        None => bail!(
            "OC_KEK is required (base64 of 32 random bytes, e.g. `openssl rand -base64 32`); set OC_DEV=1 to run without it in development"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

    #[test]
    fn seals_and_opens_with_associated_data() {
        let k = Kek::from_b64(KEY).unwrap();
        let s = k.seal("cb-token", "ticket-1");
        assert!(s.starts_with("enc:v1:"));
        assert!(!s.contains("cb-token"));
        assert_ne!(s, k.seal("cb-token", "ticket-1"), "fresh nonce each time");
        assert_eq!(k.open(&s, "ticket-1").unwrap(), "cb-token");
        assert!(k.open(&s, "ticket-2").is_err(), "bound to its row");
        let other = Kek::from_b64(&STANDARD.encode([7u8; 32])).unwrap();
        assert!(other.open(&s, "ticket-1").is_err(), "wrong key");
    }

    #[test]
    fn kek_is_required_outside_dev() {
        assert!(load_kek(None, false).is_err());
        assert!(load_kek(Some(""), false).is_err());
        assert!(load_kek(None, true).unwrap().is_none());
        assert!(load_kek(Some("c2hvcnQ="), true).is_err(), "wrong length");
        assert!(load_kek(Some("not base64!"), false).is_err());
        assert!(load_kek(Some(KEY), false).unwrap().is_some());
    }

    #[test]
    fn plaintext_passes_through_only_without_marker() {
        assert_eq!(open(None, "plain", "a").unwrap(), "plain");
        let k = Kek::from_b64(KEY).unwrap();
        let s = seal(Some(&k), "x", "a");
        assert!(open(None, &s, "a").is_err());
        assert_eq!(open(Some(&k), &s, "a").unwrap(), "x");
    }
}
