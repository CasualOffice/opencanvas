# Assistant prototype (approved 2026-11-22)

Approved by the owner on 2026-11-22 (ADR-011 gate) from the Artifact
https://claude.ai/artifact/2zSXdP5hnAvxdEEyjsjByT (version 1795365870-dd19).

- `Main.dc.html`: desktop. Selection toolbar "Ask Assistant ⌘J" → inline command bar with
  actions for the selection and the security line ("Acts as you… sent to the AI server") → inline
  plan ("Nothing changes until you run it", flagged injected instruction) → the new block builds
  in place in a purple outline, floating progress pill with Follow and Stop → inline suggestions
  with ✓/✕ per line, review bar (n of m, Accept all, Undo run, Done), "New · by Assistant" tag.
- `Phone.dc.html`: the same flow with a bottom toolbar, an action sheet, a progress pill and a
  review bar; 44 px targets, 16 px inputs.

Tokens are the editor's own (`web/packages/ui/src/tokens.css`) plus the assistant colour
`--ai` (#7a45f0 light, #b49aff dark) and `--ai-soft`, `--ai-line`. Lucide icons only.
The build must match these screens; any change goes back through a prototype.
