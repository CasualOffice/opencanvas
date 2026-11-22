// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// t. Assistant against the real server (AI-01, AI-02, AI-UI; docs/24 §10.5). The "sample" host
// has `[host.ai]` on, with a provider profile pointing at the mock Anthropic SSE model that
// global-setup.ts starts (mock-model.ts): it plans, then calls canvas_read → db_create →
// db_upsert_rows through the real canvas tool layer. Select the notes → Ask Assistant → plan
// (server `ai-plan`) → Run (`ai-approve`) → the Tasks database appears → a second browser sees it →
// review → Undo run removes it everywhere. A viewer never sees the assistant.
//
// The server's session does not carry an AI flag yet, so the editor is opened with `?ai=1` (the
// documented switch, docs/24 §10.2): every launch redirect in these contexts gets it.
import { expect, test, type BrowserContext } from "@playwright/test";
import { OC } from "../env";
import { editor, openFile, person, setAccess, sharedFile, type Person } from "../helpers";
import { MOCK_PLAN, MOCK_ROWS } from "../mock-model";

async function forceAi(ctx: BrowserContext) {
  await ctx.route(`${OC}/v1/launch**`, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    const loc = res.headers()["location"];
    if (res.status() !== 303 || !loc?.startsWith("/app/#")) return route.fulfill({ response: res });
    await route.fulfill({ response: res, headers: { ...res.headers(), location: loc.replace("/app/#", "/app/?ai=1#") } });
  });
}

// One node wrapper per database block (the block inside carries `data-db` too).
const dbs = (p: Person) => editor(p).locator(".wideblock[data-db]");
/** The title cells (inputs) of the table view of every database on the canvas. */
const titles = (p: Person) => editor(p).locator("tbody td[data-c='0'] input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

test("assistant on the real server: plan → approve → database from tool calls → second browser → undo run", async ({ browser }) => {
  // Priya and Sam (edit) both (re)open a meeting-notes canvas with `?ai=1`.
  const { priya, sam, fileId } = await sharedFile(browser, { name: "Assistant real run", samRole: "edit" });
  await forceAi(priya.ctx);
  await forceAi(sam.ctx);
  await openFile(priya, fileId);
  await openFile(sam, fileId);
  const before = await dbs(priya).count();

  // Select the first list (the notes) as a person would: click its first line, shift-click its last.
  // (No `__ocEditor` hook outside `#demo`.)
  const list = editor(priya).locator("ul, ol").first();
  await expect(list.locator("li").first()).toBeVisible();
  await list.locator("li").first().click();
  await priya.page.keyboard.press("Home");
  await list.locator("li").last().click({ modifiers: ["Shift"] });
  await priya.page.keyboard.press("Shift+End");
  await expect(priya.oc.getByRole("button", { name: "Ask Assistant" })).toBeVisible();

  // Ask Assistant → the command bar, no demo label (a real run).
  await priya.oc.getByRole("button", { name: "Ask Assistant" }).click();
  const bar = priya.oc.getByRole("dialog", { name: "Ask the assistant about the selection" });
  await expect(bar.getByRole("combobox")).toBeFocused();
  await expect(bar).not.toContainText("Demo: a scripted run");
  await bar.getByRole("option", { name: /task/i }).first().click();

  // The plan comes from the server (`ai-plan`, parsed from the model's text); nothing changes yet.
  const plan = priya.oc.getByRole("dialog", { name: "The assistant's plan" });
  await expect(plan.getByRole("listitem")).toHaveCount(MOCK_PLAN.length, { timeout: 15_000 });
  for (const [i, line] of MOCK_PLAN.entries()) await expect(plan.getByRole("listitem").nth(i)).toContainText(line);
  expect(await dbs(priya).count()).toBe(before);
  expect(await dbs(sam).count()).toBe(before);

  // Run → `ai-approve` → the tool calls build the database; review shows.
  await plan.getByRole("button", { name: /^Run/ }).click();
  const review = priya.oc.getByRole("region", { name: "Review the assistant's changes" });
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(review).toContainText(`Created Tasks with ${MOCK_ROWS.length} rows.`);
  await expect(dbs(priya)).toHaveCount(before + 1);
  await expect.poll(() => titles(priya)).toEqual(expect.arrayContaining(MOCK_ROWS));

  // A second browser sees the database (real-time, from the server's transaction).
  await expect(dbs(sam)).toHaveCount(before + 1);
  await expect.poll(() => titles(sam)).toEqual(expect.arrayContaining(MOCK_ROWS));

  // Undo run: the database goes, for both.
  await review.getByRole("button", { name: "Undo run" }).click();
  await expect(review).toHaveCount(0);
  await expect(dbs(priya)).toHaveCount(before);
  await expect(dbs(sam)).toHaveCount(before);
  for (const p of [priya, sam]) await expect.poll(async () => (await titles(p)).filter((t) => MOCK_ROWS.includes(t))).toEqual([]);

  // A viewer (same host, AI on, `?ai=1`) has no assistant anywhere.
  await setAccess(priya, fileId, "u_ravi", "view");
  const ravi = await person(browser, "u_ravi");
  await forceAi(ravi.ctx);
  await openFile(ravi, fileId);
  await expect(editor(ravi)).toBeVisible();
  // The editor's own assistant button is there for Priya (same flags), never for Ravi.
  await expect(priya.oc.getByRole("button", { name: "Assistant", exact: true })).toBeVisible();
  await expect(ravi.oc.getByRole("button", { name: "Assistant", exact: true })).toHaveCount(0);
  await editor(ravi).locator("li").first().click();
  await ravi.page.keyboard.press("ControlOrMeta+j");
  await expect(ravi.oc.getByRole("dialog", { name: "Ask the assistant about the selection" })).toHaveCount(0);

  for (const p of [priya, sam, ravi]) await p.ctx.close();
});
