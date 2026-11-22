# Open design items (approved 2026-11-23)

Approved by the owner on 2026-11-23 (ADR-011 gate) from the Artifact
https://claude.ai/artifact/FheMwRjiDuKvxZPGY9fqpG (version 1795376080-7d27).

- `Main.dc.html` (PERM-07): access running out. Silent renewal by default; an amber status bar a
  minute before expiry ("Renew now", "Let it end"); a red read-only bar after expiry with the last
  saved time and "Reconnect"; a toast on renewal.
- `ToolbarClosed.dc.html`, `ToolbarOpen.dc.html` (MOB-11): the phone toolbar clears the 34 px
  home-indicator safe area when the keyboard is closed and sits on the keyboard when it is open.
- `PhoneDb.dc.html` (MOB-04b): the sticky title column is at most 132 px (a third of the screen),
  truncates with an ellipsis and casts a soft edge; tapping a title opens the row.
- `Import.dc.html` (FC-10 UI): "Import into this canvas": a drop zone for Markdown, HTML or CSV;
  CSV shows a preview with a detected, changeable type per column and where to insert; a done
  state with undo. Hidden when the host's `import_formats` flag is off.

Tokens are the editor's (`web/packages/ui/src/tokens.css`); Lucide icons only.
