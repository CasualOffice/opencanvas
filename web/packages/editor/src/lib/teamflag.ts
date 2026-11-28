// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// TPL-01: whether the gallery shows "From your team". Its own module so the editor's first
// load carries only this flag; the team templates' calls load with the gallery (ADR-079 START).

/** Whether this session shows the team section: the host's `team_templates` flag. */
export function teamEnabled(session: { templates?: { team?: unknown } | null; demo?: boolean }): boolean {
  return !session.demo && session.templates?.team === true;
}
