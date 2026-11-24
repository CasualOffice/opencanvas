// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Block discovery metadata (owner decision for v0.2; manifest `discovery`, ADR-058 note):
// how insert menus label, file and filter an SDK block. The one shared filter that decides
// whether a block shows in the / menu, the phone insert sheet and the gallery for an editor
// profile is `blockVisibleInMenus`; host editor profiles (`[host.editor]`) set the profile with
// `setMenuProfile`. A block already in a canvas always draws, whatever the profile.

export const CATEGORIES = ["content", "data-planning", "visual", "layout", "extensions"] as const;
export const PROFILES = ["notebook", "meeting", "project", "diagramming", "document", "full"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Profile = (typeof PROFILES)[number];

export interface Discovery {
  /** Menu label (the title when the manifest has none). */
  label: string;
  category: Category;
  /** The manifest's `keywords` and `discovery.keywords`, merged. */
  keywords: string[];
  profiles: Profile[];
  complexity: "basic" | "advanced";
}

/** The defaults the server applies when a manifest leaves a field out. */
export const DISCOVERY_DEFAULTS: Omit<Discovery, "label" | "keywords"> = { category: "extensions", profiles: ["full"], complexity: "basic" };

let profile: string | null = null;

/** Sets the editor profile menus filter by (null: no profile, everything shows). */
export function setMenuProfile(p: string | null | undefined): void {
  profile = p ?? null;
}

export function menuProfile(): string | null {
  return profile;
}

/** Whether a block is offered in the insert menus for `p` (default: the profile set with
 *  `setMenuProfile`). No profile, or `full`, offers every enabled block; any other profile
 *  offers the blocks whose `discovery.profiles` name it. */
export function blockVisibleInMenus(entry: { discovery?: Partial<Discovery> | null }, p: string | null = profile): boolean {
  if (!p || p === "full") return true;
  const ps = entry.discovery?.profiles ?? DISCOVERY_DEFAULTS.profiles;
  return (ps as string[]).includes(p);
}
