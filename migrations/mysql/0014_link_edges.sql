-- Link index (LINK-02, ADR-081, docs/38 §2.3): which canvas and block points at which canvas,
-- block and row. Ids and a kind only: no titles, labels or text (ADR-001, AGENTS rules 5 and 9;
-- LINK-A3 scans this table). Written only after the host acknowledged a save; every read checks
-- the reader's role on each source with the host first.
--
-- src_key / dst_key: room ids (the hash of host and file, as everywhere), so the keys stay short
-- for MySQL's index limits while file ids may be 1,024 characters. n: the edge's position in the
-- source (edges are deduplicated before they are written). Empty strings mean "none" for
-- src_block, dst_block and dst_row. Keep in sync with migrations/sqlite.

CREATE TABLE link_edges (
  src_key   VARCHAR(64)   NOT NULL,
  n         INT           NOT NULL,
  host_id   VARCHAR(64)   NOT NULL,
  src_file  VARCHAR(1024) NOT NULL,
  src_block VARCHAR(128)  NOT NULL DEFAULT '',
  dst_key   VARCHAR(64)   NOT NULL,
  dst_file  VARCHAR(1024) NOT NULL,
  dst_block VARCHAR(128)  NOT NULL DEFAULT '',
  dst_row   VARCHAR(128)  NOT NULL DEFAULT '',
  kind      VARCHAR(16)   NOT NULL,
  saved_at  BIGINT        NOT NULL,
  PRIMARY KEY (src_key, n),
  INDEX ix_link_dst (dst_key, src_key),
  INDEX ix_link_host (host_id, saved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;
