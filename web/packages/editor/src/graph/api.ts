// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// `GET /v1/graph` (GRAPH-01, ADR-082): the local graph of this session's canvas, or the full
// graph with `root=none`, as this session's person. Nothing is kept beyond the panel's memory.
import type { GraphData } from "./model";

export interface GraphError extends Error {
  status: number;
  code: string;
  /** Seconds, for RATE_LIMITED. */
  retryAfter: number;
}

export async function fetchGraph(ticket: string, o: { full: boolean; depth?: number; blocks?: boolean; signal?: AbortSignal }): Promise<GraphData> {
  const q = new URLSearchParams({ ticket });
  if (o.full) q.set("root", "none");
  else q.set("depth", String(o.depth ?? 1));
  if (o.blocks) q.set("blocks", "true");
  const r = await fetch(`/v1/graph?${q}`, { signal: o.signal });
  if (!r.ok) {
    let code = "";
    try {
      code = ((await r.json()) as { code?: string }).code ?? "";
    } catch {
      /* no body */
    }
    throw Object.assign(new Error(code || `HTTP ${r.status}`), { status: r.status, code, retryAfter: Number(r.headers.get("retry-after")) || 0 }) as GraphError;
  }
  const d = (await r.json()) as GraphData;
  return { nodes: Array.isArray(d.nodes) ? d.nodes : [], edges: Array.isArray(d.edges) ? d.edges : [], truncated: !!d.truncated, total: typeof d.total === "number" ? d.total : undefined };
}
