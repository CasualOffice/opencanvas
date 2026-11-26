// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The editor runs exactly one canvas per page, so editor plugins (slash menu,
// node views, click handlers) reach app-level services through this singleton
// instead of threading props through ProseMirror.
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { BlockEnv } from "@opencanvas/ui";
import { createContext, useContext } from "react";
import type { Session } from "./session";

export interface Uploaded {
  url: string;
  mime: string;
  size: number;
  name: string;
}

export interface Bridge {
  doc: Y.Doc;
  awareness: Awareness;
  env: BlockEnv;
  session: Session;
  /** Opens the CSV import dialog and calls back with the CSV text. */
  importCsv(onCsv: (csv: string) => void): void;
  /** Asks for a URL (link preview / embed). */
  promptUrl(kind: "bookmark" | "embed", onUrl: (url: string) => void): void;
  /** Opens a native file picker. */
  pickFile(accept: string, onFile: (f: File) => void): void;
  /** Uploads through `POST /v1/assets?ticket=`; `onProgress` gets 0..1. */
  upload(f: File, onProgress?: (p: number) => void): Promise<Uploaded>;
  openThread(threadId: string): void;
  /** Tell the host page about a link click (it decides navigation). */
  linkClick(url: string): void;
}

export const bridge = {} as Bridge;

export function setBridge(b: Bridge) {
  Object.assign(bridge, b);
}

/** The Y.Doc an editor edits: a live block's own editor edits the live file's document, not
 *  the canvas's, so new databases and boards go there (LIVE-03). */
export function docOf(editor: { extensionManager?: { extensions: readonly { name: string; options: unknown }[] } } | null | undefined): Y.Doc {
  const ext = editor?.extensionManager?.extensions.find((x) => x.name === "collaboration");
  return (ext?.options as { document?: Y.Doc } | undefined)?.document ?? bridge.doc;
}

/** React context for node views (they render inside EditorContent's tree). */
export const BridgeCtx = createContext<Bridge | null>(null);
export function useBridge(): Bridge {
  return useContext(BridgeCtx) ?? bridge;
}
