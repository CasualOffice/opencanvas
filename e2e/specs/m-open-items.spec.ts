// m. Open items from docs/19 (UX-02): offline detection by heartbeat, @mention notifications
//    to the host, follow mode on click and long-press, text colour and date mentions, block
//    links inside a host.
import { expect, test } from "@playwright/test";
import { createFile, editor, openFile, person, applyTemplate } from "../helpers";

test("a silent network drop shows Offline within 20 s, and the canvas recovers", async ({ browser }) => {
  test.setTimeout(90_000);
  const priya = await person(browser, "u_priya");
  // A silent drop: the browser never says it is offline (no `offline` event, onLine stays
  // true), so only the server heartbeat can reveal it.
  await priya.ctx.addInitScript(() => {
    for (const t of ["offline", "online"]) window.addEventListener(t, (e) => e.stopImmediatePropagation(), true);
    Object.defineProperty(Navigator.prototype, "onLine", { get: () => true });
  });
  await createFile(priya, "E2E m · offline");
  await applyTemplate(priya, "Meeting notes");
  const status = priya.oc.locator(".top .status");
  await expect(status).toHaveAttribute("aria-label", /^Saved/, { timeout: 10_000 });

  await priya.ctx.setOffline(true);
  const t0 = Date.now();
  await expect(status).toHaveAttribute("aria-label", /^Offline/, { timeout: 20_000 });
  const ms = Date.now() - t0;
  test.info().annotations.push({ type: "offline", description: `shown after ${ms} ms` });
  expect(ms).toBeLessThan(20_000);
  await expect(priya.oc.getByText("You're offline. Keep working.")).toBeVisible();

  // Typing while offline is kept and syncs once the network is back.
  await editor(priya).locator("p").last().click();
  await priya.page.keyboard.type("Written offline");
  await priya.ctx.setOffline(false);
  await expect(status).toHaveAttribute("aria-label", /^(Saved|Saving|Unsaved)/, { timeout: 20_000 });
  await expect(status).toHaveAttribute("aria-label", /^Saved/, { timeout: 15_000 });
  await priya.ctx.close();
});
