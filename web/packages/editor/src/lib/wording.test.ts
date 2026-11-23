// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// ADR-048 (skip the start screen) and ADR-049 (temporary-canvas wording), from the approved
// Mattermost S2f and Matrix S5-S7b prototypes. The meeting wording is what Jitsi shows today.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vitest runs from the package directory.
const src = (f: string) => readFileSync(resolve(process.cwd(), "src", f), "utf8");
import { showsGallery, temporaryWording, wordingOf } from "./wording";

describe("temporary wording", () => {
  it("defaults to the meeting wording Jitsi shows, unchanged", () => {
    expect(wordingOf(undefined)).toBe("meeting");
    expect(wordingOf("chat")).toBe("meeting");
    const m = temporaryWording(wordingOf(undefined));
    expect(m.note).toBe("This canvas is not saved anywhere. It is deleted when the meeting ends; download a copy to keep it.");
    expect(m.pill).toBe("Not saved anywhere. Deleted when the meeting ends.");
    expect(m.endedTitle).toBe("This canvas ended with the meeting");
    expect(m.endedSub).toBe("It has been deleted and cannot be reopened. Copies you downloaded are yours to keep.");
    expect(m.startNew).toBeNull();
    expect(m.revokedTitle).toBeNull();
    expect(m.viewOnly).toBeNull();
  });

  it("uses the approved room wording (MX S5, S5 tooltip, S6a, S7a, S7b)", () => {
    const r = temporaryWording(wordingOf("room"));
    expect(r.note).toBe("This canvas isn't saved anywhere. It's deleted after everyone has closed it; download a copy to keep it.");
    expect(r.pill).toBe("Not saved anywhere. Deleted after everyone closes it.");
    expect(r.endedTitle).toBe("This canvas ended when everyone left");
    expect(r.endedSub).toBe("It was deleted and can't be reopened. Copies you downloaded are yours to keep.");
    expect(r.startNew).toBe("Start a new canvas");
    expect(r.revokedTitle).toBe("You're no longer in this room, so this canvas is closed");
    expect(r.revokedSub).toBe("Only room members can open it. Join the room again to come back. Copies you downloaded are yours to keep.");
    expect(r.viewOnly).toBe("You can view this canvas. Room moderators can edit.");
  });

  it("is what the editor renders: no meeting sentence is hard-coded in the components", () => {
    for (const f of ["App.tsx", "components/TopBar.tsx"]) {
      expect(src(f), f).not.toContain("when the meeting ends");
      expect(src(f), f).not.toContain("ended with the meeting");
    }
    expect(src("App.tsx")).toContain("showsGallery(");
  });
});

describe("start screen", () => {
  const base = { isNew: true, storage: "host", role: "edit", empty: true, hash: "#t=01ABC" };
  it("shows the template picker for a new, empty canvas by default", () => {
    expect(showsGallery(base)).toBe(true);
  });
  it("skips it when the host launched with start=page (ADR-048)", () => {
    expect(showsGallery({ ...base, hash: "#t=01ABC&start=page" })).toBe(false);
    expect(showsGallery({ ...base, hash: "#t=01ABC&start=page&block=b_1" })).toBe(false);
    expect(showsGallery({ ...base, hash: "#t=01ABC&start=other" })).toBe(true);
  });
  it("never shows it for temporary, viewers, or canvases with content", () => {
    expect(showsGallery({ ...base, storage: "ephemeral" })).toBe(false);
    expect(showsGallery({ ...base, role: "view" })).toBe(false);
    expect(showsGallery({ ...base, empty: false })).toBe(false);
    expect(showsGallery({ ...base, isNew: false })).toBe(false);
  });
});
