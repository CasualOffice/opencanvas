// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The Workspace API (/api/ws/*). Cookies carry the session; every state change sends the
// custom header the server's CSRF check wants.

export type FileType = "document" | "spreadsheet" | "whiteboard" | "database";

export interface Me {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "guest";
  color: string;
  org: { name: string; accent: string; publicLinks: boolean };
  unread: number;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
}

export interface Space {
  id: string;
  name: string;
  icon: string;
  color: string;
  visibility: "open" | "private";
  personal: boolean;
  role: string | null;
  member: boolean;
  folders: Folder[];
  description?: string;
}

export interface Card {
  id: string;
  name: string;
  type: FileType;
  workspaceId: string;
  workspace?: string;
  folderId: string | null;
  folder?: string | null;
  updatedAt: number;
  updatedBy?: string;
  size: number;
  version: number;
  star: boolean;
  role: string | null;
  isTemplate: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/ws${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "x-requested-with": "opencanvas-workspace",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new ApiError(r.status, data.error || "ERROR", data.message || "Something went wrong");
  return data as T;
}

export const api = {
  get: <T>(p: string) => call<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => call<T>("POST", p, b),
  put: <T>(p: string, b: unknown = {}) => call<T>("PUT", p, b),
  patch: <T>(p: string, b: unknown = {}) => call<T>("PATCH", p, b),
  del: <T>(p: string) => call<T>("DELETE", p),
};

export const TYPES: { id: FileType; label: string; line: string; tone: string }[] = [
  { id: "document", label: "Document", line: "Text, tasks and any block", tone: "t-blue" },
  { id: "spreadsheet", label: "Spreadsheet", line: "Grid, formulas and sheets", tone: "t-green" },
  { id: "whiteboard", label: "Whiteboard", line: "Board, diagrams and stickies", tone: "t-amber" },
  { id: "database", label: "Database", line: "Rows with table, board and calendar views", tone: "t-purple" },
];

export const typeOf = (t: string) => TYPES.find((x) => x.id === t) ?? TYPES[0];

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
