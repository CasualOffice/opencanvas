// People on this canvas (docs/21 revision 2, ADR-026). The mention list is the people with
// access to this canvas: the server's `/v1/members` (members callback > token `members` > the
// saved `people` map). The list is the same for every viewer, everyone sees real names, and
// e-mail is never read or shown. A mentioned id that is no longer a member keeps its snapshot
// label and is marked "No longer has access".
import type * as Y from "yjs";
import { USER_PALETTE, duplicateNames, foldName, initialsById, type OcUser } from "@opencanvas/ui";
import { createStore, type Store } from "./store";

export interface PeopleConfig {
  /** Session ticket for `/v1/members`; absent in `#demo`. */
  ticket?: string;
  me: OcUser;
  /** Demo/offline members (no server). */
  local?: OcUser[];
}

const SEARCH_TTL = 30_000;

export function colorOf(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return USER_PALETTE[h % (USER_PALETTE.length - 1)];
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** A user object from the server (`/v1/members`, the `people` root). Any e-mail is dropped. */
export function toUser(v: Record<string, unknown>): OcUser | null {
  const id = str(v.id);
  if (!id) return null;
  return {
    id,
    name: str(v.name) ?? id,
    color: str(v.color) ?? colorOf(id),
    avatar: str(v.avatar),
    detail: str(v.detail),
    lastSeen: typeof v.lastSeen === "number" ? v.lastSeen : undefined,
  };
}

export class People {
  /** Bumped on every change, for `useSyncExternalStore` and node views. */
  readonly version: Store<number> = createStore(0);
  /** The member list arrived (until then nobody is marked "No longer has access"). */
  loaded: boolean;
  private members = new Map<string, OcUser>();
  private docPeople = new Map<string, OcUser>();
  private peers = new Map<string, OcUser>();
  private searchCache = new Map<string, { at: number; list: OcUser[] }>();
  private derived: { dupes: Set<string>; initials: Map<string, string> } | null = null;
  private off: (() => void) | null = null;

  constructor(readonly cfg: PeopleConfig, doc?: Y.Doc) {
    this.loaded = !cfg.ticket;
    for (const u of cfg.local ?? []) this.members.set(u.id, u);
    this.members.set(cfg.me.id, cfg.me);
    if (doc) this.watchDoc(doc);
    if (cfg.ticket) void this.load();
  }

  private changed() {
    this.derived = null;
    this.version.set((v) => v + 1);
  }

  subscribe(fn: () => void): () => void {
    return this.version.subscribe(fn);
  }

  destroy() {
    this.off?.();
  }

  private async fetchMembers(q: string): Promise<OcUser[] | null> {
    try {
      const r = await fetch(`/v1/members?ticket=${encodeURIComponent(this.cfg.ticket!)}&q=${encodeURIComponent(q)}`);
      if (!r.ok) return null;
      const j = (await r.json()) as { members?: Record<string, unknown>[] };
      return (j.members ?? []).map(toUser).filter((u): u is OcUser => !!u);
    } catch {
      return null;
    }
  }

  /** The canvas's members, once per open (a rename or a removal shows on reload). */
  private async load() {
    const list = await this.fetchMembers("");
    if (list) {
      for (const u of list) this.members.set(u.id, u.id === this.cfg.me.id ? { ...this.cfg.me, ...u, color: this.cfg.me.color } : u);
      this.loaded = true;
    }
    this.changed();
  }

  /** The document's `people` root (who opened the file). */
  private watchDoc(doc: Y.Doc) {
    const map = doc.getMap<Record<string, unknown>>("people");
    const read = () => {
      this.docPeople.clear();
      map.forEach((v, id) => {
        const u = v && typeof v === "object" ? toUser({ ...v, id }) : null;
        if (u) this.docPeople.set(id, u);
      });
      this.changed();
    };
    map.observe(read);
    read();
    this.off = () => map.unobserve(read);
  }

  /** Presence: someone here right now has access. */
  setPeers(list: OcUser[]) {
    const next = new Map(list.map((u) => [u.id, u]));
    const key = (m: Map<string, OcUser>) => JSON.stringify([...m.values()].map((u) => [u.id, u.name, u.detail, u.avatar, u.color]));
    if (key(next) === key(this.peers)) return;
    this.peers = next;
    this.changed();
  }

  /** Whether `id` has access to this canvas. */
  isMember(id: string): boolean {
    return this.members.has(id) || this.peers.has(id);
  }

  /**
   * `id` as shown: the member's current name; else (no longer a member) the `snapshot` label
   * stored with the mention or comment, marked `deactivated` ("No longer has access").
   */
  get(id: string, snapshot?: string | null): OcUser {
    if (id === this.cfg.me.id) return this.members.get(id) ?? this.cfg.me;
    const m = this.members.get(id) ?? this.peers.get(id);
    const d = this.docPeople.get(id);
    if (m) return d?.lastSeen && !m.lastSeen ? { ...m, lastSeen: d.lastSeen } : m;
    if (!this.loaded && d) return d;
    return { id, name: snapshot || d?.name || id, color: colorOf(id), deactivated: this.loaded || undefined };
  }

  private allKnown(): OcUser[] {
    const ids = new Set([...this.members.keys(), ...this.peers.keys(), ...this.docPeople.keys()]);
    return [...ids].map((id) => this.get(id));
  }

  private derive() {
    if (!this.derived) {
      const all = this.allKnown();
      this.derived = { dupes: duplicateNames(all), initials: initialsById(all) };
    }
    return this.derived;
  }

  /** Folded names that two or more known people share. */
  dupes(): Set<string> {
    return this.derive().dupes;
  }

  isDuplicate(name: string): boolean {
    return this.derive().dupes.has(foldName(name));
  }

  /** Initials with a subscript when they collide ("AR", "AR₂"). */
  initialsOf(id: string, name: string): string {
    return this.derive().initials.get(id) ?? initialsFallback(name);
  }

  /** The canvas's members (who can be mentioned or assigned). Before the list arrives:
   *  everyone who opened the canvas and everyone here. */
  pickable(): OcUser[] {
    const out = new Map<string, OcUser>();
    if (!this.loaded) for (const id of this.docPeople.keys()) out.set(id, this.get(id));
    for (const id of new Set([...this.members.keys(), ...this.peers.keys()])) out.set(id, this.get(id));
    return [...out.values()].filter((u) => !u.deactivated);
  }

  /** The mention picker: members matched case- and accent-insensitively on the name or second
   *  line (plus the host's members search for big lists), same-name rows together. */
  async search(q: string): Promise<OcUser[]> {
    const fq = foldName(q);
    const out = new Map<string, OcUser>();
    for (const u of this.pickable()) out.set(u.id, u);
    for (const h of await this.hostSearch(q)) if (!out.has(h.id)) out.set(h.id, h);
    return [...out.values()]
      .filter((u) => !fq || foldName(u.name).includes(fq) || (u.detail ? foldName(u.detail).includes(fq) : false))
      .sort((a, b) => foldName(a.name).localeCompare(foldName(b.name)) || (a.detail ?? "").localeCompare(b.detail ?? "") || a.id.localeCompare(b.id));
  }

  private async hostSearch(q: string): Promise<OcUser[]> {
    if (!this.cfg.ticket || !q) return [];
    const hit = this.searchCache.get(q);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list;
    const list = (await this.fetchMembers(q)) ?? [];
    this.searchCache.set(q, { at: Date.now(), list });
    return list;
  }
}

function initialsFallback(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

/** The page's people (one canvas per page), for node views and plugins outside React. */
export const peopleRef: { current: People | null } = { current: null };
export const peopleChanged = createStore(0);

export function setPeople(p: People | null) {
  peopleRef.current = p;
  peopleChanged.set((v) => v + 1);
}
