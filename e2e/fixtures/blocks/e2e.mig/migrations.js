// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
OpenCanvasBlock.defineMigrations({
  1: (attrs, data) => ({ attrs: { title: String(attrs.name ?? "") + " (migrated)" }, data }),
});
