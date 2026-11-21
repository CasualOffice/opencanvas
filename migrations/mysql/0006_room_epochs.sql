-- Fencing for room ownership (docs/22 §8 weakness 3). Every room load takes the next epoch here;
-- WAL appends, snapshots and outbox writes only land while the writer's epoch is the room's
-- latest, so a node that lost its lease (paused, partitioned) can no longer write. `checks` is
-- bumped by guarded transactions so they hold the row's write lock. Rows outlive the room (an
-- epoch must never go back) and are swept a week after the room's last claim. Keep in sync with
-- migrations/sqlite.

CREATE TABLE room_epochs (
  room_id    VARCHAR(32) PRIMARY KEY,
  epoch      BIGINT      NOT NULL,
  checks     BIGINT      NOT NULL DEFAULT 0,
  updated_at BIGINT      NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;
