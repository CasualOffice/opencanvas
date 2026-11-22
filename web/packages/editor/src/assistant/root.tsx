// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Lazy entry: picks the transport (the server, or the `#demo` script) and mounts the assistant UI.
import { useMemo } from "react";
import type { Editor } from "@tiptap/react";
import type { OcUser, Role } from "@opencanvas/ui";
import type { Collab } from "../lib/session";
import Assistant from "./Assistant";
import { demoTransport } from "./demo";
import { serverTransport } from "./transport";

export default function AssistantRoot(p: { editor: Editor; collab: Collab; demo: boolean; me: OcUser; people: () => OcUser[]; role: Role; compact: boolean; hostName: string }) {
  const { collab, demo, me, people } = p;
  const transport = useMemo(
    () => (demo ? demoTransport({ doc: collab.doc, awareness: collab.awareness, me, people }) : serverTransport(collab)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collab, demo],
  );
  return <Assistant editor={p.editor} doc={collab.doc} awareness={collab.awareness} transport={transport} role={p.role} compact={p.compact} hostName={p.hostName} />;
}
