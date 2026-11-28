// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The export background, remembered per person on this device (BRD-20: default Light).
export type ExportBg = "transparent" | "light" | "dark";
const KEY = "oc.board.exportBg";

export function readExportBg(): ExportBg {
  try {
    const v = localStorage.getItem(KEY);
    return v === "transparent" || v === "dark" || v === "light" ? v : "light";
  } catch {
    return "light";
  }
}
export function writeExportBg(v: ExportBg) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private mode: not remembered */
  }
}
