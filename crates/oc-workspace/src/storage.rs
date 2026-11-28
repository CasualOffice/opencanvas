// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! File storage (ADR-085 §4): canvas versions and assets as opaque bytes. Local disk under
//! `<data>/files` by default; S3-compatible storage is a later row (WS-11 notes). Writes go to
//! a temporary file first and are renamed into place, so a crash never leaves half a file.

use std::path::{Path, PathBuf};

use anyhow::Context;

#[derive(Clone)]
pub struct Files {
    root: PathBuf,
}

/// Keys are built only from ids we generate; anything else is refused.
fn safe(part: &str) -> anyhow::Result<&str> {
    anyhow::ensure!(
        !part.is_empty()
            && part.len() <= 80
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "bad storage key part {part:?}"
    );
    Ok(part)
}

impl Files {
    pub fn new(root: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(root).with_context(|| format!("creating {}", root.display()))?;
        Ok(Self {
            root: root.to_path_buf(),
        })
    }

    fn version_path(&self, canvas: &str, version: i64) -> anyhow::Result<PathBuf> {
        Ok(self
            .root
            .join("canvases")
            .join(safe(canvas)?)
            .join(format!("{version}.ocanvas")))
    }
    fn asset_path(&self, asset: &str) -> anyhow::Result<PathBuf> {
        Ok(self.root.join("assets").join(safe(asset)?))
    }

    async fn write(path: PathBuf, bytes: &[u8]) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let tmp = path.with_extension(format!("tmp-{}", crate::util::token(6)));
        tokio::fs::write(&tmp, bytes).await?;
        let f = tokio::fs::File::open(&tmp).await?;
        f.sync_all().await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }

    async fn read(path: PathBuf) -> anyhow::Result<Option<Vec<u8>>> {
        match tokio::fs::read(&path).await {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn put_version(
        &self,
        canvas: &str,
        version: i64,
        bytes: &[u8],
    ) -> anyhow::Result<()> {
        Self::write(self.version_path(canvas, version)?, bytes).await
    }
    pub async fn get_version(&self, canvas: &str, version: i64) -> anyhow::Result<Option<Vec<u8>>> {
        Self::read(self.version_path(canvas, version)?).await
    }
    pub async fn delete_version(&self, canvas: &str, version: i64) -> anyhow::Result<()> {
        match tokio::fs::remove_file(self.version_path(canvas, version)?).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
    /// Every file of a canvas (purge after Trash).
    pub async fn delete_canvas(&self, canvas: &str) -> anyhow::Result<()> {
        match tokio::fs::remove_dir_all(self.root.join("canvases").join(safe(canvas)?)).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
    pub async fn put_asset(&self, asset: &str, bytes: &[u8]) -> anyhow::Result<()> {
        Self::write(self.asset_path(asset)?, bytes).await
    }
    pub async fn get_asset(&self, asset: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Self::read(self.asset_path(asset)?).await
    }
    pub async fn delete_asset(&self, asset: &str) -> anyhow::Result<()> {
        match tokio::fs::remove_file(self.asset_path(asset)?).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
    pub fn canvas_dir_exists(&self, canvas: &str) -> bool {
        safe(canvas).is_ok_and(|c| self.root.join("canvases").join(c).exists())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn versions_round_trip_and_keys_are_checked() {
        let dir = std::env::temp_dir().join(format!("ws-files-{}", crate::util::token(6)));
        let f = Files::new(&dir).unwrap();
        f.put_version("c_1", 3, b"abc").await.unwrap();
        assert_eq!(
            f.get_version("c_1", 3).await.unwrap().as_deref(),
            Some(&b"abc"[..])
        );
        assert_eq!(f.get_version("c_1", 4).await.unwrap(), None);
        assert!(f.put_version("../x", 1, b"").await.is_err());
        f.delete_canvas("c_1").await.unwrap();
        assert!(!f.canvas_dir_exists("c_1"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
