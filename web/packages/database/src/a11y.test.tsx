// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Accessibility rules axe found in spec zi (DB4-07): roles and attributes allowed where they are
// used, and initials that meet 4.5:1 on every person colour.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { DatabaseBlock } from "./index";
import { addRow, createDatabase } from "./model";
import { avatarInk } from "./ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (compact = false): BlockEnv => ({ role: "edit", compact, me: { id: "p", name: "P", color: "#2a5ad7" }, users: [], toast: () => {} });

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(node));
  cleanup = () => act(() => root.unmount());
  return el;
}

function lum(hex: string) {
  const h = hex.length === 4 ? hex.slice(1).replace(/./g, (c) => c + c) : hex.slice(1);
  const n = parseInt(h, 16);
  const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("accessibility", () => {
  it("avatar initials reach 4.5:1 on light and dark person colours", () => {
    expect(avatarInk("#ffd166")).toBe("#000");
    expect(avatarInk("#1f3a93")).toBe("#fff");
    for (let i = 0; i < 4096; i += 7) {
      const c = "#" + [(i >> 8) & 15, (i >> 4) & 15, i & 15].map((d) => (d * 17).toString(16).padStart(2, "0")).join("");
      expect(ratio(c, avatarInk(c)), c).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the table carries no aria-multiselectable (allowed on grids, not tables)", async () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "blank");
    addRow(doc, id, { title: "One" });
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const table = el.querySelector("table")!;
    expect(table).toBeTruthy();
    expect(table.hasAttribute("aria-multiselectable")).toBe(false);
  });

  it("every phone card row holds a cell", async () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "blank");
    doc.transact(() => {
      for (let i = 0; i < 1200; i++) addRow(doc, id, { title: "Row " + i });
    });
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env(true)} />);
    const rows = [...el.querySelectorAll(".ocdb-lt-r[role=row]")];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.querySelector(":scope > [role=gridcell] .ocdb-lt-card")).toBeTruthy();
  });
});
