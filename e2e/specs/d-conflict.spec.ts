// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// d. Someone saves the file outside OpenCanvas while two people are editing.
//    Host "sample" (:4200) uses on_conflict = "copy", host "sample-reload" (:4201) uses "reload"
//    (both from the suite's temp hosts.toml).
import { expect, test } from "@playwright/test";
import { HOST, HOST_RELOAD } from "../env";
import { editor, expectSaved, hostFiles, hostVersion, sharedFile, typeAfterHeading } from "../helpers";
import { storedDocument, unzip } from "../ocanvas";
import fs from "node:fs";
import path from "node:path";

async function bump(page: import("@playwright/test").Page, host: string, fileId: string) {
  const r = await page.request.post(`${host}/__test/files/${fileId}/bump`);
  expect(r.ok()).toBe(true);
}

test("conflict policy copy: the session's version becomes a (copy) file", async ({ browser }) => {
  const name = "E2E d · conflict copy";
  const { priya, sam, fileId } = await sharedFile(browser, { name, samRole: "edit" });
  await typeAfterHeading(priya, "Notes", "Before conflict");
  await expect.poll(() => storedDocument(fileId)?.includes("Before conflict") ?? false, { timeout: 15_000 }).toBe(true);
  await expectSaved(priya);
  const v = hostVersion(fileId);

  await bump(priya.page, HOST, fileId);
  expect(hostVersion(fileId)).toBe(v + 1);
  await priya.page.keyboard.type(" and after the bump");

  for (const p of [priya, sam]) {
    const dlg = p.oc.getByRole("dialog", { name: "Canvas changed" });
    await expect(dlg).toBeVisible({ timeout: 15_000 });
    await expect(dlg).toContainText(`(copy)`);
    await expect(editor(p)).toHaveAttribute("contenteditable", "false");
  }
  await expect(priya.oc.locator(".banner", { hasText: "Your version was saved as" })).toBeVisible();

  // The host has a "(copy)" file holding the session's latest state; the original is untouched.
  const copy = Object.values(hostFiles()).find((f) => f.name === `${name} (copy)`);
  expect(copy, "a (copy) file on the host").toBeTruthy();
  const bytes = fs.readFileSync(path.join(process.env.E2E_TMP!, "host", "files", `${copy!.id}.ocanvas`));
  expect(unzip(bytes).get("document.json")!.toString()).toContain("Before conflict and after the bump");
  expect(hostVersion(fileId)).toBe(v + 1);
  expect(storedDocument(fileId)).not.toContain("after the bump");
  expect(copy!.acl.u_sam).toBe("edit");

  await priya.ctx.close();
  await sam.ctx.close();
});

test("conflict policy reload: both sessions start over from the host's version", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E d · conflict reload", samRole: "edit", host: HOST_RELOAD });
  await typeAfterHeading(priya, "Notes", "Before conflict");
  await expect.poll(() => storedDocument(fileId, HOST_RELOAD)?.includes("Before conflict") ?? false, { timeout: 15_000 }).toBe(true);
  await expectSaved(priya);

  await bump(priya.page, HOST_RELOAD, fileId);
  await priya.page.keyboard.type(" and after the bump");
  await expect(editor(sam)).toContainText("and after the bump", { timeout: 2_000 });

  for (const p of [priya, sam]) {
    await expect(p.oc.locator(".toast", { hasText: "Loaded the latest version from Reload host" })).toBeVisible({ timeout: 15_000 });
    await expect(editor(p).locator("p", { hasText: "Before conflict" })).toBeVisible();
    await expect(editor(p)).not.toContainText("after the bump");
    await expect(editor(p)).toHaveAttribute("contenteditable", "true");
  }
  // Reload policy keeps no copy.
  expect(Object.values(hostFiles(HOST_RELOAD)).filter((f) => f.name.endsWith("(copy)"))).toEqual([]);
  // And editing continues live after the restart.
  await typeAfterHeading(sam, "Decisions", "Fresh start");
  await expect(editor(priya).locator("p", { hasText: "Fresh start" })).toBeVisible({ timeout: 2_000 });

  await priya.ctx.close();
  await sam.ctx.close();
});
