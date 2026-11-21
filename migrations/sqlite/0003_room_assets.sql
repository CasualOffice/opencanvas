-- WOPI mode (docs/05 §6): assets uploaded during a session, kept only until they are inlined
-- into the host's file as `assets/<id>` (transient room state, like snapshots). Rows of rooms
-- that are gone and have no pending commit are swept. Keep in sync with migrations/mysql.

CREATE TABLE room_assets (
  room_id    VARCHAR(32)  NOT NULL,
  asset_id   VARCHAR(64)  NOT NULL,
  mime       VARCHAR(127) NOT NULL,
  size       BIGINT       NOT NULL,
  data       BLOB         NOT NULL,
  created_at BIGINT       NOT NULL,
  PRIMARY KEY (room_id, asset_id)
);
