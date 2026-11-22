// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Images on the board: where the bytes go, and how big the shape starts.

/** Largest image stored inline as a data: URL when the host gives no `env.upload`. */
export const MAX_INLINE_IMAGE = 2 * 1024 * 1024;

export class ImageError extends Error {}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error ?? new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

/**
 * URL for an image file: the host's upload when there is one, else an inline data: URL
 * (≤ 2 MB). Throws `ImageError` with a user-facing message otherwise.
 */
export async function imageSource(file: File, upload?: (file: File) => Promise<{ url: string }>): Promise<string> {
  if (!file.type.startsWith("image/")) throw new ImageError("Only images can be dropped on a board");
  if (upload) {
    try {
      const { url } = await upload(file);
      if (url) return url;
    } catch {
      throw new ImageError(`Couldn't upload ${file.name || "the image"}`);
    }
    throw new ImageError(`Couldn't upload ${file.name || "the image"}`);
  }
  if (file.size > MAX_INLINE_IMAGE) throw new ImageError("Images over 2 MB need an upload-enabled host");
  return readAsDataUrl(file);
}

/** Natural size of an image URL; `fallback` when it can't be decoded (or outside a browser). */
export function imageSize(src: string, fallback: [number, number] = [320, 240]): Promise<[number, number]> {
  if (typeof Image === "undefined") return Promise.resolve(fallback);
  return new Promise((res) => {
    const img = new Image();
    const t = setTimeout(() => res(fallback), 4000);
    img.onload = () => {
      clearTimeout(t);
      res(img.naturalWidth && img.naturalHeight ? [img.naturalWidth, img.naturalHeight] : fallback);
    };
    img.onerror = () => {
      clearTimeout(t);
      res(fallback);
    };
    img.src = src;
  });
}

/** Scale (w, h) to fit inside `max` × `max`, never enlarging, keeping a 40px minimum side. */
export function fitImage(w: number, h: number, max = 360): [number, number] {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return [Math.max(40, Math.round(w * k)), Math.max(40, Math.round(h * k))];
}

/** Image files in a DataTransfer (drop or paste). */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files?.length) for (const f of Array.from(dt.files)) if (f.type.startsWith("image/")) out.push(f);
  if (!out.length && dt.items)
    for (const it of Array.from(dt.items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  return out;
}
