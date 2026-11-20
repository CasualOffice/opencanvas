-- OpenCanvas transient room state (docs/04 §5). Keep in sync with migrations/sqlite.

CREATE TABLE sessions (
  id          VARCHAR(32)  PRIMARY KEY,
  room_id     VARCHAR(32)  NOT NULL,
  host_id     VARCHAR(64)  NOT NULL,
  file_id     VARCHAR(255) NOT NULL,
  user_id     VARCHAR(255) NOT NULL,
  role        VARCHAR(8)   NOT NULL,
  grant_json  TEXT         NOT NULL,
  expires_at  BIGINT       NOT NULL,
  created_at  BIGINT       NOT NULL,
  INDEX ix_sessions_room (room_id),
  INDEX ix_sessions_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

CREATE TABLE launch_jti (
  host_id     VARCHAR(64)  NOT NULL,
  jti         VARCHAR(255) NOT NULL,
  expires_at  BIGINT       NOT NULL,
  PRIMARY KEY (host_id, jti),
  INDEX ix_launch_jti_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

CREATE TABLE rooms (
  id             VARCHAR(32)  PRIMARY KEY,
  host_id        VARCHAR(64)  NOT NULL,
  file_id        VARCHAR(255) NOT NULL,
  host_version   VARCHAR(255),
  owner_node     VARCHAR(64),
  dirty          SMALLINT     NOT NULL DEFAULT 0,
  last_commit_at BIGINT,
  last_active_at BIGINT       NOT NULL,
  UNIQUE KEY ux_rooms_file (host_id, file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

CREATE TABLE room_snapshots (
  room_id    VARCHAR(32) PRIMARY KEY,
  seq        BIGINT      NOT NULL,
  state      LONGBLOB    NOT NULL,
  updated_at BIGINT      NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

CREATE TABLE room_updates (
  room_id    VARCHAR(32) NOT NULL,
  seq        BIGINT      NOT NULL,
  data       MEDIUMBLOB  NOT NULL,
  origin     VARCHAR(255),
  created_at BIGINT      NOT NULL,
  PRIMARY KEY (room_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

CREATE TABLE commit_outbox (
  id          VARCHAR(32) PRIMARY KEY,
  room_id     VARCHAR(32) NOT NULL,
  payload     LONGBLOB    NOT NULL,
  message     TEXT,
  authors     TEXT        NOT NULL,
  attempts    INT         NOT NULL DEFAULT 0,
  next_try_at BIGINT      NOT NULL,
  status      VARCHAR(16) NOT NULL,
  last_error  TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;
