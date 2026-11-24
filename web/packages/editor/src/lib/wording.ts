// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Host-level wording of a temporary canvas (ADR-049). "meeting" is the default and what the
// Jitsi integration shows; "room" is the approved Matrix wording (MX prototype S5, S6, S7a, S7b).
// The session carries `wording` from `[host.flags] temporary_wording`.

export type Wording = "meeting" | "room";

export interface TemporaryWording {
  /** The note under the bar on first open (S5). */
  note: string;
  /** Tooltip of the "Temporary" pill (S5). */
  pill: string;
  /** The ended screen (S6). */
  endedTitle: string;
  endedSub: string;
  /** S6a: a button that asks the host for a fresh canvas (`UI_StartNew`); none for meetings. */
  startNew: string | null;
  /** Access removed (S7b); null keeps the host-named default. */
  revokedTitle: string | null;
  revokedSub: string | null;
  /** View-only banner (S7a); null keeps the host-named default. */
  viewOnly: string | null;
  /** The version history panel of a temporary canvas (VH-01d frame 8c). */
  historyTitle: string;
  historySub: string;
}

export function wordingOf(v: unknown): Wording {
  return v === "room" ? "room" : "meeting";
}

export function temporaryWording(w: Wording): TemporaryWording {
  if (w === "room")
    return {
      note: "This canvas isn't saved anywhere. It's deleted after everyone has closed it; download a copy to keep it.",
      pill: "Not saved anywhere. Deleted after everyone closes it.",
      endedTitle: "This canvas ended when everyone left",
      endedSub: "It was deleted and can't be reopened. Copies you downloaded are yours to keep.",
      startNew: "Start a new canvas",
      revokedTitle: "You're no longer in this room, so this canvas is closed",
      revokedSub: "Only room members can open it. Join the room again to come back. Copies you downloaded are yours to keep.",
      viewOnly: "You can view this canvas. Room moderators can edit.",
      historyTitle: "This canvas is temporary",
      historySub: "It isn't saved anywhere and is deleted after everyone has closed it, so it has no versions. Download a copy to keep one.",
    };
  return {
    note: "This canvas is not saved anywhere. It is deleted when the meeting ends; download a copy to keep it.",
    pill: "Not saved anywhere. Deleted when the meeting ends.",
    endedTitle: "This canvas ended with the meeting",
    endedSub: "It has been deleted and cannot be reopened. Copies you downloaded are yours to keep.",
    startNew: null,
    revokedTitle: null,
    revokedSub: null,
    viewOnly: null,
    historyTitle: "This canvas is temporary",
    historySub: "It isn't saved anywhere and is deleted when the meeting ends, so it has no versions. Download a copy to keep one.",
  };
}

/**
 * Whether a first open shows the template picker. Not for a temporary canvas (people join it
 * mid-meeting), and not when the host launched with `"start": "page"` (ADR-048, MM S2f):
 * the host already asked what kind of canvas it is.
 */
export function showsGallery(s: { isNew: boolean; storage?: string; role: string; empty: boolean; hash: string }): boolean {
  if (!s.isNew || s.role !== "edit" || !s.empty || s.storage === "ephemeral") return false;
  return new URLSearchParams(s.hash.replace(/^#/, "")).get("start") !== "page";
}
