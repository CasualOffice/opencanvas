// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Search (WS-14, docs/40 §4.7, ADR-065): every save carries `search.json`; we index it into
//! SQLite FTS5 or MySQL FULLTEXT and filter by the searcher's access at query time, so a canvas
//! they cannot open never appears, not even as a count.

use std::io::Read;

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::access::Snapshot;
use crate::db::Db;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Line {
    #[serde(rename = "blockId", skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    pub trail: String,
    pub text: String,
}

#[derive(Debug, Default)]
pub struct Extracted {
    pub title: String,
    pub lines: Vec<Line>,
}

/// Reads `search.json` from an `.ocanvas` zip (at most 4 MB inflated). `None` = no index.
pub fn extract(ocanvas: &[u8]) -> Option<Extracted> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(ocanvas)).ok()?;
    let f = zip.by_name("search.json").ok()?;
    let mut s = String::new();
    f.take(4 * 1024 * 1024).read_to_string(&mut s).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    if v["v"].as_i64() != Some(1) {
        return None;
    }
    let mut out = Extracted {
        title: v["title"].as_str().unwrap_or("").to_string(),
        lines: vec![],
    };
    let s = |x: &serde_json::Value| x.as_str().unwrap_or("").to_string();
    for b in v["blocks"].as_array().into_iter().flatten() {
        let trail = b["path"]
            .as_array()
            .map(|p| {
                p.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(" › ")
            })
            .unwrap_or_default();
        out.lines.push(Line {
            block_id: b["id"].as_str().map(String::from),
            trail,
            text: s(&b["text"]),
        });
    }
    for d in v["databases"].as_array().into_iter().flatten() {
        for r in d["rows"].as_array().into_iter().flatten() {
            out.lines.push(Line {
                block_id: d["id"].as_str().map(String::from),
                trail: s(&d["title"]),
                text: s(&r["text"]),
            });
        }
    }
    for bd in v["boards"].as_array().into_iter().flatten() {
        let texts: Vec<String> = match &bd["text"] {
            serde_json::Value::Array(a) => a.iter().map(s).collect(),
            other => vec![s(other)],
        };
        for t in texts {
            out.lines.push(Line {
                block_id: bd["id"].as_str().map(String::from),
                trail: "Board".into(),
                text: t,
            });
        }
    }
    out.lines.retain(|l| !l.text.trim().is_empty());
    out.lines.truncate(20_000);
    Some(out)
}

pub async fn index(db: &Db, canvas: &str, x: &Extracted) -> anyhow::Result<()> {
    let body: String = x
        .lines
        .iter()
        .map(|l| format!("{} {}", l.trail, l.text))
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(2_000_000)
        .collect();
    let title: String = x.title.chars().take(250).collect();
    let blocks = serde_json::to_string(&x.lines)?;
    let mut tx = db.pool.begin().await?;
    sqlx::query("DELETE FROM search_docs WHERE canvas_id = ?")
        .bind(canvas)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO search_docs (canvas_id, title, body, blocks) VALUES (?, ?, ?, ?)")
        .bind(canvas)
        .bind(&title)
        .bind(&body)
        .bind(&blocks)
        .execute(&mut *tx)
        .await?;
    if db.sqlite {
        sqlx::query("DELETE FROM search_fts WHERE canvas_id = ?")
            .bind(canvas)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO search_fts (canvas_id, title, body) VALUES (?, ?, ?)")
            .bind(canvas)
            .bind(&title)
            .bind(&body)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn remove(db: &Db, canvas: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM search_docs WHERE canvas_id = ?")
        .bind(canvas)
        .execute(&db.pool)
        .await?;
    if db.sqlite {
        sqlx::query("DELETE FROM search_fts WHERE canvas_id = ?")
            .bind(canvas)
            .execute(&db.pool)
            .await?;
    }
    Ok(())
}

fn fold(s: &str) -> String {
    s.to_lowercase()
}

/// The words of a query, without search-syntax characters.
pub fn words(q: &str) -> Vec<String> {
    q.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .take(8)
        .collect()
}

#[derive(Serialize, Debug, Clone)]
pub struct Hit {
    #[serde(rename = "fileId")]
    pub file_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    #[serde(rename = "blockId", skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    pub snippet: String,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(rename = "type")]
    pub ftype: String,
}

/// Canvases matching every word, newest first among equals, only those `user` may open.
pub async fn query(
    db: &Db,
    snap: &Snapshot,
    user: &str,
    q: &str,
    limit: usize,
) -> anyhow::Result<Vec<Hit>> {
    let ws = words(q);
    if ws.is_empty() {
        return Ok(vec![]);
    }
    let mut ids: Vec<String> = Vec::new();
    if db.sqlite {
        let m = ws
            .iter()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" AND ");
        for r in sqlx::query(
            "SELECT canvas_id FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT 1000",
        )
        .bind(m)
        .fetch_all(&db.pool)
        .await?
        {
            ids.push(r.try_get(0)?);
        }
    } else {
        let m = ws
            .iter()
            .map(|w| format!("+{w}*"))
            .collect::<Vec<_>>()
            .join(" ");
        for r in sqlx::query("SELECT canvas_id FROM search_docs WHERE MATCH(title, body) AGAINST (? IN BOOLEAN MODE) LIMIT 1000")
            .bind(m)
            .fetch_all(&db.pool)
            .await?
        {
            ids.push(r.try_get(0)?);
        }
    }
    // Titles of canvases never saved yet (no search.json) match by name.
    let like = format!("%{}%", ws[0].replace(['%', '_', '\\'], ""));
    for r in sqlx::query("SELECT id, name FROM canvases WHERE deleted_at IS NULL AND LOWER(name) LIKE ? ORDER BY updated_at DESC LIMIT 200")
        .bind(like)
        .fetch_all(&db.pool)
        .await?
    {
        let id: String = r.try_get(0)?;
        let name: String = r.try_get(1)?;
        if ws.iter().all(|w| fold(&name).contains(w.as_str())) && !ids.contains(&id) {
            ids.insert(0, id);
        }
    }
    let mut hits = Vec::new();
    for id in ids {
        if hits.len() >= limit {
            break;
        }
        // The access filter: nothing the searcher cannot open, whatever the index says.
        if snap.can_open(user, &id).is_none() {
            continue;
        }
        let Some(row) = sqlx::query(
            "SELECT c.name, c.updated_at, c.ftype, d.blocks FROM canvases c LEFT JOIN search_docs d ON d.canvas_id = c.id WHERE c.id = ?",
        )
        .bind(&id)
        .fetch_optional(&db.pool)
        .await?
        else {
            continue;
        };
        let name: String = row.try_get(0)?;
        let updated: i64 = row.try_get(1)?;
        let ftype: String = row.try_get(2)?;
        let blocks: Option<String> = row.try_get(3)?;
        let lines: Vec<Line> = blocks
            .and_then(|b| serde_json::from_str(&b).ok())
            .unwrap_or_default();
        let best = lines
            .iter()
            .find(|l| {
                let hay = fold(&format!("{} {}", l.trail, l.text));
                ws.iter().all(|w| hay.contains(w.as_str()))
            })
            .or_else(|| {
                lines
                    .iter()
                    .find(|l| ws.iter().any(|w| fold(&l.text).contains(w.as_str())))
            });
        hits.push(Hit {
            file_id: id,
            title: name,
            path: best.map(|l| l.trail.clone()).unwrap_or_default(),
            block_id: best.and_then(|l| l.block_id.clone()),
            snippet: best
                .map(|l| l.text.chars().take(300).collect())
                .unwrap_or_default(),
            updated_at: Some(crate::util::rfc3339(updated)),
            ftype,
        });
    }
    Ok(hits)
}

#[cfg(test)]
pub(crate) fn ocanvas_with_search(json: &str) -> Vec<u8> {
    use std::io::Write;
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let o = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        z.start_file("manifest.json", o).unwrap();
        z.write_all(b"{}").unwrap();
        z.start_file("search.json", o).unwrap();
        z.write_all(json.as_bytes()).unwrap();
        z.finish().unwrap();
    }
    buf.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_blocks_rows_and_boards() {
        let z = ocanvas_with_search(
            r#"{"v":1,"title":"Plan","blocks":[{"id":"b1","type":"p","path":["Goals"],"text":"Ship the launch"}],
               "databases":[{"id":"d1","title":"Tasks","rows":[{"id":"r1","text":"Partner onboarding"}]}],
               "boards":[{"id":"w1","text":["S3 optional"]}],"truncated":false}"#,
        );
        let x = extract(&z).unwrap();
        assert_eq!(x.title, "Plan");
        assert_eq!(x.lines.len(), 3);
        assert_eq!(x.lines[0].trail, "Goals");
        assert_eq!(x.lines[0].block_id.as_deref(), Some("b1"));
        assert_eq!(x.lines[1].trail, "Tasks");
        assert_eq!(x.lines[2].text, "S3 optional");
        assert!(extract(b"not a zip").is_none());
    }

    #[test]
    fn query_words_drop_syntax() {
        assert_eq!(
            words(r#"launch "plan"* OR -x"#),
            vec!["launch", "plan", "or", "x"]
        );
    }
}
