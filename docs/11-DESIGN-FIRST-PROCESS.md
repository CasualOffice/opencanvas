# 11 — Design-first process and UI approval gate

Every feature runs the same cycle:

    define outcome → design doc → compare competitors → risks → acceptance gates
    → tracker row → (UI? prototype on Artifact → approval) → implement → verify → update docs

## UI approval gate (ADR-011)

1. A clickable HTML prototype of the UI is published as a claude.ai Artifact.
2. The user reviews it and replies with approval or changes.
3. Approval is recorded in [10-EXECUTION-TRACKER.md](10-EXECUTION-TRACKER.md)
   (UI-xx row → `Done`, with date and Artifact link).
4. Only then do WEB-xx rows unblock.

Prototypes are throwaway: they fix layout, interaction and states, not code.
Every state must be shown: empty, loading, editing, multi-user, read-only,
offline/reconnecting, save failed, conflict, narrow side panel (≥ 320 px),
dark mode.

## Doc rules

- Numbered notes in `docs/`; new topic = next free number, linked from
  [00-README.md](00-README.md).
- A decision that changes a boundary, a wire format, a file format or a
  dependency gets an ADR row in [08](08-ADR-REGISTER.md).
- Competitor claims carry a source and a "checked" date.
