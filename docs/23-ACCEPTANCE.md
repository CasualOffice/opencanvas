# 23 — Acceptance matrix

The gate for promoting OpenCanvas beyond alpha. Each area has its own table with a criterion
ID, the criterion, the test that checks it, and the result (**PASS**, **FAIL** or
**BLOCKED**). A result counts only if the test was run. Sessions add their own areas under
their own headings.

- Browser tests are in `e2e/specs/` and run with `cd e2e && npm run e2e`. They use ports
  8280, 4200, 4201 and 4202.
- `webkit-phone` is WebKit on an iPhone 13 at 390×844. `android-chromium` is Chromium on a
  Pixel 5 at 360×760, and it runs `s-mobile.phone.spec.ts` only.
- Rust tests are in `crates/oc-server/tests/`.
- A test marked `test.fail()` is a known FAIL that the suite records. When the bug is fixed,
  the test starts failing as "unexpectedly passed", and the marker comes off.
- **needs design** means the fix needs new UI. The project's UI approval gate (ADR-011,
  AGENTS.md rule 2) applies: a prototype is published as an Artifact and approved before any
  code changes.

Run: 2026-11-22, branch `worktree-agent-a64d043748d68571e` off `ad74bd7`.

## Permissions

| ID | Criterion | How it is tested | Result |
|---|---|---|---|
| PERM-01 | Roles change live while the canvas is open: edit → comment → view, then back up view → comment → edit. There is no reload, each step shows a banner or toast, and writes are accepted again after the upgrade. | `r-permissions` "PERM-01/02 …"; `c-roles` "live role change view → edit → none"; `hardening.rs::role_api_downgrades_a_live_session` | PASS |
| PERM-02 | Each role can do what it should and no more. **Typing:** only edit (contenteditable). **Cells and board:** only edit, server-side. **Comments:** comment and edit. **Export:** governed by host `perms`. **Mention:** members only. | Typing: PERM-01 and `c-roles`. Cells, board and comments: `rooms.rs::comment_role_can_write_comments` and `commenter_and_viewer_cannot_touch_cells_boards_or_new_roots` (new). Mentions: `p-people` (7 tests). Export: `preview.rs::viewers_and_no_download_sessions_can_preview`. | PASS for the server and for typing. **BLOCKED** for the UI matrix (which file actions, database or board controls and export items each role sees in the browser): not written within the time box. |
| PERM-03 | A downgrade that races local unsynced edits: the server refuses them, they disappear from the downgraded person's screen as well, and the "Edits that hadn't synced weren't kept" banner shows. | `r-permissions` "PERM-03 …" (holds Sam's WebSocket frames with `routeWebSocket`) | **FAIL**, partly fixed. The edits stayed on Sam's screen. **Fixed:** on a denial the client now starts over from the room's state (`App.tsx` `onDenied` → reboot). The test was seen failing first. **Still failing:** the banner is lost across the restart. A minimal fix, with the test marked `test.fail()`. |
| PERM-04 | Revoke (`none`) closes the socket with 1008, shows "Canvas closed", and drops the person from everyone's member list at once. | `c-roles`; `r-permissions` PERM-01; `p-people` "revoking Sam while Priya's canvas is open …"; `people.rs::revoke_removes_a_member_at_once`; `cluster.rs::revoke_on_one_node_reaches_every_node` | PASS |
| PERM-05 | Saves keep reaching the host after a role change. | `r-permissions` "PERM-05 …" (`test.fail()`) | **FAIL.** The room saves with the callback token of the last person granted edit (`actor.rs` `set_role`/`join`). Once that person is revoked, the host answers 403 to every save, even though another editor is still in the room. Status shows "Retrying save" forever. Switching the room token in `set_role` was tried and was not enough: the pending outbox row keeps the revoked token. The fix needs the outbox retry to pick a current writer's token. Server only, no design needed. |
| PERM-06 | The server enforces everything. A forged frame from a viewer (sent from devtools, bypassing the read-only editor) or from a commenter (content, `meta`, `databases`, `boards`, a new root, or a comment bundled with a content change) is refused and never reaches peers or the host. | `r-permissions` "PERM-06 …"; `rooms.rs::view_role_cannot_write`, `comment_role_cannot_change_content`, `commenter_and_viewer_cannot_touch_cells_boards_or_new_roots` (new); `cluster.rs::non_owner_relays_frames_and_the_owner_enforces_roles`; `filter.rs` unit tests | PASS. The viewer's own screen also drops the forged text now. That uses the PERM-03 fix, which was seen failing first. |
| PERM-07 | Token expiry and refresh. The canvas warns before expiry (`Token_Expiring`, `oc:token-expiring`), the host refreshes (`Action_RefreshToken`, `POST /tokens/refresh`), and the session continues. Without a refresh the session ends cleanly. | Code search; `collab.rs` closes with 1008 "session expired" at the session expiry | **FAIL: not built.** docs/05 and docs/06 describe the refresh, but no code sends `Token_Expiring` or handles a refresh. Server-side expiry exists but is untested. The "token expiring" banner and refresh UX **need design**. |
| PERM-08 | Host 409 conflict policy: `copy` saves the session as "<name> (copy)" and makes the room read-only, and `reload` restarts both sessions from the host's version. | `d-conflict` (2 tests); `conflict_live.rs`; `k-ux` "a blank canvas invites a start; a conflict shows autosave as paused" | PASS |
| PERM-09 | Sample-host ACL changes ("Save access" → role API) are reflected live in the open canvas. | `helpers.setAccess`, used by `c-roles`, `r-permissions` and `p-people` | PASS |

## Mobile

| ID | Criterion | How it is tested | Result |
|---|---|---|---|
| MOB-01 | Typing on a phone, and IME-safe input: a CJK commit through `insertText` lands in the text. | `s-mobile` "MOB-01 …" (webkit-phone, android-chromium) | PASS. Composition events in progress (`compositionstart`/`update`) are not simulated. |
| MOB-02 | The slash menu opens as a bottom sheet, the mobile toolbar shows while typing, and "+" inserts a block below the caret. | `f-phone`; `l-ux-phone` | PASS on WebKit |
| MOB-03 | Select a word and format it (bold, italic) and link it from the mobile toolbar. | `s-mobile` "MOB-03 …"; `l-ux-phone` (link sheet) | PASS |
| MOB-04 | Tables and database cells and views on a phone: editable, scroll inside the block, no page overflow. | none | **BLOCKED**: not written within the time box. `o-columns` covers column stacking at 390 px only. |
| MOB-05 | Board touch: tap to activate, pan and pinch, draw, move a shape. | `f-phone` (tap to activate, owner and viewer); `p-inline-drag` (desktop pointer) | Tap to activate: PASS. **BLOCKED** for pan, pinch, draw and move on touch: not written. |
| MOB-06 | File preview and the PDF viewer in full screen on a phone. | `n-file-preview` (desktop Chromium only) | **BLOCKED** on phone: not written. |
| MOB-07 | Comments, mentions and the people list on a phone: the comments panel fits the screen. | `s-mobile` "MOB-07 …" | Comments panel: PASS. **BLOCKED** for mentions and the people list on a phone. |
| MOB-08 | Tap targets in the top bar and mobile toolbar are at least 24×24 px (WCAG 2.2 2.5.8). | `s-mobile` "MOB-09 …" | PASS. Covers only the top bar and toolbar. |
| MOB-09 | No horizontal page scroll. | `s-mobile` "MOB-10/11/12 …" | PASS |
| MOB-10 | Safe area: the bottom sheet pads `env(safe-area-inset-bottom)`. | `s-mobile` "MOB-10/11/12 …" | PASS |
| MOB-11 | Safe area: the mobile toolbar keeps clear of the home indicator when the keyboard is closed. | `s-mobile` "MOB-11b …" (`test.fail()`) | **FAIL, needs design.** `.mbar` ignores `safe-area-inset-bottom`. Above the keyboard the inset must not apply, so where the toolbar sits is a design decision. |
| MOB-12 | Orientation change: rotating to landscape and back keeps the editor usable with no sideways scroll. | `s-mobile` "MOB-10/11/12 …" (viewport swap) | PASS |

### Needs design

- PERM-07: the "token expiring" banner and refresh flow.
- MOB-11: where the mobile toolbar sits relative to the home indicator.
- PERM-03 (possibly): how the downgrade notice survives the client's restart. The banner
  already exists, so this may be a code-only fix.
