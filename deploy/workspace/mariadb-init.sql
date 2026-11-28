-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 CasualOffice
-- The Workspace's own database on the same MariaDB (docs/40 §3).
CREATE DATABASE IF NOT EXISTS workspace CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON workspace.* TO 'opencanvas'@'%';
FLUSH PRIVILEGES;
