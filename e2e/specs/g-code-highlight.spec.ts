// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Code blocks: grammars load lazily (only once a code block exists), syntax colours come
// from the theme tokens in light and dark, the language picker syncs, copy works.
import { expect, test } from "@playwright/test";
import { editor, sharedFile } from "../helpers";

test("code block highlighting, language picker and copy", async ({ browser }) => {
  const { priya, sam } = await sharedFile(browser, { name: "E2E g · code", samRole: "view", ctx: { colorScheme: "light" } });
  await sam.page.emulateMedia({ colorScheme: "dark" });
  const grammars: string[] = [];
  priya.page.on("request", (r) => /\/assets\/highlight-[^/]+\.js$/.test(r.url()) && grammars.push(r.url()));
  await priya.page.waitForTimeout(500); // nothing should fetch the grammars while there is no code block
  expect(grammars).toEqual([]);

  await editor(priya).locator("h2", { hasText: "Notes" }).click();
  await priya.page.keyboard.press("End");
  await priya.page.keyboard.press("Enter");
  await priya.page.keyboard.type("```");
  await priya.page.keyboard.press("Space");
  await priya.page.keyboard.type("function greet(name) {\n  return 'hi ' + name; // say hi\n}");

  const block = (p: typeof priya) => p.oc.locator(".code").first();
  await expect(block(priya).locator(".hljs-keyword").first()).toHaveText("function");
  expect(grammars.length).toBe(1);
  // Auto-detect names what it found.
  await expect(block(priya).locator(".clang span").first()).toHaveText(/^Auto · JavaScript$/);

  // Colours come from the tokens: light for Priya, dark for Sam.
  const kw = (p: typeof priya) => block(p).locator(".hljs-keyword").first().evaluate((e) => getComputedStyle(e).color);
  const cm = (p: typeof priya) => block(p).locator(".hljs-comment").first().evaluate((e) => getComputedStyle(e).fontStyle);
  await expect(block(sam).locator(".hljs-keyword").first()).toHaveText("function", { timeout: 5_000 });
  expect(await kw(priya)).toBe("rgb(101, 56, 196)"); // --purple-fg, light
  expect(await kw(sam)).toBe("rgb(192, 166, 255)"); // --purple-fg, dark
  expect(await cm(priya)).toBe("italic");

  // Picking a language stores it on the node; the viewer sees the label, read-only.
  await block(priya).getByLabel("Code language").selectOption("python");
  await expect(block(sam).locator(".clang")).toHaveText("Python");
  await expect(block(sam).getByLabel("Code language")).toHaveCount(0);
  await block(priya).getByLabel("Code language").selectOption("");
  await expect(block(sam).locator(".clang")).toHaveText(/^Auto/);

  // Copy puts the code on the clipboard.
  // (Reading the clipboard back is blocked by permissions policy in a cross-origin iframe, so
  // record what the button writes.)
  const frame = priya.page.frames().find((f) => f.url().includes("localhost:8280/app/"))!;
  await frame.evaluate(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void w.__copied.push(t) } });
  });
  await block(priya).getByRole("button", { name: "Copy code" }).click();
  await expect(priya.oc.locator(".toast", { hasText: "Code copied" })).toBeVisible();
  expect(await frame.evaluate(() => (window as unknown as { __copied: string[] }).__copied.join(""))).toContain("return 'hi ' + name;");

  await priya.ctx.close();
  await sam.ctx.close();
});
