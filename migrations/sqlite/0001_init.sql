-- OpenCanvas transient room state (docs/04 §5). Keep in sync with migrations/mysql.

CREATE TABLE sessions (
  id          VARCHAR(32)  PRIMARY KEY,
  room_id     VARCHAR(32)  NOT NULL,
  host_id     VARCHAR(64)  NOT NULL,
  file_id     VARCHAR(255) NOT NULL,
  user_id     VARCHAR(255) NOT NULL,
  role        VARCHAR(8)   NOT NULL,
  grant_json  TEXT         NOT NULL,
  expires_at  BIGINT       NOT NULL,
  created_at  BIGINT       NOT NULL
);
CREATE INDEX ix_sessions_room ON sessions(room_id);
CREATE INDEX ix_sessions_exp ON sessions(expires_at);

CREATE TABLE launch_jti (
  host_id     VARCHAR(64)  NOT NULL,
  jti         VARCHAR(255) NOT NULL,
  expires_at  BIGINT       NOT NULL,
  PRIMARY KEY (host_id, jti)
);
CREATE INDEX ix_launch_jti_exp ON launch_jti(expires_at);

CREATE TABLE rooms (
  id             VARCHAR(32)  PRIMARY KEY,
  host_id        VARCHAR(64)  NOT NULL,
  file_id        VARCHAR(255) NOT NULL,
  host_version   VARCHAR(255),
  owner_node     VARCHAR(64),
  dirty          SMALLINT     NOT NULL DEFAULT 0,
  last_commit_at BIGINT,
  last_active_at BIGINT       NOT NULL,
  UNIQUE (host_id, file_id)
);

CREATE TABLE room_snapshots (
  room_id    VARCHAR(32) PRIMARY KEY,
  seq        BIGINT      NOT NULL,
  state      BLOB        NOT NULL,
  updated_at BIGINT      NOT NULL
);

CREATE TABLE room_updates (
  room_id    VARCHAR(32) NOT NULL,
  seq        BIGINT      NOT NULL,
  data       BLOB        NOT NULL,
  origin     VARCHAR(255),
  created_at BIGINT      NOT NULL,
  PRIMARY KEY (room_id, seq)
);

CREATE TABLE commit_outbox (
  id          VARCHAR(32) PRIMARY KEY,
  room_id     VARCHAR(32) NOT NULL,
  payload     BLOB        NOT NULL,
  message     TEXT,
  authors     TEXT        NOT NULL,
  attempts    INT         NOT NULL DEFAULT 0,
  next_try_at BIGINT      NOT NULL,
  status      VARCHAR(16) NOT NULL,
  last_error  TEXT
);
