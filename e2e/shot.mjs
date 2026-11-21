// Screenshot helper for docs/ux-audit (not part of the suite):
//   node shot.mjs <url> <out.png> [selector] [theme] [width] [height] [action]
import { chromium } from "@playwright/test";

const [url, out, sel, theme = "light", w = "1280", h = "900", action] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, colorScheme: theme === "dark" ? "dark" : "light" });
await page.goto(url);
await page.locator(".ProseMirror").waitFor();
await page.waitForTimeout(800);
const target = sel ? page.locator(sel).first() : null;
if (target) await target.scrollIntoViewIfNeeded();
if (action === "click" && target) await target.click();
if (action === "expand") await page.locator(".filev").getByRole("button", { name: "Expand to full screen" }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
await browser.close();
