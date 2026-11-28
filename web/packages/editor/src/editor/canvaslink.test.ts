// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { describe, expect, it } from "vitest";
import { linkKey, linkText } from "./canvaslink";

describe("canvas link text (LINK-01, 3b)", () => {
  const attrs = { fileId: "f", targetBlockId: "h2", label: "Old title › Old heading" };
  it("shows the saved label until the host answered", () => {
    expect(linkText(attrs, undefined)).toBe("Old title › Old heading");
    expect(linkText({ fileId: "f", label: "" }, undefined)).toBe("Canvas");
  });
  it("follows the host's title and the block's current text (renamed or moved)", () => {
    expect(linkText(attrs, { state: "ok", title: "SSO rollout plan (Business plan)", block: "Phase 2" })).toBe("SSO rollout plan (Business plan) › Phase 2");
  });
  it("hides the title without access, keeps the last one when deleted", () => {
    expect(linkText(attrs, { state: "none" })).toBe("No access");
    expect(linkText(attrs, { state: "gone" })).toBe("Old title › Old heading");
  });
  it("keys a block link apart from the canvas", () => {
    expect(linkKey("f")).toBe("f");
    expect(linkKey("f", "h2")).toBe("f#h2");
  });
});
