-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 CasualOffice
-- Passkeys (WS-06): WebAuthn credentials and one-time challenges.

CREATE TABLE passkeys (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  public_key VARCHAR(255) NOT NULL,
  sign_count BIGINT NOT NULL DEFAULT 0,
  name VARCHAR(120) NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  INDEX passkeys_user (user_id)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE webauthn_challenges (
  challenge_hash VARCHAR(64) PRIMARY KEY,
  purpose VARCHAR(16) NOT NULL,
  user_id VARCHAR(64),
  expires_at BIGINT NOT NULL
) DEFAULT CHARSET=utf8mb4;
