// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// y. TPL-01: host-supplied team templates. The sample host answers `GET /templates` with two
//    Acme templates; they fill the gallery's "From your team" section and start a canvas like
//    built-in ones (applied by the server, undone from the toast). Someone without the edit
//    role cannot apply one, and a host without `team_templates` shows no team section.
import { expect, test } from "@playwright/test";
import { HOST_RELOAD } from "../env";
import { createFile, editor, person, sharedFile } from "../helpers";

test("TPL-01: a team template appears under From your team and starts the canvas; Undo removes it", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  await createFile(priya, "E2E y · team template");
  const oc = priya.oc;
  await expect(oc.locator(".tgrid")).toBeVisible();
  const team = oc.locator(".tgside").getByRole("button", { name: /Your team's templates/ });
  await expect(team).toContainText("2");
  await team.click();
  await expect(oc.locator(".tgsec")).toContainText("From your team");
  const card = oc.locator(".tcard").filter({ hasText: "Acme weekly sync" });
  await expect(card).toContainText("Our Monday agenda");
  await expect(oc.locator(".tcard").filter({ hasText: "Acme incident review" })).toBeVisible();
  await card.click();
  const dlg = oc.getByRole("dialog", { name: "Acme weekly sync" });
  await expect(dlg).toContainText("Meetings");
  await dlg.getByRole("button", { name: "Use template" }).click();

  await expect(editor(priya).locator("h2", { hasText: "Metrics" })).toBeVisible();
  await expect(editor(priya).locator("table")).toBeVisible();
  const toast = oc.getByText("Started from “Acme weekly sync”");
  await expect(toast).toBeVisible();
  await oc.getByRole("button", { name: "Undo" }).click();
  await expect(oc.getByText("Template removed")).toBeVisible();
  await expect(editor(priya).locator("h2", { hasText: "Metrics" })).toHaveCount(0);
  await priya.ctx.close();
});

test("TPL-01: without the edit role a team template cannot be applied", async ({ browser }) => {
  const { priya, sam } = await sharedFile(browser, { name: "E2E y · team roles", samRole: "view" });
  await expect(editor(sam)).toContainText("Agenda");
  const frame = sam.page.frame({ name: "oc" })!;
  const r = await frame.evaluate(async () => {
    const t = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";
    const res = await fetch(`/v1/templates/acme-weekly/apply?ticket=${encodeURIComponent(t)}`, { method: "POST" });
    return { status: res.status, body: await res.json() };
  });
  expect(r.status).toBe(403);
  expect(r.body.error.message).toContain("edit role");
  // The canvas is unchanged for everyone.
  await expect(editor(priya).locator("h2", { hasText: "Metrics" })).toHaveCount(0);
  await expect(editor(priya)).toContainText("Agenda");
  await priya.ctx.close();
  await sam.ctx.close();
});

test("TPL-01: a host without team templates shows no team section", async ({ browser }) => {
  const priya = await person(browser, "u_priya");
  await createFile(priya, "E2E y · no team", HOST_RELOAD);
  await expect(priya.oc.locator(".tgrid")).toBeVisible();
  await expect(priya.oc.getByRole("button", { name: /Your team's templates/ })).toHaveCount(0);
  await priya.ctx.close();
});
