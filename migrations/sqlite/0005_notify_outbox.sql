-- Host notifications (UX-02, ADR-025): @mention calls to the host's `POST /mentions`, written
-- here before they are sent so a failed call is retried (fire-and-forget for the room). `id` is
-- derived from the room and the mentioning item, so a message is never queued twice. `token` is
-- the callback token sealed with OC_KEK; `payload` (JSON with a short excerpt) is cleared once the
-- call is done or given up, and finished rows are swept after a day. Keep in sync with
-- migrations/mysql.

CREATE TABLE notify_outbox (
  id          VARCHAR(64)  PRIMARY KEY,
  room_id     VARCHAR(32)  NOT NULL,
  host_id     VARCHAR(64)  NOT NULL,
  file_id     VARCHAR(255) NOT NULL,
  kind        VARCHAR(16)  NOT NULL,
  token       TEXT         NOT NULL,
  payload     TEXT         NOT NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  next_try_at BIGINT       NOT NULL,
  status      VARCHAR(16)  NOT NULL,
  created_at  BIGINT       NOT NULL
);
CREATE INDEX ix_notify_status ON notify_outbox(status, next_try_at);
