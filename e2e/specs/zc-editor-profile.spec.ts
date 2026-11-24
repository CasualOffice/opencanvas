// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zc. Editor profiles (EDP-01, docs/05 §2b): on a host with `profile = "meeting"` the / menu
// offers only the meeting blocks, and a canvas full of other block types (made on a `full`
// host) still opens intact and stays editable. Hide, never delete.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { HOST, HOST_MEETING } from "../env";
import { applyTemplate, blocksReady, clickEndOf, createFile, editor, expectSaved, openFile, person } from "../helpers";

const MEETING_MENU = ["Text", "Heading 1", "Heading 2", "Heading 3", "Checklist", "Bulleted list", "Numbered list", "Callout", "Divider", "Simple table", "Date"];

test("meeting profile: / shows only its blocks, and a full document opens intact", async ({ browser }) => {
  const priya = await person(browser, "u_priya");

  // A canvas on the full host with blocks the meeting profile hides: a quote, a database, a
  // whiteboard and a code block, next to a table and headings.
  const full = await createFile(priya, "Everything", HOST);
  await applyTemplate(priya, "User interview notes");
  await clickEndOf(priya, "Insights");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("/whiteboard");
  await expect(priya.oc.getByRole("listbox", { name: "Insert" }).getByRole("option").first()).toContainText("Whiteboard");
  await priya.page.keyboard.press("Enter");
  await expect(editor(priya).locator(".ocbd").first()).toBeVisible({ timeout: 10_000 });
  await expectSaved(priya);
  const bytes = fs.readFileSync(path.join(process.env.E2E_TMP!, "host", "files", `${full}.ocanvas`));

  // The same bytes as a file of the meeting host.
  const r = await fetch(`${HOST_MEETING}/files?as=u_priya`, { method: "POST", body: "name=Everything+(meeting)", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
  const id = r.headers.get("location")!.split("/").pop()!;
  fs.writeFileSync(path.join(process.env.E2E_TMP!, "host-meeting", "files", `${id}.ocanvas`), bytes);

  await openFile(priya, id, HOST_MEETING);
  await blocksReady(priya.oc);
  const ed = editor(priya);
  // Every block opens: the quote, the table, the database and the whiteboard.
  await expect(ed.locator("blockquote")).toContainText("paste the meeting notes");
  await expect(ed.locator("table").first()).toContainText("Participant");
  await expect(ed.locator("[data-board]").first()).toBeVisible();
  await expect(ed.locator("[data-db]").first()).toBeVisible();
  await expect(ed.locator("h2", { hasText: "Feedback log" })).toBeVisible();

  // And stays editable: type into the quote, a block type this profile does not offer.
  await ed.locator("blockquote p").first().click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.type(" Still editable.");
  await expect(ed.locator("blockquote")).toContainText("Still editable.");

  // The / menu offers the meeting blocks only.
  await clickEndOf(priya, "Insights");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("/");
  const menu = priya.oc.getByRole("listbox", { name: "Insert" });
  await expect(menu).toBeVisible();
  const titles = (await menu.getByRole("option").allInnerTexts()).map((t) => t.split("\n")[0].trim());
  expect(titles).toEqual(MEETING_MENU);
  // Intent keywords work in the menu too ("track" → Checklist).
  await priya.page.keyboard.type("track");
  await expect(menu.getByRole("option").first()).toContainText("Checklist");
  await priya.page.keyboard.press("Escape");

  // A markdown shortcut for a hidden type stays text.
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("> not a quote");
  await expect(ed.locator("p", { hasText: "> not a quote" })).toBeVisible();
  await expect(ed.locator("blockquote")).toHaveCount(1);
  await priya.ctx.close();
});
