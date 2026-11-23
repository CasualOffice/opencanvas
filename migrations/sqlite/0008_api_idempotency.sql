-- Headless API `Idempotency-Key` store (docs/27 §4.2, HAPI-03). One row per (host, subject,
-- key), keyed by sha256 of the three, so neither the subject nor the key is stored. Holds the
-- request hash and, once done, the 2xx answer of a write (ids and counts, never document
-- content: ADR-001). Running rows expire after a short lease (a crashed node frees the key),
-- done rows after 24 h. Keep in sync with migrations/mysql.

CREATE TABLE api_idempotency (
  id           CHAR(64)     NOT NULL PRIMARY KEY,
  host_id      VARCHAR(128) NOT NULL,
  request_hash CHAR(64)     NOT NULL,
  state        VARCHAR(16)  NOT NULL,
  status       BIGINT       NOT NULL,
  response     TEXT         NOT NULL,
  expires_at   BIGINT       NOT NULL
);

CREATE INDEX api_idempotency_expires ON api_idempotency (expires_at);
