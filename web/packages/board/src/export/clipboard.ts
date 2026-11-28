// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Copy as PNG / SVG (BRD-20). Where the browser can't put an image on the clipboard, the caller
// says so and offers Download instead.

/** Puts an image on the clipboard. False when this browser can't (no async clipboard, or refused). */
export async function copyImage(blob: Blob | Promise<Blob>, type?: string): Promise<boolean> {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  const Item = (globalThis as { ClipboardItem?: new (items: Record<string, Blob | Promise<Blob>>) => unknown }).ClipboardItem;
  if (!clip?.write || !Item) return false;
  try {
    // Safari wants the item created inside the gesture, so the blob may still be a promise here.
    const mime = type ?? (blob instanceof Blob ? blob.type : "image/png");
    await clip.write([new Item({ [mime]: blob }) as ClipboardItem]);
    return true;
  } catch {
    // Many browsers refuse image/svg+xml; the SVG source as text still pastes into editors.
    if (type === "image/svg+xml" || (blob instanceof Blob && blob.type === "image/svg+xml")) {
      try {
        await clip.writeText?.(await (await blob).text());
        return !!clip.writeText;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/** Saves a file through a temporary link. */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
