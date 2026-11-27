// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Spreadsheet rules ported from OpenCalc (https://github.com/CasualOffice/opencalc, Apache-2.0,
// revision 88a2522), adapted to the block's grid (indexes into the current row and column
// order). Sources:
//   crates/casual-calc-wasm/src/find.rs        Pattern: Excel's Find and Replace matcher
//   crates/casual-calc-wasm/src/style.rs       border_edges: which edges a border placement sets
//   crates/casual-calc-wasm/src/structural.rs  merge_hits; merging drops the merges it overlaps
//                                               and clears covered values but keeps their style

import type { Rect } from "./logic";

type Tok = { k: "lit"; ch: string } | { k: "one" } | { k: "run" };

/** Splits text into characters, lowercased one original character at a time when case does not
 *  matter, with each folded character's origin index (find.rs `fold`). */
function fold(text: string, matchCase: boolean): { chars: string[]; origin: number[] } {
  const chars: string[] = [];
  const origin: number[] = [];
  [...text].forEach((ch, i) => {
    if (matchCase) (chars.push(ch), origin.push(i));
    else for (const lc of ch.toLowerCase()) (chars.push(lc), origin.push(i));
  });
  return { chars, origin };
}

/**
 * A compiled Find query (find.rs `Pattern`). `?` is one character, `*` any run, `~` makes the
 * next `* ? ~` literal; an empty query matches nothing. Matching is a position-set simulation,
 * O(text × pattern) whatever the query.
 */
export class Pattern {
  private toks: Tok[] = [];
  constructor(
    query: string,
    private matchCase = false,
    wildcards = true,
  ) {
    const lit = (ch: string) => {
      if (matchCase) this.toks.push({ k: "lit", ch });
      else for (const lc of ch.toLowerCase()) this.toks.push({ k: "lit", ch: lc });
    };
    const q = [...query];
    for (let i = 0; i < q.length; i++) {
      const ch = q[i];
      if (!wildcards) lit(ch);
      else if (ch === "?") this.toks.push({ k: "one" });
      else if (ch === "*") {
        if (this.toks[this.toks.length - 1]?.k !== "run") this.toks.push({ k: "run" });
      } else if (ch === "~" && (q[i + 1] === "*" || q[i + 1] === "?" || q[i + 1] === "~")) lit(q[++i]);
      else lit(ch);
    }
  }
  get empty() {
    return this.toks.length === 0;
  }
  private close(st: (number | null)[]) {
    for (let k = 0; k < this.toks.length; k++) {
      const s = st[k];
      if (this.toks[k].k === "run" && s != null && (st[k + 1] == null || s < st[k + 1]!)) st[k + 1] = s;
    }
  }
  private step(st: (number | null)[], ch: string): (number | null)[] {
    const next: (number | null)[] = new Array(st.length).fill(null);
    const put = (k: number, s: number) => {
      if (next[k] == null || s < next[k]!) next[k] = s;
    };
    this.toks.forEach((t, k) => {
      const s = st[k];
      if (s == null) return;
      if (t.k === "lit") {
        if (t.ch === ch) put(k + 1, s);
      } else if (t.k === "one") put(k + 1, s);
      else put(k, s);
    });
    return next;
  }
  /** "Match entire cell contents"; an empty cell is never a hit. */
  matchesWhole(text: string): boolean {
    if (this.empty || !text) return false;
    let st: (number | null)[] = new Array(this.toks.length + 1).fill(null);
    st[0] = 0;
    this.close(st);
    for (const ch of fold(text, this.matchCase).chars) {
      st = this.step(st, ch);
      if (st.every((x) => x == null)) return false;
      this.close(st);
    }
    return st[this.toks.length] != null;
  }
  /** The leftmost, then longest, match in `text` from `from`, as [start, end). */
  private span(text: string[], from: number): [number, number] | null {
    if (this.empty) return null;
    const m = this.toks.length;
    let st: (number | null)[] = new Array(m + 1).fill(null);
    let best: [number, number] | null = null;
    for (let i = from; ; i++) {
      if (!best && (st[0] == null || st[0] > i)) st[0] = i;
      this.close(st);
      const s = st[m];
      if (s != null && (!best || s < best[0] || (s === best[0] && i > best[1]))) best = [s, i];
      if (best) {
        const bs = best[0];
        st = st.map((x) => (x != null && x > bs ? null : x));
        if (st.every((x) => x == null)) break;
      }
      if (i >= text.length) break;
      st = this.step(st, text[i]);
    }
    return best;
  }
  hits(text: string, wholeCell: boolean): boolean {
    if (wholeCell) return this.matchesWhole(text);
    return !!text && this.span(fold(text, this.matchCase).chars, 0) != null;
  }
  /** `text` with every match replaced (or the whole of it under `wholeCell`); null when nothing
   *  matched, so a caller never writes a cell it did not change. */
  replace(text: string, by: string, wholeCell: boolean): string | null {
    if (wholeCell) return this.matchesWhole(text) ? by : null;
    if (!text) return null;
    const f = fold(text, this.matchCase);
    const orig = [...text];
    let out = "";
    let pos = 0;
    let emitted = 0;
    let any = false;
    while (pos < f.chars.length) {
      const sp = this.span(f.chars, pos);
      if (!sp) break;
      const [s, e] = sp;
      any = true;
      const so = f.origin[s] ?? orig.length;
      if (so > emitted) out += orig.slice(emitted, so).join("");
      out += by;
      if (e === s) {
        emitted = orig.length;
        break;
      }
      emitted = Math.max(emitted, f.origin[e - 1] + 1);
      pos = e;
    }
    if (!any) return null;
    if (emitted < orig.length) out += orig.slice(emitted).join("");
    return out;
  }
}

export type BorderKind = "all" | "outer" | "inner" | "top" | "bottom" | "left" | "right" | "topandbottom" | "bottomthick" | "none";

/** Which edges `[top, bottom, left, right]` of cell (r, c) a placement sets inside `q`
 *  (style.rs `border_edges`). `none` clears every edge of every cell. */
export function borderEdges(kind: BorderKind, r: number, c: number, q: Rect): [boolean, boolean, boolean, boolean] {
  switch (kind) {
    case "all":
      return [true, true, true, true];
    case "outer":
      return [r === q.r0, r === q.r1, c === q.c0, c === q.c1];
    case "inner":
      return [r > q.r0, r < q.r1, c > q.c0, c < q.c1];
    case "top":
      return [r === q.r0, false, false, false];
    case "bottom":
    case "bottomthick":
      return [false, r === q.r1, false, false];
    case "left":
      return [false, false, c === q.c0, false];
    case "right":
      return [false, false, false, c === q.c1];
    case "topandbottom":
      return [r === q.r0, r === q.r1, false, false];
    default:
      return [false, false, false, false];
  }
}

/** Whether merge `m` intersects `q` (structural.rs `merge_hits`). */
export const mergeHits = (m: Rect, q: Rect) => !(m.r1 < q.r0 || m.r0 > q.r1 || m.c1 < q.c0 || m.c0 > q.c1);
