// o. Columns layout (COL-01) on the `#demo` canvas: add a column from the hover affordance,
//    type in it, resize from the keyboard (quarter steps), label columns, remove an empty
//    column (Undo brings it back), and the layout stacks at 390 px.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { OC } from "../env";

async function demo(page: Page) {
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await expect(page.locator(".ProseMirror .cols")).toBeVisible();
}
const cols = (page: Page) => page.locator(".ProseMirror .cols").first();
const widths = (page: Page) => cols(page).evaluate((el) => [...el.querySelectorAll(":scope > .column")].map((c) => Math.round(c.getBoundingClientRect().width)));

test("columns: add, type, resize by keyboard, title, remove with undo", async ({ page }) => {
  await demo(page);
  const grid = cols(page);
  await expect(grid.locator(":scope > .column")).toHaveCount(2);
  await grid.hover();
  // At rest there are no hard borders; on hover each column gets a dashed outline.
  await expect.poll(() => grid.locator(":scope > .column").first().evaluate((c) => getComputedStyle(c).outlineStyle)).toBe("dashed");

  // Add a column at the end: it gets the caret and the "/" hint.
  await grid.getByRole("button", { name: "Add a column at the end" }).click();
  await expect(grid.locator(":scope > .column")).toHaveCount(3);
  const third = grid.locator(":scope > .column").nth(2);
  await expect(third).toHaveClass(/col-active/);
  await expect(third.locator("p.is-empty")).toHaveAttribute("data-placeholder", "Type '/' for blocks");
  await page.keyboard.type("Risks");
  await expect(third).toContainText("Risks");

  // Keyboard resize: the boundary after column 1 moves in quarter steps.
  const sep = grid.getByRole("separator", { name: "Width of columns 1 and 2" });
  await sep.focus();
  const before = await widths(page);
  await page.keyboard.press("ArrowRight");
  await expect(grid.getByRole("separator", { name: "Width of columns 1 and 2" })).toHaveAttribute("aria-valuenow", "50");
  await expect.poll(async () => (await widths(page))[0]).toBeGreaterThan(before[0] + 40);
  await expect(grid).toHaveAttribute("data-widths", "50,17,33");

  // Column titles from the layout's block menu (gutter handle of the columns block).
  await grid.hover({ position: { x: 10, y: 10 } });
  await page.getByRole("button", { name: "Block options" }).click();
  await page.getByRole("menuitem", { name: "Add column title" }).click();
  const t1 = grid.getByRole("textbox", { name: "Column 1 title" });
  await expect(t1).toBeFocused();
  await t1.fill("Host");
  await page.keyboard.press("Enter");
  await expect(grid.locator(".coltitle input").first()).toHaveValue("Host");

  // An empty column offers "Remove column"; Undo brings it back.
  await grid.getByRole("button", { name: "Add a column after column 1" }).click();
  await expect(grid.locator(":scope > .column")).toHaveCount(4);
  await expect(grid.getByRole("button", { name: "Add a column at the end" })).toHaveCount(0); // 4 is the most
  await grid.hover();
  await grid.getByRole("button", { name: "Remove column 2" }).click();
  await expect(grid.locator(":scope > .column")).toHaveCount(3);
  await page.locator(".toasts button", { hasText: "Undo" }).dispatchEvent("click");
  await expect(grid.locator(":scope > .column")).toHaveCount(4);
  // Backspace in an empty column removes it too.
  await grid.locator(":scope > .column").nth(1).locator("p").click();
  await page.keyboard.press("Backspace");
  await expect(grid.locator(":scope > .column")).toHaveCount(3);

  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await grid.hover();
    const r = await new AxeBuilder({ page }).include(".cols").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
});

test("columns stack on a 390 px phone with a separator", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await demo(page);
  const grid = cols(page);
  await grid.scrollIntoViewIfNeeded();
  const boxes = await grid.locator(":scope > .column").evaluateAll((cs) => cs.map((c) => c.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) })));
  expect(boxes).toHaveLength(2);
  expect(boxes[0].x).toBe(boxes[1].x);
  expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
  expect(boxes[0].w).toBeGreaterThan(300);
  await expect.poll(() => grid.locator(":scope > .column").nth(1).evaluate((c) => getComputedStyle(c).borderTopStyle)).toBe("solid");
  await ctx.close();
});
