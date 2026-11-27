// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (4h, 8a): BlockEnv.sheetActions and dbActions for editors. Tiny on purpose (it is in
// the editor's initial JS); the work lives in ./place, loaded when an entry is used.
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import type { BlockEnv, OcUser } from "@opencanvas/ui";

const place = () => import("./place");

export function blockActions(editor: Editor, doc: Y.Doc, dbDoc: (id: string) => Y.Doc, users: () => OcUser[], fail: (m: string) => void): Pick<BlockEnv, "sheetActions" | "dbActions"> {
  const run = (f: (m: typeof import("./place")) => unknown) => void place().then(f).catch(() => fail("That block couldn't load. Check your connection and try again."));
  return {
    sheetActions: {
      chart: (r) => run((m) => m.chartFromRange(editor, r)),
      toDatabase: (r, values, name) => run((m) => m.rangeToDatabase(editor, doc, r, values, name)),
    },
    dbActions: {
      chart: (id) => run((m) => m.chartFromDb(editor, id)),
      openAsSheet: (id, mode) => run((m) => m.openAsSheet(editor, dbDoc(id), doc, id, mode, users())),
    },
  };
}
