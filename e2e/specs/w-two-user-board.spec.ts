// w — docs/23 two-user acceptance, board: two people edit shapes live and converge; a
//     viewer cannot move a shape (not on their own screen, not for anyone else).
import { expect, test, type Locator } from "@playwright/test";
import { editor, expectSaved, setAccess, sharedFile, typeAfterHeading, type Person } from "../helpers";

const board = (p: Person) => p.oc.locator(".ocbd").first();
const svg = (p: Person) => board(p).locator("svg.ocbd-svg");
const count = async (p: Person) => Number(/(\d+) shapes?/.exec((await board(p).getAttribute("aria-label")) ?? "")?.[1] ?? -1);
/** The rectangle's position in board coordinates, as rendered (`<rect x y>` inside `g[data-s]`). */
const rectAt = async (p: Person) => {
  const r = svg(p).locator("g[data-s] rect").first();
  return { x: Number(await r.getAttribute("x")), y: Number(await r.getAttribute("y")) };
};

async function activate(p: Person) {
  await board(p).scrollIntoViewIfNeeded();
  await board(p).click({ position: { x: 40, y: 40 } });
}

/** Drags with the mouse from the centre of `el` by (dx, dy) screen pixels. */
async function dragBy(p: Person, el: Locator, dx: number, dy: number) {
  const b = (await el.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await p.page.mouse.move(x, y);
  await p.page.mouse.down();
  for (let i = 1; i <= 6; i++) await p.page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
  await p.page.mouse.up();
}

test("BOARD-2U: two people edit shapes live and converge; a viewer cannot move a shape", async ({ browser }) => {
  test.setTimeout(120_000);
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E w · board", samRole: "edit" });
  await typeAfterHeading(priya, "Notes", "");
  await priya.page.keyboard.type("/whiteboard");
  await priya.page.keyboard.press("Enter");
  await expect(board(priya)).toBeVisible({ timeout: 10_000 });
  await expect(board(sam)).toBeVisible({ timeout: 10_000 });

  // Priya adds a rectangle; Sam sees it live.
  await activate(priya);
  await board(priya).getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: "Rectangle" }).click();
  const box = (await svg(priya).boundingBox())!;
  await priya.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => count(priya)).toBe(1);
  await expect.poll(() => count(sam), { timeout: 5_000 }).toBe(1);
  expect(await rectAt(sam)).toEqual(await rectAt(priya));

  // Sam moves it; both screens converge on the same position.
  await activate(sam);
  const before = await rectAt(sam);
  await dragBy(sam, svg(sam).locator("g[data-s]").first(), 80, 40);
  await expect.poll(async () => (await rectAt(sam)).x - before.x).toBeGreaterThan(20);
  await expect.poll(async () => JSON.stringify(await rectAt(priya)), { timeout: 5_000 }).toBe(JSON.stringify(await rectAt(sam)));

  // At the same time: Sam adds a second rectangle while Priya moves the first.
  await board(sam).getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: "Rectangle" }).click();
  const sb = (await svg(sam).boundingBox())!;
  await Promise.all([
    sam.page.mouse.click(sb.x + 80, sb.y + sb.height - 80),
    dragBy(priya, svg(priya).locator("g[data-s]").first(), -40, -20),
  ]);
  await expect.poll(() => count(priya), { timeout: 5_000 }).toBe(2);
  await expect.poll(() => count(sam), { timeout: 5_000 }).toBe(2);
  await expect.poll(async () => JSON.stringify(await rectAt(sam)), { timeout: 5_000 }).toBe(JSON.stringify(await rectAt(priya)));
  await expectSaved(priya);

  // Sam becomes a viewer: dragging a shape moves nothing, on his screen or Priya's.
  await setAccess(priya, fileId, "u_sam", "view");
  await sam.page.reload();
  await expect(editor(sam)).toHaveAttribute("contenteditable", "false", { timeout: 15_000 });
  await expect.poll(() => count(sam), { timeout: 10_000 }).toBe(2);
  await activate(sam);
  const fixed = await rectAt(priya);
  expect(await rectAt(sam)).toEqual(fixed);
  await dragBy(sam, svg(sam).locator("g[data-s]").first(), 90, 60);
  await sam.page.waitForTimeout(1_000);
  expect(await rectAt(sam), "the viewer's own screen").toEqual(fixed);
  expect(await rectAt(priya), "the editor's screen").toEqual(fixed);
  expect(await count(sam)).toBe(2);

  await priya.ctx.close();
  await sam.ctx.close();
});
