// e. Pasting an image uploads it through the server to the host; the other person sees it.
import { expect, test } from "@playwright/test";
import { HOST } from "../env";
import { editor, PNG_1PX, sharedFile, storedDocumentHas, typeAfterHeading } from "../helpers";

test("pasted image uploads and appears for the other person", async ({ browser }) => {
  const { priya, sam, fileId } = await sharedFile(browser, { name: "E2E e · upload", samRole: "view" });
  await typeAfterHeading(priya, "Notes", "Screenshot below");

  await editor(priya).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_1PX);

  const hosted = new RegExp(`^${HOST}/assets/a_[0-9a-f]+$`);
  for (const p of [priya, sam]) {
    const img = editor(p).locator("img").first();
    await expect(img).toHaveAttribute("src", hosted, { timeout: 10_000 });
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
  }
  await expect.poll(() => storedDocumentHas(fileId, `${HOST}/assets/a_`), { timeout: 15_000 }).toBe(true);

  await priya.ctx.close();
  await sam.ctx.close();
});
