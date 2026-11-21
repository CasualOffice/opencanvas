// Telling people apart (docs/21 "Telling people apart"). Pure helpers shared by the editor and
// the block packages: case- and accent-insensitive name matching, the second line, initials
// with subscripts on collision, and how a relation is described.

/** How the host says a person relates to the viewer (docs/21). */
export type Relation = "contact" | "member" | "external" | "hidden";

export interface PersonLike {
  id: string;
  name: string;
  detail?: string;
  email?: string;
  relation?: Relation;
  deactivated?: boolean;
  lastSeen?: number;
}

/** What a `hidden` person is called everywhere. */
export const HIDDEN_NAME = "Someone";
/** The neutral colour of a `hidden` person. */
export const HIDDEN_COLOR = "#6b7280";

/** Case- and accent-insensitive comparison key: "Ásha  RAO" → "asha rao". */
export function foldName(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/** Folded names that two or more different known people share (hidden people never count). */
export function duplicateNames(people: Iterable<PersonLike>): Set<string> {
  const ids = new Map<string, Set<string>>();
  for (const p of people) {
    if (!p.name || p.relation === "hidden") continue;
    const k = foldName(p.name);
    const s = ids.get(k) ?? new Set<string>();
    s.add(p.id);
    ids.set(k, s);
  }
  return new Set([...ids].filter(([, s]) => s.size > 1).map(([k]) => k));
}

/** "just now", "5 minutes ago", "3 days ago". */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  if (s < 86400 * 60) return unit(Math.floor(s / 86400), "day");
  return unit(Math.floor(s / (86400 * 30)), "month");
}

/**
 * The muted second line under a name: the host's `detail`; else the e-mail when the viewer may
 * see it; else "Last here 3 days ago"; else the last 4 characters of the id ("ID …x7Q2").
 */
export function secondLine(p: PersonLike, opts: { showEmail?: boolean; now?: number } = {}): string {
  if (p.detail) return p.detail;
  if (opts.showEmail && p.email) return p.email;
  if (p.lastSeen) return `Last here ${timeAgo(p.lastSeen, opts.now)}`;
  return `ID …${p.id.slice(-4)}`;
}

/** "Asha Rao · Design" when the name is shared (or `always`), else just the name. */
export function nameWithDetail(p: PersonLike, dupes: Set<string>, always = false): string {
  if (p.relation === "hidden" || !p.detail) return p.name;
  return always || dupes.has(foldName(p.name)) ? `${p.name} · ${p.detail}` : p.name;
}

/** A short note about how this person relates to the viewer, if any. */
export function relationNote(p: PersonLike): string | null {
  if (p.deactivated) return "Former member";
  if (p.relation === "external") return "Not in your contacts";
  return null;
}

export function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";
const subscript = (n: number) => String(n).replace(/\d/g, (d) => SUB[Number(d)]);

/**
 * Initials per id, with a subscript when two people's initials collide ("AR", "AR₂"). Ids are
 * ordered so everyone sees the same suffixes; hidden people are left out.
 */
export function initialsById(people: Iterable<PersonLike>): Map<string, string> {
  const byIni = new Map<string, string[]>();
  for (const p of people) {
    if (p.relation === "hidden") continue;
    const k = initials(p.name);
    const list = byIni.get(k) ?? [];
    if (!list.includes(p.id)) list.push(p.id);
    byIni.set(k, list);
  }
  const out = new Map<string, string>();
  for (const [k, ids] of byIni) {
    ids.sort();
    ids.forEach((id, i) => out.set(id, i === 0 ? k : k + subscript(i + 1)));
  }
  return out;
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
