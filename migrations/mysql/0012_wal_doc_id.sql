-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 CasualOffice
--
-- PSYNC-02 (ADR-076): the WAL per document id. '' is the main document (every row before this
-- migration); 'databases/<id>' and 'boards/<id>' are parts of a split room. Seq stays room-wide.
ALTER TABLE room_updates ADD COLUMN doc_id VARCHAR(255) NOT NULL DEFAULT '';

-- A part's snapshot and its header (kind, name, count) for the editor's placeholder.
CREATE TABLE room_part_snapshots (
  room_id    VARCHAR(32)  NOT NULL,
  doc_id     VARCHAR(191) NOT NULL,
  seq        BIGINT       NOT NULL,
  state      LONGBLOB     NOT NULL,
  header     TEXT         NOT NULL,
  updated_at BIGINT       NOT NULL,
  PRIMARY KEY (room_id, doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;
