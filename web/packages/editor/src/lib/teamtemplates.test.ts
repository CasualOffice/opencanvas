// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { describe, expect, it } from "vitest";
import { applyTeamTemplate, loadTeamTemplates, parseTeamList, teamCard, teamEnabled, teamMatches, undoTeamTemplate, TEAM_CAT } from "./teamtemplates";

const answer = {
  enabled: true,
  templates: [
    { id: "acme-retro", name: "Acme retro", description: "Our retro", category: "Meetings", icon: "repeat", tone: "green", updatedAt: "2026-11-20T10:00:00Z" },
    { id: "acme-weekly", name: "Acme weekly", description: "", icon: "", tone: "neon" },
    { id: 3, name: "bad id" },
    { id: "blank", name: "  " },
  ],
};

function fake(status: number, json: unknown, seen: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
}

describe("team templates (TPL-01)", () => {
  it("shows the section only when the host enabled it, never in the demo", () => {
    expect(teamEnabled({ templates: { team: true } })).toBe(true);
    expect(teamEnabled({ templates: { team: false } })).toBe(false);
    expect(teamEnabled({})).toBe(false);
    expect(teamEnabled({ templates: { team: true }, demo: true })).toBe(false);
  });

  it("cleans the list and turns entries into gallery cards", () => {
    const l = parseTeamList(answer)!;
    expect(l.map((t) => t.id)).toEqual(["acme-retro", "acme-weekly"]);
    expect(l[1].icon).toBe("layout-template");
    const c = teamCard(l[1]);
    expect(c).toMatchObject({ id: "team:acme-weekly", cat: TEAM_CAT, tone: "gray", blocks: [] });
    expect(teamCard(l[0]).tone).toBe("green");
    expect(parseTeamList({ enabled: false, templates: [] })).toBeNull();
    expect(parseTeamList(null)).toBeNull();
  });

  it("searches name, description and category", () => {
    const [retro] = parseTeamList(answer)!;
    expect(teamMatches(retro, "")).toBe(true);
    expect(teamMatches(retro, "meet")).toBe(true);
    expect(teamMatches(retro, "OUR")).toBe(true);
    expect(teamMatches(retro, "roadmap")).toBe(false);
  });

  it("loads, applies and undoes through the server with the ticket", async () => {
    const seen: string[] = [];
    expect((await loadTeamTemplates("t 1", fake(200, answer, seen)))!.length).toBe(2);
    expect(await applyTeamTemplate("t1", "acme-retro", fake(200, { applyId: "a1", name: "Acme retro", blockIds: [] }, seen))).toEqual({ applyId: "a1", name: "Acme retro" });
    await undoTeamTemplate("t1", "a1", fake(200, { undone: true }, seen));
    expect(seen).toEqual([
      "GET /v1/templates?ticket=t%201",
      "POST /v1/templates/acme-retro/apply?ticket=t1",
      "POST /v1/templates/undo?ticket=t1&applyId=a1",
    ]);
  });

  it("surfaces the server's refusal", async () => {
    await expect(applyTeamTemplate("t1", "x", fake(403, { error: { code: "FORBIDDEN", message: "applying a template needs the edit role" } }))).rejects.toThrow("edit role");
    await expect(loadTeamTemplates("t1", fake(502, {}))).rejects.toThrow("didn't load");
    await expect(undoTeamTemplate("t1", "a1", fake(409, { error: { message: "this template can no longer be undone" } }))).rejects.toThrow("no longer");
  });
});
