# 23 — Acceptance before leaving alpha

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
| FC-07 | All 40 built-in templates load | Templates are TS block lists (`web/packages/editor/src/templates.ts`), not `.ocanvas` files, so there is nothing to load server-side; a vitest that builds each into a Y.Doc and writes `.ocanvas` for the Rust reader was not written in the timebox | Not run |
| FC-08 | Markdown import/export | `roundtrip::markdown_import_builds_blocks`, `export` unit tests, `acceptance::ex_markdown` | PASS |
| FC-09 | HTML import/export | `POST /v1/convert?from=html` (forgiving parser) and `acceptance::ex_html` | PASS (export); import covered by existing `import` tests only |
| FC-10 | CSV import/export | Web only (database block, `database/src/csv.test.ts`); no server CSV route | BLOCKED (server side not implemented; web side covered by DB-03 vitest) |

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
| WOPI-13 | Proof keys (`X-WOPI-Proof`) | — | FAIL: not implemented (docs/05 §6 "no proof keys yet"). Callers are only trusted through the allow-list + access token |
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
