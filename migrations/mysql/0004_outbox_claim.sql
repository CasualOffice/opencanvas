-- Cluster mode (ADR-006): the outbox sweeper claims a pending row before resuming it, so two
-- nodes never resend the same commit. `claim_until` is unix ms. Keep in sync across engines.
ALTER TABLE commit_outbox ADD COLUMN claimed_by VARCHAR(64);
ALTER TABLE commit_outbox ADD COLUMN claim_until BIGINT;
