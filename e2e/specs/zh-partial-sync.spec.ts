// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// zh. Partial sync (PSYNC-02/03, ADR-076) on a host with `[host.flags] partial_sync`: a database
// made in the canvas becomes a subdocument when the room next splits; both editors then load
// it over message type 101, edits reach the other person, and a reload shows the saved state.
import { expect, test, type Page } from "@playwright/test";
import { HOST_PSYNC } from "../env";
import { editor, expectSaved, sharedFile } from "../helpers";

/** Counts the type 101 (subdocument) frames the page receives. */
function countSubdocFrames(page: Page) {
  const n = { frames: 0 };
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      const b = f.payload;
      if (typeof b !== "string" && b.length && b[0] === 101) n.frames++;
      if (process.env.ZH_DEBUG && typeof b !== "string" && (b[0] === 101 || b[0] === 100)) console.log("recv", b[0], Buffer.from(b).subarray(0, 120).toString("latin1"));
    });
    ws.on("framesent", (f) => {
      const b = f.payload;
      if (process.env.ZH_DEBUG && typeof b !== "string" && b[0] === 101) console.log("sent", Buffer.from(b).subarray(0, 80).toString("latin1"));
    });
  });
  if (process.env.ZH_DEBUG) page.on("console", (m) => console.log("console", m.text().slice(0, 200)));
  return n;
}

test("databases load as subdocuments; edits and saves work as before", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E zh · partial sync", samRole: "edit", host: HOST_PSYNC });
  await expectSaved(priya);
  // The template's database was made in the main document; the save makes a whole view, and
  // 20 s later (no more server work) the room splits again with the database as a part.
  await priya.page.waitForTimeout(25_000);
  // Sam opens it again: the text arrives first, the database through its part (type 101).
  const samSubs = countSubdocFrames(sam.page);
  await sam.page.reload();
  await expect(editor(sam)).toBeVisible({ timeout: 15_000 });
  await expect(sam.oc.locator(".ocdb")).toBeVisible({ timeout: 15_000 });
  expect(samSubs.frames).toBeGreaterThan(0);

  const row = (p: typeof sam, name: RegExp) => p.oc.locator(".ocdb").getByRole("row", { name });
  const done = (p: typeof sam) => row(p, /Book a design review/).getByRole("checkbox", { name: "Done" });
  await expect(done(priya)).toHaveAttribute("aria-checked", "false");
  await done(sam).click();
  await expect(done(priya)).toHaveAttribute("aria-checked", "true", { timeout: 5_000 });
  await expectSaved(sam);

  // A fresh load shows the saved state.
  await sam.page.reload();
  await expect(editor(sam)).toBeVisible({ timeout: 15_000 });
  await expect(done(sam)).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  void fileId;
  await priya.ctx.close();
  await sam.ctx.close();
});
