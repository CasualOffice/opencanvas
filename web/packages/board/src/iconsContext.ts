// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Icons added to the document (DGM-17 part 3), shared by the canvas, the shapes panel and the
// icon dialogs of one board: the server-written `icons` root, read live, and what can be done.
import { createContext, useContext, useEffect, useState } from "react";
import type * as Y from "yjs";
import type { IconApi } from "@opencanvas/ui";
import { docIconUrl, readDocIcons, type DocIcon } from "./icons";

export interface DocIconsCtx {
  list: DocIcon[];
  /** `data:` URL by icon id. */
  urls: ReadonlyMap<string, string>;
  /** The server API; absent without a server (Add your own icon is disabled). */
  api?: IconApi;
  /** Editors can add, place and manage icons. */
  edit: boolean;
  /** Places a document icon in the middle of the view. */
  place?: (id: string) => void;
  /** Opens Add icon (optionally with a file already chosen, 2e). */
  openAdd?: (file?: File) => void;
  /** Opens Icons in this document (3b). */
  openManage?: () => void;
}

const EMPTY: DocIconsCtx = { list: [], urls: new Map(), edit: false };
export const DocIconsContext = createContext<DocIconsCtx>(EMPTY);
export const useDocIcons = () => useContext(DocIconsContext);

/** The document's icons, kept up to date. */
export function useDocIconList(doc: Y.Doc): { list: DocIcon[]; urls: Map<string, string> } {
  const read = () => {
    const list = readDocIcons(doc);
    const urls = new Map<string, string>();
    for (const i of list) {
      const u = docIconUrl(i);
      if (u) urls.set(i.id, u);
    }
    return { list, urls };
  };
  const [v, setV] = useState(read);
  useEffect(() => {
    const m = doc.getMap("icons");
    const on = () => setV(read());
    m.observeDeep(on);
    on();
    return () => m.unobserveDeep(on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);
  return v;
}
