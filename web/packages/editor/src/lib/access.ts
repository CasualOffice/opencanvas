// docs/23 PERM-07, prototype Main.dc.html (docs/prototypes/fixes-approved): access running out.
// WARN_S before the session's `exp` we post `Token_Expiring` to the host. A host that renews
// (`Action_RefreshToken`) does so quietly; if it hasn't within GRACE_MS the amber bar shows. At
// `exp` the canvas turns read only (local edits stay in the Y.Doc) until access is renewed.
import type { Session } from "./session";

export const WARN_S = 60;
export const GRACE_MS = 5_000;

export type AccessState = "ok" | "warn" | "expired";

/** Swaps the session onto the ticket for the host's fresh token (POST /v1/launch, JSON). */
export async function renewSession(token: string): Promise<{ ticket: string; exp: number | null }> {
  const r = await fetch("/v1/launch", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!r.ok) throw new Error("renew failed: " + r.status);
  const { ticket } = (await r.json()) as { ticket: string };
  const s = await fetch(`/v1/sessions/${encodeURIComponent(ticket)}`, { headers: { Accept: "application/json" } });
  if (!s.ok) throw new Error("session failed: " + s.status);
  const j = (await s.json()) as Session;
  return { ticket, exp: typeof j.exp === "number" ? j.exp : null };
}

/** When each step is due, in ms from `now`; null = no expiry known. */
export function schedule(exp: number | null | undefined, now = Date.now()) {
  if (!exp) return null;
  const end = exp * 1000 - now;
  return { ask: Math.max(0, end - WARN_S * 1000), warn: Math.max(0, end - WARN_S * 1000 + GRACE_MS), end: Math.max(0, end) };
}

export const savedAtLabel = (at: number | null) =>
  at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
