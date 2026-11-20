import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { Role } from "@opencanvas/ui";

export interface Peer {
  clientId: number;
  id: string;
  name: string;
  color: string;
  avatar?: string | null;
  role: Role;
  typing: boolean;
  me: boolean;
  hasCursor: boolean;
}

function read(aw: Awareness): Peer[] {
  const byUser = new Map<string, Peer>();
  aw.getStates().forEach((st, clientId) => {
    const u = st.user as { id?: string; name?: string; color?: string; avatar?: string; role?: Role } | undefined;
    if (!u?.name) return;
    const id = u.id ?? String(clientId);
    const me = clientId === aw.clientID;
    const prev = byUser.get(id);
    const p: Peer = {
      clientId,
      id,
      name: u.name,
      color: u.color ?? "#6b7280",
      avatar: u.avatar,
      role: u.role ?? "edit",
      typing: !!st.typing,
      me,
      hasCursor: !!st.cursor,
    };
    // One avatar per person even with several tabs open; keep the most active.
    if (!prev || me || (!prev.me && (p.typing || p.hasCursor))) byUser.set(id, prev ? { ...p, me: prev.me || me, typing: prev.typing || p.typing } : p);
  });
  return [...byUser.values()].sort((a, b) => Number(b.me) - Number(a.me) || Number(a.role === "view") - Number(b.role === "view") || a.name.localeCompare(b.name));
}

export function usePeers(aw: Awareness): Peer[] {
  const [peers, setPeers] = useState(() => read(aw));
  useEffect(() => {
    let last = "";
    const f = () => {
      const next = read(aw);
      const key = JSON.stringify(next.map((p) => [p.id, p.name, p.color, p.role, p.typing, p.hasCursor, p.me]));
      if (key !== last) {
        last = key;
        setPeers(next);
      }
    };
    aw.on("change", f);
    f();
    return () => aw.off("change", f);
  }, [aw]);
  return peers;
}
