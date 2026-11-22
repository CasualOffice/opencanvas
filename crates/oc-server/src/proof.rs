// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! WOPI proof keys (docs/05 §6.4): every call OpenCanvas makes to a WOPI host carries
//! `X-WOPI-TimeStamp`, `X-WOPI-Proof` and `X-WOPI-ProofOld`, so the host can check that the
//! request comes from this server. The public halves are published in `/hosting/discovery`.
//!
//! Spec (Microsoft "Verifying that requests originate from Office for the web by using proof
//! keys"): the signed bytes are
//!
//! ```text
//! be32(len(access_token)) ‖ access_token (UTF-8)
//! be32(len(URL))          ‖ uppercase(full request URL, query included)
//! be32(8)                 ‖ be64(X-WOPI-TimeStamp, .NET ticks)
//! ```
//!
//! signed with RSASSA-PKCS1-v1_5 / SHA-256. `X-WOPI-Proof` is the signature with the current
//! key, `X-WOPI-ProofOld` with the old one (rotation: hosts accept either).
//!
//! RSA here is the constant-time `rsa` 0.10 (crypto-bigint), not 0.9 (RUSTSEC-2023-0071).

use std::path::Path;
use std::sync::{Arc, OnceLock};

use anyhow::{Context, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::sha2::Sha256;
use rsa::traits::PublicKeyParts;
use rsa::{PrivateKey, PublicKey};

use crate::crypto::{self, Kek};

/// Associated data of a proof key sealed with `OC_KEK` (`opencanvas seal-proof-key`).
pub const SEAL_AAD: &str = "wopi-proof-key";
/// Key size generated in development.
pub const DEV_BITS: usize = 2048;
/// .NET ticks (100 ns since 0001-01-01) at the Unix epoch.
pub const TICKS_AT_UNIX_EPOCH: i64 = 621_355_968_000_000_000;

/// `X-WOPI-TimeStamp` for a Unix time in milliseconds.
pub fn ticks_from_unix_ms(ms: i64) -> i64 {
    ms * 10_000 + TICKS_AT_UNIX_EPOCH
}

/// `X-WOPI-TimeStamp` now.
pub fn ticks_now() -> i64 {
    ticks_from_unix_ms(crate::util::now_ms())
}

/// The bytes a proof signs (see the module docs).
pub fn proof_bytes(access_token: &str, url: &str, ticks: i64) -> Vec<u8> {
    let token = access_token.as_bytes();
    let url = url.to_uppercase();
    let url = url.as_bytes();
    let mut out = Vec::with_capacity(4 + token.len() + 4 + url.len() + 4 + 8);
    out.extend_from_slice(&(token.len() as u32).to_be_bytes());
    out.extend_from_slice(token);
    out.extend_from_slice(&(url.len() as u32).to_be_bytes());
    out.extend_from_slice(url);
    out.extend_from_slice(&8u32.to_be_bytes());
    out.extend_from_slice(&ticks.to_be_bytes());
    out
}

/// A Microsoft CryptoAPI `PUBLICKEYBLOB` (the discovery `value`): `BLOBHEADER` (type 0x06,
/// version 2, `CALG_RSA_KEYX`), `RSAPUBKEY` (`RSA1`, bit length, exponent), then the modulus,
/// all little-endian.
pub fn csp_blob(key: &PublicKey) -> Vec<u8> {
    let n = key.n_bytes();
    let bits = (key.size() * 8) as u32;
    let mut e = [0u8; 4];
    let eb = key.e_bytes();
    e[4 - eb.len()..].copy_from_slice(&eb);
    let mut out = vec![0x06, 0x02, 0x00, 0x00];
    out.extend_from_slice(&0x0000_a400u32.to_le_bytes());
    out.extend_from_slice(b"RSA1");
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(&u32::from_be_bytes(e).to_le_bytes());
    let mut modulus = vec![0u8; key.size() - n.len()];
    modulus.extend_from_slice(&n);
    modulus.reverse();
    out.extend_from_slice(&modulus);
    out
}

/// The three discovery attributes of one key: CSP blob, modulus, exponent (base64).
pub fn public_parts(key: &PublicKey) -> (String, String, String) {
    (
        STANDARD.encode(csp_blob(key)),
        STANDARD.encode(key.n_bytes()),
        STANDARD.encode(key.e_bytes()),
    )
}

/// The proof headers of one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proof {
    pub timestamp: i64,
    pub proof: String,
    pub proof_old: String,
}

impl Proof {
    pub fn headers(&self) -> [(&'static str, String); 3] {
        [
            ("X-WOPI-TimeStamp", self.timestamp.to_string()),
            ("X-WOPI-Proof", self.proof.clone()),
            ("X-WOPI-ProofOld", self.proof_old.clone()),
        ]
    }
}

/// The current and old proof keys. Without an old key, the current one is used for both.
#[derive(Clone)]
pub struct ProofKeys {
    current: Arc<PrivateKey>,
    old: Arc<PrivateKey>,
}

impl std::fmt::Debug for ProofKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProofKeys(..)")
    }
}

fn parse_pem(pem: &str) -> anyhow::Result<PrivateKey> {
    PrivateKey::from_pkcs8_pem(pem)
        .or_else(|_| PrivateKey::from_pkcs1_pem(pem))
        .map_err(|_| anyhow!("not an RSA private key in PKCS#8 or PKCS#1 PEM"))
}

/// A key file: PEM, or a PEM sealed with `OC_KEK` (`enc:v1:…`).
fn read_key(path: &Path, kek: Option<&Kek>) -> anyhow::Result<PrivateKey> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading WOPI proof key {}", path.display()))?;
    let pem = crypto::open(kek, raw.trim(), SEAL_AAD)
        .with_context(|| format!("opening sealed WOPI proof key {}", path.display()))?;
    let key = parse_pem(&pem).with_context(|| format!("WOPI proof key {}", path.display()))?;
    if key.size() < 256 {
        bail!(
            "WOPI proof key {} must be at least 2048 bits",
            path.display()
        );
    }
    Ok(key)
}

impl ProofKeys {
    pub fn new(current: PrivateKey, old: Option<PrivateKey>) -> Self {
        let current = Arc::new(current);
        let old = old.map(Arc::new).unwrap_or_else(|| current.clone());
        Self { current, old }
    }

    pub fn from_pem(current: &str, old: Option<&str>) -> anyhow::Result<Self> {
        Ok(Self::new(parse_pem(current)?, old.map(parse_pem).transpose()?))
    }

    /// A fresh 2048-bit pair (development), generated once per process.
    pub fn dev() -> anyhow::Result<Self> {
        static DEV: OnceLock<ProofKeys> = OnceLock::new();
        if let Some(k) = DEV.get() {
            return Ok(k.clone());
        }
        let key = PrivateKey::new(&mut getrandom::SysRng, DEV_BITS)
            .map_err(|e| anyhow!("generating a WOPI proof key: {e}"))?;
        Ok(DEV.get_or_init(|| Self::new(key, None)).clone())
    }

    /// `OC_WOPI_PROOF_KEY` / `OC_WOPI_PROOF_KEY_OLD` (paths); in development, without them, a
    /// generated pair. `None`: no keys (refused at start-up when a host speaks WOPI).
    pub fn load(
        current: Option<&str>,
        old: Option<&str>,
        kek: Option<&Kek>,
        dev: bool,
    ) -> anyhow::Result<Option<Self>> {
        match current {
            Some(p) => {
                let cur = read_key(Path::new(p), kek)?;
                let old = old.map(|p| read_key(Path::new(p), kek)).transpose()?;
                Ok(Some(Self::new(cur, old)))
            }
            None if old.is_some() => bail!("OC_WOPI_PROOF_KEY_OLD needs OC_WOPI_PROOF_KEY"),
            None if dev => {
                tracing::warn!(
                    "OC_DEV=1 and no OC_WOPI_PROOF_KEY: WOPI proof keys generated for this process"
                );
                Self::dev().map(Some)
            }
            None => Ok(None),
        }
    }

    pub fn current_public(&self) -> PublicKey {
        self.current.to_public_key()
    }

    pub fn old_public(&self) -> PublicKey {
        self.old.to_public_key()
    }

    /// Signs one request: `url` is the exact URL sent (query and `access_token` included).
    pub fn sign(&self, access_token: &str, url: &str, ticks: i64) -> Proof {
        let msg = proof_bytes(access_token, url, ticks);
        let sign = |k: &PrivateKey| {
            STANDARD.encode(
                k.pkcs1v15_sign::<Sha256>(&msg)
                    .expect("PKCS#1 v1.5 signing with a valid key does not fail"),
            )
        };
        Proof {
            timestamp: ticks,
            proof: sign(&self.current),
            proof_old: sign(&self.old),
        }
    }

    /// The discovery `<proof-key …/>` element.
    pub fn discovery_element(&self) -> String {
        let (value, modulus, exponent) = public_parts(&self.current_public());
        let (oldvalue, oldmodulus, oldexponent) = public_parts(&self.old_public());
        format!(
            r#"<proof-key oldvalue="{oldvalue}" oldmodulus="{oldmodulus}" oldexponent="{oldexponent}" value="{value}" modulus="{modulus}" exponent="{exponent}"/>"#
        )
    }
}

/// Verifies `X-WOPI-Proof` / `X-WOPI-ProofOld` as a host would (tests and tooling): any of
/// proof/current, proofOld/current, proof/old.
pub fn verify(
    current: &PublicKey,
    old: &PublicKey,
    access_token: &str,
    url: &str,
    p: &Proof,
) -> bool {
    let msg = proof_bytes(access_token, url, p.timestamp);
    let ok = |k: &PublicKey, sig: &str| {
        STANDARD
            .decode(sig)
            .is_ok_and(|s| k.pkcs1v15_verify::<Sha256>(&msg, &s).is_ok())
    };
    ok(current, &p.proof) || ok(current, &p.proof_old) || ok(old, &p.proof)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CUR: &str = include_str!("../tests/keys/rsa.pem");
    const OLD: &str = include_str!("../tests/keys/wopi-proof-old.pem");
    const URL: &str = "http://localhost:4300/wopi/files/doc_1?access_token=ab";

    /// Hand-derived from the spec: lengths are big-endian u32, the URL is uppercased, the
    /// timestamp is a big-endian i64 preceded by its length 8.
    #[test]
    fn proof_bytes_follow_the_spec_layout() {
        let got = proof_bytes("ab", URL, 0x0102_0304_0506_0708);
        let mut want = vec![0, 0, 0, 2, b'a', b'b', 0, 0, 0, 54];
        want.extend_from_slice(b"HTTP://LOCALHOST:4300/WOPI/FILES/DOC_1?ACCESS_TOKEN=AB");
        want.extend_from_slice(&[0, 0, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(got, want);
        // The token keeps its case; only the URL is uppercased.
        assert_eq!(&proof_bytes("aB", "x", 1)[4..6], b"aB");
        // .NET ticks: the Unix epoch, and 2026-11-23T00:00:00Z.
        assert_eq!(ticks_from_unix_ms(0), 621_355_968_000_000_000);
        assert_eq!(ticks_from_unix_ms(1_795_392_000_000), 639_309_888_000_000_000);
    }

    /// Cross-checked with OpenSSL: `openssl dgst -sha256 -sign tests/keys/rsa.pem` over the
    /// spec bytes of ("ab", URL, 1) gives this signature (PKCS#1 v1.5 is deterministic).
    #[test]
    fn signature_matches_openssl_and_verifies_with_the_public_key() {
        let keys = ProofKeys::from_pem(CUR, Some(OLD)).unwrap();
        let p = keys.sign("ab", URL, 1);
        assert_eq!(p.proof, include_str!("../tests/keys/wopi-proof-vector.b64").trim());
        let (cur, old) = (keys.current_public(), keys.old_public());
        assert!(verify(&cur, &old, "ab", URL, &p));
        // ProofOld is the old key's signature.
        let msg = proof_bytes("ab", URL, 1);
        let sig_old = STANDARD.decode(&p.proof_old).unwrap();
        assert!(old.pkcs1v15_verify::<Sha256>(&msg, &sig_old).is_ok());
        assert!(cur.pkcs1v15_verify::<Sha256>(&msg, &sig_old).is_err());
        // Any change to the token, URL or timestamp breaks it.
        assert!(!verify(&cur, &old, "ac", URL, &p));
        assert!(!verify(&cur, &old, "ab", &format!("{URL}x"), &p));
        let mut later = p.clone();
        later.timestamp += 1;
        assert!(!verify(&cur, &old, "ab", URL, &later));
        // URL case does not matter (it is uppercased before signing).
        assert!(verify(&cur, &old, "ab", &URL.to_uppercase(), &p));
    }

    #[test]
    fn discovery_element_publishes_blob_modulus_and_exponent() {
        let keys = ProofKeys::from_pem(CUR, Some(OLD)).unwrap();
        let el = keys.discovery_element();
        let attr = |name: &str| {
            let start = el.find(&format!(" {name}=\"")).unwrap() + name.len() + 3;
            let len = el[start..].find('"').unwrap();
            STANDARD.decode(&el[start..start + len]).unwrap()
        };
        let cur = keys.current_public();
        assert_eq!(attr("modulus"), cur.n_bytes().to_vec());
        assert_eq!(attr("exponent"), vec![1, 0, 1]);
        assert_eq!(attr("oldmodulus"), keys.old_public().n_bytes().to_vec());
        let blob = attr("value");
        assert_eq!(blob.len(), 8 + 12 + 256);
        assert_eq!(&blob[..8], &[0x06, 0x02, 0, 0, 0x00, 0xa4, 0, 0]);
        assert_eq!(&blob[8..12], b"RSA1");
        assert_eq!(&blob[12..16], &2048u32.to_le_bytes());
        assert_eq!(&blob[16..20], &65537u32.to_le_bytes());
        let mut n = blob[20..].to_vec();
        n.reverse();
        assert_eq!(n, cur.n_bytes().to_vec());
        assert_ne!(attr("oldvalue"), blob);
        // No old key: the current key is published (and signs) for both.
        let single = ProofKeys::from_pem(CUR, None).unwrap();
        let el = single.discovery_element();
        assert!(el.contains(&format!(
            r#"oldmodulus="{}""#,
            STANDARD.encode(cur.n_bytes())
        )));
    }

    #[test]
    fn keys_load_from_pem_or_sealed_files_and_dev_generates() {
        let dir = std::env::temp_dir().join(format!("oc-proof-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let kek = Kek::from_b64("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=").unwrap();
        let (cur, old) = (dir.join("cur.pem"), dir.join("old.sealed"));
        std::fs::write(&cur, CUR).unwrap();
        std::fs::write(&old, kek.seal(OLD, SEAL_AAD)).unwrap();
        let p = |p: &Path| p.to_str().unwrap().to_string();
        let k = ProofKeys::load(Some(&p(&cur)), Some(&p(&old)), Some(&kek), false)
            .unwrap()
            .unwrap();
        let want = ProofKeys::from_pem(CUR, Some(OLD)).unwrap();
        assert_eq!(k.discovery_element(), want.discovery_element());
        // A sealed key needs OC_KEK.
        assert!(ProofKeys::load(Some(&p(&old)), None, None, false).is_err());
        // Garbage is refused.
        std::fs::write(&cur, "not a key").unwrap();
        assert!(ProofKeys::load(Some(&p(&cur)), None, None, false).is_err());
        assert!(ProofKeys::load(None, Some(&p(&old)), None, true).is_err());
        assert!(ProofKeys::load(None, None, None, false).unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
