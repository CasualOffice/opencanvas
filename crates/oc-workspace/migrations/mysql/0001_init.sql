-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 CasualOffice
-- OpenCanvas Workspace metadata (ADR-085) for MySQL 8 / MariaDB 10.6+. Same shape as SQLite.

CREATE TABLE meta (k VARCHAR(64) PRIMARY KEY, v TEXT NOT NULL) DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  password_hash VARCHAR(255),
  role VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  color VARCHAR(16) NOT NULL,
  created_at BIGINT NOT NULL,
  last_active_at BIGINT,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until BIGINT
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  id_hash VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  agent VARCHAR(255) NOT NULL DEFAULT '',
  INDEX sessions_user (user_id)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE tokens (
  token_hash VARCHAR(64) PRIMARY KEY,
  purpose VARCHAR(16) NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT '',
  target_id VARCHAR(64) NOT NULL DEFAULT '',
  role VARCHAR(16) NOT NULL DEFAULT '',
  email VARCHAR(320),
  user_id VARCHAR(64),
  created_by VARCHAR(64),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  used_by VARCHAR(64)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE teams (id VARCHAR(64) PRIMARY KEY, name VARCHAR(200) NOT NULL, created_at BIGINT NOT NULL) DEFAULT CHARSET=utf8mb4;
CREATE TABLE team_members (team_id VARCHAR(64) NOT NULL, user_id VARCHAR(64) NOT NULL, PRIMARY KEY (team_id, user_id)) DEFAULT CHARSET=utf8mb4;

CREATE TABLE workspaces (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  icon VARCHAR(64) NOT NULL DEFAULT 'layers',
  color VARCHAR(16) NOT NULL DEFAULT 'blue',
  description TEXT NOT NULL,
  visibility VARCHAR(16) NOT NULL,
  personal_owner VARCHAR(64),
  created_at BIGINT NOT NULL,
  deleted_at BIGINT
) DEFAULT CHARSET=utf8mb4;
CREATE TABLE workspace_members (
  workspace_id VARCHAR(64) NOT NULL,
  principal_kind VARCHAR(8) NOT NULL,
  principal_id VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL,
  PRIMARY KEY (workspace_id, principal_kind, principal_id)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE folders (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL,
  parent_id VARCHAR(64),
  name VARCHAR(200) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at BIGINT NOT NULL,
  deleted_at BIGINT,
  trash_batch VARCHAR(64),
  trashed_by VARCHAR(64),
  INDEX folders_ws (workspace_id)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE canvases (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL,
  folder_id VARCHAR(64),
  name VARCHAR(200) NOT NULL,
  ftype VARCHAR(16) NOT NULL DEFAULT 'document',
  version BIGINT NOT NULL DEFAULT 0,
  size BIGINT NOT NULL DEFAULT 0,
  is_template INT NOT NULL DEFAULT 0,
  seed MEDIUMTEXT,
  created_by VARCHAR(64) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by VARCHAR(64),
  deleted_at BIGINT,
  trash_batch VARCHAR(64),
  trashed_by VARCHAR(64),
  link_access VARCHAR(8) NOT NULL DEFAULT 'none',
  link_role VARCHAR(16) NOT NULL DEFAULT 'view',
  link_token VARCHAR(64) UNIQUE,
  link_expires_at BIGINT,
  link_password_hash VARCHAR(255),
  INDEX canvases_ws (workspace_id),
  INDEX canvases_updated (updated_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE shares (
  object_kind VARCHAR(8) NOT NULL,
  object_id VARCHAR(64) NOT NULL,
  principal_kind VARCHAR(8) NOT NULL,
  principal_id VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL,
  PRIMARY KEY (object_kind, object_id, principal_kind, principal_id)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE favourites (user_id VARCHAR(64) NOT NULL, canvas_id VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (user_id, canvas_id)) DEFAULT CHARSET=utf8mb4;
CREATE TABLE recents (user_id VARCHAR(64) NOT NULL, canvas_id VARCHAR(64) NOT NULL, opened_at BIGINT NOT NULL, PRIMARY KEY (user_id, canvas_id)) DEFAULT CHARSET=utf8mb4;

CREATE TABLE versions (
  canvas_id VARCHAR(64) NOT NULL,
  version BIGINT NOT NULL,
  at BIGINT NOT NULL,
  authors TEXT NOT NULL,
  kind VARCHAR(16) NOT NULL,
  name VARCHAR(255),
  restored_from VARCHAR(64),
  checkpoint INT NOT NULL DEFAULT 0,
  size BIGINT NOT NULL,
  PRIMARY KEY (canvas_id, version)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE assets (
  id VARCHAR(64) PRIMARY KEY,
  canvas_id VARCHAR(64) NOT NULL,
  mime VARCHAR(128) NOT NULL,
  name VARCHAR(255) NOT NULL,
  size BIGINT NOT NULL,
  created_at BIGINT NOT NULL
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE notifications (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  canvas_id VARCHAR(64),
  block_id VARCHAR(64),
  by_user VARCHAR(64),
  excerpt TEXT NOT NULL,
  at BIGINT NOT NULL,
  read_at BIGINT,
  INDEX notifications_user (user_id, at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE idempotency (k VARCHAR(128) PRIMARY KEY, result TEXT NOT NULL, at BIGINT NOT NULL) DEFAULT CHARSET=utf8mb4;

CREATE TABLE search_docs (
  canvas_id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  blocks MEDIUMTEXT NOT NULL,
  FULLTEXT INDEX search_ft (title, body)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
