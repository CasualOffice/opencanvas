// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// VH-01d: the history panel's states against the approved frames: 1b (list, footer "Kept by"),
// the owner's footer addition ("Kept in this file"), 7a (viewer: no Name, no Restore), 8a/8b/8c
// (no history: plain message, link to the host's page, temporary wording) and 6b's toast text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import * as Y from "yjs";
import type { Session } from "../lib/session";
import { temporaryWording } from "../lib/wording";
import { restoredText } from "../lib/restored";
import { ShellCtx } from "../components/overlay";
import HistoryRoot, { namesOf, type HistoryProps } from "./root";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (h: number, m: number) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), h, m).toISOString();
const session = (o: Partial<Session> = {}): Session =>
  ({
    ticket: "t1",
    room: "r",
    role: "edit",
    user: { id: "u_priya", name: "Priya Raman", color: "#7a45f0", avatar: null },
    file: { id: "f", name: "Sprint" },
    host: { id: "acme", name: "Acme Docs" },
    perms: { history: true, restore: true, commitMessage: true },
    isNew: false,
    wsUrl: "",
    history: "full",
    historySource: "host",
    historyHostName: "Acme Docs",
    ...o,
  }) as Session;

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

function list(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

async function render(o: Partial<HistoryProps> & { session: Session }) {
  const props: HistoryProps = {
    bridge: {} as HistoryProps["bridge"],
    liveDoc: new Y.Doc(),
    me: { id: "u_priya", name: "Priya Raman", color: "#7a45f0" },
    peers: [],
    person: (id) => ({ id, name: { u_lea: "Lea Fischer", u_jonas: "Jonas Weber", u_priya: "Priya Raman" }[id] ?? id, color: "#2a5ad7" }),
    compact: false,
    role: "edit",
    temporary: false,
    words: temporaryWording("meeting"),
    tick: 0,
    nameReq: 0,
    onClose: () => undefined,
    onPreview: () => undefined,
    onDownload: () => undefined,
    ...o,
  };
  await act(async () => {
    root.render(createElement(ShellCtx.Provider, { value: { root: el, compact: false } }, createElement(HistoryRoot, props)));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return el;
}

const VERSIONS = [
  { version: "9", at: at(10, 47), kind: "auto", authors: ["u_lea", "u_jonas"] },
  { version: "8", at: at(10, 31), kind: "auto", authors: ["u_lea"] },
  { version: "7", at: at(10, 2), kind: "auto", authors: ["u_jonas"] },
  { version: "5", at: at(9, 30), kind: "named", name: "Capacity agreed", authors: ["u_priya"] },
];

describe("history panel", () => {
  it("1b: lists the current version, a folded session and a named version, with the host's footer", async () => {
    list({ source: "host", hostName: "Acme Docs", versions: VERSIONS });
    const p = await render({ session: session(), peers: [{ clientId: 2, id: "u_jonas", name: "Jonas Weber", color: "#000", role: "edit", typing: false, me: false, hasCursor: true }] });
    const text = p.textContent ?? "";
    expect(text).toContain("Current version");
    expect(text).toContain("Jonas is editing");
    expect(text).toContain("10:02 – 10:47");
    expect(text).toContain("Edited by Lea Fischer, Jonas Weber");
    expect(text).toContain("3 saves");
    expect(text).toContain("Capacity agreed");
    expect(text).toContain("09:30 · Priya Raman");
    expect(p.querySelector(".vh-pfoot")?.textContent).toBe("Kept by Acme Docs. Older automatic saves may be thinned by Acme Docs.");
    expect([...p.querySelectorAll("button")].some((b) => b.textContent === "Name this version")).toBe(true);
  });

  it("owner addition: says “Kept in this file” for in-file history", async () => {
    list({ source: "file", hostName: "Acme Docs", versions: VERSIONS });
    const p = await render({ session: session({ historySource: "file" }) });
    expect(p.querySelector(".vh-pfoot b")?.textContent).toBe("Kept in this file.");
  });

  it("7a: a viewer browses only (no Name this version) and the footer says who can restore", async () => {
    list({ source: "host", hostName: "Acme Docs", versions: VERSIONS });
    const p = await render({ session: session({ role: "view", perms: { history: true } }), role: "view" });
    expect([...p.querySelectorAll("button")].some((b) => /^Name( this version)?$/.test(b.textContent ?? ""))).toBe(false);
    expect(p.querySelector(".vh-pfoot")?.textContent).toContain("You can view this canvas. People who can edit can name and restore versions.");
  });

  it("8a: a host without history gets one plain sentence", async () => {
    list({});
    const p = await render({ session: session({ history: "none" }) });
    expect(p.querySelector(".vh-empty h3")?.textContent).toBe("Version history isn’t available here");
    expect(p.querySelector(".vh-empty p")?.textContent).toBe("Acme Docs keeps this canvas. If it keeps earlier versions, you’ll find them there.");
  });

  it("8b: a host with its own version page gets a link out", async () => {
    list({});
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const p = await render({ session: session({ history: "link", historyUrl: "https://cloud.example/versions/f", host: { id: "nc", name: "Nextcloud" }, historyHostName: "Nextcloud" }) });
    expect(p.querySelector(".vh-empty h3")?.textContent).toBe("Nextcloud keeps the versions");
    const btn = [...p.querySelectorAll("button")].find((b) => b.textContent === "Open Versions in Nextcloud")!;
    act(() => btn.click());
    expect(open).toHaveBeenCalledWith("https://cloud.example/versions/f", "_blank", "noopener,noreferrer");
  });

  it("8c: a temporary canvas uses the host's temporary wording (ADR-049) and offers a download", async () => {
    list({});
    const dl = vi.fn();
    const p = await render({ session: session({ storage: "ephemeral" }), temporary: true, words: temporaryWording("room"), onDownload: dl });
    expect(p.querySelector(".vh-empty h3")?.textContent).toBe("This canvas is temporary");
    expect(p.querySelector(".vh-empty p")?.textContent).toBe(temporaryWording("room").historySub);
    act(() => [...p.querySelectorAll("button")].find((b) => b.textContent === "Download a copy")!.click());
    expect(dl).toHaveBeenCalled();
  });
});

describe("messages", () => {
  it("6b: tells the others who restored what, and where earlier edits are", () => {
    expect(restoredText({ byName: "Priya Raman", name: "Restored from Nov 23, 15:58" })).toBe("Priya restored the version from Nov 23, 15:58. Earlier edits are in Version history.");
    expect(restoredText({ byName: "Priya Raman", name: "Restored from “Board review”" })).toBe("Priya restored “Board review”. Earlier edits are in Version history.");
  });
  it("names the people editing", () => {
    expect(namesOf(["Jonas"])).toBe("Jonas");
    expect(namesOf(["Jonas", "Lea"])).toBe("Jonas and Lea");
    expect(namesOf(["Jonas", "Lea", "Sam", "Ana", "Bo"])).toBe("Jonas, Lea and 3 others");
  });
});
