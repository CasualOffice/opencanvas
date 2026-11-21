// People for one viewer (docs/21, ADR-026). The host owns its users; this module merges what
// OpenCanvas knows about them, per id, in the documented order:
//
//   resolve (tier 3, this viewer's answer) > tokens (presence, participants) > document snapshot
//
// Presence arrives already rewritten for this viewer by the server, so it ranks with tokens.
// When a resolve answer exists, the document's snapshot labels are never shown for that id.
// Nothing here decides who knows whom: relations and search results come from the host.
import type * as Y from "yjs";
import { HIDDEN_COLOR, HIDDEN_NAME, USER_PALETTE, duplicateNames, foldName, initialsById, type OcUser, type Relation } from "@opencanvas/ui";
import { createStore, type Store } from "./store";

export type Coviewers = "all" | "contacts" | "none";

export interface PeopleConfig {
  /** Session ticket for `/v1/users` and `/v1/users/resolve`; absent in `#demo`. */
  ticket?: string;
  me: OcUser;
  /** Tier 1: from this viewer's own token only. */
  participants: OcUser[];
  coviewers: Coviewers;
  /** The host has user callbacks (JWT); false for WOPI and `#demo`. */
  callbacks: boolean;
  showEmail: boolean;
  /** Demo/offline directory (search runs locally). */
  local?: OcUser[];
}

/** `unknown`: the first resolve answer isn't in yet; `none`: no resolve callback (tiers 0-2). */
export type ResolveState = "unknown" | "available" | "none";

const SEARCH_TTL = 30_000;

export function colorOf(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return USER_PALETTE[h % (USER_PALETTE.length - 1)];
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** A user object from the server (search, resolve, participants, the `people` root). */
export function toUser(v: Record<string, unknown>): OcUser | null {
  const id = str(v.id);
  if (!id) return null;
  const relation = str(v.relation) as Relation | undefined;
  const hidden = relation === "hidden";
  return {
    id,
    name: hidden ? HIDDEN_NAME : str(v.name) ?? id,
    color: hidden ? HIDDEN_COLOR : str(v.color) ?? colorOf(id),
    avatar: hidden ? undefined : str(v.avatar),
    detail: hidden ? undefined : str(v.detail),
    email: hidden ? undefined : str(v.email),
    relation,
    deactivated: v.deactivated === true || undefined,
    access: typeof v.access === "boolean" ? v.access : undefined,
    lastSeen: typeof v.lastSeen === "number" ? v.lastSeen : undefined,
  };
}

export class People {
  /** Bumped on every change, for `useSyncExternalStore` and node views. */
  readonly version: Store<number> = createStore(0);
  state: ResolveState;
  private resolved = new Map<string, OcUser>();
  /** Ids a finished resolve call asked about (listed or not). */
  private answered = new Set<string>();
  private queued = new Set<string>();
  private timer: number | undefined;
  private inflight = 0;
  private docPeople = new Map<string, OcUser>();
  private peers = new Map<string, OcUser>();
  private participants: Map<string, OcUser>;
  private searchCache = new Map<string, { at: number; list: OcUser[] }>();
  private derived: { dupes: Set<string>; initials: Map<string, string> } | null = null;
  private off: (() => void) | null = null;

  constructor(readonly cfg: PeopleConfig, doc?: Y.Doc) {
    this.state = cfg.callbacks && cfg.ticket ? "unknown" : "none";
    this.participants = new Map(cfg.participants.map((u) => [u.id, u]));
    if (doc) this.watchDoc(doc);
    // Ask once right away, so "no resolve callback" is known before any chip waits on it.
    if (this.state === "unknown") this.request([cfg.me.id]);
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
    window.clearTimeout(this.timer);
  }

  // ---------- sources ----------

  /** Tier 0: the document's `people` root (who opened the file). */
  private watchDoc(doc: Y.Doc) {
    const map = doc.getMap<Record<string, unknown>>("people");
    const read = () => {
      this.docPeople.clear();
      map.forEach((v, id) => {
        const u = v && typeof v === "object" ? toUser({ ...v, id }) : null;
        if (u) this.docPeople.set(id, u);
      });
      this.request([...this.docPeople.keys()]);
      this.changed();
    };
    map.observe(read);
    read();
    this.off = () => map.unobserve(read);
  }

  /** Presence (already rewritten for this viewer by the server). */
  setPeers(list: OcUser[]) {
    const next = new Map(list.map((u) => [u.id, u]));
    const key = (m: Map<string, OcUser>) => JSON.stringify([...m.values()].map((u) => [u.id, u.name, u.detail, u.relation, u.avatar, u.color]));
    if (key(next) === key(this.peers)) return;
    this.peers = next;
    this.changed();
  }

  // ---------- tier 3: resolve ----------

  /** Queues ids for this viewer's resolve call (batched, at most one call in flight per batch). */
  request(ids: Iterable<string>) {
    if (this.state === "none" || !this.cfg.ticket) return;
    let added = false;
    for (const id of ids) {
      if (!id || this.answered.has(id) || this.queued.has(id) || id.startsWith("anon_")) continue;
      this.queued.add(id);
      added = true;
    }
    if (added && this.timer === undefined) this.timer = window.setTimeout(() => void this.flush(), 40);
  }

  private async flush() {
    this.timer = undefined;
    const ids = [...this.queued].slice(0, 500);
    if (!ids.length) return;
    ids.forEach((i) => this.queued.delete(i));
    this.inflight++;
    try {
      const r = await fetch(`/v1/users/resolve?ticket=${encodeURIComponent(this.cfg.ticket!)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const j = r.ok ? ((await r.json()) as { resolve?: boolean; users?: Record<string, unknown>[] }) : { resolve: false };
      if (!j.resolve) {
        // No resolve callback, or the host can't be reached: tokens and snapshots apply.
        this.state = "none";
        this.queued.clear();
      } else {
        this.state = "available";
        for (const v of j.users ?? []) {
          const u = toUser(v);
          if (u) this.resolved.set(u.id, u);
        }
      }
    } catch {
      this.state = "none";
    } finally {
      this.inflight--;
      ids.forEach((i) => this.answered.add(i));
      this.changed();
      if (this.queued.size && this.state !== "none") this.timer = window.setTimeout(() => void this.flush(), 0);
    }
  }

  // ---------- reading ----------

  /** The resolve answer for `id`, if any. */
  resolvedOf(id: string): OcUser | undefined {
    return this.resolved.get(id);
  }

  /**
   * How this viewer sees `id`: resolve > presence/tokens > the `people` root > `snapshot` (the
   * label stored with a mention or comment). `pending` while a resolve answer may still
   * replace a document snapshot, so a name the viewer mustn't see is never shown meanwhile.
   */
  get(id: string, snapshot?: string | null): OcUser {
    if (id === this.cfg.me.id) return this.resolved.get(id) ? { ...this.cfg.me, ...pickName(this.resolved.get(id)!) } : this.cfg.me;
    const r = this.resolved.get(id);
    if (r) return r;
    const tok = this.peers.get(id) ?? this.participants.get(id) ?? this.cfg.local?.find((u) => u.id === id);
    if (tok) {
      this.request([id]);
      const d = this.docPeople.get(id);
      return d && !tok.lastSeen ? { ...tok, lastSeen: d.lastSeen } : tok;
    }
    this.request([id]);
    const waiting = this.state === "unknown" || (this.state === "available" && !this.answered.has(id));
    if (waiting) return { id, name: "…", color: HIDDEN_COLOR, pending: true };
    const d = this.docPeople.get(id);
    if (d) return d;
    return { id, name: snapshot || id, color: colorOf(id) };
  }

  private allKnown(): OcUser[] {
    const m = new Map<string, OcUser>();
    for (const src of [this.docPeople, this.participants, this.peers, this.resolved]) for (const [id, u] of src) m.set(id, u);
    m.set(this.cfg.me.id, this.cfg.me);
    return [...m.keys()].map((id) => this.get(id)).filter((u) => !u.pending);
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

  // ---------- who can be mentioned ----------

  /** Whether a co-viewer (opened the file, is here, or is in the document) may be listed. */
  private coviewerListed(id: string): boolean {
    const r = this.resolved.get(id);
    if (r) return r.relation === "contact" || r.relation === "member" || r.relation === undefined;
    if (this.cfg.coviewers === "none") return false;
    if (this.cfg.coviewers === "all") return true;
    // "contacts": only a resolve answer can say so. Without a resolve callback the server
    // can't tell contacts apart, and lists co-viewers like "all" (docs/21 deviation note).
    return this.state === "none";
  }

  /** People this viewer can mention or assign without a search: themselves, their token's
   *  participants, and co-viewers the host allows. */
  pickable(): OcUser[] {
    const out = new Map<string, OcUser>();
    out.set(this.cfg.me.id, this.cfg.me);
    for (const u of this.cfg.local ?? []) out.set(u.id, this.get(u.id));
    for (const id of this.participants.keys()) out.set(id, this.get(id));
    for (const id of new Set([...this.docPeople.keys(), ...this.peers.keys()])) {
      if (out.has(id) || id.startsWith("anon_")) continue;
      if (this.coviewerListed(id)) out.set(id, this.get(id));
    }
    return [...out.values()].filter((u) => !u.pending && u.relation !== "hidden" && u.relation !== "external" && !u.deactivated);
  }

  /** The mention picker: the host's per-viewer search (tier 2) plus [`pickable`], matched
   *  case- and accent-insensitively on the name or second line, same-name rows together. */
  async search(q: string): Promise<OcUser[]> {
    const fq = foldName(q);
    const host = await this.hostSearch(q);
    const out = new Map<string, OcUser>();
    for (const u of this.pickable()) out.set(u.id, u);
    for (const h of host) {
      // The host's search is per viewer and authoritative: even an external person it lists may
      // be mentioned. Fresh resolve answers still win for the name.
      const r = this.resolved.get(h.id);
      out.set(h.id, { ...h, ...(r ? pickName(r) : {}), access: h.access });
    }
    return [...out.values()]
      .filter((u) => u.relation !== "hidden" && !u.deactivated)
      .filter((u) => !fq || foldName(u.name).includes(fq) || (u.detail ? foldName(u.detail).includes(fq) : false))
      .sort((a, b) => foldName(a.name).localeCompare(foldName(b.name)) || (a.detail ?? "").localeCompare(b.detail ?? "") || a.id.localeCompare(b.id));
  }

  private async hostSearch(q: string): Promise<OcUser[]> {
    if (!this.cfg.callbacks || !this.cfg.ticket || !q) return [];
    const hit = this.searchCache.get(q);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list;
    try {
      const r = await fetch(`/v1/users?ticket=${encodeURIComponent(this.cfg.ticket)}&q=${encodeURIComponent(q)}`);
      if (!r.ok) return [];
      const j = (await r.json()) as Record<string, unknown>[];
      const list = (Array.isArray(j) ? j : []).map(toUser).filter((u): u is OcUser => !!u);
      this.searchCache.set(q, { at: Date.now(), list });
      return list;
    } catch {
      return [];
    }
  }
}

function pickName(r: OcUser): Partial<OcUser> {
  return { name: r.name, detail: r.detail ?? undefined, relation: r.relation, deactivated: r.deactivated, avatar: r.avatar ?? undefined };
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
