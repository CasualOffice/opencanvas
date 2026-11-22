# 23 — Acceptance matrix

The gate for promoting OpenCanvas beyond alpha. Each area has its own table with a criterion
ID, the criterion, the test that checks it, and the result (**PASS**, **FAIL** or
**BLOCKED**). A result counts only if the test was run. Sessions add their own areas under
their own headings.

- Browser tests are in `e2e/specs/` and run with `cd e2e && npm run e2e`. They use ports
  8280, 4200, 4201 and 4202.
- `webkit-phone` is WebKit on an iPhone 13 at 390×844. `android-chromium` is Chromium on a
  Pixel 5 at 360×760, and it runs `s-mobile.phone.spec.ts` and `t-mobile-blocks.phone.spec.ts`.
- Rust tests are in `crates/oc-server/tests/`.
- A test marked `test.fail()` is a known FAIL that the suite records. When the bug is fixed,
  the test starts failing as "unexpectedly passed", and the marker comes off.
- **needs design** means the fix needs new UI. The project's UI approval gate (ADR-011,
  AGENTS.md rule 2) applies: a prototype is published as an Artifact and approved before any
  code changes.

Run: 2026-11-22, branch `worktree-agent-a64d043748d68571e` off `ad74bd7`. Rerun of PERM-02/03/05 and MOB-04..07: 2026-11-22, branch `fix/perm05-save-token` off `296ab38`.

## Permissions

| ID | Criterion | How it is tested | Result |
|---|---|---|---|
| PERM-01 | Roles change live while the canvas is open: edit → comment → view, then back up view → comment → edit. There is no reload, each step shows a banner or toast, and writes are accepted again after the upgrade. | `r-permissions` "PERM-01/02 …"; `c-roles` "live role change view → edit → none"; `hardening.rs::role_api_downgrades_a_live_session` | PASS |
| PERM-02 | Each role can do what it should and no more. **Typing:** only edit (contenteditable). **Cells and board:** only edit, server-side. **Comments:** comment and edit. **Export:** governed by host `perms`. **Mention:** members only. | Typing: PERM-01 and `c-roles`. Cells, board and comments: `rooms.rs::comment_role_can_write_comments` and `commenter_and_viewer_cannot_touch_cells_boards_or_new_roots`. Mentions: `p-people` (7 tests). Export: `preview.rs::viewers_and_no_download_sessions_can_preview`. UI matrix: `r-permissions` "PERM-02: file, database, board and export controls per role". | PASS. Browser matrix: edit sees file Rename/Delete, "Add a field", "New row" and the board Pen; comment and view see none of them; all three see the 6 export items, as the sample host's `perms` allow. |
| PERM-03 | A downgrade that races local unsynced edits: the server refuses them, they disappear from the downgraded person's screen as well, and the "Edits that hadn't synced weren't kept" banner shows. | `r-permissions` "PERM-03 …" (holds Sam's WebSocket frames with `routeWebSocket`) | PASS. On a denial the client starts over from the room's state (`App.tsx` `onDenied` → reboot). The banner was lost because a Workspace mounted for one render on the previous, destroyed session and consumed the module flag. Now the flag is a per-room `sessionStorage` entry (`oc:downgraded:<room>`), shown once, and no Workspace mounts on a stale boot. The test also checks that a reload does not repeat it. `test.fail()` removed; seen failing first. |
| PERM-04 | Revoke (`none`) closes the socket with 1008, shows "Canvas closed", and drops the person from everyone's member list at once. | `c-roles`; `r-permissions` PERM-01; `p-people` "revoking Sam while Priya's canvas is open …"; `people.rs::revoke_removes_a_member_at_once`; `cluster.rs::revoke_on_one_node_reaches_every_node` | PASS |
| PERM-05 | Saves keep reaching the host after a role change. | `r-permissions` "PERM-05 …"; `hardening.rs::saves_use_a_connected_editor_after_the_last_editor_is_revoked`, `a_save_refused_with_403_falls_back_to_another_editor` | PASS. Cause: the save token was the last-granted editor's (`join`/`set_role`), and `put_payload` fell back to the pending outbox row's token, which still carried the revoked grant (the earlier attempt cleared the room token, so the row's token was used). A restart's outbox resume would also reuse it. Fix (`actor.rs`): revoked and view-downgraded tokens are tracked; `save_tokens` lists connected editors, then commenters, then the room's and the row's token, never a revoked one; the PUT tries each and moves on after a 401/403; a pending row carrying a revoked token is superseded and rewritten at once. `test.fail()` removed; both Rust tests and the spec seen failing first. |
| PERM-06 | The server enforces everything. A forged frame from a viewer (sent from devtools, bypassing the read-only editor) or from a commenter (content, `meta`, `databases`, `boards`, a new root, or a comment bundled with a content change) is refused and never reaches peers or the host. | `r-permissions` "PERM-06 …"; `rooms.rs::view_role_cannot_write`, `comment_role_cannot_change_content`, `commenter_and_viewer_cannot_touch_cells_boards_or_new_roots` (new); `cluster.rs::non_owner_relays_frames_and_the_owner_enforces_roles`; `filter.rs` unit tests | PASS. The viewer's own screen also drops the forged text now. That uses the PERM-03 fix, which was seen failing first. |
| PERM-07 | Token expiry and refresh. The canvas warns before expiry (`Token_Expiring`, `oc:token-expiring`), the host refreshes (`Action_RefreshToken`, `POST /tokens/refresh`), and the session continues. Without a refresh the session ends cleanly. | `e2e/specs/u-access-expiry.spec.ts` (ending-soon bar, Renew now, read-only bar with Reconnect and "Read only", axe light and dark; seen failing first) | **PASS** (2026-11-23): built to the approved prototype `docs/prototypes/fixes-approved/Main.dc.html`; the session now carries `exp` and `POST /v1/launch` can answer JSON so renewal needs no reload (ADR-036). |
| PERM-08 | Host 409 conflict policy: `copy` saves the session as "<name> (copy)" and makes the room read-only, and `reload` restarts both sessions from the host's version. | `d-conflict` (2 tests); `conflict_live.rs`; `k-ux` "a blank canvas invites a start; a conflict shows autosave as paused" | PASS |
| PERM-09 | Sample-host ACL changes ("Save access" → role API) are reflected live in the open canvas. | `helpers.setAccess`, used by `c-roles`, `r-permissions` and `p-people` | PASS |

## Mobile

| ID | Criterion | How it is tested | Result |
|---|---|---|---|
| MOB-01 | Typing on a phone, and IME-safe input: a CJK commit through `insertText` lands in the text. | `s-mobile` "MOB-01 …" (webkit-phone, android-chromium) | PASS. Composition events in progress (`compositionstart`/`update`) are not simulated. |
| MOB-02 | The slash menu opens as a bottom sheet, the mobile toolbar shows while typing, and "+" inserts a block below the caret. | `f-phone`; `l-ux-phone` | PASS on WebKit |
| MOB-03 | Select a word and format it (bold, italic) and link it from the mobile toolbar. | `s-mobile` "MOB-03 …"; `l-ux-phone` (link sheet) | PASS |
| MOB-04 | Tables and database cells and views on a phone: editable, scroll inside the block, no page overflow. | `t-mobile-blocks.phone` "MOB-04: a table …", "MOB-04: database cells and views …" (webkit-phone, android-chromium) | PASS: insert a table from the sheet and type in cells; edit a database cell; Table, Board, Calendar and Gallery views; the grid scrolls inside the block; no page overflow. |
| MOB-04b | A database cell is reachable by tapping after it is scrolled into view. | Seen while writing MOB-04 | **PASS** (2026-11-23): built to the approved prototype (`PhoneDb`): the title column is at most 132 px with an ellipsis and a scroll edge; tapping a title opens the row; passes on both phones. |
| MOB-05 | Board touch: tap to activate, pan and pinch, draw, move a shape. | `f-phone` (tap to activate, owner and viewer); `t-mobile-blocks.phone` "MOB-05 …" (touch pointer events) | PASS: tap to open, one-finger drag moves a shape, one-finger pan on empty canvas, two-finger pinch zooms, the Pen draws a stroke. |
| MOB-06 | File preview and the PDF viewer in full screen on a phone. | `t-mobile-blocks.phone` "MOB-06 …" | PASS: inline preview, Expand, the viewer and its first page fit the phone, Close is on screen and at least 24 px. On android-chromium the close is a click event: emulated Chromium enters element full screen and Playwright cannot tap inside it. |
| MOB-07 | Comments, mentions and the people list on a phone: the comments panel fits the screen. | `s-mobile` "MOB-07 …"; `t-mobile-blocks.phone` "MOB-07: mentions and the people list …" | PASS: the comments panel; the @ picker fits the width, options are at least 24 px tall and a tap inserts the mention; the avatar stack (or the "more people" list) fits. |
| MOB-08 | Tap targets in the top bar and mobile toolbar are at least 24×24 px (WCAG 2.2 2.5.8). | `s-mobile` "MOB-09 …" | PASS. Covers only the top bar and toolbar. |
| MOB-09 | No horizontal page scroll. | `s-mobile` "MOB-10/11/12 …" | PASS |
| MOB-10 | Safe area: the bottom sheet pads `env(safe-area-inset-bottom)`. | `s-mobile` "MOB-10/11/12 …" | PASS |
| MOB-11 | Safe area: the mobile toolbar keeps clear of the home indicator when the keyboard is closed. | `s-mobile` "MOB-11b …" (`test.fail()`) | **PASS** (2026-11-23): built to the approved prototype (`ToolbarClosed`/`ToolbarOpen`): `env(safe-area-inset-bottom)` with the keyboard closed, on the keyboard when open; `test.fail()` removed, passes on webkit-phone and android-chromium. |
| MOB-12 | Orientation change: rotating to landscape and back keeps the editor usable with no sideways scroll. | `s-mobile` "MOB-10/11/12 …" (viewport swap) | PASS |

### Needs design

None open. PERM-07, MOB-11 and MOB-04b were designed, approved (`docs/prototypes/fixes-approved/`, 2026-11-23) and built; their specs pass.

## Files, WOPI and exports: method

Each row: ID, criterion, test, result (`PASS`, `FAIL`, `BLOCKED`, or `Not run`).
Run 2026-11-22 on branch `acceptance/files-wopi-exports` (off main `ad74bd7`). Servers on
ports 88xx only; the Playwright suite and its ports belong to the other session.

Fixture: `rich()` in `crates/oc-model/tests/acceptance.rs` — every Tiptap node of docs/15 §4
(heading, paragraph with bold/link/`javascript:` link/textColor/commentMark, mention,
dateMention, bullet/ordered/task lists, blockquote, codeBlock, horizontalRule, image (data PNG),
callout, toggle, columns with widths/title, table, bookmark, two embeds (YouTube and a
`javascript:` one), fileAttachment, database, board), a database with all 11 field types plus an
unknown one and all four views, the shared board fixture (every shape type, bound straight/elbow
connectors, waypoints, frames, labels), a comment thread with a mention, an unknown block, an
unknown attr and unknown meta/database keys, and CJK, RTL and emoji text.
`OC_ACC_OUT=<dir> cargo test -p oc-model --test acceptance` writes every output for external checks.

## File compatibility

| ID | Criterion | Test | Result |
|---|---|---|---|
| FC-01 | Round trip of every block type, every database field type and view, every board shape/connector/frame, and comments through write → read is lossless | `acceptance::fc_round_trip_every_block_and_unknowns` | PASS |
| FC-02 | Unknown blocks, attrs, database fields/keys and meta keys survive a round trip | same test (`futureBlock`, `futureAttr`, field type `stars`, `futureKey`, `futureMeta`) | PASS |
| FC-03a | Committed v1 file (`tests/fixtures/v1-rich.ocanvas`, format 1 / schema 1) reads to the same document | `acceptance::fc_reads_committed_v1_fixture` (fixture added; regenerate with `OC_ACC_REGEN=1`) | PASS |
| FC-03b | Other writers' variants: `document.json` only, `ydoc.bin` only as a **v2** update, no manifest, `schemaVersion` mismatch (document.json wins) | `acceptance::fc_reads_variant_archives` | PASS after fix (was FAIL: a v2 `ydoc.bin` loaded as an **empty canvas**, see Fixes) |
| FC-03c | Files from an older format version | Only format version 1 has ever existed; the v1 fixture is now committed so v2 readers are tested against it | PASS (n/a until v2) |
| FC-04 | Zip limits: zip bomb (200 MB → ratio/total), `../` and `a/../../b` traversal (also in `read_assets`), stored entry > 100 MB, > 1000 entries — all an `Error::Limit`/error, no panic; lying declared sizes (existing SEC-14 test) | `acceptance::fc_zip_limits`, `ocanvas::asset_tests` | PASS. Note: an absolute name (`/etc/passwd`) is accepted by the zip crate's `enclosed_name` as a relative path; harmless because entries are read into memory by name and never extracted |
| FC-05 | Corrupt or truncated file (cut at 0/4/30/half/−10 bytes, flipped bytes, garbage `ydoc.bin`, bad JSON, no content entries) fails with an error | `acceptance::fc_corrupt_and_truncated_fail_cleanly` | PASS |
| FC-06 | `document.json` equals the walk of `ydoc.bin` in a written file; manifest title/commit | `acceptance::fc_document_json_matches_ydoc` | PASS. By design the reader prefers `ydoc.bin`, so a tool that edits only `document.json` must drop `ydoc.bin` or bump `schemaVersion` (docs/04 §2.3) |
| FC-07 | All 40 built-in templates load | `web/packages/editor/src/templates.fixture.test.ts` builds every template as the gallery does (`buildDoc` + database/board presets, ids and dates made deterministic) and checks it against the committed `crates/oc-model/tests/fixtures/templates.json` (stale = fail; `OC_UPDATE_FIXTURES=1` rewrites it); `oc-model` `templates::fc07_every_builtin_template_validates_and_round_trips` passes each through `oc_model::validate_json` (no errors, no warnings) and the `.ocanvas` write → read (document unchanged, databases/boards/blocks/title kept). Seen failing with a corrupted heading level | PASS (2026-11-23) |
| FC-08 | Markdown import/export | `roundtrip::markdown_import_builds_blocks`, `export` unit tests, `acceptance::ex_markdown` | PASS |
| FC-09 | HTML import/export | `POST /v1/convert?from=html` (forgiving parser) and `acceptance::ex_html` | PASS (export); import covered by existing `import` tests only |
| FC-10 | CSV import/export (and server-side Markdown/HTML import) | Web: `database/src/csv.test.ts`. Server: `POST /v1/import?format=md\|html\|csv&ticket=` and `POST /v1/files/:id/import` (docs/05 §7): `tests/import.rs` (`markdown_imports_at_the_end_and_after_a_block`, `html_is_sanitised` (`javascript:` link, `<img onerror>`, `<script>`, `style`, `onclick` dropped), `csv_becomes_a_database_with_detected_types`, `limits_are_enforced` (10,001 rows, 201 columns, 6 MiB → 413), `only_editors_may_import`, `import_is_off_by_default_and_per_format`, `the_kill_switch_wins`, `unknown_import_formats_are_refused_at_load`, `host_rest_import`), `routes::import::tests` (CSV quoting, type detection, duplicate headers), `http::session_carries_the_import_formats`. All seen failing first (404 / missing field) | PASS (server, 2026-11-23). Gated by `[host.flags] import_formats` (default off) and `OC_IMPORT=off`. Editor import menu not built (needs a design) |

## WOPI

| ID | Criterion | Test | Result |
|---|---|---|---|
| WOPI-01 | Discovery XML (ocanvas edit/view, md edit/view/convert, capabilities) | `wopi::discovery_route_serves_xml`; `scripts/e2e-wopi.sh` | PASS |
| WOPI-02 | Launch: WOPISrc outside the allow-list (other host, userinfo trick, query, fragment, > 255 chars) refused with 403 before any call | `wopi::launch_refuses_wopisrc_outside_the_allowlist`; e2e `localhost:8881@evil.example` | PASS |
| WOPI-03 | CheckFileInfo → role (edit/comment/view, ReadOnly wins), perms (DisableExport, HideExportOption, DisablePrint), BaseFileName, ttl → session expiry | `wopi::check_file_info_sets_role_user_perms_and_expiry`; e2e roles | PASS |
| WOPI-04 | GetFile + PutFile with `X-WOPI-Override: PUT`, `X-COOL-WOPI-Timestamp`, `IsAutosave`, `IsModifiedByUser`; new LastModifiedTime tracked | `wopi::edit_autosaves_through_putfile`; e2e (3 PutFiles) | PASS |
| WOPI-05 | Conflict: 409 + `COOLStatusCode 1010` → conflict policy; commit API answers 409 | `wopi::conflict_1010_saves_a_copy_with_put_relative`; e2e bump → 409 | PASS. No `LOCK`/`UNLOCK`/`X-WOPI-Lock`: not implemented by design (timestamps, like Collabora) |
| WOPI-06 | PUT_RELATIVE conflict copy with UTF-7 `X-WOPI-SuggestedTarget`, copy holds the edit | same; e2e `Team board (conflict copy).ocanvas` | PASS |
| WOPI-07 | access_token expiry: ttl in the past → 401; unknown token → 401; a session stops working at `access_token_ttl` (sessions and export answer 401) | `wopi::launch_refuses…` (past ttl), new `wopi::acceptance_token_expiry_and_avatar_scheme` | PASS |
| WOPI-08 | `UserExtraInfo.detail` and `.avatar` (http(s) only; `javascript:` dropped) | `wopi::check_file_info…`, `wopi::acceptance_token_expiry_and_avatar_scheme` | PASS |
| WOPI-09 | Assets in WOPI mode: upload, serve, inline as `assets/<id>` on save, read back | `wopi::assets_are_inlined_and_round_trip`; e2e | PASS |
| WOPI-10 | Mentions in WOPI mode: member list = users who opened the file; no `POST /mentions` calls | `wopi::check_file_info…` (member list); notifications skipped in `notify.rs` (by design, docs/05 §5) | PASS (no-call path by code review, no dedicated test) |
| WOPI-11 | Markdown files stay Markdown | `wopi::markdown_files_stay_markdown`; e2e | PASS |
| WOPI-12 | Access token sealed at rest and never logged | `wopi::check_file_info…`; e2e log grep | PASS |
| WOPI-13 | Proof keys (`X-WOPI-Proof`) | `proof::tests::proof_bytes_follow_the_spec_layout`, `proof::tests::signature_matches_openssl_and_verifies_with_the_public_key`, `proof::tests::discovery_element_publishes_blob_modulus_and_exponent`, `proof::tests::keys_load_from_pem_or_sealed_files_and_dev_generates`, `wopi::discovery_route_serves_xml`, `wopi::every_wopi_call_carries_a_valid_proof`, `wopi::conflict_1010_saves_a_copy_with_put_relative`, `scripts/e2e-wopi.sh` | PASS (2026-11-23): every WOPI call carries `X-WOPI-TimeStamp` / `X-WOPI-Proof` / `X-WOPI-ProofOld` (SHA256withRSA over the spec bytes, cross-checked with OpenSSL); discovery publishes `<proof-key>`; the reference host verifies real calls and refuses missing, tampered and > 20 min proofs (each test seen failing first) |
| WOPI-14 | Full flow against `examples/wopi-host` | `OC_PORT=8880 HOST_PORT=8881 scripts/e2e-wopi.sh` | PASS (`PASS [wopi/sqlite]: 3 PutFiles, roles edit/comment/view, asset inlined, md kept as md, 1010 → PutRelativeFile copy, allowlist refuses, no token in logs`) |

## Exports

| ID | Criterion | Test | Result |
|---|---|---|---|
| EX-01 | Markdown has the table, bullet/ordered/task lists, code, database as a table; no `javascript:` | `acceptance::ex_markdown` | PASS |
| EX-02 | HTML sanitised: no `<script>`, no `javascript:` (links and the bad embed), no iframes; script text escaped; served with `sandbox` CSP | `acceptance::ex_html`; `security::sec01…` | PASS |
| EX-03 | DOCX opens: every XML part well-formed (`xmllint`), `Heading1`, `<w:tbl>`, `<w:drawing>` + `word/media/*`, text present | `acceptance::ex_docx`; `unzip` + `xmllint --noout` on the output | PASS |
| EX-04 | PDF through real Gotenberg 8 (container `oc-acc-gotenberg`, removed after): text extractable, 2 pages for the rich fixture | `pdfinfo`/`pdftotext` on the rich HTML rendered by Gotenberg; `exports::real_gotenberg` (server pipeline, `--include-ignored`) | PASS |
| EX-05 | Board SVG valid XML (usvg + `xmllint`), PNG decodes at the SVG's size (1264×1004 at 1×) | `acceptance::ex_board_svg_png`; `board::*` | PASS |
| EX-06 | `.ocanvas` export reads back to the same document with CRDT state | `acceptance::ex_ocanvas` | PASS |
| EX-07 | Non-ASCII (CJK, Hebrew/Arabic RTL, emoji) survives in MD, HTML, DOCX, SVG and PDF text | `acceptance::ex_*`; `pdftotext` shows `日本語のテキストと中文`, `שלום עולם مرحبا`, `🚀✅` | PASS |
| EX-08 | Permissions: export needs `perms.export` (`.ocanvas` needs `download`, PDF needs `print`); WOPI `DisableExport`/`HideExportOption`/`DisablePrint` map to them | `security::sec_guard_export_needs_the_permission_for_every_format`, `exports::board_export_needs_the_export_permission`, `wopi::check_file_info…` (PDF 403) | PASS. Gap: the host flag `export_formats` (docs/05 §2) is not enforced anywhere — any format is allowed when `perms.export` is true. Recorded as FAIL-lite below |
| EX-09 | Host flag `export_formats` limits the formats | `security::sec_host_export_formats_limits_what_can_be_exported` (seen failing first: `html` was 200) | PASS (fixed 2026-11-22: enforced for documents and board images; absent means every format) |

## Fixes

- **FC-03b** `oc_model::ocanvas::apply_update_bytes`: a v2 Yjs update starts with a 0 feature
  byte that the v1 decoder reads as an empty update, so a `.ocanvas` with a v2 `ydoc.bin` (which
  docs/15 says readers accept) loaded as a blank canvas — silent data loss. Bytes starting with 0
  are now tried as v2 first, falling back to v1. Seen failing in
  `acceptance::fc_reads_variant_archives`.
- `scripts/e2e-wopi.sh` honours `CARGO_TARGET_DIR` (it looked for `target/release` in the
  checkout) and accepts any `HOST_PORT` (temporary hosts file with the allow-list moved).
