// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The board projection as shipped in v0.1.1 (`useShapes` in BoardBlock.tsx before DGM-05),
// kept verbatim so the "before" numbers stay reproducible after the change.
import * as Y from "yjs";
import { getBoardMap, readShapes, type Shape } from "../src/model";

export class LegacyProjection {
  private ver = 0;
  private at = -1;
  private val: Shape[] | null = null;
  private byId = new Map<string, { j: string; s: Shape }>();
  private inner: Y.Map<unknown> | null;
  private readonly bump = () => {
    this.ver++;
  };

  constructor(
    private doc: Y.Doc,
    private boardId: string,
  ) {
    this.inner = getBoardMap(doc, boardId);
    this.inner?.observeDeep(this.bump);
  }

  destroy() {
    this.inner?.unobserveDeep(this.bump);
  }

  get(): Shape[] | null {
    if (this.at !== this.ver) {
      const m = getBoardMap(this.doc, this.boardId);
      const list = m ? readShapes(m) : null;
      if (list) {
        const next = new Map<string, { j: string; s: Shape }>();
        this.val = list.map((s) => {
          const j = JSON.stringify(s);
          const old = this.byId.get(s.id);
          const keep = old && old.j === j ? old.s : s;
          next.set(s.id, { j, s: keep });
          return keep;
        });
        this.byId = next;
      } else this.val = null;
      this.at = this.ver;
    }
    return this.val;
  }
}
