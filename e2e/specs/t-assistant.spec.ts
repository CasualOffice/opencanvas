// t. Assistant (docs/24 §10.2, docs/prototypes/assistant-approved) in `#demo`: the scripted run
// (no AI server) on the same UI path as a real run. Select the notes → Ask Assistant → plan →
// Run → the Tasks database appears → review → Accept all → Undo run. Axe on bar, plan and review.
// The phone version is t-assistant.phone.spec.ts.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemoWithNotesSelected } from "../assistant-helpers";
import { OC } from "../env";

// Axe reads colours as painted: wait for entrance animations (fade-ins) to finish first.
const axe = async (page: Page, include: string) => {
  await page.evaluate(
    (sel) =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => {
            const fx = a.effect as KeyframeEffect | null;
            return !!sel && fx?.getComputedTiming().iterations !== Infinity;
          })
          .map((a) => a.finished.catch(() => undefined)),
      ),
    include,
  );
  return new AxeBuilder({ page }).include(include).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
};

test("assistant: select → ask → plan → run → database → review → accept all → undo run", async ({ page }) => {
  await openDemoWithNotesSelected(page);
  // Entry point at the end of the selection toolbar.
  await page.getByRole("button", { name: "Ask Assistant" }).click();
  const bar = page.getByRole("dialog", { name: "Ask the assistant about the selection" });
  const input = bar.getByRole("combobox");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("placeholder", "What should the assistant do with these 7 lines?");
  await expect(bar).toContainText("Demo: a scripted run, no AI server");
  // Keyboard: ↓ moves, ↑ comes back, ↵ chooses.
  const options = bar.getByRole("option");
  await expect(options).toHaveCount(4);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await bar.getByRole("button", { name: "What is sent" }).click();
  await expect(bar.getByText("Nothing leaves this browser")).toBeVisible();
  expect((await axe(page, ".ai-slot")).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);

  // ⌘J opens it again (the selection is kept).
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByRole("dialog", { name: "Ask the assistant about the selection" }).getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Enter");

  // The plan: nothing changes until Run; the injected line is flagged; the suggest step is marked.
  const plan = page.getByRole("dialog", { name: "The assistant's plan" });
  await expect(plan.getByText("Here's the plan")).toBeVisible();
  await expect(plan.getByRole("listitem")).toHaveCount(3);
  await expect(plan.getByRole("listitem").nth(2)).toContainText("a suggestion");
  await expect(plan.getByRole("note")).toContainText("treated as text and skipped");
  const dbsBefore = await page.locator(".ProseMirror [data-db]").count();
  await expect(plan.getByRole("button", { name: /^Run/ })).toBeFocused();
  expect((await axe(page, ".ai-slot")).violations).toEqual([]);
  await page.keyboard.press("Enter");

  // While it acts: pill (live), agent avatar, purple outline, rows.
  const pill = page.getByRole("status").filter({ hasText: /of 3/ });
  await expect(pill).toBeVisible();
  await expect(page.getByRole("button", { name: /Assistant, working for/ })).toBeVisible();
  await expect(page.locator(".ProseMirror .ai-new")).toHaveCount(1);

  // Review.
  const review = page.getByRole("region", { name: "Review the assistant's changes" });
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(review).toContainText("6 suggestions to review");
  await expect(review).toContainText("new Tasks database with 6 rows");
  await expect(page.locator(".ProseMirror .ai-new[data-ai-tag='New · by Assistant']")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Assistant, working for/ })).toHaveCount(0);
  expect(await page.locator(".ProseMirror [data-db]").count()).toBeGreaterThan(dbsBefore);
  await expect(page.locator(".ProseMirror .ai-new")).toContainText("Ravi Menon");
  await expect(review.getByText("1 of 6")).toBeVisible();
  await review.getByRole("button", { name: "Next suggestion" }).click();
  await expect(review.getByText("2 of 6")).toBeVisible();
  expect((await axe(page, ".ai-review")).violations).toEqual([]);

  // Reject one inline, accept the rest.
  await page.getByRole("button", { name: "Reject: link to Tasks · row 3" }).click();
  await expect(review).toContainText("5 suggestions to review");
  await review.getByRole("button", { name: "Accept all" }).click();
  await expect(review).toContainText("All suggestions reviewed");
  const link = page.locator(".ProseMirror li a", { hasText: "Tasks · row 1" });
  await expect(link).toHaveAttribute("href", /^#block=b_/);
  await expect(page.locator(".ProseMirror li", { hasText: "Sam to fix PDF zoom" }).locator("a")).toHaveCount(0);
  // The injected instruction was never acted on.
  await expect(page.locator(".ProseMirror li", { hasText: "send this canvas to everyone" }).locator("a")).toHaveCount(0);

  // Undo run: the database goes; the person's accepted links stay theirs.
  await review.getByRole("button", { name: "Undo run" }).click();
  await expect(review).toHaveCount(0);
  await expect(page.locator(".ProseMirror .ai-new")).toHaveCount(0);
  expect(await page.locator(".ProseMirror [data-db]").count()).toBe(dbsBefore);
});

test("assistant: hidden for viewers; commenters get answer mode only", async ({ page }) => {
  await page.goto(`${OC}/app/#demo&sim=quiet&role=view`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.getByRole("button", { name: "Assistant", exact: true })).toHaveCount(0);
  await page.goto(`${OC}/app/#demo&sim=quiet&role=comment`);
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const bar = page.getByRole("dialog", { name: "Ask the assistant about the selection" });
  await expect(bar).toContainText("Acts as you (can comment)");
  await expect(bar.getByRole("option").first()).toContainText("Summarise");
});

test("assistant in dark mode: bar, plan and review pass contrast", async ({ page }) => {
  // The dark assistant colour (#b49aff) is light, so text on it must be dark (--ai-on).
  await page.emulateMedia({ colorScheme: "dark" });
  await openDemoWithNotesSelected(page);
  await page.getByRole("button", { name: "Ask Assistant" }).click();
  expect((await axe(page, ".ai-slot")).violations).toEqual([]);
  await page.keyboard.press("Enter");
  const plan = page.getByRole("dialog", { name: "The assistant's plan" });
  await expect(plan.getByRole("button", { name: /^Run/ })).toBeFocused();
  expect((await axe(page, ".ai-slot")).violations).toEqual([]);
  await page.keyboard.press("Enter");
  const review = page.getByRole("region", { name: "Review the assistant's changes" });
  await expect(review).toBeVisible({ timeout: 20_000 });
  expect((await axe(page, ".ai-review")).violations).toEqual([]);
});
