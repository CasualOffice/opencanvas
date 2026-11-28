// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The native file picker behind "/file", "/image" and "Replace" (RLB-04-F7).
//
// WebKit (iPhone Safari, Playwright webkit-phone) sent a picked PDF to POST /v1/assets with
// 0 bytes: the picker's <input> was never in the document, so nothing kept it (and its
// FileList) alive, and the File was a lazy, path-backed handle read only when the upload
// started. Two changes close it:
//   1. the input sits in the document (hidden) while the picker is open and is removed after;
//   2. the picked file's bytes are read at once, while the input is alive, and the callback
//      gets an in-memory copy. A short read is reported, never uploaded as an empty file.
import { toast } from "./store";
import { MAX_UPLOAD } from "./uploads";

const MARK = "data-oc-picker";

/** Reads a picked file into memory, so the upload no longer depends on the picker. */
export async function snapshotFile(f: File): Promise<File> {
  if (f.size > MAX_UPLOAD) return f; // refused by the upload path anyway; not read
  const buf = await f.arrayBuffer();
  if (buf.byteLength !== f.size) throw new Error(`short read: ${buf.byteLength} of ${f.size} bytes`);
  return new File([buf], f.name, { type: f.type, lastModified: f.lastModified });
}

export function pickFile(accept: string, onFile: (f: File) => void): void {
  // A picker that was cancelled without a "cancel" event (older WebKit) is still here.
  document.querySelectorAll(`input[${MARK}]`).forEach((n) => n.remove());
  const i = document.createElement("input");
  i.type = "file";
  i.accept = accept;
  i.setAttribute(MARK, "");
  i.hidden = true;
  i.tabIndex = -1;
  i.setAttribute("aria-hidden", "true");
  document.body.append(i);
  i.addEventListener("cancel", () => i.remove(), { once: true });
  i.addEventListener(
    "change",
    () => {
      const f = i.files?.[0];
      if (!f) return i.remove();
      snapshotFile(f).then(
        (copy) => {
          i.remove();
          onFile(copy);
        },
        () => {
          i.remove();
          toast(`Couldn't read “${f.name}”. Try picking it again.`, { icon: "triangle-alert" });
        },
      );
    },
    { once: true },
  );
  i.click();
}
