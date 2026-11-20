// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv, Role } from "@opencanvas/ui";
import { CsvImportDialog, DatabaseBlock } from "./index";
import { createDatabase, setCell, setView } from "./model";
import { DB_PRESETS } from "./presets";
import { VIEW_KINDS } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts: string[] = [];
const env = (role: Role = "edit", compact = false): BlockEnv => ({
  role,
  compact,
  me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" },
  users: [{ id: "asha", name: "Asha Rao", color: "#7a45f0" }, { id: "ravi", name: "Ravi Menon", color: "#e5602a" }, { id: "lin", name: "Lin Zhou", color: "#0e9a78" }],
  toast: (m) => void toasts.push(m),
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanup = () => act(() => root.unmount());
  return el;
}

describe("DatabaseBlock render", () => {
  it.each(DB_PRESETS.flatMap((p) => VIEW_KINDS.map((v) => [p, v] as const)))("%s in %s view", (p, v) => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, p);
    setView(doc, id, v);
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env("edit", v === "calendar" && p === "content")} />);
    expect(el.querySelector(".ocdb")).toBeTruthy();
    expect(document.head.querySelector("style[data-ocdb]")).toBeTruthy();
  });

  it("re-renders on remote Yjs changes", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const rid = [...(remote.getMap("databases").get(id) as Y.Map<Y.Map<unknown>>).get("order") as unknown as Y.Array<string>].at(0)!;
    setCell(remote, id, rid, "title", "Edited remotely");
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote)));
    const inputs = [...el.querySelectorAll<HTMLInputElement>("input.ocdb-ce")].map((i) => i.value);
    expect(inputs).toContain("Edited remotely");
  });

  it("is read-only for viewers", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env("view")} />);
    expect(el.querySelector(".ocdb-newrow")).toBeNull();
    expect(el.querySelector(".ocdb-addcol")).toBeNull();
    const before = Y.encodeStateVector(doc);
    // switching view as a viewer must not write to the doc
    act(() => (el.querySelectorAll<HTMLButtonElement>(".ocdb-tab")[1]).click());
    expect(el.querySelector(".ocdb-kan")).toBeTruthy();
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it("adds a row from the table", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "blank");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    act(() => el.querySelector<HTMLButtonElement>(".ocdb-newrow")!.click());
    expect(el.querySelectorAll("tbody tr")).toHaveLength(4);
  });

  it("opens a status editor and sets a value", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "kanban");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    act(() => setView(doc, id, "table"));
    const cell = el.querySelector<HTMLButtonElement>("tbody tr button.ocdb-cin")!;
    act(() => cell.click());
    const opts = [...document.querySelectorAll<HTMLButtonElement>(".ocdb-pop .ocdb-mi")];
    const review = opts.find((b) => b.textContent?.includes("Review"))!;
    act(() => review.click());
    const m = (doc.getMap("databases").get(id) as Y.Map<unknown>).get("rows") as Y.Map<Y.Map<unknown>>;
    const firstId = ((doc.getMap("databases").get(id) as Y.Map<unknown>).get("order") as Y.Array<string>).get(0);
    expect(m.get(firstId)!.get("status")).toBe("Review");
  });

  it("CsvImportDialog previews detected types", () => {
    let got = "";
    mount(<CsvImportDialog open env={env()} onClose={() => {}} onImport={(c) => (got = c)} />);
    const ta = document.querySelector<HTMLTextAreaElement>(".ocdb-modal textarea")!;
    expect(ta).toBeTruthy();
    const sample = [...document.querySelectorAll<HTMLButtonElement>(".ocdb-modal button")].find((b) => b.textContent === "Use sample data")!;
    act(() => sample.click());
    const ths = [...document.querySelectorAll(".ocdb-prev th small")].map((x) => x.textContent);
    expect(ths).toEqual(["Title", "Status", "Person", "Number", "Date", "Text"]);
    const imp = [...document.querySelectorAll<HTMLButtonElement>(".ocdb-modal button")].find((b) => b.textContent?.startsWith("Import"))!;
    act(() => imp.click());
    expect(got).toContain("Per-channel autosave");
  });
});
