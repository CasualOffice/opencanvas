-- Offline copies (OFF-01, ADR-063, docs/34 §3.4/§3.6): one row per host and user holding the
-- revocation generation. `POST /api/v1/offline/revoke` raises `gen`; a device whose offline
-- grants carry a lower one deletes its copies at the next session answer. A number and a time:
-- no document content, no titles (ADR-001). Keep in sync with migrations/mysql.

CREATE TABLE offline_generation (
  host_id    VARCHAR(64)  NOT NULL,
  user_id    VARCHAR(255) NOT NULL,
  gen        BIGINT       NOT NULL,
  updated_at BIGINT       NOT NULL,
  PRIMARY KEY (host_id, user_id)
);
