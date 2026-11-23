// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Shared contracts between the editor shell and the block packages.
// Keep this file small and stable: @opencanvas/editor, @opencanvas/database
// and @opencanvas/board all import from it.

export type Role = "view" | "comment" | "edit";
export type Tone = "gray" | "blue" | "green" | "amber" | "red" | "purple" | "pink";

export * from "./people";

/** A person as this viewer sees them (docs/21 "The user object"). */
export interface OcUser {
  id: string;
  name: string;
  /** CSS colour, assigned by the server from the session grant. */
  color: string;
  avatar?: string;
  /** Host-chosen second line (team, title, handle) that tells same-named people apart. */
  detail?: string;
  /** No longer a member of this canvas: shown with "No longer has access". */
  deactivated?: boolean;
  /** When they last opened this file (ms since the epoch). */
  lastSeen?: number;
}

/** What every embedded block view (database, board) receives from the editor. */
export interface BlockEnv {
  role: Role;
  me: OcUser;
  /** The canvas's members: who can be assigned/mentioned (docs/21 revision 2). */
  users: OcUser[];
  /**
   * Optional: any person id as shown (the member's current name, else the document's snapshot
   * with "No longer has access"), for ids that aren't in `users`.
   */
  person?: (id: string) => OcUser | null;
  /** True below 45em wide (720 px at the default font size; side panel, phone). ADR-050. */
  compact: boolean;
  /** Show a short toast in the editor chrome. */
  toast: (message: string, action?: { label: string; run: () => void }) => void;
  /**
   * Optional: store a file (image dropped on a board, …) and return its URL. Without it blocks
   * fall back to an inline data: URL (capped at 2 MB).
   */
  upload?: (file: File) => Promise<{ url: string }>;
  /** Maps a stored asset URL to one this viewer can load (adds the session ticket to room-served `/v1/assets/…`). */
  resolveAsset?: (src: string) => string;
  /**
   * Optional: the editor's undo manager. When given, a block adds its own Yjs type to the
   * manager's scope and its local origin to `trackedOrigins` instead of keeping a private
   * stack, so one Cmd/Ctrl+Z (and the editor's undo buttons) step through block edits too.
   * The block never destroys it.
   */
  undoManager?: import("yjs").UndoManager;
  /**
   * Optional (DGM-14.6): a board as draw.io or Mermaid, converted by the server
   * (`GET /v1/export/board/:id.:ext?report=1`), with the "what changes" report. `ids` limits it to
   * a selection. Absent without a server (`#demo`): those formats are not offered.
   */
  exportBoard?: (boardId: string, format: "drawio" | "mmd", ids: string[] | null) => Promise<{ text: string; report: DiagramExportReport }>;
  /** Optional (DGM-14.6): opens the import dialog adding a diagram file to this board. */
  importToBoard?: (boardId: string) => void;
}

/** The server's diagram export report (`oc_model::diagram_export`). */
export interface DiagramExportReport {
  format: "drawio" | "mermaid";
  counts: { shapes: number; connectors: number; containers: number; needLook: number };
  items: { level: "warn" | "gray" | "ok"; code: string; title: string; detail?: string; count: number; examples: string[] }[];
}

export const USER_PALETTE = ["#2a5ad7", "#7a45f0", "#e5602a", "#0e9a78", "#d63f78", "#b7791f", "#0b7fa6", "#6b7280"];


