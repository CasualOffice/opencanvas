// t. Assistant on a phone (Phone.dc.html): bottom toolbar "Ask Assistant", action sheet, plan,
// progress pill, review bar; 44 px targets, 16 px inputs. `#demo` scripted run.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDemoWithNotesSelected } from "../assistant-helpers";

test("assistant on a phone: ask → sheet → plan → run → review → accept all → undo", async ({ page }) => {
  await openDemoWithNotesSelected(page);
  const ask = page.getByRole("toolbar", { name: "Editing tools" }).getByRole("button", { name: "Ask Assistant" });
  await ask.click();
  const sheet = page.getByRole("dialog", { name: "Assistant" });
  await expect(sheet.getByText("With the 7 selected lines")).toBeVisible();
  const input = sheet.getByLabel("Ask the assistant");
  expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  for (const b of await sheet.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Axe reads colours as painted: let the sheet's entrance animation finish first (as in t-assistant).
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect | null)?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  expect((await new AxeBuilder({ page }).include(".ai-sheet").withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await sheet.getByRole("button", { name: "Make a task database" }).click();

  await expect(sheet.getByText("Here's the plan")).toBeVisible();
  await expect(sheet.getByRole("note")).toContainText("treated as text and skipped");
  await sheet.getByRole("button", { name: "Run", exact: true }).click();

  const pill = page.getByRole("status").filter({ has: page.getByRole("button", { name: "Stop" }) });
  await expect(pill).toBeVisible();
  expect((await pill.getByRole("button", { name: "Stop" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  const review = page.getByRole("region", { name: "Review the assistant's changes" });
  await expect(review).toContainText("6 suggestions to review", { timeout: 20_000 });
  await expect(page.locator(".ProseMirror .ai-new")).toHaveCount(1);
  await review.getByRole("button", { name: "Accept all" }).click();
  await expect(review).toContainText("All reviewed");
  await expect(page.locator(".ProseMirror li a", { hasText: "Tasks · row 1" })).toHaveCount(1);
  await review.getByRole("button", { name: "Undo" }).click();
  await expect(review).toHaveCount(0);
  await expect(page.locator(".ProseMirror .ai-new")).toHaveCount(0);
});
