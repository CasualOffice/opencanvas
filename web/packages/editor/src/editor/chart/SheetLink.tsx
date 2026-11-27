// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (frame 8a): keeps a spreadsheet opened as a live view of a database in step with it
// (web/packages/sheet/src/link.ts has the layout). A record or field change made here is written
// into the cells (rows and columns added or removed by the person who made it; on open, by the
// first person present); an edit in a field column is written back to the record. Formulas go
// in the free columns on the right.
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { Database } from "lucide-react";
import type { BlockEnv } from "@opencanvas/ui";
import { loadDatabase, loadSheet } from "../blockdata";
import { linkedSnapshot } from "./place";
import { injectChartCss } from "./styles";

interface Props {
  doc: Y.Doc;
  block: string;
  dbDoc: Y.Doc | null;
  dbId: string;
  env: BlockEnv;
  /** True for one person present (the lowest client id), who repairs structure on open. */
  leader: () => boolean;
}

export function SheetLink({ doc, block, dbDoc, dbId, env, leader }: Props) {
  injectChartCss();
  const [name, setName] = useState<string | null>(null);
  const canEdit = env.role === "edit";
  useEffect(() => {
    if (!dbDoc) return;
    let off = false;
    const cleanup: (() => void)[] = [];
    void Promise.all([loadSheet(), loadDatabase()]).then(([s, d]) => {
      if (off) return;
      const users = [env.me, ...env.users];
      const push = async (structure: boolean) => {
        const snap = await linkedSnapshot(dbDoc, dbId, users);
        if (off || !snap) return;
        setName(snap.name || "Database");
        if (canEdit) s.syncLinked(doc, block, snap, structure);
      };
      void push(leader());
      const dbRoot = dbDoc.getMap("databases");
      const onDb = (_: unknown, tr: Y.Transaction) => {
        if (tr.origin !== s.LINK_ORIGIN) void push(tr.local);
      };
      dbRoot.observeDeep(onDb);
      cleanup.push(() => dbRoot.unobserveDeep(onDb));
      const bm = s.blockMap(doc, block);
      if (!bm || !canEdit) return;
      let warned = false;
      const onSheet = async (_: unknown, tr: Y.Transaction) => {
        if (!tr.local || tr.origin === s.LINK_ORIGIN) return;
        const snap = await linkedSnapshot(dbDoc, dbId, users);
        if (off || !snap) return;
        const out = s.linkedEdits(doc, block, snap);
        for (const w of out.writes) {
          const f = snap.fields.find((x) => x.id === w.field)!;
          d.setCell(dbDoc, dbId, w.row, w.field, d.coerce(w.text, f.type as never, users));
        }
        if (out.refused && !warned) {
          warned = true;
          env.toast("Formulas go in the columns to the right of the database’s fields.");
        }
      };
      bm.observeDeep(onSheet);
      cleanup.push(() => bm.unobserveDeep(onSheet));
    });
    return () => {
      off = true;
      cleanup.forEach((f) => f());
    };
  }, [doc, block, dbDoc, dbId, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="occh-link" role="note">
      <Database size={15} aria-hidden="true" />
      <span>
        Live view of <b>{name ?? "a database"}</b>. Edits in its columns go to the database; add your own columns to the right.
      </span>
    </div>
  );
}
