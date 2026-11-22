// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The file block's actions (FILE-01), shared by the card's ⋯ menu and the block menu. The
// card implements them; the block menu sends a FILE_EVENT to the card.
import type { FileDisplay, FileKind } from "./kind";

export type FileActionId = "preview" | "expand" | "display" | "download" | "copy" | "rename" | "replace" | "comment" | "delete";

export interface FileAction {
  id: FileActionId;
  icon: string;
  label: string;
  hint?: string;
  danger?: boolean;
  sepBefore?: boolean;
}

/**
 * What a person may do with an attachment. Viewers: Preview, Download (when allowed) and
 * Copy link. Commenters add Comment. Editors get everything. The block menu has its own
 * Comment and Delete, so `inBlockMenu` leaves those out.
 */
export function fileActions(o: { kind: FileKind; display: FileDisplay; role: string; editable: boolean; canDownload: boolean; hasFile: boolean; inBlockMenu: boolean }): FileAction[] {
  const out: FileAction[] = [];
  const edit = o.editable && o.role === "edit";
  if (o.hasFile) {
    out.push({ id: "preview", icon: "eye", label: "Preview", hint: o.inBlockMenu ? undefined : "Enter" });
    out.push({ id: "expand", icon: "maximize-2", label: "Expand to full screen" });
    if (edit && o.kind === "pdf") out.push(o.display === "preview" ? { id: "display", icon: "rectangle-horizontal", label: "Show as card" } : { id: "display", icon: "book-open", label: "Show as preview" });
    if (o.canDownload) out.push({ id: "download", icon: "download", label: "Download", sepBefore: true });
    out.push({ id: "copy", icon: "link", label: "Copy link", sepBefore: !o.canDownload });
  }
  if (edit) {
    out.push({ id: "rename", icon: "pencil", label: "Rename", sepBefore: true });
    out.push({ id: "replace", icon: "refresh-cw", label: "Replace file" });
  }
  if (!o.inBlockMenu && (o.role === "edit" || o.role === "comment")) out.push({ id: "comment", icon: "message-square-plus", label: "Comment", sepBefore: !edit });
  if (!o.inBlockMenu && edit) out.push({ id: "delete", icon: "trash-2", label: "Delete", danger: true, sepBefore: true });
  return out;
}
