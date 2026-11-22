// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// h. A bot appends a block through the host REST API while people are editing. The block
//    appears live, keeps its blockId after a person edits it, and a second API call can
//    still address it by that id.
import { expect, test } from "@playwright/test";
import { OC } from "../env";
import { editor, sharedFile } from "../helpers";

const headers = { "content-type": "application/json", "x-opencanvas-host": "sample", "x-opencanvas-key": "dev-api-key-change-me" };
const author = { id: "bot-standup", name: "Standup bot" };

test("API-appended block appears live and stays addressable after a person edits it", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E h · patch", samRole: "edit" });

  const add = await fetch(`${OC}/v1/files/${fileId}/patch`, {
    method: "POST", headers,
    body: JSON.stringify({ ops: [{ op: "append", markdown: "Posted by the standup bot" }], author }),
  });
  expect(add.status).toBe(200);
  const { blockIds } = (await add.json()) as { blockIds: string[] };
  expect(blockIds.length).toBe(1);

  const botLine = (p: typeof sam) => editor(p).locator("p", { hasText: "Posted by the standup bot" });
  await expect(botLine(priya)).toBeVisible({ timeout: 2_000 });
  await expect(botLine(sam)).toHaveAttribute("data-block-id", blockIds[0]);

  // A person edits the bot's block. Without the schema attribute the id would be dropped here.
  await botLine(sam).click();
  await sam.page.keyboard.press("End");
  await sam.page.keyboard.type(" (edited by Sam)");
  await expect(botLine(priya)).toContainText("(edited by Sam)", { timeout: 2_000 });
  await expect(botLine(priya)).toHaveAttribute("data-block-id", blockIds[0]);

  // The id still resolves on the server: insert right after it.
  const after = await fetch(`${OC}/v1/files/${fileId}/patch`, {
    method: "POST", headers,
    body: JSON.stringify({ ops: [{ op: "insertAfter", blockId: blockIds[0], markdown: "Follow-up from the bot" }], author }),
  });
  expect(after.status).toBe(200);
  const following = editor(priya).locator("p", { hasText: "Posted by the standup bot" }).locator("xpath=following-sibling::*[1]");
  await expect(following).toContainText("Follow-up from the bot", { timeout: 2_000 });
});
