// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Mattermost exposes its own React as window.React; plugins must use it, not bundle a second
// copy. The build aliases `react` to this file (package.json "build").
module.exports = window.React;
