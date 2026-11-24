// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Discovery metadata in the insert menus: the shared profile filter, labels and keywords.
import { afterEach, describe, expect, it } from "vitest";
import { blockVisibleInMenus, setMenuProfile } from "./discovery";
import { setInstalledBlocks, type BlockPackage } from "./model";
import { filterSlash, ORG_GROUP } from "../editor/slash";

const pkg = (type: string, discovery?: BlockPackage["discovery"]): BlockPackage => ({
  type, version: "1.0.0", v: 1, title: type, content: "none", attrs: { type: "object" }, entry: null, integrity: "", discovery,
});

afterEach(() => {
  setMenuProfile(null);
  setInstalledBlocks([]);
});

describe("blockVisibleInMenus", () => {
  it("offers every block without a profile or with full, else only the named profiles", () => {
    const gantt = pkg("acme.gantt", { label: "Gantt chart", category: "data-planning", keywords: ["timeline"], profiles: ["project", "meeting"], complexity: "advanced" });
    const plain = pkg("acme.plain");
    expect(blockVisibleInMenus(gantt, null)).toBe(true);
    expect(blockVisibleInMenus(gantt, "full")).toBe(true);
    expect(blockVisibleInMenus(gantt, "project")).toBe(true);
    expect(blockVisibleInMenus(gantt, "notebook")).toBe(false);
    // No discovery: profiles default to ["full"].
    expect(blockVisibleInMenus(plain, "notebook")).toBe(false);
    expect(blockVisibleInMenus(plain, "full")).toBe(true);
  });

  it("filters the / menu group and uses the discovery label and keywords", () => {
    setInstalledBlocks([
      pkg("acme.gantt", { label: "Gantt chart", category: "data-planning", keywords: ["timeline", "schedule"], profiles: ["project"], complexity: "basic" }),
      pkg("acme.plain"),
    ]);
    const org = () => filterSlash("").filter((x) => x.group === ORG_GROUP).map((x) => x.title);
    expect(org()).toEqual(["Gantt chart", "acme.plain"]);
    expect(filterSlash("schedule").map((x) => x.title)).toContain("Gantt chart");
    setMenuProfile("project");
    expect(org()).toEqual(["Gantt chart"]);
    setMenuProfile("notebook");
    expect(org()).toEqual([]);
  });
});
