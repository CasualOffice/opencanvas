-- Durable saves (docs/04 §5): commit_outbox gains what a restarted process needs to
-- resend a commit. The table was unused before this migration, so it is recreated.
-- `token` is the host callback token sealed with OC_KEK. Keep in sync with migrations/sqlite.

DROP TABLE commit_outbox;

CREATE TABLE commit_outbox (
  id           VARCHAR(32)  PRIMARY KEY,
  room_id      VARCHAR(32)  NOT NULL,
  host_id      VARCHAR(64)  NOT NULL,
  file_id      VARCHAR(255) NOT NULL,
  seq          BIGINT       NOT NULL,
  base_version VARCHAR(255),
  token        TEXT         NOT NULL,
  payload      LONGBLOB     NOT NULL,
  message      TEXT,
  authors      TEXT         NOT NULL,
  attempts     INT          NOT NULL DEFAULT 0,
  next_try_at  BIGINT       NOT NULL,
  status       VARCHAR(16)  NOT NULL,
  last_error   TEXT,
  created_at   BIGINT       NOT NULL,
  INDEX ix_outbox_status (status, next_try_at),
  INDEX ix_outbox_room (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;
