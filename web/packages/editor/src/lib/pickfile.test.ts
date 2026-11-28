// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// RLB-04-F7: WebKit uploaded a picked PDF with 0 bytes. The picker's <input> was never in the
// document and the File stayed a lazy, path-backed handle read only at upload time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickFile } from "./pickfile";

function pickWith(file: File | null) {
  let input: HTMLInputElement | null = null;
  let connectedAtClick = false;
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    input = this;
    connectedAtClick = this.isConnected;
  });
  const got = new Promise<File>((resolve) => pickFile("*/*", resolve));
  const choose = () => {
    Object.defineProperty(input!, "files", { value: file ? [file] : [], configurable: true });
    input!.dispatchEvent(new Event("change"));
  };
  return { got, choose, input: () => input!, connectedAtClick: () => connectedAtClick };
}

describe("pickFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("keeps its input in the document while the picker is open, and removes it after", async () => {
    const p = pickWith(new File(["%PDF-1.4 abc"], "a.pdf", { type: "application/pdf" }));
    expect(p.connectedAtClick(), "the input is in the document when the picker opens").toBe(true);
    p.choose();
    await p.got;
    expect(p.input().isConnected).toBe(false);
  });

  it("hands over a copy whose bytes were read at pick time", async () => {
    const original = new File(["%PDF-1.4 abc"], "a.pdf", { type: "application/pdf", lastModified: 5 });
    const read = vi.spyOn(original, "arrayBuffer");
    const p = pickWith(original);
    p.choose();
    const f = await p.got;
    expect(read).toHaveBeenCalled();
    expect(f).not.toBe(original);
    expect([f.name, f.type, f.size, f.lastModified]).toEqual(["a.pdf", "application/pdf", 12, 5]);
    expect(await f.text()).toBe("%PDF-1.4 abc");
  });

  it("drops a leftover picker that was cancelled", () => {
    pickWith(null);
    vi.restoreAllMocks();
    pickWith(null);
    expect(document.querySelectorAll("input[type=file]").length).toBe(1);
  });
});
