// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { describe, expect, it } from "vitest";
import { appRootOf, resolveApp } from "./appmode";

const doc = (...content: object[]) => ({ type: "doc", content });
const sheet = (id: string) => ({ type: "spreadsheet", attrs: { sheetId: id } });
const board = (id: string) => ({ type: "board", attrs: { boardId: id } });
const db = (id: string) => ({ type: "database", attrs: { dbId: id } });
const p = (text?: string) => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) });

describe("appRootOf (FTY-02..05, docs/05 §2f)", () => {
  it("finds the one root block of the file's type", () => {
    expect(appRootOf(doc(sheet("s1"), p()), "spreadsheet")).toEqual({ id: "s1" });
    expect(appRootOf(doc(board("b1")), "whiteboard")).toEqual({ id: "b1" });
    expect(appRootOf(doc(p(), db("d1"), p()), "database")).toEqual({ id: "d1" });
  });
  it("falls back to a document when there is other content, never changing it", () => {
    expect(appRootOf(doc(sheet("s1"), p("notes")), "spreadsheet")).toEqual({ fallback: "content" });
    expect(appRootOf(doc(sheet("s1"), sheet("s2")), "spreadsheet")).toEqual({ fallback: "content" });
    expect(appRootOf(doc(board("b1")), "spreadsheet")).toEqual({ fallback: "content" });
  });
  it("an empty file has no root yet", () => {
    expect(appRootOf(doc(p()), "spreadsheet")).toEqual({ empty: true });
  });
});

describe("resolveApp (FTY-02)", () => {
  it("prefers the launch, then the session, then the file's own type", () => {
    expect(resolveApp("#t=1&app=whiteboard", "spreadsheet", "database")).toBe("whiteboard");
    expect(resolveApp("#t=1", "spreadsheet", "database")).toBe("spreadsheet");
    expect(resolveApp("#t=1", "document", "database")).toBe("database");
    expect(resolveApp("#t=1", undefined, "slides")).toBe(null);
    expect(resolveApp("#t=1", undefined, undefined)).toBe(null);
  });
});
