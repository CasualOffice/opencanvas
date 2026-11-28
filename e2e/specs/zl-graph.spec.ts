// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zl-graph. The knowledge graph (GRAPH-02/03, ADR-082), to the approved prototype
// docs/prototypes/v05-approved/knowledge-graph.html: the Graph button opens the local graph
// beside the canvas (1b) with its depth slider, the keyboard model and its announcements (4b),
// selection and pins (3a), Enter opens through the host; the full graph with search (2b), the
// list with aria-sort and rows that expand (4a); a reader who cannot open the linking canvas
// sees no trace of it (6a, GRAPH-A1); the phone shows the list first (5b, 5a); links off (6b);
// axe on the panel and the dialog.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import { HOST, HOST_LINKS } from "../env";
import { applyTemplate, createFile, editor, expectSaved, openFile, person, setAccess, typeAfterHeading, type Person } from "../helpers";

test.describe.configure({ mode: "serial" });

let target = "",
  source = "",
  third = "";

/** Types `[[name` and picks the canvas from the host's search. */
async function linkTo(p: Person, name: string) {
  await expect(editor(p)).toHaveAttribute("data-links", "ready", { timeout: 15_000 });
  await p.page.keyboard.type(`[[${name}`);
  const pick = p.oc.getByRole("dialog", { name: "Link a canvas" });
  await expect(pick.getByRole("option", { name: new RegExp(name) })).toBeVisible({ timeout: 15_000 });
  await p.page.keyboard.press("Enter");
}

const announced = (panel: Locator) => panel.locator(".sr-only[aria-live]");

test("local graph: depth, keyboard, selection, pins, Enter opens through the host", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  target = await createFile(priya, "Graph target", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await expectSaved(priya);
  source = await createFile(priya, "Graph source", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "See ");
  await linkTo(priya, "Graph target");
  await expect(editor(priya).locator("a.clink").first()).toHaveAttribute("data-state", "ok");
  await expectSaved(priya);
  third = await createFile(priya, "Graph third", HOST_LINKS);
  await applyTemplate(priya, "Meeting notes");
  await typeAfterHeading(priya, "Notes", "Builds on ");
  await linkTo(priya, "Graph source");
  await expectSaved(priya);

  await openFile(priya, target, HOST_LINKS);
  await priya.oc.getByRole("button", { name: "Graph", exact: true }).click();
  const panel = priya.oc.getByRole("complementary", { name: "Local graph" });
  // 1b: this canvas and everything one link away.
  await expect(panel).toContainText("2 canvases · 1 link", { timeout: 15_000 });
  const depth = panel.getByRole("slider", { name: "Depth" });
  await expect(depth).toHaveAttribute("aria-valuetext", "1 link away");
  await depth.fill("2");
  await expect(panel).toContainText("3 canvases · 2 links");
  await expect(panel.locator(".gr-n .nd")).toHaveCount(3);
  await depth.fill("1");
  await expect(panel.locator(".gr-n .nd")).toHaveCount(2);
  const axe = await new AxeBuilder({ page: priya.page }).include("iframe").analyze();
  expect(axe.violations.filter((v) => /gr-/.test(JSON.stringify(v.nodes)))).toEqual([]);

  // 4b: one Tab stop; focus lands on this canvas and says what it is.
  const graph = panel.getByRole("application");
  await expect(graph).toHaveAttribute("aria-roledescription", "graph");
  await graph.focus();
  await expect(announced(panel)).toContainText("Graph target, ");
  await expect(announced(panel)).toContainText("1 link in, 0 out, 1 neighbour");
  // Arrow keys move to the linked canvas in that direction.
  for (const k of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"]) {
    await priya.page.keyboard.press(k);
    await priya.page.waitForTimeout(80);
    if ((await announced(panel).textContent())?.includes("Graph source")) break;
  }
  await expect(announced(panel)).toContainText("Graph source, ");
  // Space selects: the card with its actions; P pins (kept in this browser only).
  await priya.page.keyboard.press(" ");
  const card = panel.getByRole("dialog", { name: "Graph source" });
  await expect(card).toContainText("0 links in");
  await expect(card.getByRole("button", { name: "Open" })).toBeVisible();
  await priya.page.keyboard.press("p");
  await expect(announced(panel)).toContainText("Graph source pinned");
  await expect(panel.locator(".nd.pinned")).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Unpin" })).toHaveAttribute("aria-pressed", "true");
  const kept = await priya.oc.locator("body").evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("oc.graph.pins.u_priya.")));
  expect(kept.length).toBe(1);
  // Enter opens the canvas through the host (UI_OpenFile); the graph never navigates itself.
  await graph.focus();
  await priya.page.keyboard.press("Enter");
  await priya.page.waitForURL(new RegExp(`/files/${source}`));
});

test("full graph: search, list with aria-sort, rows expand, Esc closes", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  await openFile(priya, target, HOST_LINKS);
  await priya.oc.getByRole("button", { name: "Graph", exact: true }).click();
  const panel = priya.oc.getByRole("complementary", { name: "Local graph" });
  await expect(panel).toContainText("2 canvases · 1 link", { timeout: 15_000 });
  await panel.getByRole("button", { name: "Open full graph" }).click();
  const full = priya.oc.getByRole("dialog", { name: "Graph" });
  await expect(full.getByRole("status").first()).toContainText(/\d+ canvases · \d+ links/, { timeout: 15_000 });
  await expect(full).toContainText("Only canvases you can open in");
  // 2b: search highlights and dims; nothing is removed.
  const drawn = await full.locator(".gr-n .nd").count();
  await full.getByRole("searchbox", { name: "Search canvases" }).fill("Graph sou");
  await expect(full.locator(".gr-stat").first()).toHaveText(/^1 of \d+ match$/);
  await expect(full.locator(".gr-n .nd")).toHaveCount(drawn);
  await expect(full.locator(".gr-n .nd.dim").first()).toBeVisible();
  await full.getByRole("searchbox", { name: "Search canvases" }).fill("");

  // 4a: L in the graph switches to the list: sortable, rows expand to their neighbours.
  await full.getByRole("application").focus();
  await priya.page.keyboard.press("l");
  const table = full.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Links in" })).toHaveAttribute("aria-sort", "descending");
  await table.getByRole("button", { name: "Canvas", exact: true }).click();
  await expect(table.getByRole("columnheader", { name: "Canvas", exact: true })).toHaveAttribute("aria-sort", "ascending");
  await expect(table.getByRole("columnheader", { name: "Links in" })).toHaveAttribute("aria-sort", "none");
  const row = table.getByRole("button", { name: /^Graph target/ });
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(table.locator("tr.ex")).toContainText("Linked from");
  await expect(table.locator("tr.ex").getByRole("button", { name: "Graph source", exact: true })).toBeVisible();
  const axe = await new AxeBuilder({ page: priya.page }).include("iframe").analyze();
  expect(axe.violations.filter((v) => /gr-/.test(JSON.stringify(v.nodes)))).toEqual([]);
  await priya.page.keyboard.press("Escape");
  await expect(full).toBeHidden();
});

test("a reader who cannot open the linking canvas sees no trace of it (6a)", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  await setAccess(priya, target, "u_ravi", "view", HOST_LINKS);
  const ravi = await person(browser, "u_ravi");
  await openFile(ravi, target, HOST_LINKS);
  await ravi.oc.getByRole("button", { name: "Graph", exact: true }).click();
  const panel = ravi.oc.getByRole("complementary", { name: "Local graph" });
  await expect(panel).toContainText("No links yet", { timeout: 15_000 });
  await expect(panel).not.toContainText("Graph source");
  await expect(panel).not.toContainText("Graph third");
  void third;
});

test("phone: the list first, a tap opens the sheet; the graph is one tap away (5a, 5b)", async ({ browser }) => {
  const priya = await person(browser, "u_priya", { viewport: { width: 390, height: 844 }, hasTouch: true });
  await openFile(priya, target, HOST_LINKS);
  await priya.oc.getByRole("button", { name: "Graph", exact: true }).click();
  const panel = priya.oc.getByRole("complementary", { name: "Local graph" });
  await expect(panel).toContainText("Most linked first", { timeout: 15_000 });
  await expect(panel.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: /Graph source/ }).click();
  const sheet = panel.getByRole("dialog", { name: "Graph source" });
  await expect(sheet.getByRole("button", { name: "Open" })).toBeVisible();
  const box = await sheet.getByRole("button", { name: "Open" }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await sheet.getByRole("button", { name: "Close" }).click();
  await panel.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(panel.getByRole("application")).toBeVisible();
  await expect(panel.locator(".gr-n .nd")).toHaveCount(2);
});

test("links off: the host's Action_OpenGraph explains why (6b)", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  const f = await createFile(priya, "No links here", HOST);
  await applyTemplate(priya, "Meeting notes");
  await expect(priya.oc.getByRole("button", { name: "Graph", exact: true })).toHaveCount(0);
  await priya.page.evaluate(() => (document.querySelector('iframe[name="oc"]') as HTMLIFrameElement).contentWindow!.postMessage({ MessageId: "Action_OpenGraph", Values: {} }, "*"));
  const full = priya.oc.getByRole("dialog", { name: "Graph" });
  await expect(full).toContainText("The graph needs links turned on");
  await expect(full.getByRole("button", { name: "Copy a note for your admin" })).toBeVisible();
  void f;
});
