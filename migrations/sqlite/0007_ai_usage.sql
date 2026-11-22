-- Per-host monthly AI token counters (docs/24 §7.3 `monthly_token_quota`, §9.1 T8). One row per
-- host and UTC calendar month (`YYYY-MM`); every node adds its runs' tokens, so the quota holds
-- across restarts and nodes. Keep in sync with migrations/mysql.

CREATE TABLE ai_usage (
  host_id VARCHAR(128) NOT NULL,
  month   CHAR(7)      NOT NULL,
  tokens  BIGINT       NOT NULL,
  PRIMARY KEY (host_id, month)
);
