-- Automation (AUTO-03/05, ADR-067): metadata only, never document content (ADR-001, AGENTS
-- rules 5 and 9). Rules live in the canvas (the `automations` root); these tables hold ids,
-- times, counts and codes.
--
-- automation_schedule: one row per enabled date or schedule rule, written by the node that owns
-- the room; every node's worker claims due rows (a conditional update of claimed_until), so a
-- schedule fires once across nodes. room_id is the hash of host and file (as everywhere).
-- automation_runs: the run log, kept 30 days. Keep in sync with migrations/mysql.

CREATE TABLE automation_schedule (
  room_id       VARCHAR(64)   NOT NULL,
  rule_id       VARCHAR(64)   NOT NULL,
  host_id       VARCHAR(64)   NOT NULL,
  file_id       VARCHAR(1024) NOT NULL,
  next_run_at   BIGINT        NOT NULL,
  claimed_by    VARCHAR(64)   NOT NULL DEFAULT '',
  claimed_until BIGINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, rule_id)
);
CREATE INDEX ix_auto_due ON automation_schedule(next_run_at);

CREATE TABLE automation_runs (
  id          VARCHAR(64)   PRIMARY KEY,
  room_id     VARCHAR(64)   NOT NULL,
  host_id     VARCHAR(64)   NOT NULL,
  file_id     VARCHAR(1024) NOT NULL,
  rule_id     VARCHAR(64)   NOT NULL,
  trigger_kind VARCHAR(32)  NOT NULL,
  result      VARCHAR(16)   NOT NULL,
  error_code  VARCHAR(64)   NOT NULL DEFAULT '',
  http_status INT           NOT NULL DEFAULT 0,
  changes     INT           NOT NULL DEFAULT 0,
  notified    INT           NOT NULL DEFAULT 0,
  depth       INT           NOT NULL DEFAULT 0,
  duration_ms INT           NOT NULL DEFAULT 0,
  at          BIGINT        NOT NULL
);
CREATE INDEX ix_auto_runs_room ON automation_runs(room_id, at);
CREATE INDEX ix_auto_runs_at ON automation_runs(at);
