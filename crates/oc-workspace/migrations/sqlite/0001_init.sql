-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 CasualOffice
-- OpenCanvas Workspace metadata (ADR-085). Times are Unix milliseconds. Files live on disk or S3.

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL,              -- owner | admin | member | guest
  status TEXT NOT NULL,            -- active | suspended
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,           -- invite | reset
  kind TEXT NOT NULL DEFAULT '',   -- invite: org | workspace | canvas
  target_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  email TEXT,
  user_id TEXT,                    -- reset: whose password
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);

CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE team_members (team_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (team_id, user_id));

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'layers',
  color TEXT NOT NULL DEFAULT 'blue',
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL,        -- open | private
  personal_owner TEXT,             -- "My canvases" of this user
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL,    -- user | team
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL,              -- admin | editor | commenter | viewer
  PRIMARY KEY (workspace_id, principal_kind, principal_id)
);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  trash_batch TEXT,
  trashed_by TEXT
);
CREATE INDEX folders_ws ON folders(workspace_id);

CREATE TABLE canvases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  folder_id TEXT,
  name TEXT NOT NULL,
  ftype TEXT NOT NULL DEFAULT 'document',  -- document | spreadsheet | whiteboard | database (docs/05 §2f)
  version INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  is_template INTEGER NOT NULL DEFAULT 0,
  seed TEXT,                       -- sample content (Markdown) served until the first save
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  deleted_at INTEGER,
  trash_batch TEXT,
  trashed_by TEXT,
  link_access TEXT NOT NULL DEFAULT 'none',  -- none | org | public
  link_role TEXT NOT NULL DEFAULT 'view',
  link_token TEXT UNIQUE,
  link_expires_at INTEGER,
  link_password_hash TEXT
);
CREATE INDEX canvases_ws ON canvases(workspace_id);
CREATE INDEX canvases_updated ON canvases(updated_at);

CREATE TABLE shares (
  object_kind TEXT NOT NULL,       -- canvas | folder
  object_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL,    -- user | team
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL,              -- full | edit | comment | view
  PRIMARY KEY (object_kind, object_id, principal_kind, principal_id)
);

CREATE TABLE favourites (user_id TEXT NOT NULL, canvas_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, canvas_id));
CREATE TABLE recents (user_id TEXT NOT NULL, canvas_id TEXT NOT NULL, opened_at INTEGER NOT NULL, PRIMARY KEY (user_id, canvas_id));

CREATE TABLE versions (
  canvas_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  at INTEGER NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL,              -- auto | named | restore
  name TEXT,
  restored_from TEXT,
  checkpoint INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL,
  PRIMARY KEY (canvas_id, version)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- mention | share | invite
  canvas_id TEXT,
  block_id TEXT,
  by_user TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, at);

CREATE TABLE idempotency (k TEXT PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL);

-- Search (ADR-065): the text of each canvas from the search.json of its last save.
CREATE TABLE search_docs (canvas_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, blocks TEXT NOT NULL DEFAULT '[]');
CREATE VIRTUAL TABLE search_fts USING fts5(canvas_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
