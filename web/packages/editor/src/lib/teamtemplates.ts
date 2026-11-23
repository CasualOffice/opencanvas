// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// TPL-01: the host's team templates in the gallery's "From your team" section. The editor
// only talks to the OpenCanvas server (`/v1/templates…` with the session ticket); the server
// calls the host, checks the file and applies it to the room.
import type { Tone } from "@opencanvas/ui";
import type { Template } from "../templates";

/** Category id of the team section (not one of the built-in `CATS`). */
export const TEAM_CAT = "yourteam";

export interface TeamItem {
  id: string;
  name: string;
  description: string;
  category: string | null;
  icon: string;
  tone: string;
  updatedAt: string | null;
}

export type TeamState =
  | { s: "off" }
  | { s: "loading" }
  | { s: "error"; message: string }
  | { s: "ready"; items: TeamItem[] };

const TONES: Tone[] = ["gray", "blue", "green", "amber", "red", "purple", "pink"];

/** Whether this session shows the team section: the host's `team_templates` flag. */
export function teamEnabled(session: { templates?: { team?: unknown } | null; demo?: boolean }): boolean {
  return !session.demo && session.templates?.team === true;
}

/** Cleans the server's answer (defensive: it already cleaned the host's list). */
export function parseTeamList(v: unknown): TeamItem[] | null {
  const o = v as { enabled?: unknown; templates?: unknown } | null;
  if (!o || o.enabled !== true || !Array.isArray(o.templates)) return null;
  const out: TeamItem[] = [];
  for (const raw of o.templates as Record<string, unknown>[]) {
    if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string" || !raw.name.trim()) continue;
    out.push({
      id: raw.id,
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : "",
      category: typeof raw.category === "string" ? raw.category : null,
      icon: typeof raw.icon === "string" && raw.icon ? raw.icon : "layout-template",
      tone: typeof raw.tone === "string" ? raw.tone : "gray",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    });
  }
  return out;
}

/** A team template as a gallery card (no blocks: the file stays with the host until used). */
export function teamCard(t: TeamItem): Template {
  return {
    id: "team:" + t.id,
    cat: TEAM_CAT,
    name: t.name,
    icon: t.icon,
    tone: (TONES as string[]).includes(t.tone) ? (t.tone as Tone) : "gray",
    desc: t.description,
    blocks: [],
  };
}

/** Matches the gallery search the way built-in templates do (name, description, category). */
export function teamMatches(t: TeamItem, q: string): boolean {
  const ql = q.trim().toLowerCase();
  return !ql || (t.name + " " + t.description + " " + (t.category ?? "")).toLowerCase().includes(ql);
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
}

function errorOf(j: Record<string, unknown>, fallback: string): string {
  const m = (j.error as { message?: unknown } | undefined)?.message;
  return typeof m === "string" && m ? m : fallback;
}

export async function loadTeamTemplates(ticket: string, f: typeof fetch = fetch): Promise<TeamItem[] | null> {
  const r = await f(`/v1/templates?ticket=${encodeURIComponent(ticket)}`);
  const j = await body(r);
  if (!r.ok) throw new Error(errorOf(j, "Your team's templates didn't load."));
  return parseTeamList(j);
}

export interface Applied {
  applyId: string;
  name: string;
}

export async function applyTeamTemplate(ticket: string, id: string, f: typeof fetch = fetch): Promise<Applied> {
  const r = await f(`/v1/templates/${encodeURIComponent(id)}/apply?ticket=${encodeURIComponent(ticket)}`, { method: "POST" });
  const j = await body(r);
  if (!r.ok || typeof j.applyId !== "string") throw new Error(errorOf(j, "That template couldn't be used. Try again."));
  return { applyId: j.applyId, name: typeof j.name === "string" ? j.name : "" };
}

export async function undoTeamTemplate(ticket: string, applyId: string, f: typeof fetch = fetch): Promise<void> {
  const q = new URLSearchParams({ ticket, applyId });
  const r = await f(`/v1/templates/undo?${q}`, { method: "POST" });
  if (!r.ok) throw new Error(errorOf(await body(r), "That template can no longer be undone."));
}
