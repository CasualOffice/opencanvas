// p. Users and identity (docs/21, ADR-026), one test per acceptance bullet: tier 0 mentions
//    with no user callbacks, two people called Asha Rao told apart everywhere, a host rename
//    reaching existing mentions through resolve (and the snapshot without it), and per-viewer
//    networks: Sam never finds Priya, sees her only by the host's external label, and sees a
//    hidden person as "Someone" with no real name anywhere in his DOM.
import { expect, test, type FrameLocator } from "@playwright/test";
import { applyTemplate, createFile, editor, openFile, person, setAccess, setDirectory, typeAfterHeading, updateHostUser, type Person } from "../helpers";

const picker = (p: Person) => p.oc.locator(".pop").filter({ hasText: "People" });

/** Everything the OpenCanvas frame renders: text, attributes (titles, labels) and all. */
async function frameHtml(p: Person): Promise<string> {
  const frame = p.page.frame({ name: "oc" });
  if (!frame) throw new Error("no OpenCanvas frame");
  return frame.content();
}

async function caretIn(p: Person, heading: string) {
  await editor(p).locator("h1, h2, h3").filter({ hasText: heading }).first().click();
  await p.page.keyboard.press("End");
}

const label = (oc: FrameLocator, text: string | RegExp) => oc.locator(".collaboration-carets__label", { hasText: text });

test("tier 0: with only launch tokens, mentions list everyone who has opened the file", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · tier 0");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_asha", "edit");
  await setAccess(priya, fileId, "u_ravi", "edit");
  // No participants, no search, no resolve: the host only signs launch tokens.
  await setDirectory(fileId, { tier: 0 });
  const asha = await person(browser, "u_asha");
  await openFile(asha, fileId);
  await expect(priya.oc.getByRole("button", { name: "Follow Asha Rao" })).toBeVisible();
  await asha.ctx.close();
  // Priya reopens with a tier-0 token. Asha opened the file, so she is listed; Ravi has
  // access but never opened it, and without callbacks OpenCanvas can't know about him.
  await openFile(priya, fileId);
  await typeAfterHeading(priya, "Notes", "Ask @");
  await expect(picker(priya).getByRole("option", { name: /Asha Rao/ })).toBeVisible();
  await expect(picker(priya).getByRole("option", { name: /Ravi/ })).toHaveCount(0);
  // Her second line came with her own launch token.
  await expect(picker(priya).getByRole("option", { name: /Asha Rao/ })).toContainText("Design · Bengaluru");
  await priya.page.keyboard.type("Ash");
  await expect(picker(priya).getByRole("option").first()).toContainText("Asha Rao");
  await priya.page.keyboard.press("Enter");
  await expect(editor(priya).locator('.mention[data-id="u_asha"]')).toHaveText(/Asha Rao/);
  await priya.ctx.close();
});

test("two people called Asha Rao are distinguishable in the picker, avatars, cursors and hover cards", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · duplicates");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_asha", "edit");
  await setAccess(priya, fileId, "u_asha2", "edit");
  const asha = await person(browser, "u_asha");
  const asha2 = await person(browser, "u_asha2");
  await openFile(asha, fileId);
  await openFile(asha2, fileId);

  // Avatars: the tooltip carries the second line, initials get a subscript.
  const design = priya.oc.locator('.avs .av[title^="Asha Rao · Design · Bengaluru"]');
  const finance = priya.oc.locator('.avs .av[title^="Asha Rao · Finance · Pune"]');
  await expect(design).toBeVisible();
  await expect(finance).toBeVisible();
  const ini = [await design.innerText(), await finance.innerText()].sort();
  expect(ini).toEqual(["AR", "AR₂"]);
  await expect(priya.oc.getByRole("button", { name: "Follow Asha Rao · Finance · Pune" })).toBeVisible();

  // Cursor labels: "Asha Rao · Design · Bengaluru" and "Asha Rao · Finance · Pune".
  await caretIn(asha, "Agenda");
  await caretIn(asha2, "Notes");
  await expect(label(editor(priya), "Asha Rao · Design · Bengaluru")).toBeVisible();
  await expect(label(editor(priya), "Asha Rao · Finance · Pune")).toBeVisible();

  // Picker: both rows, next to each other, each with its own second line.
  await typeAfterHeading(priya, "Decisions", "Over to @asha");
  const opts = picker(priya).getByRole("option");
  await expect(opts.filter({ hasText: "Asha Rao" })).toHaveCount(2);
  const texts = await opts.allInnerTexts();
  const rows = texts.map((t, i) => [t, i] as const).filter(([t]) => t.includes("Asha Rao"));
  expect(rows[1][1] - rows[0][1]).toBe(1);
  expect(rows.map(([t]) => t).join("|")).toMatch(/Design · Bengaluru[\s\S]*\|[\s\S]*Finance · Pune/);
  await opts.filter({ hasText: "Finance · Pune" }).click();
  const chip = editor(priya).locator('.mention[data-id="u_asha2"]');
  await expect(chip).toHaveText(/Asha Rao/);

  // Hover card on the chip: name and second line.
  await chip.hover();
  const card = priya.oc.getByRole("tooltip");
  await expect(card).toContainText("Asha Rao");
  await expect(card).toContainText("Finance · Pune");
  await expect(chip).toHaveAttribute("aria-describedby", "oc-person-card");
  // Escape dismisses it (WCAG 1.4.13).
  await priya.page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  // Keyboard: with the caret right after the chip, the card opens too.
  await editor(priya).locator("p", { hasText: "Over to" }).click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("ArrowLeft");
  await expect(priya.oc.getByRole("tooltip")).toContainText("Finance · Pune");
  for (const p of [priya, asha, asha2]) await p.ctx.close();
});

test("a rename in the host reaches existing mentions after reload with resolve, and the snapshot is used without it", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, "E2E p · rename");
  await applyTemplate(priya, "Meeting notes");
  await setAccess(priya, fileId, "u_ravi", "edit");
  await openFile(priya, fileId);
  await typeAfterHeading(priya, "Notes", "Owner @Ravi");
  await expect(picker(priya).getByRole("option", { name: /Ravi Menon/ })).toBeVisible();
  await priya.page.keyboard.press("Enter");
  const chip = editor(priya).locator('.mention[data-id="u_ravi"]');
  await expect(chip).toHaveText(/Ravi Menon$/);
  await expect(priya.oc.locator(".top .status")).toHaveAttribute("aria-label", /^Saved/, { timeout: 10_000 });
  try {
    await updateHostUser("u_ravi", { name: "Ravi Iyer" });
    await openFile(priya, fileId);
    await expect(chip).toHaveText(/Ravi Iyer$/);
    // Without resolve (and nothing about Ravi in a token), the stored label is shown.
    await setDirectory(fileId, { tier: 0 });
    await openFile(priya, fileId);
    await expect(chip).toHaveText(/Ravi Menon$/);
  } finally {
    await updateHostUser("u_ravi", { name: "Ravi Menon" });
  }
  await priya.ctx.close();
});

/** Priya and Sam on a file with the contacts graph on: they are not contacts. */
async function networks(browser: Parameters<typeof person>[0], name: string, extra: ("u_ravi")[] = []) {
  const priya = await person(browser, "u_priya");
  const fileId = await createFile(priya, name);
  // A template without sample databases: their example owners are made-up people.
  await applyTemplate(priya, "Daily standup");
  await setAccess(priya, fileId, "u_sam", "edit");
  for (const u of extra) await setAccess(priya, fileId, u, "edit");
  await setDirectory(fileId, { tier: 3, networks: true });
  await openFile(priya, fileId);
  return { priya, fileId };
}

test("per-viewer networks: Sam's mention search never returns Priya", async ({ browser }) => {
  test.setTimeout(90_000);
  const { priya, fileId } = await networks(browser, "E2E p · Sam never finds Priya");
  const sam = await person(browser, "u_sam");
  await openFile(sam, fileId);
  // Priya is right here (and in the file's people), yet she isn't Sam's contact.
  await expect(sam.oc.locator(".avs .av")).toHaveCount(2);
  for (const q of ["Pri", "Shah"]) {
    await typeAfterHeading(sam, "Today", `@${q}`);
    await expect(sam.oc.locator(".pop")).toContainText(`No one matches “${q}”`);
    await expect(sam.oc.locator(".pop").getByRole("option", { name: /Priya/ })).toHaveCount(0);
    await sam.page.keyboard.press("Escape");
    // The next click on the same heading must not count as a double-click (it would select the word).
    await sam.page.waitForTimeout(600);
  }
  // Sam's own contacts are there.
  await typeAfterHeading(sam, "Today", "@Ash");
  await expect(picker(sam).getByRole("option", { name: /Asha Rao/ }).first()).toBeVisible();
  await expect(picker(sam).getByRole("option", { name: /Priya/ })).toHaveCount(0);
  for (const p of [priya, sam]) await p.ctx.close();
});

test("per-viewer networks: Sam sees Priya's cursor with the host's external label", async ({ browser }) => {
  test.setTimeout(90_000);
  const { priya, fileId } = await networks(browser, "E2E p · external label");
  const sam = await person(browser, "u_sam");
  await openFile(sam, fileId);
  await caretIn(priya, "Yesterday");
  await expect(label(editor(sam), "Priya S.")).toBeVisible();
  await expect(sam.oc.locator('.avs .av[title^="Priya S. · Not in your contacts"]')).toBeVisible();
  expect(await frameHtml(sam)).not.toContain("Priya Shah");
  for (const p of [priya, sam]) await p.ctx.close();
});

test('per-viewer networks: a hidden person is "Someone" to Sam, with no real name anywhere in his DOM', async ({ browser }) => {
  test.setTimeout(90_000);
  const { priya, fileId } = await networks(browser, "E2E p · hidden", ["u_ravi"]);
  const ravi = await person(browser, "u_ravi");
  await openFile(ravi, fileId);
  await caretIn(ravi, "Yesterday");
  // Priya mentions Ravi (her own nickname for him) in the canvas.
  await typeAfterHeading(priya, "Today", "Owner @Ravi");
  await expect(picker(priya).getByRole("option", { name: /Ravi \(eng lead\)/ })).toBeVisible();
  await priya.page.keyboard.press("Enter");
  await expect(editor(priya).locator('.mention[data-id="u_ravi"]')).toHaveText(/Ravi \(eng lead\)/);

  const sam = await person(browser, "u_sam");
  await openFile(sam, fileId);
  await expect(editor(sam).locator('.mention[data-id="u_ravi"]')).toHaveText(/Someone$/);
  await expect(label(editor(sam), "Someone")).toBeVisible();
  await expect(sam.oc.locator('.avs .av[title^="Someone"]')).toBeVisible();
  await caretIn(ravi, "Blockers");
  await sam.page.waitForTimeout(500);
  const html = await frameHtml(sam);
  for (const real of ["Ravi", "Menon", "eng lead", "Engineering"]) expect(html).not.toContain(real);
  for (const p of [priya, ravi, sam]) await p.ctx.close();
});
