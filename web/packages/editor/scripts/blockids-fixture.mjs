// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Writes the shared VH-00 fixture `crates/oc-model/tests/fixtures/blockids.ydoc.bin`: a Yjs v1
// update with block ids as the web editor stores them (y-prosemirror XmlElement attributes).
// Read by src/editor/blockId.test.ts and crates/oc-model/tests/roundtrip.rs.
// Usage: node scripts/blockids-fixture.mjs
import * as Y from "yjs";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../../../../crates/oc-model/tests/fixtures/blockids.ydoc.bin", import.meta.url));
const doc = new Y.Doc();
doc.clientID = 1;
const el = (type, attrs, kids) => {
  const e = new Y.XmlElement(type);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.insert(0, kids);
  return e;
};
const t = (s) => new Y.XmlText(s);
doc.getXmlFragment("content").insert(0, [
  el("heading", { level: 1, blockId: "b_0000000000000000000000000a" }, [t("Plan")]),
  el("paragraph", { blockId: "b_0000000000000000000000000b" }, [t("Hello world")]),
  el("bulletList", { blockId: "b_0000000000000000000000000c" }, [
    el("listItem", { blockId: "b_0000000000000000000000000d" }, [el("paragraph", { blockId: "b_0000000000000000000000000e" }, [t("item")])]),
  ]),
]);
doc.getMap("meta").set("title", "Plan");
writeFileSync(out, Y.encodeStateAsUpdate(doc));
console.log("wrote", out);
