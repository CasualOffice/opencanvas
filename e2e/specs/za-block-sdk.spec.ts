// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// za. SDK blocks in the sandbox (BSDK-03; docs/27 §3.4-3.5, the approved frames, decisions 1-9).
//   Flows: insert from the / menu, edit, a second person sees it; viewers run it read only;
//   crash then Reload block, the crash-loop guard; missing, tampered and not-enabled packages
//   show the read-only fallback; a script migration runs in the sandbox on first open.
//   Security suite: the hostile block cannot read cookies, storage or the editor's DOM, cannot
//   navigate the top window or fetch outside its permissions; schema-invalid writes and a write
//   flood are refused; a hang is detected; a tampered bundle never runs (/healthz lists it).
//   axe in light and dark on the chrome, the fallbacks and the gallery.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator } from "@playwright/test";
import { OC } from "../env";
import { editor, sharedFile, type Person } from "../helpers";
import { storedDocument } from "../ocanvas";

const headers = { "content-type": "application/json", "x-opencanvas-host": "sample", "x-opencanvas-key": "dev-api-key-change-me" };

async function patch(fileId: string, ops: unknown[]) {
  const r = await fetch(`${OC}/v1/files/${fileId}/patch`, { method: "POST", headers, body: JSON.stringify({ ops, author: { id: "bot", name: "Bot" } }) });
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as { blockIds: string[] };
}

type Node = { type: string; attrs: Record<string, never>; content?: Node[] };
/** The `extBlock` nodes of the host's stored copy. */
function extNodes(fileId: string): Node[] {
  const d = storedDocument(fileId);
  if (!d) return [];
  const out: Node[] = [];
  const walk = (ns: Node[] = []) => ns.forEach((n) => (n.type === "extBlock" && out.push(n), walk(n.content)));
  walk((JSON.parse(d) as { content: Node[] }).content);
  return out;
}

const block = (p: Person, type: string) => p.oc.locator(`.oc-ext[data-ext-type="${type}"]`);
const frameOf = (p: Person, type: string): FrameLocator => block(p, type).frameLocator("iframe.oc-ext-iframe");

test("insert from the / menu, edit, and a second person sees it", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E za · insert", samRole: "edit" });
  await editor(priya).locator(":scope > p").last().click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("/tick");
  const menu = priya.oc.getByRole("listbox", { name: "Insert" });
  await expect(menu.getByText("From your organisation")).toBeVisible();
  await expect(menu.getByText("E2E Corp · Objective and progress")).toBeVisible();
  await priya.page.keyboard.press("Enter");

  const f = frameOf(priya, "e2e.okr");
  const objective = f.getByLabel("Objective");
  await expect(objective).toHaveValue("New objective", { timeout: 10_000 });
  // Inserted blocks take focus (6g): typing goes into the block's first field.
  await objective.fill("Ship the block SDK");
  await objective.press("Tab");
  await f.getByRole("button", { name: "+10%" }).click();
  await f.getByRole("button", { name: "Score +1" }).click();
  await expect(f.locator(".score")).toHaveText("Score 1");

  const g = frameOf(sam, "e2e.okr");
  await expect(g.getByLabel("Objective")).toHaveValue("Ship the block SDK", { timeout: 10_000 });
  await expect(g.locator(".progress")).toHaveText("10%");
  await expect(g.locator(".score")).toHaveText("Score 1");
  // Readers without the package get the fallback the editor keeps current.
  await expect.poll(() => storedDocument(fileId) ?? "", { timeout: 20_000 }).toContain("**Ship the block SDK** (10%) score 1");
});

test("a viewer runs the block read only; the badge still tells where it comes from", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E za · viewer", samRole: "view" });
  await patch(fileId, [{ op: "append", blocks: [{ type: "extBlock", attrs: { type: "e2e.okr", attrs: { objective: "Read me", progress: 0.5 } } }] }]);
  await expect(frameOf(priya, "e2e.okr").locator(".status")).toHaveText("Ready", { timeout: 10_000 });
  const g = frameOf(sam, "e2e.okr");
  await expect(g.locator(".status")).toHaveText("Read only", { timeout: 10_000 });
  await expect(g.getByLabel("Objective")).toHaveJSProperty("readOnly", true);
  await block(sam, "e2e.okr").hover();
  const badge = block(sam, "e2e.okr").getByRole("button", { name: "Test OKR block by E2E Corp. About this block" });
  await expect(badge).toBeVisible();
  await badge.click();
  const about = sam.oc.getByRole("dialog", { name: "About Test OKR" });
  await expect(about).toContainText("Connect to okr.e2e.example");
  await expect(about).toContainText("See the names and pictures of people in this canvas, not their e-mail");
  await about.getByRole("button", { name: "Done" }).click();
});

test("security: the hostile block stays in its sandbox and its bad writes are refused", async ({ browser }) => {
  const { priya, fileId } = await sharedFile(browser, { name: "E2E za · hostile", samRole: "view" });
  const title = await priya.page.title();
  await patch(fileId, [{ op: "append", blocks: [{ type: "extBlock", attrs: { type: "e2e.hostile", attrs: {} } }] }]);
  const report = frameOf(priya, "e2e.hostile").locator(".report");
  await expect(report).toContainText("flood=", { timeout: 15_000 });
  await expect(report).toContainText("fetchOut=blocked");
  const text = await report.textContent();
  expect(text).toContain("cookie=blocked");
  expect(text).toContain("storage=blocked");
  expect(text).toContain("parentDom=blocked");
  expect(text).toContain("topNav=blocked");
  expect(text).toMatch(/invalidWrite=refused: attrs don't match the block's schema/);
  expect(text).toMatch(/flood=rate limited \d+/);
  // Nothing navigated away.
  expect(await priya.page.title()).toBe(title);
  await expect(editor(priya)).toBeVisible();
});

test("crash, Reload block, and the crash-loop guard", async ({ browser }) => {
  const { priya, fileId } = await sharedFile(browser, { name: "E2E za · crash", samRole: "view" });
  await patch(fileId, [{ op: "append", blocks: [{ type: "extBlock", attrs: { type: "e2e.hostile", attrs: {}, fallback: { markdown: "**Saved** copy" } } }] }]);
  const b = block(priya, "e2e.hostile");
  for (let i = 1; i <= 3; i++) {
    await frameOf(priya, "e2e.hostile").getByRole("button", { name: "Crash" }).click();
    // Crash detection rides the frame heartbeat; a loaded machine can take longer than 10 s.
    await expect(b.getByRole("alert")).toContainText("This block stopped working", { timeout: 20_000 });
    await expect(b).toContainText("Last saved copy");
    await expect(b.locator(".oc-ext-copy b")).toHaveText("Saved");
    // The rest of the canvas keeps working.
    await expect(editor(priya)).toBeVisible();
    if (i < 3) await b.getByRole("button", { name: "Reload block" }).click();
  }
  // Decision 4: three crashes in a minute.
  await expect(b.getByRole("button", { name: "Try again later" })).toBeDisabled();
});

test("a hang (no heartbeat for 5 s) is reported as a crash", async ({ browser }) => {
  const { priya, fileId } = await sharedFile(browser, { name: "E2E za · hang", samRole: "view" });
  await patch(fileId, [{ op: "append", blocks: [{ type: "extBlock", attrs: { type: "e2e.hostile", attrs: {} } }] }]);
  // Clicked from inside the frame on the next tick: the click itself must not wait on the hang.
  await frameOf(priya, "e2e.hostile").getByRole("button", { name: "Hang" }).evaluate((b) => setTimeout(() => (b as HTMLButtonElement).click(), 0));
  await expect(block(priya, "e2e.hostile").getByRole("alert")).toContainText("This block stopped working", { timeout: 25_000 });
});

test("missing, tampered and not-enabled packages show the read-only saved copy", async ({ browser }) => {
  const { priya, fileId } = await sharedFile(browser, { name: "E2E za · missing", samRole: "view" });
  await patch(fileId, [
    { op: "append", blocks: [{ type: "extBlock", attrs: { type: "e2e.gone", v: 1, attrs: { x: 1 }, fallback: { markdown: "Gone **copy**", title: "Gone" } } }] },
    { op: "append", blocks: [{ type: "extBlock", attrs: { type: "e2e.tampered", v: 1, attrs: {}, fallback: { text: "Tampered copy" } } }] },
  ]);
  const gone = block(priya, "e2e.gone");
  await expect(gone).toContainText("Gone isn’t available here");
  await expect(gone).toContainText("This canvas has a Gone block (e2e.gone) that Sample host hasn’t turned on. Its data is kept.");
  await expect(gone).toContainText("Saved copy · read only");
  await expect(gone.locator("iframe")).toHaveCount(0);
  const tampered = block(priya, "e2e.tampered");
  await expect(tampered).toContainText("isn’t available here");
  await expect(tampered).toContainText("Tampered copy");
  await expect(tampered.locator("iframe")).toHaveCount(0);
  // The data travels with the document untouched.
  await expect.poll(() => storedDocument(fileId) ?? "", { timeout: 20_000 }).toContain('"x":1');
  // Refused at start-up and reported (7b, decision 9).
  const health = await (await fetch(`${OC}/healthz`)).json();
  expect(JSON.stringify(health.blocks.refused)).toContain("integrity mismatch");
});

test("a script migration runs in the sandbox and the first edit stores the new version", async ({ browser }) => {
  const { priya, fileId } = await sharedFile(browser, { name: "E2E za · migrate", samRole: "view" });
  await patch(fileId, [{ op: "append", blocks: [{ type: "extBlock", attrs: { type: "e2e.mig", v: 1, attrs: { name: "Old" } } }] }]);
  const f = frameOf(priya, "e2e.mig");
  await expect(f.locator(".title")).toHaveText("Title: Old (migrated)", { timeout: 10_000 });
  await f.getByRole("button", { name: "Touch" }).click();
  await expect
    .poll(() => {
      const n = extNodes(fileId).find((x) => x.attrs.type === "e2e.mig");
      return n ? { v: n.attrs.v, attrs: n.attrs.attrs } : null;
    }, { timeout: 20_000 })
    .toEqual({ v: 2, attrs: { title: "Old (migrated)", touched: true } });
});

test("axe: block chrome, fallbacks and the gallery in light and dark", async ({ browser }) => {
  const { priya, fileId } = await sharedFile(browser, { name: "E2E za · axe", samRole: "view" });
  await patch(fileId, [
    { op: "append", blocks: [{ type: "extBlock", attrs: { type: "e2e.okr", attrs: { objective: "Accessible", progress: 0.3 } } }] },
    { op: "append", blocks: [{ type: "extBlock", attrs: { type: "e2e.gone", v: 1, attrs: {}, fallback: { markdown: "Saved", title: "Gone" } } }] },
  ]);
  await expect(frameOf(priya, "e2e.okr").locator(".status")).toHaveText("Ready", { timeout: 10_000 });
  await block(priya, "e2e.okr").hover();
  // Theme switches transition colours (.btn: background .2s); axe must not sample mid-fade.
  await priya.page.emulateMedia({ reducedMotion: "reduce" });
  const tags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
  const frame = priya.page.frame({ name: "oc" })!;
  for (const theme of ["light", "dark"]) {
    await frame.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    // The theme reaches the block over the bridge.
    await expect(frameOf(priya, "e2e.okr").locator("html")).toHaveAttribute("data-theme", theme);
    const r = await new AxeBuilder({ page: priya.page }).include(['iframe[name="oc"]', ".oc-ext"]).withTags(tags).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
  // The gallery, from the / menu's "Browse all blocks".
  await editor(priya).getByRole("heading", { name: "Notes" }).click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("/");
  await priya.oc.getByRole("option", { name: "Browse all blocks" }).click();
  const gallery = priya.oc.getByRole("dialog", { name: "Insert a block" });
  await expect(gallery.getByRole("option", { name: /Test OKR/ })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await frame.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page: priya.page }).include(['iframe[name="oc"]', ".modal"]).withTags(tags).analyze();
    expect(r.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
  // Enter inserts the selected card.
  await gallery.getByRole("option", { name: /Test OKR/ }).press("Enter");
  await expect(block(priya, "e2e.okr")).toHaveCount(2);
});
