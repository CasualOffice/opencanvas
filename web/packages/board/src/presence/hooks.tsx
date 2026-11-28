// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Working together (decision 12): other people on this board from awareness, following one of them.
import { useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import { readPeer, viewFor } from "./awareness";

export interface Peer {
  id: number;
  name: string;
  color: string;
  x: number | null;
  y: number | null;
  sel: string[];
  vp: [number, number, number] | null;
}
type View = { tx: number; ty: number; z: number };

/** Everyone else on this board (a cursor, a selection or a viewport here). */
export function usePeers(awareness: Awareness | undefined, boardId: string): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    if (!awareness) return;
    const read = () => {
      const out: Peer[] = [];
      awareness.getStates().forEach((st, id) => {
        if (id === awareness.clientID || !st) return;
        const b = readPeer(st.board, boardId);
        if (!b || (b.x === null && !b.sel.length && !b.vp)) return;
        const u = (st.user ?? {}) as { name?: string; color?: string };
        out.push({ id, name: String(u.name ?? "Someone"), color: String(u.color ?? "var(--u2)"), ...b });
      });
      setPeers(out);
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [awareness, boardId]);
  return peers;
}

/**
 * Following a person: our view tracks their viewport. Any other change to our view (pan, zoom,
 * fit) stops it, as do Esc and Stop. Nothing is written anywhere.
 */
export function useFollow(peers: Peer[], view: View, size: [number, number], setView: (v: View) => void) {
  const [following, setFollowing] = useState<number | null>(null);
  const applied = useRef<View | null>(null);
  const peer = following === null ? undefined : peers.find((p) => p.id === following);
  const vp = peer?.vp;
  useEffect(() => {
    if (following === null) return;
    if (!peer) return setFollowing(null);
    if (!vp) return;
    const v = viewFor(vp, size);
    const cur = applied.current ?? view;
    if (Math.abs(cur.tx - v.tx) < 0.5 && Math.abs(cur.ty - v.ty) < 0.5 && Math.abs(cur.z - v.z) < 1e-4 && applied.current === view) return;
    applied.current = v;
    setView(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, vp?.[0], vp?.[1], vp?.[2], size[0], size[1], !!peer]);
  // Our view changed, and not to what following set: someone panned or zoomed, so stop.
  const last = useRef(view);
  useEffect(() => {
    if (last.current === view) return;
    last.current = view;
    if (following !== null && applied.current && view !== applied.current) {
      applied.current = null;
      setFollowing(null);
    }
  }, [view, following]);
  return {
    following: peer ?? null,
    follow: (id: number) => {
      applied.current = null;
      setFollowing(id);
    },
    stop: () => {
      applied.current = null;
      setFollowing(null);
    },
  };
}
