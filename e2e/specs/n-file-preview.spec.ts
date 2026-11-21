// n. File previews (FILE-01): a PDF uploaded through the host shows inline as pages, the card
//    gets a first-page thumbnail, the viewer pages and zooms, Expand goes full screen and Esc
//    comes back, the inline viewer resizes by mouse and keyboard, and rename / delete + undo
//    work from the file's ⋯ menu. The host's file URL is read through /v1/assets/fetch.
import path from "node:path";
import { expect, test, type FrameLocator } from "@playwright/test";
import { ROOT } from "../env";
import { editor, sharedFile, typeAfterHeading } from "../helpers";

const PDF = path.join(ROOT, "e2e/fixtures/three-pages.pdf");

const pageCanvas = (oc: FrameLocator, root: string, n: number) => oc.locator(`${root} .pdfpage[data-page="${n}"] canvas`);
/** A canvas that has been drawn on (pdf.js rendered the page). */
const drawn = (oc: FrameLocator, sel: string, min = 20) =>
  oc.locator(sel).first().evaluate((c: HTMLCanvasElement, min) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && Math.min(d[i], d[i + 1], d[i + 2]) < 200) ink++;
    return c.width > 0 && ink > min;
  }, min);

test("PDF: inline pages, thumbnail, viewer, full screen, resize, rename and delete with undo", async ({ browser }) => {
  test.setTimeout(90_000);
  const { priya, sam } = await sharedFile(browser, { name: "E2E n · files", samRole: "view" });
  const oc = priya.oc;
  await typeAfterHeading(priya, "Notes", "");
  await priya.page.keyboard.type("/file");
  await expect(oc.locator(".pop").filter({ hasText: "File" })).toBeVisible();
  const [chooser] = await Promise.all([priya.page.waitForEvent("filechooser"), priya.page.keyboard.press("Enter")]);
  await chooser.setFiles(PDF);

  // Inline preview is the default for PDFs: the first page is drawn, 3 pages in the toolbar.
  const inline = oc.locator('.filev[data-display="preview"]');
  await expect(inline).toBeVisible({ timeout: 15_000 });
  await expect(inline.locator(".pdfpg")).toHaveText("1 / 3", { timeout: 15_000 });
  await expect.poll(() => drawn(oc, '.filev[data-display="preview"] .pdfpage[data-page="1"] canvas'), { timeout: 15_000 }).toBe(true);
  // The bytes came from this origin: the host's URL through the preview route.
  // Sam (view only) sees it too.
  await expect(sam.oc.locator('.filev[data-display="preview"] .pdfpg')).toHaveText("1 / 3", { timeout: 15_000 });

  // Resize the inline viewer: mouse drag, then the keyboard.
  const pdfv = inline.locator(".pdfv");
  const h0 = (await pdfv.boundingBox())!.height;
  const handle = inline.getByRole("button", { name: /^Preview height/ });
  await pdfv.hover();
  const hb = (await handle.boundingBox())!;
  await priya.page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await priya.page.mouse.down();
  await priya.page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 120, { steps: 5 });
  await priya.page.mouse.up();
  await expect.poll(async () => Math.round((await pdfv.boundingBox())!.height)).toBe(Math.round(h0 - 120));
  await handle.focus();
  await priya.page.keyboard.press("ArrowDown");
  await expect(handle).toHaveAttribute("aria-label", `Preview height, ${Math.round(h0 - 120 + 40)} pixels`);

  // Expand: the full viewer, page through, zoom, Esc returns to the same page inline.
  await inline.getByRole("button", { name: "Expand to full screen" }).click();
  const viewer = oc.getByRole("dialog", { name: /^Preview of three-pages\.pdf/ });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText("Page 1 of 3")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => drawn(oc, '.ocviewer .pdfpage[data-page="1"] canvas'), { timeout: 15_000 }).toBe(true);
  await priya.page.keyboard.press("ArrowRight");
  await expect(viewer.getByText("Page 2 of 3")).toBeVisible();
  await priya.page.keyboard.press("ArrowRight");
  await expect(viewer.getByText("Page 3 of 3")).toBeVisible();
  await expect.poll(() => drawn(oc, '.ocviewer .pdfpage[data-page="3"] canvas'), { timeout: 15_000 }).toBe(true);
  const w1 = (await pageCanvas(oc, ".ocviewer", 3).boundingBox())!.width;
  await viewer.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(async () => (await pageCanvas(oc, ".ocviewer", 3).boundingBox())!.width).toBeGreaterThan(w1 * 1.2);
  await priya.page.keyboard.press("0");
  await expect.poll(async () => Math.round((await pageCanvas(oc, ".ocviewer", 3).boundingBox())!.width)).toBe(Math.round(w1));
  // Focus stays inside the dialog.
  for (let i = 0; i < 12; i++) await priya.page.keyboard.press("Tab");
  await expect.poll(() => oc.locator(".ocviewer").evaluate((v) => v.contains(document.activeElement))).toBe(true);
  await expect(viewer.getByText("Page 3 of 3")).toBeVisible();
  // Esc leaves (full screen first when the browser granted it) and lands on page 3 inline.
  await priya.page.keyboard.press("Escape");
  if (await viewer.isVisible()) await priya.page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(inline.locator(".pdfpg")).toHaveText("3 / 3");

  // Card ⇄ preview from the ⋯ menu; the card has a first-page thumbnail and the page count.
  await inline.getByRole("button", { name: "Actions for three-pages.pdf" }).click();
  await oc.getByRole("menuitem", { name: "Show as card" }).click();
  const card = oc.locator('.filev[data-display="card"] .attach');
  await expect(card).toBeVisible();
  await expect(card.locator(".fmeta")).toContainText("3 pages");
  await expect.poll(() => drawn(oc, ".attach .fthumb.pdf canvas", 3)).toBe(true);
  // Enter on the card opens the viewer; Esc closes it and focus returns to the card.
  await card.focus();
  await priya.page.keyboard.press("Enter");
  await expect(viewer).toBeVisible();
  await priya.page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(card).toBeFocused();
  await card.getByRole("button", { name: "Actions for three-pages.pdf" }).click();
  await oc.getByRole("menuitem", { name: "Show as preview" }).click();
  await expect(inline).toBeVisible();

  // Rename, then delete and undo.
  await inline.getByRole("button", { name: "Actions for three-pages.pdf" }).click();
  await oc.getByRole("menuitem", { name: "Rename" }).click();
  const field = oc.getByRole("textbox", { name: "File name" });
  await expect(field).toBeFocused();
  await field.fill("Design brief.pdf");
  await priya.page.keyboard.press("Enter");
  await expect(inline.locator(".pdfname")).toHaveText("Design brief.pdf");
  await expect(sam.oc.locator(".filev .pdfname")).toHaveText("Design brief.pdf", { timeout: 3_000 });
  // Viewers get Preview, Download and Copy link only.
  await sam.oc.locator(".filev").getByRole("button", { name: "Actions for Design brief.pdf" }).click();
  await expect(sam.oc.getByRole("menuitem")).toHaveText([/^Preview/, "Expand to full screen", "Download", "Copy link"]);
  await sam.page.keyboard.press("Escape");

  await inline.getByRole("button", { name: "Actions for Design brief.pdf" }).click();
  await oc.getByRole("menuitem", { name: "Delete" }).click();
  await expect(oc.locator(".filev")).toHaveCount(0);
  await oc.getByRole("button", { name: "Undo" }).click();
  await expect(oc.locator(".filev .pdfname")).toHaveText("Design brief.pdf");
  await expect(editor(sam).locator(".filev")).toHaveCount(1, { timeout: 3_000 });

  await priya.ctx.close();
  await sam.ctx.close();
});

test("images open in a lightbox with zoom and prev / next", async ({ page }) => {
  const { OC } = await import("../env");
  await page.goto(`${OC}/app/#demo&sim=quiet`);
  await expect(page.locator(".ProseMirror .figure img").first()).toBeVisible();
  // Add a second image so prev / next has somewhere to go.
  await page.evaluate(() => {
    const ed = (window as unknown as { __ocEditor: { commands: { insertContentAt(p: number, c: unknown): void }; state: { doc: { content: { size: number } } } } }).__ocEditor;
    const svg = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#2a5ad7"/></svg>');
    ed.commands.insertContentAt(ed.state.doc.content.size, { type: "image", attrs: { src: svg, alt: "Blue box" } });
  });
  const fig = page.locator(".ProseMirror .figure").first();
  await fig.hover();
  await fig.getByRole("button", { name: "Expand image" }).click();
  const box = page.getByRole("dialog", { name: /^Preview of / });
  await expect(box).toBeVisible();
  await expect(box.locator(".vtitle span")).toContainText("1 of 2");
  await box.getByRole("button", { name: "Zoom in" }).click();
  await expect(box.locator(".vz")).toHaveText("125%");
  await page.keyboard.press("ArrowRight");
  await expect(box.locator(".vtitle b")).toHaveText("Blue box");
  await expect(box.locator(".vz")).toHaveText("100%");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
});
