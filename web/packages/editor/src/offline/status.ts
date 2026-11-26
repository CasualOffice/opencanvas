// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// What the save pill and the offline popover show (OFF-06, frames 1a-1d). Kept small: it is on
// the first paint. The offline controller (lazy, offline/controller.ts) writes it; session
// resilience without an offline copy only needs `net` and the unsent count.
import { createStore } from "../lib/store";

export type Net = "online" | "offline" | "reconnecting" | "sending";

export interface OfflineView {
  /** `[host.offline] enabled` for this host. */
  enabled: boolean;
  /** This launch may keep the canvas (`perms.offline`), else `reason`. */
  allowed: boolean;
  reason?: string;
  /** The canvas is kept on this device. */
  kept: boolean;
  auto?: boolean;
  net: Net;
  /** Unsent changes (this tab or this device). */
  pending: number;
  pendingBytes: number;
  uploads: { count: number; bytes: number; sent?: number };
  sending?: { sent: number; total: number };
  offlineSince: number | null;
  lastSent: number | null;
  validUntil: number | null;
  /** Past the unsent-change limit: editing paused (5d). */
  paused: boolean;
  /** The offline grant expired (5c). */
  locked: boolean;
  /** Opened from the device without a launch. */
  openedOffline: boolean;
  /** View only on reconnect: this many unsent changes are held (5a). */
  held: number;
  /** Access removed: the copy and this many unsent changes were deleted (5b). */
  revoked: { count: number } | null;
  maxDays: number;
  limits: { maxCanvases: number; maxMb: number; uploadsMb: number; uploadsFiles: number; unsentMb: number };
}

export const DEFAULT_LIMITS = { maxCanvases: 50, maxMb: 200, uploadsMb: 50, uploadsFiles: 20, unsentMb: 5 };

export const offlineView = createStore<OfflineView>({
  enabled: false,
  allowed: false,
  kept: false,
  net: "online",
  pending: 0,
  pendingBytes: 0,
  uploads: { count: 0, bytes: 0 },
  offlineSince: null,
  lastSent: null,
  validUntil: null,
  paused: false,
  locked: false,
  openedOffline: false,
  held: 0,
  revoked: null,
  maxDays: 7,
  limits: DEFAULT_LIMITS,
});

export const patchView = (p: Partial<OfflineView>) => offlineView.set((v) => ({ ...v, ...p }));

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The pill while offline states apply (frame 1a), or null to show the save state. */
export function offlineLook(v: OfflineView): { cls: string; icon: string; label: string } | null {
  if (v.locked) return { cls: "bad", icon: "lock", label: "Offline · locked" };
  if (v.paused) return { cls: "bad", icon: "circle-pause", label: "Offline · editing paused" };
  if (v.net === "sending") return { cls: "info", icon: "loader-circle", label: `Sending ${plural(v.pending, "change")}` };
  if (v.net === "reconnecting") return { cls: "info", icon: "loader-circle", label: "Reconnecting" };
  if (v.net !== "offline") return null;
  if (v.kept) return { cls: "warn", icon: "cloud-off", label: v.pending ? `Offline · ${plural(v.pending, "change")} on this device` : "Offline · saved on this device" };
  return { cls: "warn", icon: "cloud-off", label: v.pending ? `Offline · ${plural(v.pending, "change")} not saved yet` : "Offline · nothing to send" };
}

/** OFF-04: while a reconnect waits for the host's fresh token, the controller takes the next
 *  `Action_RefreshToken` (a token, or `{access: "none"}`). */
export const reconnectToken: { take: ((v: Record<string, unknown>) => void) | null } = { take: null };

/** Frame 1d: the browser's own "Leave site?" only while changes exist in this tab alone. */
export function leaveGuard(e: BeforeUnloadEvent) {
  const v = offlineView.get();
  if (!v.kept && v.net !== "online" && v.pending > 0) {
    e.preventDefault();
    e.returnValue = "";
  }
}

/** "Available offline on this device" in the canvas menu (2a, 2d, 3b) and the phone sheet (8c). */
export function keepLine(v: OfflineView, hostName: string, phone: boolean): { on: boolean; disabled: boolean; sub: string } {
  if (!v.allowed) {
    const r = v.reason;
    const sub =
      r === "shared-device"
        ? `${hostName} doesn’t keep canvases on shared or public computers`
        : r === "wopi"
          ? `${hostName} opens canvases in a way that can’t be kept offline yet`
          : r && r !== "not-allowed"
            ? r
            : `${hostName} doesn’t allow offline copies for this canvas`;
    return { on: false, disabled: true, sub };
  }
  if (v.kept) return { on: true, disabled: false, sub: v.validUntil ? `Kept on this ${phone ? "phone" : "device"} · valid until ${new Date(v.validUntil).toLocaleDateString([], { month: "short", day: "numeric" })}` : "Kept on this device" };
  return { on: false, disabled: false, sub: "Open and edit without a connection" };
}
