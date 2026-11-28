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

/** A range of a Spreadsheet block by row and column ids (it follows inserted rows). */
export interface SheetRange {
  /** The block (`sheets` root key). */
  sheetId: string;
  sheet: string;
  r0: string;
  r1: string;
  c0: string;
  c1: string;
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
   * Optional (AUTO-06, frame 1c): the database header's "Automate" button. `automations` counts
   * the rules that watch a database; `automate` opens their menu at the button. Absent: no button
   * (viewers, hosts without automation).
   */
  automations?: (dbId: string) => number;
  automate?: (dbId: string, anchor: HTMLElement) => void;
  /**
   * FTY-03..05 (docs/05 §2f): this block is the root of a spreadsheet, whiteboard or database
   * file in app mode. It fills the page from the start and offers no way back to a document view.
   */
  app?: boolean;
  /** The document limit from the session (`maxDocBytes`); boards budget 25 % of it (DGM-14 S9). */
  maxDocBytes?: number;
  /** EDP-01: `false` hides the board's Diagram button, menu entry and Shift+D (default on). */
  diagramming?: boolean;
  /**
   * Optional: diagram-mode switches the host or its administrator controls (DGM-14). `bpmn`
   * shows the BPMN shape library (off by default, 2f). BPMN shapes in a document always draw.
   */
  diagram?: { bpmn?: boolean };
  /**
   * Optional (DGM-14.6): a board as draw.io or Mermaid, converted by the server
   * (`GET /v1/export/board/:id.:ext?report=1`), with the "what changes" report. `ids` limits it to
   * a selection. Absent without a server (`#demo`): those formats are not offered.
   */
  exportBoard?: (boardId: string, format: "drawio" | "mmd", ids: string[] | null) => Promise<{ text: string; report: DiagramExportReport }>;
  /** Optional (DGM-14.6): opens the import dialog adding a diagram file to this board. */
  importToBoard?: (boardId: string) => void;
  /**
   * Optional (DGM-17, ADR-057): Add your own icon. The server cleans the file
   * (`POST /v1/icons`) and writes it into the document's `icons` root, which clients can't
   * write. Absent (no server): Add your own icon is offered but disabled.
   */
  icons?: IconApi;
  /** ADR-078, `[host.flags] formulas`: formula, relation and rollup fields can be added. */
  formulas?: boolean;
  /**
   * Optional (ADR-078, prototype 2d): databases in other canvases that have a live block on this
   * canvas, for relations across canvases.
   */
  liveDbs?: () => { fileId: string; dbId: string; name: string; source: string }[];
  /**
   * Optional (SHEET-06, frames 4h and 8a), editors only: blocks placed on the canvas after this
   * one. A sheet range as a linked chart or as a new database; a database as a chart or as a
   * spreadsheet (a live view, or a copy of its values).
   */
  sheetActions?: {
    chart(r: SheetRange): void;
    toDatabase(r: SheetRange, values: string[][], name: string): void;
  };
  dbActions?: {
    chart(dbId: string): void;
    openAsSheet(dbId: string, mode: "view" | "convert"): void;
  };
  /**
   * Optional (BRD-21, board UX decision 1): "Copy link to shape". The editor gives each board its
   * own: it copies the link to this block with `&shape=<shapeId>` and tells the host
   * (`UI_BlockLink` with `shapeId`, docs/05 §4). Absent: the menu does not offer it.
   */
  linkToShape?: (shapeId: string) => void;
  /** Optional: what this reader may see of such a database; `"noAccess"` without access. */
  liveDb?: (fileId: string, dbId: string) => { fields: { id: string; name: string; type: string }[]; rows: { id: string; v: Record<string, unknown> }[] } | "noAccess" | null;
}

/** What the server's cleaner says about a file (`POST /v1/icons?dryRun=1`). */
export interface IconCheck {
  format: "svg" | "png";
  width: number;
  height: number;
  /** Cleaned size in bytes. */
  bytes: number;
  /** What was taken out, by name ("Scripts", 2). */
  removed: { what: string; count: number }[];
  /** The cleaned file, for the preview. */
  dataUrl: string;
}

/** A refused file or change: a stable code and a sentence for the person. */
export class IconError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface IconApi {
  check(file: Blob): Promise<IconCheck>;
  add(file: Blob, name: string, keywords: string[]): Promise<{ id: string }>;
  replace(id: string, file: Blob): Promise<void>;
  rename(id: string, name: string, keywords: string[]): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The server's diagram export report (`oc_model::diagram_export`). */
export interface DiagramExportReport {
  format: "drawio" | "mermaid";
  counts: { shapes: number; connectors: number; containers: number; needLook: number };
  items: { level: "warn" | "gray" | "ok"; code: string; title: string; detail?: string; count: number; examples: string[] }[];
}

export const USER_PALETTE = ["#2a5ad7", "#7a45f0", "#e5602a", "#0e9a78", "#d63f78", "#b7791f", "#0b7fa6", "#6b7280"];


