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

## v0.2 acceptance (ACC-V2)

These rows cover [docs/27](27-ROADMAP-v0.2.md) §2.6 (live blocks), §3.5 (block SDK) and §4.3
(headless API), plus version history ([docs/30](30-VERSION-HISTORY.md)) and webhooks (WH-01).
Each row names the test file and test. A result comes from running that test.

**Run.** 2026-11-25, branch `worktree-agent-a1106dbc1b8b0f9f0` off main `2cf01ec`, with
`CARGO_TARGET_DIR=$HOME/.cache/oc-rel-target CARGO_INCREMENTAL=0 OC_DEV=1`. MySQL 8.4 and
MariaDB 10.11 ran in Docker; Redis 7 ran locally. Rust tests are in `crates/oc-server/tests/`
unless the row says otherwise.

Commands. Each row marks the one it used:

- **(S)** `cargo test -p oc-server --test <file>`
- **(M)** `cargo test -p oc-model --test <file>`
- **(C)** `cargo test -p opencanvas-client`
- **(W)** `cd web/packages/<pkg> && npx vitest run <path>`
- **(DB)** `OC_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:<port>/opencanvas OC_TEST_REDIS_URL=redis://127.0.0.1:6391/ cargo test -p oc-server --test storage_conformance`, once for MySQL 8.4 and once for MariaDB 10.11. The SQLite backend always runs.

### Portable live blocks (docs/27 §2.6): deferred to v0.3

The owner moved live blocks out of v0.2 on 2026-11-24 (docs/27 §0, LIVE-01 to LIVE-06). These
rows are the v0.3 gate and are not run for v0.2.

| ID | Criterion | Test | Result |
|---|---|---|---|
| LIVE-A1 | Two browsers, canvases A and B both embed live file L. Typing in A's embed shows in B's within the p95 target, and the presence of both users shows in L. | not built | **Deferred (v0.3)** |
| LIVE-A2 | A user with edit on B and view on L cannot change L (server role filter). Revoking access to L turns every embed read-only or "No access" within 1 s. | not built | **Deferred (v0.3)** |
| LIVE-A3 | With snapshot policy `"title"`, B's `.ocanvas` contains no L content (byte search in the zip). | not built | **Deferred (v0.3)** |
| LIVE-A4 | An export by a user without access to L contains no L content. | not built | **Deferred (v0.3)** |
| LIVE-A5 | A live file that contains a `liveBlock` is refused by validation. | not built | **Deferred (v0.3)** |
| LIVE-A6 | Cluster: A's room and L's room have different owners and edits converge. A chaos kill of L's owner loses no acknowledged edit. | not built | **Deferred (v0.3)** |
| LIVE-A7 | A 0.1.x reader keeps a `liveBlock` and round-trips it byte-equal. | not built | **Deferred (v0.3)** |

### Block SDK (docs/27 §3.5)

BSDK-01, -02 and -05 are built. BSDK-03 (sandbox runtime) and BSDK-04 (SDK package and samples)
are in progress. Rows that depend on them are marked **pending BSDK-03/04** and get filled in
when that work lands.

| ID | Criterion | Test | Result |
|---|---|---|---|
| SDK-A1 | Schema-invalid `attrs` or `data` are refused on `.ocanvas` load, REST patch and `blocks:batch`, and MCP `canvas_patch`. Types that are not installed are kept and not checked. | (M) `ext.rs::a_schema_invalid_block_refuses_the_file`, `ext.rs::validation_checks_installed_blocks_and_keeps_unknown_ones`, `ext.rs::patches_write_data_migrate_and_derive_fallbacks`; (S) `blocks.rs::api_writes_are_checked_against_the_block_schema` | PASS |
| SDK-A1b | The same refusal applies to room updates over the WebSocket, in the role filter's scratch-document step. | (S) `blocks.rs::room_updates_are_checked_against_the_block_schema` | PASS after fix (was FAIL: room updates were not checked; SEC-46, docs/18 §6; seen failing with the check off) |
| SDK-A2 | The sandbox cannot read `document.cookie`, `localStorage` or the editor DOM. It cannot navigate the top-level window or `fetch` outside its allow-list (Playwright with a hostile sample block). | BSDK-03 | **pending BSDK-03/04** |
| SDK-A3 | Exports of a canvas with an SDK block carry the template output in Markdown, HTML, DOCX and the preview (PDF is rendered from the HTML). Without the package they carry the sanitised fallback. | (M) `ext.rs::exports_render_templates_or_fallbacks`, `ext.rs::ext_fixtures`; (W) editor `src/ext/ext.test.ts` "renders every template case" | PASS with the test package `srv.okr`. The rerun with the `acme.okr` sample is **pending BSDK-04** |
| SDK-A4 | A 0.1.x build opens a v0.2 file with an `extBlock`, saves it back and loses nothing. A 0.1.x editor in a live room cannot delete SDK blocks; its session is closed with 4426. | (M) `ext.rs::ocanvas_round_trips_blocks_data_and_unknown_types`; (W) editor `src/ext/compat.test.ts` (3 tests on the v0.1.1 editor schema); (S) `blocks.rs::an_editor_older_than_0_2_cannot_delete_sdk_blocks` | PASS |
| SDK-A5 | Version skew, data side. Data at v2 with the package at v1 stays read-only: server writes are refused and readers get the fallback. Older data is migrated declaratively, validated against the installed version, and written back on the next server write. | (M) `ext.rs::a_block_from_a_newer_version_is_not_overwritten`, `ext.rs::older_data_validates_after_migration`; (W) editor `src/ext/ext.test.ts` "classifies stored versions against the installed package", "runs every migration case" | PASS |
| SDK-A5b | Version skew in the editor: the "Updated by a newer version" read-only chrome, and script migrations that run in the sandbox on first edit. | BSDK-03 | **pending BSDK-03/04** |
| SDK-A6 | Two editors, one with the package and one without (enabled for one host only). The document converges and the second editor shows the placeholder. | BSDK-03/04. The data-field merge is covered by (W) `src/ext/ext.test.ts` "merges concurrent edits of different data fields (per-field LWW)" | **pending BSDK-03/04** (data merge PASS) |
| SDK-A7 | Only the operator installs packages. A bad manifest, or a bundle whose sha384 SRI does not match, is refused (logged, and counted in `/healthz` `blocks.refused`). `[host.blocks]` selects what the session lists. | (S) `blocks.rs::installed_packages_reach_the_session_and_refused_ones_healthz`; unit tests in `ext::manifest`, `ext::schema` and `blocks` | PASS |
| SDK-A8 | Manifest `discovery` metadata (label, category, keywords, profiles, complexity) is validated, and reaches the session and `GET /api/v1/block-types`. | Being added by the SDK agent | **pending (SDK discovery metadata)** |

### Headless API (docs/27 §4.3)

| ID | Criterion | Test | Result |
|---|---|---|---|
| API-A1 | The OpenAPI document is valid 3.1. Every router route is in the document and every documented route is in the router. The server serves the checked-in document. | (S) `api_v1.rs::openapi_document_is_valid_3_1`, `openapi_matches_the_router`, `serves_the_checked_in_document`, `openapi_documents_idempotency_on_every_file_write` | PASS |
| API-A2 | Errors are RFC 9457 problems with a `code`. The API is on unless the host sets `[host.flags] api_v1 = false`. | (S) `api_v1.rs::errors_are_problem_details`, `on_by_default_and_off_when_the_host_turns_it_off` | PASS |
| API-A3 | Idempotency: the same `blocks:batch` sent twice, or concurrently, applies once, and the replay is marked. A different body with the same key gets 422, and a failure frees the key. The store contract holds on every backend. | (S) `api_idempotency.rs::a_key_applies_once_replays_and_refuses_another_body`, `concurrent_duplicates_apply_once_and_failures_free_the_key`; (DB) `storage_conformance.rs::idempotency_keys_claim_once_replay_and_expire` (SQLite, MySQL 8.4, MariaDB 10.11, Redis-only); (S) `mcp_api_parity.rs::mcp_writes_use_the_api_idempotency_store` | PASS. Cluster nodes share the store, so the store contract on each backend is the cluster check. The first MariaDB run on an empty database failed because of concurrent migrations (SEC-47, docs/18 §6) |
| API-A4 | Cursors: paging through blocks while another client inserts and deletes returns every surviving block exactly once. Cursors are signed, bound to their file and query, and expire after 1 h (410). | (S) `api_paging_limits.rs::cursors_survive_concurrent_inserts_and_deletes`, `cursors_are_signed_bound_and_expire` | PASS |
| API-A5 | Rate limits: every answer has `RateLimit-Policy` and `RateLimit` headers. A burst over the limit gets 429 with `Retry-After`, and buckets refill by the clock. MCP and the API share one bucket, and nodes share buckets through Redis. | (S) `api_paging_limits.rs::rate_limits_answer_headers_429_and_refill_by_the_clock`, `mcp_and_the_api_share_the_subjects_bucket`, `redis_buckets_are_shared_between_nodes` (with `OC_TEST_REDIS_URL`) | PASS |
| API-A6 | Permissions: a `canvas:read` token cannot write. A token whose host role is `view` cannot write, even with `canvas:write`. A file outside `files` is refused when the host has no `/access`. When it has one, `/access` overrides the claim and a revoke applies at once. Expired, too-long, foreign and forged tokens are refused. Admin operations need the host key unless `token_admin` is set. API and MCP tokens are not interchangeable. | (S) `api_tokens.rs` (6 tests); `mcp.rs` (10 tests) | PASS |
| API-A7 | MCP parity: every MCP tool maps to a documented operation with the same scope, and reads and writes answer the same through both. The 0.1 routes still answer with their old shape, plus `Deprecation`. | (S) `mcp_api_parity.rs` (4 tests); `api_v1.rs::old_routes_still_answer_with_their_shape_and_a_deprecation`; `host_api.rs` (6 tests) | PASS |
| API-A8 | The TS and Rust clients pass the shared conformance suite against a real server: read, batch with `If-Match`, idempotent replay, paging, rate limit, events resume and the webhook signature vectors. | (C) `conformance.rs::scenarios_against_a_real_server`, `conformance.rs::webhook_vectors`, `models.rs`, `unit.rs`; (W) client `test/conformance.test.ts`, `test/client.test.ts` (36 tests) | PASS on SQLite. The clients have no backend-specific code; API-A3 and (DB) cover the server backends |
| API-A9 | Events stream (SSE and WebSocket) reports every kind of change with ids only, never content. `Last-Event-ID` resumes from the ring or asks for a resync. Scope is checked, a revoked user's stream closes, and the stream works on every cluster node. | (S) `api_events.rs::sse_reports_every_kind_of_change_without_content`, `last_event_id_resumes_from_the_ring_or_asks_for_a_resync`, `websocket_events_and_scope_checks`, `a_revoked_user_stream_is_closed`; `cluster.rs::change_events_reach_streams_on_every_node` | PASS |
| API-A10 | The sync token opens the room WebSocket with the effective role, `min(scope, host role)`. It lives at most 15 min and never past the token's `exp`. | (S) `api_events.rs::sync_token_opens_the_room_websocket_with_the_effective_role` | PASS |

### Version history (VH, docs/30)

| ID | Criterion | Test | Result |
|---|---|---|---|
| VH-A1 | Naming a version saves at once with the name, even when nothing changed. Named saves and restore saves carry their headers. | (S) `history_api.rs::naming_saves_now_with_the_name_even_without_changes`; `history.rs::named_and_restore_saves_carry_their_headers` | PASS |
| VH-A2 | The list merges host versions with recent in-file versions. It falls back to in-file history when the host has no list call, and it is fetched again when it has not seen the latest save. | (S) `history_api.rs::list_merges_host_versions_and_recent_in_file_ones`, `a_host_without_the_list_call_falls_back_to_in_file_history`, `a_list_that_has_not_seen_the_latest_save_is_fetched_again` | PASS |
| VH-A3 | Permissions: viewers need `perms.history` and can never name or restore. The session says where history comes from and who may use it. Temporary canvases have no history. | (S) `history_api.rs::viewers_need_the_history_perm_and_never_name_or_restore`; `history.rs::session_says_where_history_comes_from_and_who_may_use_it`, `temporary_canvases_have_no_history_and_wopi_hosts_no_in_file_history` | PASS |
| VH-A4 | Restore saves first, applies the version, saves the result and tells everyone. Only the restorer may undo, and only within the window. Restore keeps comments and concurrent edits. | (S) `history_api.rs::restore_saves_first_applies_the_version_saves_it_and_tells_everyone`, `only_the_restorer_may_undo_and_only_within_the_window`; (M) `restore.rs` (2 tests) | PASS |
| VH-A5 | Diff from a version to the live canvas. The structural diff covers blocks, text, databases and boards, within its limits. | (S) `history_api.rs::diff_from_a_version_to_the_live_canvas`; (M) `diff.rs` (18 tests) | PASS |
| VH-A6 | In-file history: reverse diffs rebuild every kept version, the count bounds and the byte budget hold, and old readers ignore the history. Saves carry it, a loaded file keeps it, and hosts can turn it off. | (M) `file_history.rs` (6 tests); (S) `history.rs::saves_carry_in_file_history`, `a_loaded_file_keeps_its_history_and_becomes_a_version`, `hosts_can_turn_in_file_history_off`, `autosaves_are_checkpoints_only_when_the_room_empties_or_after_a_while`, `first_save_after_the_checkpoint_interval_is_a_checkpoint`, `version_callbacks_are_signed_and_normalized` | PASS |
| VH-A7 | The history panel works against the real server and sample host, on desktop and phone, and passes axe in light and dark. | `e2e/specs/z-version-history.spec.ts`, `z-version-history.phone.spec.ts`, in the full Playwright run | See the docs/32 verification checklist |

### Host editor profiles (EDP-01)

`[host.editor]` profiles (notebook, meeting, project, diagramming, document, full): the enabled
blocks, quick-insert blocks and feature switches, and the hide-never-delete rule. Another agent
is building them, so every row is **pending EDP-01**.

| ID | Criterion | Test | Result |
|---|---|---|---|
| EDP-A1 | With no `[host.editor]`, the profile is `full` and the editor behaves exactly as in 0.1.x (same blocks, same menus). | EDP-01 | PASS (2026-11-25): `editor_profiles::session_carries_the_full_profile_by_default`; `profile.test.ts` "offers everything without a profile (older server, demo) and in full" |
| EDP-A2 | Each profile's enabled and quick-insert blocks and its feature switches reach the session and the editor. Unknown profile names or blocks are refused at start-up. | EDP-01 | PASS (2026-11-25): `editor_profiles::session_carries_a_meeting_profile_and_its_blocks`, `start_up_refuses_an_unknown_profile_block_or_feature`, the feature tests in `tests/editor_profiles.rs`; `editor::tests::*`; `profile.test.ts` filter tests |
| EDP-A3 | Hide, never delete: a document holding blocks the profile hides round-trips byte-equal through load, edit and save, in the editor and on the server (REST, MCP, `.ocanvas`). The hidden blocks are shown read-only or as a placeholder, never removed. | EDP-01 | PASS in the editor (2026-11-25): `profile.test.ts` "hide, never delete": every block type opens unchanged, takes an edit and round-trips in all six profiles; hidden blocks stay fully editable (stronger than read-only). Server: no load, save, export, REST or MCP path reads the profile (`grep editor()` in `src/`: only session, features and start-up); e2e `za-editor-profile.spec.ts` opens a full document on a `meeting` host |
| EDP-A4 | A profile is not an access control. A client that sends a block its profile hides gets the same server answer as any other edit; roles stay the only gate. | EDP-01 | PASS by construction (2026-11-25): the room, patch and tool layers never consult `[host.editor]` blocks; only features with their own routes are enforced (history, AI/MCP, import, team templates, comment writes) |

### Webhooks (WH-01)

| ID | Criterion | Test | Result |
|---|---|---|---|
| WH-A1 | Deliveries are signed (`X-OpenCanvas-Signature` v2) and carry ids only. A `[host.webhooks] secret` replaces the host secret. Both clients verify the shared vectors. | (S) `webhooks.rs::deliveries_are_signed_and_carry_ids_only`, `a_webhook_secret_replaces_the_host_secret`; (C) `conformance.rs::webhook_vectors`; (W) client `test/conformance.test.ts` | PASS |
| WH-A2 | Retries back off on the server clock and honour `Retry-After`. Delivery gives up after `max_attempts`. | (S) `webhooks.rs::retries_back_off_on_the_server_clock`, `gives_up_after_max_attempts` | PASS |
| WH-A3 | SSRF: only the `callback_base` origin is allowed, checked at start-up and on every delivery. A refusal or a redirect is final and is never followed. | (S) `webhooks.rs::urls_off_the_callback_origin_are_refused`, `a_refusal_or_a_redirect_is_final_and_never_followed` | PASS |
| WH-A4 | Each event is delivered once in a cluster. | (S) `webhooks.rs::two_nodes_deliver_each_event_once`; `cluster.rs::webhooks_are_sent_once_in_a_cluster` | PASS (claims that outlive their lease: SEC-48) |
| WH-A5 | The outbox contract holds on every SQL backend. | (DB) `storage_conformance.rs::webhook_outbox_contract` on SQLite, MySQL 8.4 and MariaDB 10.11 | PASS |

**Tests run, all passing.**

- oc-server:
  - `api_v1` 10, `api_tokens` 6, `api_idempotency` 2, `api_paging_limits` 5, `api_events` 5
  - `mcp_api_parity` 4, `webhooks` 7, `history_api` 8, `history` 9
  - `blocks` 3, `icons` 3, `host_api` 6, `mcp` 10, `import` 13
  - `storage_conformance` 10: on SQLite, and again with MySQL 8.4, MariaDB 10.11 and Redis
  - `cluster`: the 2 tests named above
- oc-model: `ext` 8, `file_history` 6, `restore` 2, `diff` 18.
- opencanvas-client: 17.
- Web: editor `src/ext` 9, client 36.
