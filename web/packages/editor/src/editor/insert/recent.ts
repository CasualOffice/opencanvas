// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Recent and remembered variants (INS-01, approved frames 4a-4b): one small record in this
// browser's localStorage per host and person. Never sent anywhere. Every access is in try/catch:
// a private window or blocked storage just means no Recent band.

export interface RecentEntry {
  block: string;
  variant?: string;
  uses: number;
  /** YYYY-MM-DD */
  last: string;
}

export interface RecentRec {
  recent: RecentEntry[];
  /** The remembered variant per block (only from the menu, never from markdown). */
  variant: Record<string, string>;
}

/** At most this many entries are kept. */
export const RECENT_CAP = 24;
/** At most this many are shown. */
export const RECENT_SHOWN = 4;
const HALF_AFTER_DAYS = 14;

export const emptyRec = (): RecentRec => ({ recent: [], variant: {} });

export const storageKey = (scope: string) => `oc.insert.v1:${scope}`;

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

function valid(x: unknown): RecentRec {
  const r = x as Partial<RecentRec> | null;
  const recent = Array.isArray(r?.recent)
    ? r!.recent.filter((e): e is RecentEntry => !!e && typeof e.block === "string" && typeof e.uses === "number" && typeof e.last === "string").slice(0, RECENT_CAP)
    : [];
  const variant: Record<string, string> = {};
  if (r?.variant && typeof r.variant === "object") for (const [k, v] of Object.entries(r.variant)) if (typeof v === "string") variant[k] = v;
  return { recent, variant };
}

export function loadRecent(scope: string, store: Pick<Storage, "getItem"> | null = safeStorage()): RecentRec {
  try {
    const raw = store?.getItem(storageKey(scope));
    return raw ? valid(JSON.parse(raw)) : emptyRec();
  } catch {
    return emptyRec();
  }
}

export function saveRecent(scope: string, rec: RecentRec, store: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    store?.setItem(storageKey(scope), JSON.stringify(rec));
  } catch {
    /* blocked or full: the menu works the same */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Uses, with a use counting half once the entry is older than 14 days. */
export function score(e: RecentEntry, now: number): number {
  const age = (now - Date.parse(e.last + "T00:00:00Z")) / 86_400_000;
  return e.uses * (age > HALF_AFTER_DAYS ? 0.5 : 1);
}

/** One insert from the menu: counts the use and remembers the variant. */
export function recordUse(rec: RecentRec, block: string, variant: string | undefined, now: number): RecentRec {
  const recent = rec.recent.map((e) => ({ ...e }));
  const hit = recent.find((e) => e.block === block && e.variant === variant);
  if (hit) {
    hit.uses += 1;
    hit.last = day(now);
  } else recent.push(variant ? { block, variant, uses: 1, last: day(now) } : { block, uses: 1, last: day(now) });
  const kept = ranked(recent, now).slice(0, RECENT_CAP);
  return { recent: kept, variant: variant ? { ...rec.variant, [block]: variant } : { ...rec.variant } };
}

export function ranked(list: RecentEntry[], now: number): RecentEntry[] {
  return [...list].sort((a, b) => score(b, now) - score(a, now) || b.last.localeCompare(a.last));
}

/** Clear empties the list at once (no dialog); remembered variants stay. */
export const clearRecent = (rec: RecentRec): RecentRec => ({ recent: [], variant: { ...rec.variant } });
