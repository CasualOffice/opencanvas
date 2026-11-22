// Shared by t-assistant.spec.ts and t-assistant.phone.spec.ts.
import { expect, type Page } from "@playwright/test";
import { OC } from "./env";

export async function openDemoWithNotesSelected(page: Page) {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator(".ProseMirror li", { hasText: "Ravi to finish the embed SDK docs" })).toBeVisible();
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ed = (window as any).__ocEditor;
    let r = { from: 0, to: 0 };
    ed.state.doc.descendants((n: { type: { name: string }; textContent: string; nodeSize: number }, pos: number) => {
      if (n.type.name === "bulletList" && n.textContent.includes("Ravi to finish")) {
        r = { from: pos + 1, to: pos + n.nodeSize - 1 };
        return false;
      }
      return true;
    });
    ed.chain().focus().setTextSelection(r).run();
  });
}

