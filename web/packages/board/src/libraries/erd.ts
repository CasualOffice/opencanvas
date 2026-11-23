// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Entity relationship (DGM-14.7): Chen notation shapes, a table with rows, and crow's-foot and
// Chen connector presets. Drawn by us.
import { at, G, join, type LibraryData } from "./geo";

const { R, E, P, L } = G;
const tbl = at(200, 150);

export const ERD: LibraryData = {
  id: "erd",
  name: "Entity relationship",
  icon: "table",
  items: [
    { name: "entity", label: "Entity", base: "rect", keywords: ["table", "strong entity", "thing", "record", "er"], look: { path: R(0, 0, 100, 100), w: 140, h: 70, text: "Entity" } },
    { name: "weak-entity", label: "Weak entity", base: "rect", keywords: ["dependent", "double rectangle", "er"], look: { path: join(R(0, 0, 100, 100), R(5, 9, 90, 82)), w: 140, h: 70, text: "Weak entity", box: [5, 9, 90, 82] } },
    { name: "table", label: "Table", base: "rect", keywords: ["sql", "schema", "columns", "rows", "db", "database table", "relation"], look: { path: join(R(0, 0, 100, 100), tbl.L(0, 30, 200, 30), tbl.L(0, 60, 200, 60), tbl.L(0, 90, 200, 90), tbl.L(0, 120, 200, 120), tbl.L(36, 30, 36, 150)), w: 200, h: 150, text: "table_name", box: tbl.box(0, 0, 200, 30) } },
    { name: "attribute", label: "Attribute", base: "ellipse", keywords: ["field", "column", "property", "oval"], look: { w: 120, h: 60, text: "attribute" } },
    { name: "key-attribute", label: "Key attribute", base: "ellipse", keywords: ["primary key", "pk", "identifier", "underline", "id"], look: { path: join(E(50, 50, 50), L(24, 70, 76, 70)), w: 120, h: 60, text: "id", box: [10, 20, 80, 46] } },
    { name: "multivalued", label: "Multivalued attribute", base: "ellipse", keywords: ["multi", "list", "double ellipse", "array"], look: { path: join(E(50, 50, 50), E(50, 50, 44, 38)), w: 130, h: 64, text: "values" } },
    { name: "derived", label: "Derived attribute", base: "ellipse", keywords: ["computed", "calculated", "dashed", "derived"], look: { path: G.DE(50, 50, 50, 50, 18), w: 120, h: 60, text: "age" } },
    { name: "relationship", label: "Relationship", base: "diamond", keywords: ["relation", "association", "verb", "link"], look: { w: 130, h: 80, text: "has" } },
    { name: "identifying", label: "Identifying relationship", base: "diamond", keywords: ["weak relationship", "double diamond", "identifying"], look: { path: join(P(50, 0, 100, 50, 50, 100, 0, 50), P(50, 12, 88, 50, 50, 88, 12, 50)), w: 130, h: 80, text: "owns", box: [24, 24, 52, 52] } },
    { name: "associative", label: "Associative entity", base: "rect", keywords: ["junction", "link table", "bridge", "many to many"], look: { path: join(R(0, 0, 100, 100), P(50, 6, 96, 50, 50, 94, 4, 50)), w: 150, h: 80, text: "Enrolment", box: [24, 20, 52, 60] } },
  ],
  connectors: [
    { id: "one-to-one", label: "One to one", keywords: ["1:1", "crow's foot", "one"], route: "elbow", ends: ["one", "one"] },
    { id: "one-to-many", label: "One to many", keywords: ["1:n", "1:m", "crow's foot", "many"], route: "elbow", ends: ["one", "many"] },
    { id: "many-to-many", label: "Many to many", keywords: ["n:m", "m:n", "crow's foot"], route: "elbow", ends: ["many", "many"] },
    { id: "zero-or-one", label: "Zero or one", keywords: ["optional", "0..1", "crow's foot"], route: "elbow", ends: ["one", "zero-or-one"] },
    { id: "zero-or-many", label: "Zero or many", keywords: ["optional", "0..n", "crow's foot"], route: "elbow", ends: ["one", "zero-or-many"] },
    { id: "one-or-many", label: "One or many", keywords: ["mandatory", "1..n", "crow's foot"], route: "elbow", ends: ["one", "one-or-many"] },
    { id: "chen", label: "Chen line", keywords: ["chen", "participation", "partial"], route: "straight", ends: ["none", "none"] },
    { id: "chen-total", label: "Chen total participation", keywords: ["chen", "double line", "total"], route: "straight", ends: ["none", "double"] },
  ],
};
