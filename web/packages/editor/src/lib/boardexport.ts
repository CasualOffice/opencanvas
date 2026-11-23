// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-14.6: draw.io and Mermaid board export through the server (`oc_model::diagram_export`):
// `GET /v1/export/board/:id.:ext?ticket=&report=1[&ids=]` answers `{text, report}`.
import type { DiagramExportReport } from "@opencanvas/ui";

export async function exportBoardText(ticket: string, boardId: string, fmt: "drawio" | "mmd", ids: string[] | null): Promise<{ text: string; report: DiagramExportReport }> {
  const q = new URLSearchParams({ ticket, report: "1" });
  if (ids) q.set("ids", ids.join(","));
  const r = await fetch(`/v1/export/board/${encodeURIComponent(boardId)}.${fmt}?${q}`);
  if (!r.ok) throw new Error(`export ${r.status}`);
  return (await r.json()) as { text: string; report: DiagramExportReport };
}
