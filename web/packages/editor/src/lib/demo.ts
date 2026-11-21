// `#demo`: a local Y.Doc seeded with the prototype's "Sprint 42 planning"
// canvas and simulated collaborators, so the UI can be reviewed without a
// server. Nothing here runs in a real session.
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { OcUser, Role } from "@opencanvas/ui";
import { BOARD, CALL, CODE, COLS, DB, EMBED, FILE, H2, IMG, LINK, P, TOG, buildDoc, type TB } from "../editor/content";
import { addMessage, commentsRoot, createThread } from "./comments";
import { setMeta } from "./meta";
import type { Collab, Control, ConnState, Session } from "./session";
import { localCollab } from "./session";

export const DEMO_USERS: Record<string, OcUser & { role: Role }> = {
  me: { id: "u_priya", name: "Priya Shah", color: "#2a5ad7", role: "edit" },
  asha: { id: "u_asha", name: "Asha Rao", color: "#7a45f0", role: "edit" },
  ravi: { id: "u_ravi", name: "Ravi Menon", color: "#e5602a", role: "edit" },
  lin: { id: "u_lin", name: "Lin Zhou", color: "#0e9a78", role: "edit" },
  sam: { id: "u_sam", name: "Sam Ortiz", color: "#d63f78", role: "view" },
};

const LIN_TEXT = "Viewers get a fast HTML preview with no WebSocket, so a link in chat opens in under a second.";

export function demoSession(role: Role): Session {
  const me = DEMO_USERS.me;
  return {
    ticket: "demo",
    room: "demo",
    role,
    user: { id: me.id, name: me.name, color: me.color, avatar: null },
    file: { id: "demo", name: "Sprint 42 planning" },
    host: { id: "acme", name: "Acme" },
    perms: { export: true, download: true, comment: true },
    isNew: false,
    wsUrl: "",
    demo: true,
  };
}

function demoBlocks(): TB[] {
  return [
    CALL("blue", "target", "<b>Sprint goal:</b> ship the embed SDK beta to two internal hosts, a meeting app and a chat app, by Dec 12."),
    H2("Decisions"),
    P('The file stays in the host. We save on idle and when the last person leaves. <c id="t_demo1">Autosave runs every 60 seconds by default</c> and hosts can change it per tenant.'),
    P(""),
    H2("Backlog"),
    DB("tasks"),
    H2("How a session flows"),
    BOARD("flow"),
    H2("Notes"),
    COLS({ h: "Host app owns", items: ["Users and sign-in", "Who can view, comment or edit", "The file and its versions"] }, { h: "OpenCanvas owns", items: ["Editing and live merge", "Cursors and presence", "Preview, export and autosave"] }),
    TOG("Open questions", ["Should commenters see the board pointers of editors?", "Do we need per-channel autosave, or is per-tenant enough?"]),
    LINK("https://sdk.collaboraonline.com/docs/How_to_integrate.html", "How to integrate · Collabora Online SDK", "The WOPI host model with CheckFileInfo, GetFile and PutFile. The integration contract OpenCanvas follows.", "sdk.collaboraonline.com"),
    IMG("Session pipeline, pasted from the design review. Stored in the host app."),
    FILE("opencanvas-hld-v0.1.pdf", 1468006, "application/pdf"),
    EMBED("youtube", "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "Demo: two cursors, one board"),
    CODE("http", 'POST /v1/files/doc_8812/patch\n{ "op": "append", "markdown": "- [ ] Follow up with design" }'),
  ];
}

export interface Demo {
  collab: Collab;
  /** Seeds the doc through the editor (so Tiptap owns the schema), then starts peers. */
  seed(setContent: (json: object) => void): Promise<void>;
  users: typeof DEMO_USERS;
  simulate(s: string): void;
  destroy(): void;
}

/** Text-index helpers over the Y.XmlFragment that Collaboration binds to. */
function findText(frag: Y.XmlFragment, needle: string): { text: Y.XmlText; index: number } | null {
  const walk = (el: Y.XmlElement | Y.XmlFragment): { text: Y.XmlText; index: number } | null => {
    for (const c of el.toArray()) {
      if (c instanceof Y.XmlText) {
        const s = c.toDelta().map((d: { insert: unknown }) => (typeof d.insert === "string" ? d.insert : "\u0000")).join("");
        const i = s.indexOf(needle);
        if (i >= 0) return { text: c, index: i };
      } else if (c instanceof Y.XmlElement) {
        const r = walk(c);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(frag);
}

function relJSON(t: Y.AbstractType<any>, i: number) {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, i));
}

export function createDemo(role: Role): Demo {
  const s = demoSession(role);
  const collab = localCollab(s.user, role);
  const { doc, awareness } = collab;
  const ext = collab as unknown as { _emitControl(c: Control): void; _emitConn(c: ConnState): void };
  const timers: number[] = [];
  const peers: Awareness[] = [];
  const peerDocs: Y.Doc[] = [];

  // Autosave simulation: every change saves ~1 s later.
  let saveT: number | undefined;
  let sim = "ok";
  doc.on("update", () => {
    if (sim !== "ok") return;
    ext._emitControl({ t: "saving" });
    window.clearTimeout(saveT);
    saveT = window.setTimeout(() => ext._emitControl({ t: "saved", at: Date.now(), version: String(18 + Math.floor(Date.now() / 60000) % 40) }), 1100);
  });

  const addPeer = (key: keyof typeof DEMO_USERS, peerDoc?: Y.Doc) => {
    const u = DEMO_USERS[key];
    const d = peerDoc ?? new Y.Doc();
    if (!peerDoc) peerDocs.push(d);
    const aw = new Awareness(d);
    aw.setLocalState({ user: { id: u.id, name: u.name, color: u.color, role: u.role } });
    const forward = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) =>
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(aw, [...added, ...updated, ...removed]), "demo");
    aw.on("update", forward);
    forward({ added: [aw.clientID], updated: [], removed: [] });
    peers.push(aw);
    return aw;
  };

  const seed = async (setContent: (json: object) => void) => {
    const people = Object.fromEntries(Object.values(DEMO_USERS).map((u) => [u.id, u.name]));
    setMeta(doc, { title: "Sprint 42 planning", icon: "rocket", tone: "blue", template: "demo" });
    setContent(await buildDoc(demoBlocks(), { doc, people, me: { id: s.user.id, name: s.user.name } }));
    createThread(doc, "t_demo1", "Autosave runs every 60 seconds by default");
    const a = DEMO_USERS.ravi, b = DEMO_USERS.asha;
    addMessage(doc, "t_demo1", { user: a.id, name: a.name, color: a.color, text: "Can hosts set this per channel, or only per tenant?" });
    addMessage(doc, "t_demo1", { user: b.id, name: b.name, color: b.color, text: "Per tenant for now. Per channel is a P2 flag." });
    const msgs = commentsRoot(doc).get("t_demo1")?.get("messages") as Y.Array<Y.Map<unknown>>;
    msgs?.get(0)?.set("at", Date.now() - 9 * 60000);
    msgs?.get(1)?.set("at", Date.now() - 7 * 60000);
    startPeers();
  };

  const startPeers = () => {
    const frag = doc.getXmlFragment("content");

    // Asha: a selection on "hosts can change it per tenant".
    const asha = addPeer("asha");
    const hit = findText(frag, "hosts can change it per tenant");
    if (hit) asha.setLocalStateField("cursor", { anchor: relJSON(hit.text, hit.index), head: relJSON(hit.text, hit.index + 30) });

    // Ravi: on the board; Sam: viewing.
    const ravi = addPeer("ravi");
    let t = 0;
    timers.push(
      window.setInterval(() => {
        t += 0.05;
        ravi.setLocalStateField("board", { x: 430 + 190 * Math.cos(t * 0.8), y: 200 + 80 * Math.sin(t * 1.25), tool: "select" });
      }, 120),
    );
    addPeer("sam");

    // Lin types into the empty paragraph after "Decisions" from her own replica,
    // so her edits arrive as remote updates (not on your undo stack).
    const linDoc = new Y.Doc();
    peerDocs.push(linDoc);
    Y.applyUpdate(linDoc, Y.encodeStateAsUpdate(doc));
    doc.on("update", (u: Uint8Array, origin: unknown) => origin !== "lin" && Y.applyUpdate(linDoc, u, "main"));
    linDoc.on("update", (u: Uint8Array, origin: unknown) => origin !== "main" && Y.applyUpdate(doc, u, "lin"));
    const lin = addPeer("lin", linDoc);
    const lfrag = linDoc.getXmlFragment("content");
    const para = lfrag.toArray()[3];
    if (para instanceof Y.XmlElement && para.nodeName === "paragraph") {
      let xt: Y.XmlText | null = null;
      let i = 0;
      const step = () => {
        if (sim !== "ok" && sim !== "savefail") return;
        if (i >= LIN_TEXT.length) {
          lin.setLocalStateField("typing", false);
          return;
        }
        if (!xt) {
          xt = new Y.XmlText();
          para.insert(0, [xt]);
        }
        xt.insert(i, LIN_TEXT[i]);
        i++;
        lin.setLocalState({ ...lin.getLocalState(), typing: true, cursor: { anchor: relJSON(xt, i), head: relJSON(xt, i) } });
      };
      timers.push(window.setTimeout(() => timers.push(window.setInterval(step, 75)), 2200));
    }
  };

  return {
    collab,
    seed,
    users: DEMO_USERS,
    simulate(v: string) {
      sim = v;
      window.clearTimeout(saveT);
      if (v === "offline") ext._emitConn("offline");
      else if (v === "reconnect") ext._emitConn("reconnecting");
      else if (v === "savefail") ext._emitControl({ t: "save_error", retryInMs: 10000, message: "Host returned 503" });
      else if (v === "conflict") ext._emitControl({ t: "conflict", policy: "copy", fileId: "demo_copy", url: "https://app.acme.example/files/demo_copy" });
      else if (v === "revoked") ext._emitControl({ t: "closed", reason: "access revoked" });
      else if (v === "upgrade") ext._emitControl({ t: "role", role: "edit" });
      else if (v === "closed") ext._emitControl({ t: "closed", reason: "The file was moved" });
      else if (v === "downgrade") ext._emitControl({ t: "role", role: "view" });
    },
    destroy() {
      timers.forEach((t) => (window.clearInterval(t), window.clearTimeout(t)));
      peers.forEach((p) => p.destroy());
      peerDocs.forEach((d) => d.destroy());
      collab.destroy();
    },
  };
}
