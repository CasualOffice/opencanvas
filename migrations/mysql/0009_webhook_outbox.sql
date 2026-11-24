-- Webhooks (WH-01, ADR-056): change events (HAPI-05) waiting for, or done with, delivery to the
-- host's `[host.webhooks] url`. Written by the node that owns the room; every node delivers, one
-- row at a time (claimed by a conditional update of `next_try_at`). `id` is the event id, so an
-- event is queued once. `payload` is the event JSON: ids, user ids, versions and counts, never
-- document content (ADR-001). Finished rows are swept after 7 days. Keep in sync with
-- migrations/sqlite.

CREATE TABLE webhook_outbox (
  id          VARCHAR(64)   PRIMARY KEY,
  host_id     VARCHAR(64)   NOT NULL,
  room_id     VARCHAR(64)   NOT NULL,
  file_id     VARCHAR(1024) NOT NULL,
  event_type  VARCHAR(32)   NOT NULL,
  payload     MEDIUMTEXT    NOT NULL,
  attempts    INT           NOT NULL DEFAULT 0,
  next_try_at BIGINT        NOT NULL,
  status      VARCHAR(16)   NOT NULL,
  last_status INT           NOT NULL DEFAULT 0,
  created_at  BIGINT        NOT NULL,
  done_at     BIGINT        NOT NULL DEFAULT 0,
  INDEX ix_webhook_due (status, next_try_at),
  INDEX ix_webhook_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;
