// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// OpenCanvas Workspace (ADR-085, docs/40): the real `opencanvas-workspace` binary (engine and
// Workspace on one port) driven through its web app. First run from the same machine, the typed
// New menu (13a), a spreadsheet and a whiteboard file in app view with no editor top bar
// (13c, 13d, FTY-03/04), search, a passkey added and used with Chromium's virtual
// authenticator (WS-06), and the phone layout (10a).
//
// Needs `opencanvas-workspace` built (release, or E2E_WORKSPACE_BIN) and both web apps built:
//   cargo build --release -p oc-workspace
//   pnpm --filter @opencanvas/editor build && pnpm --filter @opencanvas/workspace build
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ROOT, port } from "../env";

const BASE = `http://localhost:${port(8290)}`;
let child: ChildProcess | null = null;

function binary(): string | null {
  const target = process.env.CARGO_TARGET_DIR ? path.resolve(ROOT, process.env.CARGO_TARGET_DIR) : path.join(ROOT, "target");
  const candidates = [process.env.E2E_WORKSPACE_BIN, path.join(target, "release/opencanvas-workspace")].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const bin = binary();
  test.skip(!bin, "opencanvas-workspace is not built (cargo build --release -p oc-workspace)");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-e2e-"));
  const log = fs.openSync(path.join(data, "log.txt"), "w");
  child = spawn(bin!, [], {
    env: {
      ...process.env,
      WS_DATA_DIR: data,
      WS_BIND: `127.0.0.1:${port(8290)}`,
      WS_WEB_DIR: path.join(ROOT, "web/packages/workspace/dist"),
      OC_WEB_DIR: path.join(ROOT, "web/packages/editor/dist"),
      DATABASE_URL: "",
      REDIS_URL: "",
      OC_HOSTS_FILE: "",
    },
    stdio: ["ignore", log, log],
  });
  for (let i = 0; i < 300; i++) {
    const ok = await fetch(`${BASE}/api/ws/healthz`).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`opencanvas-workspace did not start; see ${data}/log.txt`);
});

test.afterAll(() => {
  child?.kill("SIGTERM");
});

const newFile = async (page: Page, type: string) => {
  await page.goto(`${BASE}/ws/`);
  await page.getByRole("button", { name: "New" }).first().click();
  await expect(page.getByRole("menu", { name: "New" })).toBeVisible();
  await page.getByRole("menuitem", { name: new RegExp(`^${type}`) }).click();
  await expect(page.locator(".file-page")).toBeVisible();
  return page.frameLocator("iframe.editor-frame");
};

test("first run from the same machine needs no setup code and lands on Home", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("heading", { name: "Name your organisation" })).toBeVisible();
  await page.getByLabel("Organisation name").fill("Acme");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your name").fill("Priya Nair");
  await page.getByLabel("E-mail").fill("priya@acme.example");
  await page.getByLabel("Password").fill("plum orbit lantern");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "Acme is ready" })).toBeVisible();
  await page.getByRole("button", { name: "Open Acme" }).click();
  await expect(page.getByRole("heading", { name: /Priya/ })).toBeVisible();
  await expect(page.locator(".sb").getByText("Welcome")).toBeVisible();
});

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/ws/signin`);
    if (await page.locator("#si-e").isVisible().catch(() => false)) {
      await page.locator("#si-e").fill("priya@acme.example");
      await page.locator("#si-p").fill("plum orbit lantern");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    }
    await expect(page.locator(".sb")).toBeVisible();
  });

  test("the New menu offers the four file types (13a)", async ({ page }) => {
    await page.getByRole("button", { name: "New" }).first().click();
    const items = page.getByRole("menu", { name: "New" }).getByRole("menuitem");
    await expect(items.nth(0)).toContainText("Document");
    await expect(items.nth(1)).toContainText("Spreadsheet");
    await expect(items.nth(2)).toContainText("Whiteboard");
    await expect(items.nth(3)).toContainText("Database");
  });

  test("a spreadsheet file opens as the full grid, with no editor header and no way back (13c)", async ({ page }) => {
    const ed = await newFile(page, "Spreadsheet");
    await expect(ed.locator(".ocsh-full")).toBeVisible({ timeout: 15_000 });
    await expect(ed.getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect(ed.getByRole("button", { name: "Open full screen" })).toHaveCount(0);
    await expect(ed.locator(".dhead")).toBeHidden();
    // `[host.editor] chrome = "host"`: the Workspace header is the only one.
    await expect(ed.locator(".wsp > .top")).toHaveCount(0);
    await expect(page.locator(".file-page .cv-t .cname")).toHaveText("Untitled spreadsheet");
  });

  test("a whiteboard file opens as the full board (13d)", async ({ page }) => {
    const ed = await newFile(page, "Whiteboard");
    await expect(ed.locator(".ocbd.ocbd-full")).toBeVisible({ timeout: 15_000 });
    await expect(ed.getByRole("button", { name: "Exit full screen" })).toHaveCount(0);
  });

  test("search finds a sample document by its title (6a)", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search files" }).fill("meeting");
    await expect(page.getByRole("listbox", { name: "Results" }).getByRole("option").first()).toContainText("Meeting notes");
  });

  test("add a passkey, sign out, and sign in with it (WS-06)", async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await page.goto(`${BASE}/ws/me`);
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.locator(".sec-r", { hasText: "Added" }).first()).toBeVisible();
    await page.locator("main").getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(/\/ws\/signin/);
    // The virtual authenticator answers the autofill (conditional) request by itself; without
    // it, the button asks explicitly. Either way the passkey alone signs Priya in.
    const button = page.getByRole("button", { name: "Sign in with a passkey" });
    await expect(page.locator(".sb").or(button)).toBeVisible();
    if (await button.isVisible()) await button.click({ timeout: 3_000 }).catch(() => {});
    await expect(page.locator(".sb")).toBeVisible();
    await expect(page.locator(".sb-f .who b")).toHaveText("Priya Nair");
  });

  test("the phone layout has the bottom bar (10a)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/ws/`);
    const dock = page.getByRole("navigation", { name: "Main" });
    await expect(dock).toBeVisible();
    await expect(dock.getByRole("button", { name: "New" })).toBeVisible();
    await expect(page.locator(".app > .sb")).toBeHidden();
  });
});
