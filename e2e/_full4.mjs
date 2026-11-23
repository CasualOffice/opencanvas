import { chromium } from "@playwright/test";
const ROOM = "https://localhost:8643/" + (process.argv[2] || "Final") + Date.now();
const OUT = "/private/tmp/claude-501/-Users-sachin-Desktop-melp-services-canvas/21822934-5703-4e48-b59d-0cc065f11b25/scratchpad";
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const res = {}; let step = "start";
async function inMeeting(p) {
  const join = p.getByRole("button", { name: /^join meeting$/i }).first();
  await Promise.race([p.waitForSelector("#videospace", { timeout: 45000 }), join.waitFor({ timeout: 45000 }).then(() => join.click())]).catch(() => {});
  await p.waitForSelector("#videospace", { timeout: 45000 }); await p.waitForTimeout(3000);
}
async function join(name) {
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${ROOM}#config.prejoinConfig.enabled=false&userInfo.displayName="${name}"`);
  await inMeeting(p); return { ctx, p };
}
async function openDoc(p) {
  await p.getByRole("button", { name: /more actions/i }).first().click();
  await p.getByRole("menuitem", { name: /shared document/i }).or(p.getByRole("button", { name: /shared document/i })).first().click();
  const f = p.frameLocator("#etherpadIFrame");
  await f.locator(".ProseMirror:visible").first().waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  return f;
}
try {
  step = "priya"; const a = await join("Priya"); const fa = await openDoc(a.p);
  res.noGallery = (await fa.getByText("What are you working on?").count()) === 0;
  res.firstBlock = (await fa.locator(".ProseMirror:visible > *").first().innerText()).slice(0, 40);
  res.noTemplateButton = (await fa.locator(".top").getByRole("button", { name: "Templates" }).count()) === 0;
  res.temporaryShown = (await fa.getByText("Not saved · temporary").count()) > 0 && (await fa.getByText(/deleted when the meeting ends/).count()) > 0;
  res.saysSaved = (await fa.getByText(/^Saved$|Stored in/).count()) > 0;
  await fa.locator(".ProseMirror:visible").first().click(); await a.p.keyboard.press("ControlOrMeta+End"); await a.p.keyboard.press("Enter"); await a.p.keyboard.type("Hello from Priya in Jitsi");
  step = "ravi"; const c = await join("Ravi"); const fc = await openDoc(c.p);
  await fc.locator(".ProseMirror:visible").filter({ hasText: "Hello from Priya" }).first().waitFor({ timeout: 15000 }); res.raviSeesPriya = true;
  await fc.locator(".ProseMirror:visible").first().click(); await c.p.keyboard.press("ControlOrMeta+End"); await c.p.keyboard.type(" and Ravi");
  await fa.locator(".ProseMirror:visible").filter({ hasText: "and Ravi" }).first().waitFor({ timeout: 10000 }); res.syncBothWays = true;
  await a.p.screenshot({ path: `${OUT}/jitsi-${process.argv[2] || "final"}.png` });
  step = "reload"; await c.p.reload(); await inMeeting(c.p); const fc2 = await openDoc(c.p);
  await fc2.locator(".ProseMirror:visible").filter({ hasText: "and Ravi" }).first().waitFor({ timeout: 20000 }); res.reloadSameCanvas = true;
  step = "end"; await a.ctx.close(); await c.ctx.close();
} catch (e) { res.failedAt = step; res.error = String(e.message).split("\n")[0].slice(0, 160); }
await b.close();
console.log(JSON.stringify(res));
