// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// BRD-17 (D11): what the diagram header folds away as the diagram window narrows (decision 8 of
// docs/prototypes/board-ux-approved/board-ux.html). Measured on the diagram window, not the screen,
// so a side panel or a narrow embed behaves like a small window. Under 30 em the phone header
// (phone/Phone.tsx) takes over.
//   wide    ≥ 64 em  everything
//   mid     ≥ 48 em  Commands loses its label and ⌘K chip
//   narrow  ≥ 36 em  also: the document crumb and the Back label go; Outline and Auto-layout into ⋯
//   tiny    < 36 em  also: Commands and Redo into ⋯
export type Fold = "wide" | "mid" | "narrow" | "tiny";

export function headerFold(em: number): Fold {
  if (!(em > 0) || em >= 64) return "wide";
  if (em >= 48) return "mid";
  if (em >= 36) return "narrow";
  return "tiny";
}

/** The header controls ⋯ holds at this step, in menu order. */
export function foldedNames(f: Fold): ("Commands" | "Outline" | "Auto-layout" | "Redo")[] {
  if (f === "tiny") return ["Commands", "Outline", "Auto-layout", "Redo"];
  if (f === "narrow") return ["Outline", "Auto-layout"];
  return [];
}

/** A header control moved into the board options menu. */
export interface FoldItem {
  label: string;
  kbd?: string;
  disabled?: boolean;
  run: () => void;
}
