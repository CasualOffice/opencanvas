-- Restore epoch (RLB-03, docs/13 "Backup and restore"): one row, written when the server
-- starts with OC_RESTORED=1 after a restore from backup. `restored_at` (ms): schedule slots due
-- before it are skipped, not run (they may have run after the backup was taken). `gen_floor`:
-- every offline generation reads at least this, so a device revoked after the backup stays
-- revoked. Numbers only, no content (ADR-001). Keep in sync with migrations/sqlite.

CREATE TABLE restore_epoch (
  id          INT     NOT NULL PRIMARY KEY,
  restored_at BIGINT  NOT NULL,
  gen_floor   BIGINT  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;
