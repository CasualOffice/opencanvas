// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal,
  AlignStartVertical, AlignVerticalDistributeCenter, ALargeSmall, ArrowUpRight, BringToFront, Circle, CircleMinus, Copy, CornerDownRight, Diamond,
  Download, Ellipsis, FileUp, Frame, Group, Hand, ImagePlus, Maximize2, Minimize2, MousePointer2, MoveUpRight, Pencil,
  Redo2, RouteOff, SendToBack, Spline, Square, StickyNote, Trash2, Type, Undo2, Ungroup, Waypoints, Workflow, type LucideIcon,
} from "lucide-react";
import type { BlockEnv } from "@opencanvas/ui";
import {
  addShape, bbox, contentBounds, deleteShape, getBoardMap, readShapes, simplify, smooth, updateShape,
  type Pt, type Shape, type ShapeType,
} from "./model";
import { ensureStyles } from "./styles";
import { Dock } from "./Dock";
import { readToolsLeft, writeToolsLeft } from "./toolbar";
import { anchorPoint, ANCHORS, resolveArrow, syncArrows, viaOf, type Anchor, type ArrowRoute, type Binding } from "./connectors";
import { ExportMenuItems, useBoardExport } from "./export/hooks";
import { useFrames } from "./frames/hooks";
import { EmptyBoard, insertTemplate } from "./empty/EmptyBoard";
import { FrameNames, FrameView } from "./frames/view";
import { FRAME_SIZE, isFrame, membersOf } from "./frames/model";
import { applyMembership, createFrame, releaseMembers } from "./frames/ops";
import { createArrowResolver } from "./edges";
import { BoardProjection } from "./projection";
import { SceneIndex } from "./scene";
import { lodBucket, lodGroups, lodOn, type LodGroup } from "./lod";
import { AvoidRouter, RouteScheduler } from "./routing";
import { bindingTo, nearestPort, portPoint, portsOf } from "./ports";
import { CONTAINER, isContainer } from "./kinds";
import { descriptorOf, makeNode } from "./registry";
import { ends, HEADS } from "./heads";
import { KIND_MIME } from "./libraries";
import { DOC_PREFIX, ICON_KIND, ICON_LABEL, ICON_MIME, docIconNodeFields, iconById, iconGlyphBox, iconLabelLayout, iconNodeFields, iconPathsOf, iconProps, readDocIcons, readIconDrag } from "./icons";
import { DocIconsContext, useDocIcons, useDocIconList, type DocIconsCtx } from "./iconsContext";
// The icon dialogs (DGM-17): their own lazy module, loaded when one opens.
type IconDialogsModule = typeof import("./diagram/icons/Dialogs");
let iconDialogsModule: Promise<IconDialogsModule> | null = null;
const loadIconDialogs = () => (iconDialogsModule ??= import("./diagram/icons/Dialogs"));
import { newShapeFields, PRESET, presetOf, type ConnectorPreset } from "./panel";
import { KindMarks, UnknownShape } from "./diagram/Placeholder";
import { OrphanLayer } from "./diagram/Presence";
import { fitImage, ImageError, imageFiles, imageSize, imageSource } from "./images";
// Diagram mode (DGM-14): its own lazy chunk, loaded when someone opens a board as a diagram.
type ShellModule = typeof import("./diagram/Shell");
let shellModule: Promise<ShellModule> | null = null;
const loadShell = () => (shellModule ??= import("./diagram/Shell"));
/** Diagram settings of one person (1d, right panel with nothing selected). Never in the document. */
export interface DiagramPrefs {
  grid: boolean;
  gridSize: number;
  rulers: boolean;
  snapGrid: boolean;
  snapShapes: boolean;
  connector: "straight" | "elbow" | "avoid";
}
const DIAGRAM_PREFS: DiagramPrefs = { grid: true, gridSize: 20, rulers: true, snapGrid: true, snapShapes: true, connector: "elbow" };
import {
  alignMoves, cloneShapes, containedIn, containerBox, distributeMoves, equalGapOffset, freeSpot, gridOffset, insertShapes, type GapMark, intersects, midPoint, movePatch, reorderShapes, setGroup, snapOffset, STICKY_TEXT,
  stickyHeight, unionBox, withGroups, wrapText, type AlignMode, type Box, type ZMove,
} from "./ops";

type Tool = "select" | "hand" | "pen" | "sticky" | "rect" | "ellipse" | "diamond" | "arrow" | "text" | "frame";
// SCALE-02 / UX4-01: the priority order is the visual order; overflow takes from the end (Pan first).
const TOOLS: [Tool, LucideIcon, string, string][] = [
  ["select", MousePointer2, "Select", "V"],
  ["sticky", StickyNote, "Sticky note", "N"],
  ["pen", Pencil, "Pen", "P"],
  ["text", Type, "Text", "T"],
  ["rect", Square, "Rectangle", "R"],
  ["arrow", ArrowUpRight, "Arrow", "A"],
  ["ellipse", Circle, "Ellipse", "O"],
  ["diamond", Diamond, "Diamond", "D"],
  ["frame", Frame, "Frame", "F"],
  ["hand", Hand, "Pan", "H"],
];
const KEY_TOOL: Record<string, Tool> = { v: "select", h: "hand", p: "pen", n: "sticky", r: "rect", o: "ellipse", d: "diamond", a: "arrow", t: "text", f: "frame" };
const STICKY: Record<string, string> = { y: "var(--sticky-y)", p: "var(--sticky-p)", b: "var(--sticky-b)", g: "var(--sticky-g)" };
const SWATCH: Record<string, string> = { accent: "var(--accent)", amber: "var(--amber-fg)", green: "var(--green-fg)", pink: "var(--pink-fg)", purple: "var(--purple-fg)", red: "var(--red-fg)", blue: "var(--blue-fg)" };
/** Shape fills for rect / ellipse / diamond: a tone's background with its foreground as the outline. */
const TONES = ["gray", "blue", "green", "amber", "red", "purple", "pink"] as const;
const TONE_NAME: Record<string, string> = { gray: "Gray", blue: "Blue", green: "Green", amber: "Amber", red: "Red", purple: "Purple", pink: "Pink" };
const TEXTUAL: ShapeType[] = ["sticky", "rect", "ellipse", "diamond", "text", "arrow"];
const SIZED: ShapeType[] = ["sticky", "rect", "ellipse", "diamond", "swatch", "image"];
const BOXY: ShapeType[] = ["rect", "ellipse", "diamond"];
/** Text sizes offered for text shapes and shape labels. */
const TEXT_SIZES = [14, 18, 24, 32];
const SHAPE_SIZES = [13, 14, 16, 20];
const TYPE_NAME: Record<ShapeType, string> = { sticky: "Sticky note", rect: "Rectangle", ellipse: "Ellipse", diamond: "Diamond", text: "Text", arrow: "Connector", pen: "Drawing", swatch: "Colour swatch", image: "Image" };
const SW = 1.75;
const ZMIN = 0.1, ZMAX = 4;
/** Above this many shapes only the ones in (or near) the viewport are rendered. */
const CULL_AT = 300;

interface View { tx: number; ty: number; z: number }
interface Peer { id: number; name: string; color: string; x: number | null; y: number | null; sel: string[] }

/* --------------------------------------------------- clipboard (shared) */

/** Last shapes copied from any board on the page (the system clipboard carries them too). */
let CLIP: { shapes: Shape[]; text: string; pastes: number } | null = null;
const CLIP_ATTR = "data-oc-board";

/* ------------------------------------------------------------- store */

/**
 * The board's shapes, re-read incrementally: a transaction re-reads only the shapes it touched,
 * and unchanged shapes (and an unchanged list) stay the same objects (DGM-05, projection.ts).
 */
function useShapes(doc: Y.Doc, boardId: string): Shape[] | null {
  const proj = useMemo(() => new BoardProjection(doc, boardId), [doc, boardId]);
  return useSyncExternalStore(proj.subscribe, proj.get, proj.get);
}

function usePeers(awareness: Awareness | undefined, boardId: string): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    if (!awareness) return;
    const read = () => {
      const out: Peer[] = [];
      awareness.getStates().forEach((st, id) => {
        if (id === awareness.clientID || !st) return;
        const b = st.board as { id?: string; x?: number; y?: number; sel?: unknown } | null | undefined;
        if (!b || b.id !== boardId) return;
        const hasPt = typeof b.x === "number" && typeof b.y === "number";
        const sel = Array.isArray(b.sel) ? b.sel.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
        if (!hasPt && !sel.length) return;
        const u = (st.user ?? {}) as { name?: string; color?: string };
        out.push({ id, name: String(u.name ?? "Someone"), color: String(u.color ?? "var(--u2)"), x: hasPt ? b.x! : null, y: hasPt ? b.y! : null, sel });
      });
      setPeers(out);
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [awareness, boardId]);
  return peers;
}

/* ========================================================== component */

export function BoardBlock({ doc, boardId, env, awareness }: { doc: Y.Doc; boardId: string; env: BlockEnv; awareness?: Awareness }) {
  ensureStyles();
  const shapes = useShapes(doc, boardId);
  if (!shapes) {
    return (
      <div className={"ocbd ocbd-ph" + (env.compact ? " ocbd-compact" : "")} style={{ height: env.compact ? 300 : 440 }}>
        This board is missing or still loading.
      </div>
    );
  }
  return <Board doc={doc} boardId={boardId} env={env} awareness={awareness} shapes={shapes} />;
}

type Drag =
  | { kind: "pan"; sx: number; sy: number; v: View }
  | { kind: "move"; ids: string[]; ox: number; oy: number; orig: Map<string, Shape>; box: Box | null; others: Box[]; moved: boolean }
  | { kind: "resize"; sid: string; ox: number; oy: number; orig: Shape; moved: boolean }
  | { kind: "box"; x0: number; y0: number; base: string[]; add: boolean }
  | { kind: "pen" }
  | { kind: "arrow" }
  | { kind: "create"; t: Tool; x0: number; y0: number; cx: number; cy: number; box: Box | null }
  | { kind: "end"; sid: string; which: "start" | "end"; orig: Shape; moved: boolean }
  /** Dragging waypoint `i` of a connector; `insert` when it was a segment's midpoint handle. */
  | { kind: "wp"; sid: string; i: number; insert: boolean; orig: Pt[]; moved: boolean; seg?: { pts: Pt[]; horiz: boolean } }
  | { kind: "pinch"; d0: number; c0: [number, number]; v: View };

const describeShape = (s: Shape) => {
  const t = (s.text ?? s.label ?? s.alt ?? "").replace(/\s+/g, " ").trim();
  return TYPE_NAME[s.type] + (t ? `: ${t.length > 40 ? t.slice(0, 39) + "…" : t}` : "");
};

function Board({ doc, boardId, env, awareness, shapes: raw }: { doc: Y.Doc; boardId: string; env: BlockEnv; awareness?: Awareness; shapes: Shape[] }) {
  // Arrows bound to shapes are drawn (and hit-tested, moved, exported) from their resolved points.
  // Only connectors whose own shape or bound shapes changed are resolved again (edges.ts).
  const resolveArrows = useMemo(() => createArrowResolver(), []);
  // The drawn shapes in a spatial index, updated shape by shape (DGM-11): culling, marquee and
  // connector snapping query it instead of scanning the board. `byId` is its map, kept in place.
  const scene = useMemo(() => new SceneIndex(), []);
  // Connectors stored with `routing: "avoid"` are drawn along their obstacle-free route (DGM-13);
  // while dragging they draw as the plain elbow and are re-routed in the background (throttled).
  const router = useMemo(() => new AvoidRouter(), []);
  const routes = useMemo(() => new RouteScheduler(router), [router]);
  const [routeTick, setRouteTick] = useState(0);
  useEffect(() => router.subscribe(() => setRouteTick((t) => t + 1)), [router]);
  useEffect(() => () => routes.cancel(), [routes]);
  const [dragging, setDragging] = useState(false);
  const shapes = useMemo(() => {
    const out = router.apply(resolveArrows(raw), dragging ? 0 : 64);
    scene.update(out);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, resolveArrows, scene, router, routeTick, dragging]);
  useEffect(() => {
    if (router.pending.size) routes.schedule(dragging ? 100 : 0);
  }, [shapes, router, routes, dragging]);
  const byId = scene.byId;
  const edit = env.role === "edit";
  const compact = env.compact;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const origin = useMemo(() => ({ board: boardId, local: uid }), [boardId, uid]);
  const [tool, setToolState] = useState<Tool>("select");
  const [sel, setSelState] = useState<string[]>([]);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, z: 1 });
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const [full, setFull] = useState(false);
  const [active, setActive] = useState(false);
  // Diagram mode (DGM-14 S1): per person, per board; React state only, never in the document.
  const [dgm, setDgm] = useState<null | "open" | "closing">(null);
  const big = full || dgm !== null;
  const dgmBtn = useRef<HTMLButtonElement>(null);
  const phRef = useRef<HTMLDivElement>(null);
  const [phH, setPhH] = useState(0);
  const [place, setPlace] = useState({ heading: "", title: "" });
  const refocus = useRef(false);
  const [Dg, setDg] = useState<ShellModule | null>(null);
  // DGM-17: icons added to the document, and the icon dialogs.
  const docIcons = useDocIconList(doc);
  const [iconDlg, setIconDlg] = useState<import("./diagram/icons/Dialogs").IconDialogState | null>(null);
  const [IconDlgs, setIconDlgs] = useState<IconDialogsModule | null>(null);
  const openIconDialog = (st: import("./diagram/icons/Dialogs").IconDialogState) => {
    setIconDlg(st);
    void loadIconDialogs().then((m) => setIconDlgs(() => m));
  };
  const [dp, setDp] = useState<DiagramPrefs>(DIAGRAM_PREFS);
  /** Shape whose ports show (diagram mode, pointer over it). */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** Connector preset the next connector is drawn with (S2), until the tool changes. */
  const presetRef = useRef<ConnectorPreset | null>(null);
  const [, setPresetState] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  /** Equal-gap marks while moving (3a). */
  const [gaps, setGaps] = useState<GapMark[] | null>(null);
  const mode = dgm ? "dgm" : full ? "full" : "inline";
  const asDiagram = raw.some((s) => !!s.kind) || !!getBoardMap(doc, boardId)?.get("name");
  const [draft, setDraftState] = useState<Shape | null>(null);
  const [editing, setEditingState] = useState<{ id: string; text: string } | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [guides, setGuides] = useState<{ gx: number[]; gy: number[] } | null>(null);
  const [live, setLive] = useState("");
  // Mirrors so handlers never act on stale state (and never run side effects in updaters).
  const draftRef = useRef<Shape | null>(null);
  const editRef = useRef<{ id: string; text: string } | null>(null);
  const setDraft = (d: Shape | null) => {
    draftRef.current = d;
    setDraftState(d);
  };
  const setEditing = (v: { id: string; text: string } | null) => {
    editRef.current = v;
    setEditingState(v);
  };
  /** Shape + anchor an arrow end would attach to (shown while dragging an end). */
  const [hint, setHint] = useState<Binding | null>(null);
  const [menu, setMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [route, setRoute] = useState<ArrowRoute>("straight");
  const fileRef = useRef<HTMLInputElement>(null);
  const peers = usePeers(awareness, boardId);
  const rootRef = useRef<HTMLDivElement>(null);
  // BRD-20: the export dialog (lazy), Copy as PNG / SVG.
  const xport = useBoardExport({ doc, shapes, sel, name: String(getBoardMap(doc, boardId)?.get("name") ?? "board"), toast: env.toast, onClose: () => rootRef.current?.focus({ preventScroll: true }) });
  // BRD-21: frames (names, rename, Present).
  const frm = useFrames({ doc, boardId, shapes, view, origin, edit, onSay: (m) => setLive(m), onDone: () => rootRef.current?.focus({ preventScroll: true }) });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, [number, number]>());
  const pending = useRef(new Map<string, Partial<Shape>>());
  const raf = useRef(0);
  const cursorRaf = useRef(0);
  const fitted = useRef(false);
  const space = useRef(false);
  const lastPt = useRef<Pt | null>(null);

  /** Active waypoint (index into the selected connector's `via`) for the keyboard and Delete. */
  const [wp, setWpState] = useState<number | null>(null);
  // "Tools on the left": a personal setting, kept per device (UX4-01, option B as a rail).
  const [rail, setRailState] = useState(readToolsLeft);
  const setRail = (on: boolean) => (writeToolsLeft(on), setRailState(on));
  // The selection toolbar's measured width: its content changes with the shape and the text size.
  const barRef = useRef<HTMLDivElement>(null);
  const [barW, setBarW] = useState(0);
  useLayoutEffect(() => {
    const w = barRef.current?.offsetWidth ?? 0;
    if (w && Math.abs(w - barW) > 0.5) setBarW(w);
  });
  const [mini, setMini] = useState(false);

  // Always-fresh values for event handlers.
  const S = useRef({ shapes, raw, byId, view, tool, sel, edit, editing, wp, dgm, dp });
  S.current = { shapes, raw, byId, view, tool, sel, edit, editing, wp, dgm, dp };
  const setWp = (i: number | null) => {
    S.current.wp = i;
    setWpState(i);
  };

  const tool_ = edit ? tool : tool === "hand" ? "hand" : "select";
  const setTool = (t: Tool) => {
    presetRef.current = null;
    setPresetState(null);
    setToolState(edit || t === "select" || t === "hand" ? t : "select");
  };

  /* ---- presence: pointer + selection ---- */
  const publishNow = (sel: string[]) => {
    if (!awareness) return;
    const p = lastPt.current;
    const next = p ? { id: boardId, x: Math.round(p[0] * 10) / 10, y: Math.round(p[1] * 10) / 10, sel } : sel.length ? { id: boardId, sel } : null;
    const cur = awareness.getLocalState()?.board;
    if (!next && !cur) return;
    awareness.setLocalStateField("board", next);
  };
  const publish = (x: number | null, y = 0) => {
    if (!awareness) return;
    cancelAnimationFrame(cursorRaf.current);
    lastPt.current = x === null ? null : [x, y];
    if (x === null) return publishNow(S.current.sel);
    cursorRaf.current = requestAnimationFrame(() => publishNow(S.current.sel));
  };
  useEffect(() => () => {
    cancelAnimationFrame(cursorRaf.current);
    if (awareness?.getLocalState()?.board) awareness.setLocalStateField("board", null);
  }, [awareness]);

  const setSel = (ids: string[]) => {
    const cur = S.current.sel;
    if (ids.length !== cur.length || ids.some((x, i) => x !== cur[i])) setWp(null);
    S.current.sel = ids;
    setSelState(ids);
    publishNow(ids);
  };
  const selShapes = () => S.current.shapes.filter((s) => S.current.sel.includes(s.id));
  const announceSel = (ids: string[]) => {
    if (!ids.length) return setLive("Nothing selected");
    if (ids.length === 1) {
      const s = S.current.shapes.find((x) => x.id === ids[0]);
      const i = S.current.shapes.findIndex((x) => x.id === ids[0]);
      if (s) setLive(`${describeShape(s)}. ${i + 1} of ${S.current.shapes.length}`);
    } else setLive(`${ids.length} shapes selected`);
  };

  /* ---- undo ---- */
  // With the editor's manager (env.undoManager) board edits join the canvas undo stack, so one
  // Cmd/Ctrl+Z covers both; without one the board keeps its own (per view: only this view's edits).
  const shared = env.undoManager;
  const um = useMemo(() => {
    const m = getBoardMap(doc, boardId);
    if (!m) return null;
    if (shared) {
      shared.addToScope(m);
      shared.trackedOrigins.add(origin);
      return shared;
    }
    return new Y.UndoManager(m, { trackedOrigins: new Set([origin]), captureTimeout: 400 });
  }, [doc, boardId, origin, shared]);
  const [, setStacks] = useState(0);
  useEffect(() => {
    if (!um) return;
    const bump = () => setStacks((n) => n + 1);
    um.on("stack-item-added", bump);
    um.on("stack-item-popped", bump);
    um.on("stack-cleared", bump);
    return () => {
      um.off("stack-item-added", bump);
      um.off("stack-item-popped", bump);
      um.off("stack-cleared", bump);
      // A shared manager belongs to the editor: stop capturing this view's edits, keep its stack.
      if (um === shared) um.trackedOrigins.delete(origin);
      else um.destroy();
    };
  }, [um, shared, origin]);
  const undo = (redo = false) => {
    if (!um) return;
    if (redo ? !um.redoStack.length : !um.undoStack.length) return setLive(redo ? "Nothing to redo" : "Nothing to undo");
    if (redo) um.redo();
    else um.undo();
    setLive(redo ? "Redone" : "Undone");
  };

  /* ---- size + fit content on first layout ---- */
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => setSize((p) => (p[0] === svg.clientWidth && p[1] === svg.clientHeight ? p : [svg.clientWidth, svg.clientHeight]));
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(svg);
    return () => ro?.disconnect();
  }, [mode]);
  useLayoutEffect(() => {
    if (fitted.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const W = svg.clientWidth, H = svg.clientHeight;
    if (!W || !H) return;
    fitted.current = true;
    const b = contentBounds(shapes);
    if (!b) return;
    const pad = 24, bottom = 64;
    if (b[0] >= 0 && b[1] >= 0 && b[2] <= W - pad && b[3] <= H - bottom) return;
    const bw = b[2] - b[0], bh = b[3] - b[1];
    const z = Math.max(ZMIN, Math.min(1, (W - pad * 2) / Math.max(bw, 1), (H - pad - bottom) / Math.max(bh, 1)));
    setView({ z, tx: (W - bw * z) / 2 - b[0] * z, ty: pad + (H - pad - bottom - bh * z) / 2 - b[1] * z });
  });

  /* ---- coords ---- */
  const toWorld = (cx: number, cy: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    const v = S.current.view;
    return [(cx - r.left - v.tx) / v.z, (cy - r.top - v.ty) / v.z];
  };

  const zoomAt = (f: number, sx: number, sy: number) => {
    setView((v) => {
      const z = Math.min(ZMAX, Math.max(ZMIN, v.z * f));
      return { z, tx: sx - (sx - v.tx) * (z / v.z), ty: sy - (sy - v.ty) * (z / v.z) };
    });
  };
  const zoomCenter = (f: number) => {
    const svg = svgRef.current;
    if (svg) zoomAt(f, svg.clientWidth / 2, svg.clientHeight / 2);
  };
  const fitBox = (b: Box | null, maxZ = 1) => {
    const svg = svgRef.current;
    if (!svg || !b) return setView({ tx: 0, ty: 0, z: 1 });
    const W = svg.clientWidth, H = svg.clientHeight;
    const pad = 32, bottom = 72;
    const bw = b[2] - b[0], bh = b[3] - b[1];
    const z = Math.max(ZMIN, Math.min(maxZ, (W - pad * 2) / Math.max(bw, 1), (H - pad - bottom) / Math.max(bh, 1)));
    setView({ z, tx: (W - bw * z) / 2 - b[0] * z, ty: pad + (H - pad - bottom - bh * z) / 2 - b[1] * z });
  };
  const fit = () => fitBox(contentBounds(S.current.shapes));
  /** Diagram Go to (S5): the shape in the middle of the view, zoom unchanged. */
  const revealShape = (id: string) => {
    const s = S.current.byId.get(id), svg = svgRef.current;
    if (!s || !svg) return;
    const [x0, y0, x1, y1] = bbox(s);
    setView((v) => ({ ...v, tx: svg.clientWidth / 2 - ((x0 + x1) / 2) * v.z, ty: svg.clientHeight / 2 - ((y0 + y1) / 2) * v.z }));
  };

  /* ---- writes (batched per frame, one transaction) ---- */
  const flush = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const p = pending.current;
    if (!p.size) return;
    pending.current = new Map();
    doc.transact(() => p.forEach((patch, sid) => updateShape(doc, boardId, sid, patch, origin)), origin);
  };
  const schedule = (sid: string, patch: Partial<Shape>) => {
    pending.current.set(sid, patch);
    if (!raf.current) raf.current = requestAnimationFrame(flush);
  };
  /**
   * Refresh the stored `pts` of the connectors a change to `ids` can affect: those shapes, the
   * connectors bound to them, and any connector already out of step (DGM-11). Equal to
   * `syncBoundArrows` while the view is current, without reading the whole board.
   */
  const syncAfter = (ids: Iterable<string>) => {
    const list = [...ids];
    const cand = new Set<string>(list);
    for (const e of resolveArrows.edges.affectedBy(list)) cand.add(e);
    for (const e of resolveArrows.stale) cand.add(e);
    let hook;
    if (router.connectors.size) {
      // Avoid connectors are routed against the committed state of the changed shapes. All of
      // them are checked (syncArrows writes only those whose stored pts differ): a cost in the
      // number of avoid connectors, not the board; narrowing it to `router.affected(fresh)` plus
      // a stale set is Phase 3.
      const ys = getBoardMap(doc, boardId)?.get("shapes");
      const fresh = new Map<string, Shape | undefined>();
      for (const id of list) {
        const y = ys instanceof Y.Map ? ys.get(id) : undefined;
        fresh.set(id, y instanceof Y.Map ? ({ ...(y.toJSON() as Shape), id } as Shape) : undefined);
      }
      for (const e of router.connectors) cand.add(e);
      hook = router.hook(fresh);
    }
    syncArrows(doc, boardId, cand, origin, hook);
  };
  const applyMoves = (moves: { id: string; patch: Partial<Shape> }[]) => {
    if (!moves.length) return;
    um?.stopCapturing();
    doc.transact(() => {
      moves.forEach((m) => updateShape(doc, boardId, m.id, m.patch, origin));
      syncAfter(moves.map((m) => m.id));
    }, origin);
  };

  const startEdit = (s: Shape) => {
    if (!S.current.edit || !TEXTUAL.includes(s.type)) return;
    setSel([s.id]);
    setEditing({ id: s.id, text: s.text ?? "" });
  };
  const commitEdit = (cancel = false) => {
    const e = editRef.current;
    if (!e) return;
    setEditing(null);
    const s = S.current.shapes.find((x) => x.id === e.id);
    if (!s) return;
    if (!cancel && e.text !== (s.text ?? "")) {
      const patch: Partial<Shape> = { text: e.text };
      // Sticky notes grow to fit their text (they never shrink below what the user set).
      if (s.type === "sticky") {
        const need = stickyHeight(e.text, s.w ?? 150, s.h ?? 110);
        if (need > (s.h ?? 110)) patch.h = need;
      }
      updateShape(doc, boardId, s.id, patch, origin);
    }
    if (s.type === "text" && !(cancel ? s.text : e.text)?.trim()) {
      deleteShape(doc, boardId, s.id, origin);
      setSel([]);
    }
    rootRef.current?.focus({ preventScroll: true });
  };

  const removeSel = () => {
    const ids = S.current.sel;
    if (!ids.length) return;
    um?.stopCapturing();
    doc.transact(() => {
      // BRD-21: deleting a frame keeps its contents (they leave it).
      releaseMembers(doc, boardId, S.current.raw, ids, origin);
      ids.forEach((sid) => deleteShape(doc, boardId, sid, origin));
    }, origin);
    setLive(ids.length === 1 ? "Deleted" : `Deleted ${ids.length} shapes`);
    setSel([]);
  };
  /** Copies of the selection, offset, on top; the copies become the selection. */
  const paste = (src: Shape[], dx: number, dy: number) => {
    if (!src.length) return;
    um?.stopCapturing();
    const copies = cloneShapes(src, dx, dy);
    const ids = insertShapes(doc, boardId, copies, origin);
    setSel(ids);
    syncAfter(ids);
    setLive(copies.length === 1 ? `Pasted ${describeShape(copies[0])}` : `Pasted ${copies.length} shapes`);
  };
  const dupSel = () => paste(selShapes(), 24, 24);
  const zSel = (how: ZMove) => {
    const ids = S.current.sel;
    if (!ids.length) return;
    um?.stopCapturing();
    reorderShapes(doc, boardId, ids, how, origin);
    setLive({ front: "Brought to front", back: "Sent to back", forward: "Brought forward", backward: "Sent backward" }[how]);
  };
  const groupSel = (on: boolean) => {
    const ids = S.current.sel;
    if (on ? ids.length < 2 : !selShapes().some((s) => s.group)) return;
    um?.stopCapturing();
    setGroup(doc, boardId, ids, on ? "" : null, origin);
    setLive(on ? `Grouped ${ids.length} shapes` : "Ungrouped");
  };
  /** Diagram mode: put the selection in a new container, drawn behind it (3f, 3g). */
  const containSel = () => {
    const list = selShapes();
    const b = containerBox(list);
    const m = getBoardMap(doc, boardId);
    const order = m?.get("order");
    if (!b || !(order instanceof Y.Array)) return;
    um?.stopCapturing();
    let cid = "";
    doc.transact(() => {
      cid = addShape(doc, boardId, makeNode(CONTAINER, { x: Math.round(b[0]), y: Math.round(b[1]), w: Math.round(b[2] - b[0]), h: Math.round(b[3] - b[1]), label: "Container" }), origin);
      // Just behind the lowest selected shape, so it stays above whatever it sits on.
      const arr = order.toArray() as string[];
      const set = new Set(list.map((q) => q.id));
      const first = arr.findIndex((x) => set.has(x));
      const at = arr.lastIndexOf(cid);
      if (first >= 0 && at > first) {
        order.delete(at, 1);
        order.insert(first, [cid]);
      }
    }, origin);
    setSel([cid]);
    setLive(`Container around ${list.length} ${list.length === 1 ? "shape" : "shapes"}`);
  };
  const align = (mode: AlignMode) => applyMoves(alignMoves(selShapes(), mode));
  const distribute = (axis: "h" | "v") => applyMoves(distributeMoves(selShapes(), axis));
  /** Keyboard / single-click alternative to drawing a connector: join two selected shapes. */
  const connectSel = () => {
    const [a, b] = selShapes().filter((s) => s.type !== "arrow" && s.type !== "pen");
    if (!a || !b) return;
    const [ax0, ay0, ax1, ay1] = bbox(a), [bx0, by0, bx1, by1] = bbox(b);
    const dx = (bx0 + bx1) / 2 - (ax0 + ax1) / 2, dy = (by0 + by1) / 2 - (ay0 + ay1) / 2;
    const h = Math.abs(dx) >= Math.abs(dy);
    const sa: Anchor = h ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "bottom" : "top";
    const sb: Anchor = h ? (dx >= 0 ? "left" : "right") : dy >= 0 ? "top" : "bottom";
    const s: Shape = { id: "tmp", type: "arrow", pts: [anchorPoint(a, sa), anchorPoint(b, sb)], start: { shapeId: a.id, anchor: sa }, end: { shapeId: b.id, anchor: sb }, ...connectorStyle() };
    um?.stopCapturing();
    const { id: _tmp, ...rest } = s;
    void _tmp;
    const sid = addShape(doc, boardId, { ...rest, pts: resolveArrow(s, byId).map((q) => [Math.round(q[0]), Math.round(q[1])] as Pt) }, origin);
    setSel([sid]);
    setLive(`Connected ${describeShape(a)} to ${describeShape(b)}`);
  };

  /* ---- connector waypoints (`via`) ---- */
  const rawOf = (sid: string) => S.current.raw.find((q) => q.id === sid);
  /** A connector's editable waypoints. A legacy free polyline's middle points count as waypoints. */
  const wayOf = (r: Shape): Pt[] => {
    const v = viaOf(r);
    if (v.length || r.via) return v;
    return !r.start && !r.end && !r.route && (r.pts?.length ?? 0) > 2 ? r.pts!.slice(1, -1).map((p) => [p[0], p[1]] as Pt) : [];
  };
  /** The patch that gives connector `r` these waypoints, with `pts` rewritten to the path they draw. */
  const viaPatch = (r: Shape, via: Pt[]): Partial<Shape> => {
    const v = via.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] as Pt);
    const next: Shape = { ...r, via: v.length ? v : undefined };
    const pts = r.pts ?? [];
    const routed = !!(r.start || r.end || r.route);
    return { via: v.length ? v : undefined, pts: v.length || routed ? resolveArrow(next, S.current.byId) : pts.length > 2 ? [pts[0], pts[pts.length - 1]] : pts };
  };
  const setVia = (sid: string, via: Pt[], split = true) => {
    const r = rawOf(sid);
    if (!r) return;
    if (split) um?.stopCapturing();
    updateShape(doc, boardId, sid, viaPatch(r, via), origin);
  };
  /** Control polygon: the drawn ends with the waypoints between them. */
  const controlOf = (sid: string): Pt[] => {
    const r = rawOf(sid), s = S.current.byId.get(sid);
    if (!r || !s?.pts || s.pts.length < 2) return [];
    return [s.pts[0], ...wayOf(r), s.pts[s.pts.length - 1]];
  };
  const announceWp = (i: number, n: number) => setLive(`Waypoint ${i + 1} of ${n}. Arrow keys move it, Delete removes it, Escape returns to the connector.`);
  /** Insert a waypoint at `p` on the control segment nearest to it. */
  const addWaypointAt = (sid: string, p: Pt) => {
    const r = rawOf(sid);
    const c = controlOf(sid);
    if (!r || c.length < 2) return;
    let best = 0, bd = Infinity;
    for (let i = 0; i < c.length - 1; i++) {
      const d = segDist(p, c[i], c[i + 1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const via = wayOf(r);
    via.splice(best, 0, [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
    setVia(sid, via);
    setWp(best);
    announceWp(best, via.length);
  };
  /** Keyboard / button: a waypoint in the middle of the longest control segment. */
  const addWaypoint = (sid: string) => {
    const c = controlOf(sid);
    if (c.length < 2) return;
    let best = 0;
    for (let i = 1; i < c.length - 1; i++) if (Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]) > Math.hypot(c[best + 1][0] - c[best][0], c[best + 1][1] - c[best][1])) best = i;
    addWaypointAt(sid, [(c[best][0] + c[best + 1][0]) / 2, (c[best][1] + c[best + 1][1]) / 2]);
  };
  const removeWaypoint = (sid: string, i: number) => {
    const r = rawOf(sid);
    if (!r) return;
    const via = wayOf(r);
    if (i < 0 || i >= via.length) return;
    via.splice(i, 1);
    setVia(sid, via);
    const next = via.length ? Math.min(i, via.length - 1) : null;
    setWp(next);
    setLive(next === null ? "Waypoint removed. The connector has no waypoints." : `Waypoint removed. Waypoint ${next + 1} of ${via.length} selected.`);
  };

  /* ---- images ---- */
  const viewCenter = (): Pt => {
    const svg = svgRef.current;
    const v = S.current.view;
    return svg && svg.clientWidth ? [(svg.clientWidth / 2 - v.tx) / v.z, (svg.clientHeight / 2 - v.ty) / v.z] : [200, 150];
  };
  const insertImages = async (files: File[], at: Pt) => {
    if (!S.current.edit) return;
    let i = 0;
    // 2e: an SVG or PNG still lands as a picture; a toast offers to make it a reusable icon.
    const reusable = env.icons ? files.find((f) => f.type === "image/svg+xml" || f.type === "image/png") : undefined;
    for (const file of files) {
      let src: string;
      try {
        src = await imageSource(file, env.upload);
      } catch (err) {
        env.toast(err instanceof ImageError ? err.message : "Couldn't add the image");
        continue;
      }
      const [nw, nh] = await imageSize(src);
      const [w, h] = fitImage(nw, nh);
      const off = i++ * 24;
      um?.stopCapturing();
      const sid = addShape(doc, boardId, { type: "image", x: Math.round(at[0] - w / 2 + off), y: Math.round(at[1] - h / 2 + off), w, h, src, alt: file.name || "Image" }, origin);
      setSel([sid]);
    }
    if (reusable) env.toast("Image added. It’s a picture on this board only.", { label: "Make it a reusable icon", run: () => openIconDialog({ kind: "add", file: reusable }) });
  };
  /** Adds an icon added to the document (DGM-17 part 3) centred on `at`, on the grid in diagram mode. */
  const addDocIcon = (id: string, at: Pt = viewCenter()) => {
    if (!S.current.edit) return;
    // Read from the doc, not render state: the dialog places an icon the server just wrote.
    const icon = readDocIcons(doc).find((i) => i.id === id);
    if (!icon) return;
    const f = docIconNodeFields(icon, at);
    if (S.current.dgm && S.current.dp.snapGrid) {
      const g = S.current.dp.gridSize;
      f.x = Math.round((f.x ?? 0) / g) * g;
      f.y = Math.round((f.y ?? 0) / g) * g;
    }
    um?.stopCapturing();
    const sid = addShape(doc, boardId, f, origin);
    setSel([sid]);
    setLive(`${icon.name} icon added`);
  };
  /** Adds a shape of a registered kind centred on `at` (the view's centre by default): S2. */
  const addKind = (kind: string, where?: Pt, icon?: string, paths?: readonly string[]) => {
    // BRD-12: without a drop point (a click in the panel) it goes to the free spot nearest the middle.
    const at = where ?? viewCenter();
    if (!S.current.edit) return;
    if (kind === ICON_KIND && icon?.startsWith(DOC_PREFIX)) return addDocIcon(icon.slice(DOC_PREFIX.length), at);
    if (kind === ICON_KIND) return addIcon(icon ?? "", at, paths);
    const d = descriptorOf({ type: "rect", kind });
    if (d.kind !== kind) return;
    const f = newShapeFields(kind, d);
    const w = f.w ?? 140, h = f.h ?? 70;
    let x = Math.round(at[0] - w / 2), y = Math.round(at[1] - h / 2);
    const snap = S.current.dgm && S.current.dp.snapGrid ? S.current.dp.gridSize : 0;
    if (!where && !d.container) {
      const others = S.current.shapes.filter((q) => q.type !== "arrow").map((q) => bbox(q) as Box);
      const [dx, dy] = freeSpot([x, y, x + w, y + h], others, 16, snap || 20);
      x += dx;
      y += dy;
    }
    if (snap) {
      x = Math.round(x / snap) * snap;
      y = Math.round(y / snap) * snap;
    }
    um?.stopCapturing();
    // Text shapes size themselves; everything else gets the kind's default box.
    const box = d.base === "text" ? { x, y, text: f.text, size: f.size } : { ...f, x, y, w, h };
    const id = addShape(doc, boardId, makeNode(kind, box), origin);
    // A container kind (pool, lane, frame…) goes behind everything, so it never hides shapes.
    if (d.container) reorderShapes(doc, boardId, [id], "back", origin);
    setSel([id]);
    setLive(`${d.label ?? "Shape"} added`);
    return id;
  };
  /** Adds a built-in icon shape (DGM-17) centred on `at`, on the grid in diagram mode. */
  const addIcon = (icon: string, at: Pt, paths?: readonly string[]) => {
    const f = iconNodeFields(icon, at, paths);
    if (!f) return;
    if (S.current.dgm && S.current.dp.snapGrid) {
      const g = S.current.dp.gridSize;
      f.x = Math.round((f.x ?? 0) / g) * g;
      f.y = Math.round((f.y ?? 0) / g) * g;
    }
    um?.stopCapturing();
    const id = addShape(doc, boardId, f, origin);
    setSel([id]);
    setLive(`${f.text} icon added`);
    return id;
  };
  /**
   * A connector preset from the panel (UML relations, ERD cardinalities, flow line): with two
   * shapes selected it connects them; otherwise the connector tool is armed with that style and
   * the next connector drawn uses it.
   */
  const usePreset = (id: string) => {
    const pr = presetOf(id);
    if (!pr || !S.current.edit) return;
    const two = selShapes().filter((q) => q.type !== "arrow" && q.type !== "pen");
    if (two.length === 2) {
      presetRef.current = pr;
      connectSel();
      presetRef.current = null;
      return;
    }
    presetRef.current = pr;
    setPresetState(pr.id);
    setToolState("arrow");
    setLive(`${pr.label}: drag from one shape to another. Escape cancels`);
  };
  const onDragOver = (e: React.DragEvent) => {
    const types = [...(e.dataTransfer?.types ?? [])];
    if (S.current.edit && types.includes(KIND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (!S.current.edit || !types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: React.DragEvent) => {
    if (!S.current.edit) return;
    // Only a shapes-panel tile carries a kind; files and other drops go on as before.
    const dt = e.dataTransfer;
    const kind = dt && [...(dt.types ?? [])].includes(KIND_MIME) && typeof dt.getData === "function" ? dt.getData(KIND_MIME) : "";
    if (kind) {
      e.preventDefault();
      e.stopPropagation();
      if (kind.startsWith(PRESET)) usePreset(kind);
      else {
        const icon = kind === ICON_KIND ? readIconDrag(dt.getData(ICON_MIME)) : undefined;
        addKind(kind, svgRef.current ? toWorld(e.clientX, e.clientY) : viewCenter(), icon?.id, icon?.paths);
      }
      return;
    }
    const files = imageFiles(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    void insertImages(files, svgRef.current ? toWorld(e.clientX, e.clientY) : viewCenter());
  };

  /* ---- clipboard: copy / cut / paste shapes (and images, and plain text as a text shape) ---- */
  useEffect(() => {
    const mine = (e: Event) => {
      const root = rootRef.current;
      if (!root) return false;
      const a = document.activeElement;
      if (a && a !== root && a.closest?.("textarea,input")) return false; // editing text
      return root.contains(e.target as Node) || root.contains(a);
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!mine(e) || editRef.current) return;
      const list = S.current.shapes.filter((s) => S.current.sel.includes(s.id));
      if (!list.length) return;
      e.preventDefault();
      const text = list.map((s) => s.text ?? "").filter(Boolean).join("\n");
      CLIP = { shapes: JSON.parse(JSON.stringify(list)), text, pastes: 0 };
      e.clipboardData?.setData("text/plain", text);
      e.clipboardData?.setData("text/html", `<span ${CLIP_ATTR}="${encodeURIComponent(JSON.stringify(list))}"></span>`);
      if (e.type === "cut" && S.current.edit) removeSelRef.current();
      else setLive(list.length === 1 ? "Copied" : `Copied ${list.length} shapes`);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!mine(e) || !S.current.edit || editRef.current) return;
      const files = imageFiles(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        e.stopPropagation();
        void insertImagesRef.current(files, viewCenterRef.current());
        return;
      }
      const html = e.clipboardData?.getData?.("text/html") ?? "";
      const text = e.clipboardData?.getData?.("text/plain") ?? "";
      let list: Shape[] | null = null;
      const m = html.match(new RegExp(`${CLIP_ATTR}="([^"]*)"`));
      if (m) {
        try {
          const parsed = JSON.parse(decodeURIComponent(m[1]));
          if (Array.isArray(parsed)) list = parsed.filter((s) => s && typeof s.type === "string");
        } catch {
          /* not ours */
        }
      } else if (CLIP && text === CLIP.text) list = CLIP.shapes;
      e.preventDefault();
      if (list?.length) {
        const n = CLIP && CLIP.shapes === list ? ++CLIP.pastes : 1;
        // Paste next to the originals when they're on screen, else in the middle of the view.
        const u = unionBox(list)!;
        const v = S.current.view;
        const svg = svgRef.current;
        const vis: Box = [-v.tx / v.z, -v.ty / v.z, ((svg?.clientWidth || 600) - v.tx) / v.z, ((svg?.clientHeight || 400) - v.ty) / v.z];
        if (intersects(u, vis)) pasteRef.current(list, 24 * n, 24 * n);
        else {
          const c = viewCenterRef.current();
          pasteRef.current(list, c[0] - (u[0] + u[2]) / 2, c[1] - (u[1] + u[3]) / 2);
        }
      } else if (text.trim()) {
        const c = viewCenterRef.current();
        um?.stopCapturing();
        const t = text.trim().slice(0, 2000);
        const sid = addShape(doc, boardId, t.length > 60 || t.includes("\n") ? { type: "sticky", x: c[0] - 75, y: c[1] - 55, w: 150, h: stickyHeight(t, 150, 110), fill: "y", text: t } : { type: "text", x: c[0] - 40, y: c[1], text: t, size: 18 }, origin);
        setSel([sid]);
      }
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [doc, boardId, origin, um]);
  // Handlers used by the document listeners above.
  const removeSelRef = useRef(removeSel);
  removeSelRef.current = removeSel;
  const pasteRef = useRef(paste);
  pasteRef.current = paste;
  const insertImagesRef = useRef(insertImages);
  insertImagesRef.current = insertImages;
  const viewCenterRef = useRef(viewCenter);
  viewCenterRef.current = viewCenter;

  /* ---- creating shapes ---- */
  /** `box`: the dragged box (BRD-07); `free`: keyboard placement moves to the nearest free spot (BRD-12). */
  const createAt = (t: Tool, x: number, y: number, o: { box?: Box; free?: boolean } = {}) => {
    if (t === "frame") {
      // BRD-21: a frame adopts the free shapes whose centre is inside it and goes behind them.
      let b: Box = o.box ?? [x - FRAME_SIZE.w / 2, y - FRAME_SIZE.h / 2, x + FRAME_SIZE.w / 2, y + FRAME_SIZE.h / 2];
      if (!o.box && o.free) {
        const [dx, dy] = freeSpot(b, S.current.shapes.filter((q) => q.type !== "arrow").map((q) => bbox(q) as Box));
        b = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
      }
      um?.stopCapturing();
      const fid = createFrame(doc, boardId, S.current.shapes, b, origin);
      setSel([fid]);
      setTool("select");
      setLive("Added frame. Press F2 to rename it");
      return;
    }
    let s: Omit<Shape, "id">;
    if (t === "sticky") s = { type: "sticky", x: x - 75, y: y - 55, w: 150, h: 110, fill: ["y", "b", "p", "g"][S.current.shapes.filter((q) => q.type === "sticky").length % 4], text: "" };
    else if (t === "text") s = { type: "text", x, y: y + 9, text: "", size: 18 };
    else s = { type: t as ShapeType, x: x - 70, y: y - (t === "diamond" ? 50 : 40), w: 140, h: t === "diamond" ? 100 : 80, text: "" };
    if (o.box && t !== "text") Object.assign(s, { x: Math.round(o.box[0]), y: Math.round(o.box[1]), w: Math.round(o.box[2] - o.box[0]), h: Math.round(o.box[3] - o.box[1]) });
    else if (o.free) {
      const others = S.current.shapes.filter((q) => q.type !== "arrow").map((q) => bbox(q) as Box);
      const [dx, dy] = freeSpot(bbox({ ...s, id: "" }) as Box, others);
      s.x = (s.x ?? 0) + dx;
      s.y = (s.y ?? 0) + dy;
    }
    um?.stopCapturing();
    const nidv = addShape(doc, boardId, s, origin);
    setSel([nidv]);
    setTool("select");
    if (t === "sticky" || t === "text") setEditing({ id: nidv, text: "" });
    else setLive(`Added ${TYPE_NAME[s.type].toLowerCase()}`);
  };

  /* ---- pointer ---- */
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current!;
    rootRef.current?.focus({ preventScroll: true });
    if (editRef.current) commitEdit();
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.current.size === 2) {
      // Pinch / two-finger pan: cancel whatever the first finger started.
      const [a, b] = [...pointers.current.values()];
      const r = svg.getBoundingClientRect();
      if (drag.current?.kind === "pen" || drag.current?.kind === "arrow" || drag.current?.kind === "create") setDraft(null);
      setHint(null);
      setMarquee(null);
      setGuides(null);
      flush();
      drag.current = { kind: "pinch", d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, c0: [(a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top], v: S.current.view };
      try { svg.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    const [x, y] = toWorld(e.clientX, e.clientY);
    const target = (e.target as Element).closest?.("[data-s]") as Element | null;
    // Zoomed out (LOD) the shapes have no elements of their own: hit-test by position.
    const sid = target?.getAttribute("data-s") ?? (lodOn(S.current.view.z, S.current.shapes.length) ? scene.hitAt([x, y], 6 / S.current.view.z) : null);
    const t = S.current.tool;
    const cap = () => {
      try { svg.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    };
    if (t === "hand" || e.button === 1 || space.current || (!S.current.edit && t !== "select")) {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, v: S.current.view };
      cap();
      return;
    }
    // Diagram mode: dragging from a port draws a connector from that port (3c).
    const portOf = (e.target as Element).getAttribute?.("data-port-of");
    if (portOf && S.current.dgm && S.current.edit) {
      const s0 = S.current.byId.get(portOf);
      const port = (e.target as Element).getAttribute("data-port")!;
      if (s0) {
        um?.stopCapturing();
        const p0 = portPoint(s0, port) ?? [x, y];
        setDraft({ id: "draft", type: "arrow", pts: [p0, p0], start: bindingTo(s0, port), ...connectorStyle() });
        drag.current = { kind: "arrow" };
        cap();
        return;
      }
    }
    if (t === "select") {
      if (sid) {
        const s = S.current.shapes.find((q) => q.id === sid);
        const tEl = e.target as Element;
        const wpAttr = tEl.getAttribute?.("data-wp") ?? null, segAttr = tEl.getAttribute?.("data-seg") ?? null;
        const segMove = tEl.getAttribute?.("data-segmove") ?? null;
        const handle = tEl.classList?.contains("ocbd-rz") || tEl.getAttribute?.("data-end") || wpAttr !== null || segAttr !== null || segMove !== null;
        // A click picks the shape's whole group; Shift adds or removes it.
        const ids = handle ? [sid] : withGroups(S.current.shapes, [sid]);
        const cur = S.current.sel;
        if (e.shiftKey && !handle) {
          const all = ids.every((i) => cur.includes(i));
          const next = all ? cur.filter((i) => !ids.includes(i)) : [...cur, ...ids.filter((i) => !cur.includes(i))];
          setSel(next);
          announceSel(next);
          return;
        }
        let next = cur.includes(sid) ? cur : ids;
        if (next !== cur) {
          setSel(next);
          announceSel(next);
        }
        if (s && S.current.edit) {
          um?.stopCapturing();
          const end = (e.target as Element).getAttribute?.("data-end");
          if (segMove !== null && s?.pts) {
            // Diagram mode (3e): dragging a segment of a routed elbow moves it; its corners become
            // your bends (`via`), drawn as diamonds.
            const i = Number(segMove);
            const pts = s.pts.map((q) => [q[0], q[1]] as Pt);
            drag.current = { kind: "wp", sid, i, insert: false, orig: [], moved: false, seg: { pts, horiz: Math.abs(pts[i][1] - pts[i + 1][1]) < 0.5 } };
          } else if (wpAttr !== null || segAttr !== null) {
            const r = rawOf(sid);
            const i = Number(wpAttr ?? segAttr);
            const way = r ? wayOf(r) : [];
            drag.current = { kind: "wp", sid, i, insert: segAttr !== null, orig: way, moved: false };
            if (wpAttr !== null) {
              setWp(i);
              announceWp(i, way.length);
            }
          } else if (end === "start" || end === "end") drag.current = { kind: "end", sid, which: end, orig: JSON.parse(JSON.stringify(s)), moved: false };
          else if ((e.target as Element).classList?.contains("ocbd-rz")) drag.current = { kind: "resize", sid, ox: x, oy: y, orig: JSON.parse(JSON.stringify(s)), moved: false };
          else {
            // Diagram mode: moving a container moves what it holds (3g).
            const boxes = S.current.dgm ? S.current.shapes.filter((q) => next.includes(q.id) && isContainer(q)) : [];
            if (boxes.length) next = [...next, ...containedIn(S.current.shapes, boxes).filter((x) => !next.includes(x))];
            // BRD-21: a frame's members (`props.parent`) move with it, in both modes.
            for (const f of S.current.shapes.filter((q) => next.includes(q.id) && isFrame(q))) next = [...next, ...membersOf(S.current.shapes, f.id).filter((x) => !next.includes(x))];
            const moving = S.current.shapes.filter((q) => next.includes(q.id));
            const set = new Set(next);
            const others = S.current.shapes.length > 1500 ? [] : S.current.shapes.filter((q) => !set.has(q.id) && q.type !== "arrow" && q.type !== "pen").map((q) => bbox(q));
            drag.current = {
              kind: "move", ids: next, ox: x, oy: y, moved: false, others,
              orig: new Map(moving.map((q) => [q.id, JSON.parse(JSON.stringify(q)) as Shape])),
              box: unionBox(moving.filter((q) => q.type !== "arrow" && q.type !== "pen")),
            };
          }
          cap();
        }
      } else if (e.pointerType === "touch") {
        // One finger on empty canvas pans (a box-select would fight with scrolling).
        if (!e.shiftKey) setSel([]);
        drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, v: S.current.view };
        cap();
      } else {
        // Mouse / pen on empty canvas: box-select (Shift adds). Space or the hand tool pans.
        const base = e.shiftKey ? S.current.sel : [];
        if (!e.shiftKey) setSel([]);
        drag.current = { kind: "box", x0: x, y0: y, base, add: e.shiftKey };
        cap();
      }
      return;
    }
    um?.stopCapturing();
    if (t === "pen") {
      setDraft({ id: "draft", type: "pen", pts: [[x, y]], stroke: "accent" });
      drag.current = { kind: "pen" };
      cap();
      return;
    }
    if (t === "arrow") {
      const b0 = scene.snap([x, y], 18 / S.current.view.z);
      const s0 = b0 ? S.current.shapes.find((q) => q.id === b0.shapeId) : undefined;
      const p0: Pt = s0 ? anchorPoint(s0, b0!.anchor) : [x, y];
      setDraft({ id: "draft", type: "arrow", pts: [p0, p0], ...(b0 ? { start: b0 } : {}), ...connectorStyle() });
      setHint(b0);
      drag.current = { kind: "arrow" };
      cap();
      return;
    }
    // BRD-05: the shape is made on pointer-up. Without preventDefault the pointer-down's mousedown
    // default would move focus to the board root right after a new note's editor took it, and the
    // editor would close before the first key. BRD-07: a drag sizes the shape.
    e.preventDefault();
    drag.current = { kind: "create", t, x0: x, y0: y, cx: e.clientX, cy: e.clientY, box: null };
    cap();
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" || pointers.current.has(e.pointerId)) {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      publish(wx, wy);
    }
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    const d = drag.current;
    if (!d) {
      // Diagram mode: pointing at a shape shows its ports (3b); editors only (10c).
      if (S.current.dgm && S.current.edit && S.current.tool === "select" && e.pointerType !== "touch") {
        const el = e.target as Element;
        const keep = el.getAttribute?.("data-port-of");
        const b = keep ? null : scene.snap(toWorld(e.clientX, e.clientY), 10 / S.current.view.z);
        const id = keep ?? (b && S.current.byId.get(b.shapeId)?.type !== "arrow" ? b.shapeId : null);
        if (id !== hoverRef.current) {
          hoverRef.current = id;
          setHoverId(id);
        }
      }
      return;
    }
    if (d.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts;
      const r = svgRef.current!.getBoundingClientRect();
      const c: [number, number] = [(a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top];
      const z = Math.min(ZMAX, Math.max(ZMIN, d.v.z * (Math.hypot(a[0] - b[0], a[1] - b[1]) / d.d0)));
      // keep the world point under the initial centre under the current centre (pans with two fingers)
      const wx = (d.c0[0] - d.v.tx) / d.v.z, wy = (d.c0[1] - d.v.ty) / d.v.z;
      setView({ z, tx: c[0] - wx * z, ty: c[1] - wy * z });
      return;
    }
    if (d.kind === "pan") {
      setView({ ...d.v, tx: d.v.tx + (e.clientX - d.sx), ty: d.v.ty + (e.clientY - d.sy) });
      return;
    }
    const [x, y] = toWorld(e.clientX, e.clientY);
    if (d.kind === "create") {
      // A drag (past 4 px on screen) sizes the new shape; Shift keeps it square. Text has no box.
      if (d.t === "text" || (!d.box && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 4)) return;
      let w = x - d.x0, h = y - d.y0;
      if (e.shiftKey) {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * m;
        h = Math.sign(h || 1) * m;
      }
      d.box = [Math.min(d.x0, d.x0 + w), Math.min(d.y0, d.y0 + h), Math.max(d.x0, d.x0 + w), Math.max(d.y0, d.y0 + h)];
      const [bx0, by0, bx1, by1] = d.box;
      setDraft({ id: "draft", type: d.t as ShapeType, x: bx0, y: by0, w: Math.max(1, bx1 - bx0), h: Math.max(1, by1 - by0), text: "", ...(d.t === "sticky" ? { fill: "y" } : {}), ...(d.t === "frame" ? { type: "rect", kind: CONTAINER } : {}) });
      return;
    }
    if (d.kind === "box") {
      const b: Box = [Math.min(d.x0, x), Math.min(d.y0, y), Math.max(d.x0, x), Math.max(d.y0, y)];
      if ((b[2] - b[0]) * S.current.view.z < 3 && (b[3] - b[1]) * S.current.view.z < 3) return;
      setMarquee(b);
      const hits = withGroups(S.current.shapes, scene.inBox(b));
      const next = d.add ? [...d.base, ...hits.filter((h) => !d.base.includes(h))] : hits;
      const cur = S.current.sel;
      if (next.length !== cur.length || next.some((id, i) => id !== cur[i])) setSel(next);
      return;
    }
    if (d.kind === "pen") {
      const p = draftRef.current;
      if (!p?.pts) return;
      const l = p.pts[p.pts.length - 1];
      if (Math.hypot(l[0] - x, l[1] - y) > 1.5 / S.current.view.z) setDraft({ ...p, pts: [...p.pts, [x, y]] });
      return;
    }
    if (d.kind === "arrow") {
      const p = draftRef.current;
      if (!p?.pts) return;
      let b = scene.snap([x, y], 18 / S.current.view.z, p.start?.shapeId);
      const s1 = b ? S.current.shapes.find((q) => q.id === b!.shapeId) : undefined;
      // Diagram mode: the nearest port of the shape under the pointer (side ports, not the centre).
      let at: Pt | null = s1 ? anchorPoint(s1, b!.anchor) : null;
      if (s1 && S.current.dgm) {
        const q = nearestPort(s1, [x, y]);
        const id = q.id === "center" ? b!.anchor : q.id;
        b = bindingTo(s1, id);
        at = portPoint(s1, id) ?? at;
      }
      const { end: _drop, ...rest } = p;
      void _drop;
      setDraft({ ...rest, pts: [p.pts[0], at ?? snapArrow(p.pts[0], [x, y], e.shiftKey)], ...(b ? { end: b } : {}) });
      setHint(b);
      return;
    }
    if (d.kind === "wp" && d.seg) {
      const r = rawOf(d.sid);
      if (!r) return;
      if (!d.moved) setDragging(true);
      d.moved = true;
      const q = d.seg.pts.map((p) => [p[0], p[1]] as Pt);
      const k = d.seg.horiz ? 1 : 0, v = Math.round(d.seg.horiz ? y : x);
      q[d.i][k] = v;
      q[d.i + 1][k] = v;
      schedule(d.sid, viaPatch(r, q.slice(1, -1)));
      return;
    }
    if (d.kind === "wp") {
      const r = rawOf(d.sid);
      if (!r) return;
      if (!d.moved) {
        setDragging(true);
        if (d.insert) setWp(d.i);
      }
      d.moved = true;
      const via = d.orig.map((p) => [p[0], p[1]] as Pt);
      const p: Pt = [Math.round(x), Math.round(y)];
      if (d.insert) via.splice(d.i, 0, p);
      else via[d.i] = p;
      schedule(d.sid, viaPatch(r, via));
      return;
    }
    if (d.kind === "end") {
      if (!d.moved) setDragging(true);
      d.moved = true;
      const o = d.orig;
      const other = d.which === "start" ? o.end : o.start;
      const b = scene.snap([x, y], 18 / S.current.view.z, other?.shapeId ?? o.id);
      const target = b ? S.current.shapes.find((q) => q.id === b.shapeId) : undefined;
      const p: Pt = target ? anchorPoint(target, b!.anchor) : [Math.round(x), Math.round(y)];
      const pts = (o.pts ?? []).map((q) => [q[0], q[1]] as Pt);
      if (pts.length < 2) return;
      // A bound or routed arrow is just its two ends; a free polyline keeps its middle points.
      const two = !!(b || other || o.route || viaOf(o).length);
      const next: Pt[] = two ? (d.which === "start" ? [p, pts[pts.length - 1]] : [pts[0], p]) : d.which === "start" ? [p, ...pts.slice(1)] : [...pts.slice(0, -1), p];
      schedule(d.sid, { pts: next, [d.which]: b ?? undefined });
      setHint(b);
      return;
    }
    let dx = x - d.ox, dy = y - d.oy;
    if (!d.moved && Math.hypot(dx, dy) * S.current.view.z < 2) return;
    if (!d.moved) setDragging(true);
    d.moved = true;
    if (d.kind === "resize") {
      const o = d.orig;
      if (o.type === "image" && o.w && o.h && !e.shiftKey) {
        // Images keep their aspect ratio (Shift frees it).
        const k = Math.max(40 / o.w, 30 / o.h, Math.max((o.w + dx) / o.w, (o.h + dy) / o.h));
        schedule(d.sid, { w: Math.round(o.w * k), h: Math.round(o.h * k) });
      } else schedule(d.sid, { w: Math.round(Math.max(40, (o.w ?? 0) + dx)), h: Math.round(Math.max(30, (o.h ?? 0) + dy)) });
      return;
    }
    // Move: snap the selection's box to other shapes' edges and centres (Alt moves freely).
    if (d.box && !e.altKey && S.current.dgm) {
      // Diagram mode (3a): other shapes' edges and centres, then equal gaps, then the grid.
      const P = S.current.dp, tol = 6 / S.current.view.z;
      const sn = P.snapShapes ? snapOffset(d.box, d.others, dx, dy, tol) : { dx, dy, gx: [] as number[], gy: [] as number[] };
      dx = sn.dx;
      dy = sn.dy;
      const mv: Box = [d.box[0] + dx, d.box[1] + dy, d.box[2] + dx, d.box[3] + dy];
      const eq = P.snapShapes ? equalGapOffset(mv, d.others, tol, { x: sn.gx.length > 0, y: sn.gy.length > 0 }) : { dx: 0, dy: 0, marks: [] as GapMark[] };
      dx += eq.dx;
      dy += eq.dy;
      if (P.snapGrid) {
        const [gx, gy] = gridOffset([d.box[0] + dx, d.box[1] + dy, 0, 0], P.gridSize);
        const xFree = !sn.gx.length && !eq.dx && !eq.marks.some((m) => m.y1 === m.y2);
        const yFree = !sn.gy.length && !eq.dy && !eq.marks.some((m) => m.x1 === m.x2);
        if (xFree) dx += gx;
        if (yFree) dy += gy;
      }
      setGuides(sn.gx.length || sn.gy.length ? { gx: sn.gx, gy: sn.gy } : null);
      setGaps(eq.marks.length ? eq.marks : null);
    } else if (d.box && !e.altKey) {
      const sn = snapOffset(d.box, d.others, dx, dy, 6 / S.current.view.z);
      dx = sn.dx;
      dy = sn.dy;
      setGuides(sn.gx.length || sn.gy.length ? { gx: sn.gx, gy: sn.gy } : null);
    } else {
      setGuides(null);
      setGaps(null);
    }
    const set = new Set(d.ids);
    d.orig.forEach((o) => {
      if (o.pts) {
        const bound = [o.start, o.end].filter(Boolean) as Binding[];
        // A connector moved with both of its shapes follows them (its waypoints move along);
        // moved alone it detaches.
        if (bound.length && bound.every((b) => set.has(b.shapeId))) {
          if (o.via?.length) schedule(o.id, { via: movePatch(o, dx, dy).via });
          return;
        }
        schedule(o.id, { ...movePatch(o, dx, dy), ...(bound.length ? { start: undefined, end: undefined } : {}) });
      } else schedule(o.id, movePatch(o, dx, dy));
    });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (d?.kind === "pinch") {
      if (pointers.current.size < 2) drag.current = null;
      return;
    }
    drag.current = null;
    setDragging(false);
    setGuides(null);
    setGaps(null);
    if (!d) return;
    setHint(null);
    if (d.kind === "create") {
      setDraft(null);
      if (e.type === "pointercancel") return;
      const b = d.box;
      // A drag sizes the shape (at least 10 × 10); a click places one of the default size.
      if (b && Math.max(b[2] - b[0], b[3] - b[1]) >= 8) createAt(d.t, d.x0, d.y0, { box: [b[0], b[1], Math.max(b[2], b[0] + 10), Math.max(b[3], b[1] + 10)] });
      else createAt(d.t, d.x0, d.y0);
      return;
    }
    if (d.kind === "box") {
      setMarquee(null);
      announceSel(S.current.sel);
      return;
    }
    if (d.kind === "wp" && d.moved && d.seg) setLive("Segment moved. Its corners are now your bends; Clear waypoints removes them");
    else if (d.kind === "wp" && d.moved) {
      const n = d.orig.length + (d.insert ? 1 : 0);
      announceWp(d.i, n);
    }
    if (d.kind === "move" || d.kind === "resize" || d.kind === "end" || d.kind === "wp") {
      let said: string | null = null;
      const movedIds = d.kind === "move" && d.moved ? d.ids : null;
      doc.transact(() => {
        flush();
        if (d.moved) syncAfter(d.kind === "move" ? d.ids : [d.sid]);
        // BRD-21: a moved shape joins the frame its centre was dropped in (or leaves its frame).
        const m = movedIds ? getBoardMap(doc, boardId) : null;
        if (m && movedIds) said = applyMembership(doc, boardId, readShapes(m), movedIds, origin);
      }, origin);
      if (said) setLive(said);
    }
    const p = draftRef.current;
    if (d.kind === "pen") {
      setDraft(null);
      if (p?.pts) {
        const pts: Pt[] = p.pts.length === 1 ? [p.pts[0], [p.pts[0][0] + 0.1, p.pts[0][1] + 0.1]] : simplify(p.pts);
        addShape(doc, boardId, { type: "pen", pts, stroke: "accent" }, origin);
      }
    }
    if (d.kind === "arrow") {
      setDraft(null);
      if (p?.pts) {
        const bound = !!(p.start && p.end && p.start.shapeId !== p.end.shapeId);
        const pts = resolveArrow(p, byId);
        const a = pts[0], b = pts[pts.length - 1];
        if (bound || (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 6)) {
          const s: Omit<Shape, "id"> = { type: "arrow", pts: pts.map((q) => [Math.round(q[0]), Math.round(q[1])] as Pt) };
          if (p.start) s.start = p.start;
          if (p.end && p.end.shapeId !== p.start?.shapeId) s.end = p.end;
          if (p.route) s.route = p.route;
          if (p.routing) s.routing = p.routing;
          if (p.dashed) s.dashed = true;
          if (p.props) s.props = { ...p.props };
          setSel([addShape(doc, boardId, s, origin)]);
        }
      }
      setTool("select");
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!S.current.edit) return;
    // Pointer capture retargets click/dblclick to the <svg>, so hit-test by position.
    const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(e.clientX, e.clientY) : null;
    const target = (hit ?? (e.target as Element)).closest?.("[data-s]");
    const sid = target?.getAttribute("data-s") ?? (lodOn(S.current.view.z, S.current.shapes.length) ? scene.hitAt(toWorld(e.clientX, e.clientY), 6 / S.current.view.z) : null);
    const s = sid ? S.current.shapes.find((q) => q.id === sid) : null;
    if (s && isFrame(s)) {
      // BRD-21: double-clicking a frame's name or edge renames it.
      frm.rename?.(s.id);
      return;
    }
    if (s) {
      // On a connector: double-click a waypoint to remove it, the line to add one there.
      // Its label (or Enter, or the toolbar) edits the text.
      if (s.type === "arrow" && !hit?.closest(".ocbd-alabel")) {
        const wpEl = hit?.closest("[data-wp]");
        if (wpEl) removeWaypoint(s.id, Number(wpEl.getAttribute("data-wp")));
        else if (!hit?.closest("[data-end]")) {
          setSel([s.id]);
          addWaypointAt(s.id, toWorld(e.clientX, e.clientY));
        }
        return;
      }
      startEdit(s);
      return;
    }
    if (S.current.tool !== "select") return;
    const [x, y] = toWorld(e.clientX, e.clientY);
    const nidv = addShape(doc, boardId, { type: "text", x, y: y + 9, text: "", size: 18 }, origin);
    setSel([nidv]);
    setEditing({ id: nidv, text: "" });
  };

  /* ---- wheel (non-passive) ---- */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Inline, one trackpad gesture keeps the axis it started with (events < 200 ms apart): a
    // sideways pan that drifts down must not start scrolling the page halfway, nor the reverse.
    let axis: "x" | "y" = "y", last = -Infinity;
    const onWheel = (e: WheelEvent) => {
      const r = svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
        return;
      }
      if (big) {
        e.preventDefault();
        setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
        return;
      }
      const now = performance.now();
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (now - last > 200) axis = sideways ? "x" : "y";
      last = now;
      if (axis === "x") {
        // A sideways swipe pans the board; left to the browser it becomes Back at the page edge.
        e.preventDefault();
        setView((v) => ({ ...v, tx: v.tx - e.deltaX }));
      } else if (sideways) e.preventDefault();
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [mode]);

  /* ---- keyboard ---- */
  const nudge = (dx: number, dy: number) => {
    const list = selShapes();
    const set = new Set(list.map((s) => s.id));
    const moves: { id: string; patch: Partial<Shape> }[] = [];
    for (const s of list) {
      if (s.pts) {
        const bound = [s.start, s.end].filter(Boolean) as Binding[];
        if (bound.length && bound.every((b) => set.has(b.shapeId))) {
          if (s.via?.length) moves.push({ id: s.id, patch: { via: movePatch(s, dx, dy).via } });
          continue;
        }
        moves.push({ id: s.id, patch: { ...movePatch(raw.find((q) => q.id === s.id) ?? s, dx, dy), ...(bound.length ? { start: undefined, end: undefined } : {}) } });
      } else moves.push({ id: s.id, patch: movePatch(s, dx, dy) });
    }
    // One transaction, so one undo step whatever the undo manager's capture window.
    doc.transact(() => {
      moves.forEach((m) => updateShape(doc, boardId, m.id, m.patch, origin));
      syncAfter(moves.map((m) => m.id));
    }, origin);
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === " ") space.current = false;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    // Typing in a field of this board keeps its keys. (The board itself sits inside the editor's
    // contenteditable document, so only editable elements inside the board count.)
    const typing = t.closest("textarea,input,[contenteditable='true']");
    if (typing && typing !== rootRef.current && rootRef.current?.contains(typing)) return;
    // Buttons in the toolbars keep Space / Enter / Tab; board shortcuts only from the canvas.
    const onCanvas = t === rootRef.current;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") {
      if (S.current.wp !== null) {
        setWp(null);
        setLive("Connector selected");
      } else if (menu) setMenu(false);
      else if (S.current.tool !== "select") setTool("select");
      else if (S.current.sel.length) {
        setSel([]);
        announceSel([]);
      } else if (dgm) closeDiagram();
      else if (full) exitFull();
      return;
    }
    // ⇧⌘C: copy the selection (or the board) as PNG (BRD-20).
    if (mod && e.shiftKey && !e.altKey && k === "c") {
      e.preventDefault();
      void xport.copy("png");
      return;
    }
    // BRD-21: ⇧P presents the frames (from the selected one); F2 renames the selected frame.
    if (e.shiftKey && !mod && !e.altKey && k === "p") {
      e.preventDefault();
      const f = S.current.sel.length === 1 ? S.current.sel[0] : undefined;
      if (!frm.present(f && frm.frames.some((q) => q.id === f) ? f : undefined)) setLive("No frames to present. Draw one with F");
      return;
    }
    if (e.key === "F2" && frm.rename && S.current.sel.length === 1 && frm.frames.some((q) => q.id === S.current.sel[0])) {
      e.preventDefault();
      frm.rename(S.current.sel[0]);
      return;
    }
    // Shift+D: open this board as a diagram (1b).
    if (e.shiftKey && !mod && !e.altKey && k === "d" && !dgm && env.diagramming !== false) {
      e.preventDefault();
      void openDiagram();
      return;
    }
    if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomCenter(1.2);
      return;
    }
    if (mod && e.key === "-") {
      e.preventDefault();
      zoomCenter(1 / 1.2);
      return;
    }
    if ((mod && e.key === "0") || (e.shiftKey && e.code === "Digit0")) {
      e.preventDefault();
      setView((v) => {
        const svg = svgRef.current;
        const cx = (svg?.clientWidth ?? 0) / 2, cy = (svg?.clientHeight ?? 0) / 2;
        return { z: 1, tx: cx - (cx - v.tx) / v.z, ty: cy - (cy - v.ty) / v.z };
      });
      return;
    }
    if (e.shiftKey && !mod && e.code === "Digit1") {
      e.preventDefault();
      fit();
      return;
    }
    if (e.shiftKey && !mod && e.code === "Digit2" && S.current.sel.length) {
      e.preventDefault();
      fitBox(unionBox(selShapes()), 2);
      return;
    }
    if (onCanvas && e.key === " ") {
      e.preventDefault();
      space.current = true;
      return;
    }
    // Tab / Shift+Tab walk through the shapes; past the last one focus leaves the board.
    if (onCanvas && e.key === "Tab" && !mod && !e.altKey) {
      const list = S.current.shapes;
      if (!list.length) return;
      const cur = S.current.sel.length === 1 ? list.findIndex((s) => s.id === S.current.sel[0]) : -1;
      const next = cur < 0 ? (e.shiftKey ? list.length - 1 : 0) : cur + (e.shiftKey ? -1 : 1);
      if (next < 0 || next >= list.length) {
        setSel([]);
        return;
      }
      e.preventDefault();
      setSel([list[next].id]);
      announceSel([list[next].id]);
      return;
    }
    if (mod && k === "a") {
      e.preventDefault();
      const all = S.current.shapes.map((s) => s.id);
      setSel(all);
      announceSel(all);
      return;
    }
    if (k === "m" && !mod && !e.altKey) {
      setMini((v) => !v);
      setLive(mini ? "Minimap hidden" : "Minimap shown");
      return;
    }
    if (!S.current.edit) {
      if (!mod && (k === "v" || k === "h")) setTool(KEY_TOOL[k]);
      return;
    }
    // A single selected connector: W adds a waypoint, Alt+Left/Right picks one, arrows move the
    // picked one, Delete removes it (the keyboard path for dragging waypoints).
    const conn = S.current.sel.length === 1 ? S.current.raw.find((q) => q.id === S.current.sel[0] && q.type === "arrow") : undefined;
    if (conn && !mod) {
      const way = wayOf(conn);
      const cur = S.current.wp;
      if (k === "w" && !e.altKey) {
        e.preventDefault();
        addWaypoint(conn.id);
        return;
      }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && way.length) {
        e.preventDefault();
        const i = cur === null ? (e.key === "ArrowLeft" ? way.length - 1 : 0) : Math.max(0, Math.min(way.length - 1, cur + (e.key === "ArrowLeft" ? -1 : 1)));
        setWp(i);
        announceWp(i, way.length);
        return;
      }
      if (cur !== null && cur < way.length) {
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          removeWaypoint(conn.id, cur);
          return;
        }
        if (e.key.startsWith("Arrow") && !e.altKey) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const next = way.map((p) => [p[0], p[1]] as Pt);
          next[cur] = [next[cur][0] + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0), next[cur][1] + (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0)];
          setVia(conn.id, next, false);
          return;
        }
      }
    }
    if (mod && k === "z") {
      e.preventDefault();
      undo(e.shiftKey);
      return;
    }
    if (mod && k === "y") {
      e.preventDefault();
      undo(true);
      return;
    }
    if (mod && k === "d") {
      e.preventDefault();
      dupSel();
      return;
    }
    if (mod && k === "g") {
      e.preventDefault();
      groupSel(!e.shiftKey);
      return;
    }
    if (mod && (e.key === "]" || e.key === "[" || e.code === "BracketRight" || e.code === "BracketLeft")) {
      e.preventDefault();
      const up = e.key === "]" || e.code === "BracketRight";
      zSel(e.shiftKey || e.altKey ? (up ? "front" : "back") : up ? "forward" : "backward");
      return;
    }
    const list = selShapes();
    if ((e.key === "Backspace" || e.key === "Delete") && list.length) {
      e.preventDefault();
      removeSel();
      return;
    }
    if (e.key === "Enter" && onCanvas) {
      const T = S.current.tool;
      if (T === "arrow" && list.length >= 2) {
        e.preventDefault();
        connectSel();
        setTool("select");
        return;
      }
      if (T !== "select" && T !== "hand" && T !== "pen" && T !== "arrow") {
        // Keyboard placement: the active tool drops its shape in the middle of the view.
        e.preventDefault();
        const c = viewCenter();
        createAt(T, c[0], c[1], { free: true });
        return;
      }
      if (list.length === 1) {
        e.preventDefault();
        startEdit(list[0]);
      }
      return;
    }
    if (list.length && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      if (e.altKey) {
        // Alt+arrows resize (the keyboard alternative to dragging the handle).
        const s = list[0];
        if (list.length !== 1 || !SIZED.includes(s.type)) return;
        doc.transact(() => {
          updateShape(doc, boardId, s.id, { w: Math.max(40, (s.w ?? 0) + dx), h: Math.max(30, (s.h ?? 0) + dy) }, origin);
          syncAfter([s.id]);
        }, origin);
        setLive(`${Math.round(Math.max(40, (s.w ?? 0) + dx))} by ${Math.round(Math.max(30, (s.h ?? 0) + dy))}`);
        return;
      }
      nudge(dx, dy);
      return;
    }
    if (!mod && !e.altKey && KEY_TOOL[k]) {
      setTool(KEY_TOOL[k]);
      if (KEY_TOOL[k] !== "select" && KEY_TOOL[k] !== "hand" && KEY_TOOL[k] !== "pen") setLive(`${TOOLS.find((x) => x[0] === KEY_TOOL[k])![2]} tool. Press Enter to place one in the middle of the view`);
    }
  };

  /* ---- full screen ---- */
  const exitFull = () => {
    setFull(false);
    if (compact) setActive(false);
  };

  /* ---- diagram mode (DGM-14 S1) ---- */
  /** Route of a new connector: the diagram's "New connectors" style, else the board's toggle. */
  const connectorStyle = (): Partial<Shape> => {
    const pr = presetRef.current;
    if (pr) {
      const base = pr.fields.route === "elbow" || (S.current.dgm && S.current.dp.connector !== "straight") ? { route: "elbow" as const } : {};
      const avoid = S.current.dgm && S.current.dp.connector === "avoid" && (base.route || pr.fields.route) ? { routing: "avoid" as const } : {};
      return { ...base, ...avoid, ...(pr.fields.dashed ? { dashed: true } : {}), props: { ...pr.props } };
    }
    if (!S.current.dgm) return route === "elbow" ? { route } : {};
    const c = S.current.dp.connector;
    return c === "straight" ? {} : c === "avoid" ? { route: "elbow", routing: "avoid" } : { route: "elbow" };
  };
  const openDiagram = async () => {
    setMenu(false);
    const m = await loadShell();
    const el = rootRef.current;
    setPhH(el?.offsetHeight ?? 0);
    setPlace({ heading: m.headingAbove(el), title: m.documentTitle(el) });
    setDg(m);
    setFull(false);
    setActive(true);
    setDgm("open");
  };
  const closeDiagram = () => {
    setMenu(false);
    setDgm((d) => (d ? "closing" : d));
  };
  const diagramClosed = () => {
    // Only a close that is still in progress ends diagram mode: a late "closed" from an earlier
    // close must not shut a diagram reopened in the meantime.
    if (S.current.dgm !== "closing") return;
    refocus.current = true;
    setDgm(null);
    if (compact) setActive(false);
    env.toast("Back in the document");
  };
  // Focus returns to the Diagram button (or the board) so keyboard users land where they started (1e).
  useEffect(() => {
    if (dgm === "open") rootRef.current?.focus({ preventScroll: true });
    if (dgm === null && refocus.current) {
      refocus.current = false;
      (dgmBtn.current ?? rootRef.current)?.focus({ preventScroll: true });
    }
  }, [dgm]);

  useEffect(() => {
    if (!full && !dgm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || editRef.current || S.current.sel.length) return;
      // The canvas handles its own Escape (deselect first); fields keep theirs.
      const t = e.target as Node | null;
      if (t && rootRef.current?.contains(t)) return;
      if (t instanceof HTMLElement && t.closest("input,textarea,select,[contenteditable='true'],[role=menu],[role=listbox]")) return;
      if (dgm) closeDiagram();
      else exitFull();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [mode]);

  // Refit when entering / leaving full screen (the viewport size changes a lot).
  const firstFull = useRef(true);
  useEffect(() => {
    if (firstFull.current) {
      firstFull.current = false;
      return;
    }
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
  }, [mode]);

  // Drop selected shapes that disappear (remote delete, undo).
  useEffect(() => {
    if (sel.length && sel.some((id) => !byId.has(id))) setSel(sel.filter((id) => byId.has(id)));
    if (editing && !byId.has(editing.id)) setEditing(null);
  }, [shapes, sel, editing]);

  /* ---- render ---- */
  const selList = sel.map((id) => byId.get(id)).filter((s): s is Shape => !!s);
  const selShape = selList.length === 1 ? selList[0] : null;
  const { tx, ty, z } = view;
  const ah = `ocbd-ah-${uid}`;
  const dots = `ocbd-dots-${uid}`;
  const cursor = tool_ === "hand" ? (drag.current?.kind === "pan" ? "grabbing" : "grab") : tool_ === "select" ? "default" : "crosshair";

  // Viewport culling for big boards (selected / edited shapes always render).
  const [W, H] = size;
  // Through the scene index: the same shapes, in the same order, as filtering the board.
  // Level of detail (DGM-19): zoomed out on a big board, every shape is drawn by the grouped
  // paths of <LodLayer> (memoised on the shapes and a zoom bucket, so a pan re-renders nothing);
  // only the selected and edited shapes keep their full views, above it.
  const lod = lodOn(z, shapes.length);
  const zb = lod ? lodBucket(z) : 0;
  const visible = useMemo(() => {
    if (lod) {
      const keep = new Set(editing ? [...sel, editing.id] : sel);
      return [...keep].map((id) => byId.get(id)).filter((s): s is Shape => !!s).sort((a, b) => scene.posOf(a.id)! - scene.posOf(b.id)!);
    }
    if (shapes.length <= CULL_AT || !W) return shapes;
    const m = 200 / z;
    const vb: Box = [-tx / z - m, -ty / z - m, (W - tx) / z + m, (H - ty) / z + m];
    return scene.visible(vb, editing ? [...sel, editing.id] : sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, scene, W, H, tx, ty, z, sel, editing, lod]);

  // Where the board SVG sits in the root (the LOD underlay is placed there).
  const lodAt: [number, number] = (() => {
    const r = rootRef.current?.getBoundingClientRect(), v = svgRef.current?.getBoundingClientRect();
    return lod && r && v ? [v.left - r.left, v.top - r.top] : [0, 0];
  })();
  const background: ReactNode = dgm ? (
    dp.grid ? (
      <g data-grid="" pointerEvents="none">
        {dp.gridSize * z >= 6 ? <rect width="100%" height="100%" fill={`url(#${dots}-g)`} /> : null}
        <rect width="100%" height="100%" fill={`url(#${dots}-G)`} />
      </g>
    ) : null
  ) : (
    <rect width="100%" height="100%" fill={`url(#${dots})`} />
  );

  let selection: ReactNode = null;
  if (selList.length && !editing) {
    const sw = 1.5 / z;
    selection = (
      <>
        {selList.map((s) =>
          s.type === "arrow" ? (
            s.pts && s.pts.length >= 2 ? <path key={s.id} d={"M" + s.pts.map((q) => q.join(" ")).join(" L")} fill="none" stroke="var(--accent)" strokeWidth={sw} strokeOpacity={0.5} pointerEvents="none" /> : null
          ) : (
            (() => {
              const b = bbox(s);
              return <rect key={s.id} x={b[0] - 6} y={b[1] - 6} width={b[2] - b[0] + 12} height={b[3] - b[1] + 12} rx={6} fill="none" stroke="var(--accent)" strokeWidth={sw} pointerEvents="none" />;
            })()
          ),
        )}
        {selList.length > 1
          ? (() => {
              const u = unionBox(selList)!;
              return <rect x={u[0] - 12} y={u[1] - 12} width={u[2] - u[0] + 24} height={u[3] - u[1] + 24} rx={8} fill="none" stroke="var(--accent)" strokeWidth={sw} strokeDasharray={`${4 / z} ${4 / z}`} pointerEvents="none" />;
            })()
          : null}
        {selShape?.type === "arrow" && selShape.pts && selShape.pts.length >= 2 && edit
          ? (["start", "end"] as const).map((which) => {
              const q = which === "start" ? selShape.pts![0] : selShape.pts![selShape.pts!.length - 1];
              const bound = !!selShape[which];
              return (
                <circle
                  key={which}
                  className="ocbd-ep"
                  data-s={selShape.id}
                  data-end={which}
                  cx={q[0]}
                  cy={q[1]}
                  r={(compact ? 10 : 6) / z}
                  fill={bound ? "var(--accent)" : "var(--app)"}
                  stroke="var(--accent)"
                  strokeWidth={sw}
                  style={{ cursor: "crosshair" }}
                >
                  <title>{bound ? "Drag away to detach" : "Drag onto a shape to connect"}</title>
                </circle>
              );
            })
          : null}
        {selShape?.type === "arrow" && selShape.pts && selShape.pts.length >= 2 && edit
          ? (() => {
              // Waypoints (drag; double-click removes) and, between control points, "+" handles
              // that insert one where you drag them to.
              const r = raw.find((q) => q.id === selShape.id);
              if (!r) return null;
              const way = wayOf(r);
              const c: Pt[] = [selShape.pts[0], ...way, selShape.pts[selShape.pts.length - 1]];
              const out: ReactNode[] = [];
              if (way.length && r.route === "elbow") {
                out.push(<path key="ctl" d={"M" + c.map((q) => q.join(" ")).join(" L")} fill="none" stroke="var(--accent)" strokeOpacity={0.35} strokeWidth={1 / z} strokeDasharray={`${3 / z} ${3 / z}`} pointerEvents="none" />);
              }
              // Diagram mode, a routed elbow without bends yet: handles on its inner segments move them (3e).
              const sp = selShape.pts;
              if (dgm && r.route === "elbow" && !way.length && sp.length >= 4) {
                for (let i = 1; i < sp.length - 2; i++) {
                  const horiz = Math.abs(sp[i][1] - sp[i + 1][1]) < 0.5;
                  out.push(
                    <rect key={"segm" + i} className="ocbd-wpadd" data-s={selShape.id} data-segmove={i} x={(sp[i][0] + sp[i + 1][0]) / 2 - (horiz ? 9 : 3) / z} y={(sp[i][1] + sp[i + 1][1]) / 2 - (horiz ? 3 : 9) / z} width={(horiz ? 18 : 6) / z} height={(horiz ? 6 : 18) / z} rx={3 / z} fill="var(--app)" stroke="var(--accent)" strokeWidth={1.25 / z} style={{ cursor: horiz ? "ns-resize" : "ew-resize" }}>
                      <title>Drag to move this segment</title>
                    </rect>,
                  );
                }
                return out;
              }
              for (let i = 0; i < c.length - 1; i++) {
                if (Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]) * z < (compact ? 56 : 36)) continue;
                out.push(
                  <circle key={"seg" + i} className="ocbd-wpadd" data-s={selShape.id} data-seg={i} cx={(c[i][0] + c[i + 1][0]) / 2} cy={(c[i][1] + c[i + 1][1]) / 2} r={(compact ? 8 : 4.5) / z} fill="var(--app)" stroke="var(--accent)" strokeOpacity={0.7} strokeWidth={1.25 / z} style={{ cursor: "copy" }}>
                    <title>Drag to add a waypoint (W)</title>
                  </circle>,
                );
              }
              way.forEach((q, i) =>
                out.push(
                  dgm ? (
                    // Diagram mode: your own bends are diamonds (3e), apart from the router's corners.
                    (() => {
                      const r = ((compact ? 9 : 5.5) + (wp === i ? 1 : 0)) / z;
                      return (
                        <rect key={"wp" + i} className={"ocbd-wp" + (wp === i ? " on" : "")} data-s={selShape.id} data-wp={i} x={q[0] - r * 0.8} y={q[1] - r * 0.8} width={r * 1.6} height={r * 1.6} transform={`rotate(45 ${q[0]} ${q[1]})`} fill={wp === i ? "var(--accent)" : "var(--app)"} stroke="var(--accent)" strokeWidth={sw} style={{ cursor: "move" }}>
                          <title>Your bend. Drag to move. Double-click or Delete removes it</title>
                        </rect>
                      );
                    })()
                  ) : (
                    <circle key={"wp" + i} className={"ocbd-wp" + (wp === i ? " on" : "")} data-s={selShape.id} data-wp={i} cx={q[0]} cy={q[1]} r={((compact ? 9 : 5.5) + (wp === i ? 1 : 0)) / z} fill={wp === i ? "var(--accent)" : "var(--app)"} stroke="var(--accent)" strokeWidth={sw} style={{ cursor: "move" }}>
                      <title>Drag to move. Double-click or Delete removes it</title>
                    </circle>
                  ),
                ),
              );
              return out;
            })()
          : null}
        {edit && selShape && SIZED.includes(selShape.type)
          ? (() => {
              const b = bbox(selShape);
              return (
                <rect
                  className="ocbd-rz"
                  data-s={selShape.id}
                  x={b[2] + 6 - 5 / z}
                  y={b[3] + 6 - 5 / z}
                  width={(compact ? 16 : 10) / z}
                  height={(compact ? 16 : 10) / z}
                  rx={2 / z}
                  fill="var(--app)"
                  stroke="var(--accent)"
                  strokeWidth={sw}
                  style={{ cursor: "nwse-resize" }}
                >
                  <title>Drag to resize (Alt+arrow keys too)</title>
                </rect>
              );
            })()
          : null}
      </>
    );
  }

  // Diagram mode: the hovered shape's ports (3b), not while drawing a connector to it.
  let portDots: ReactNode = null;
  const portShape = dgm && edit && hoverId && !draft ? byId.get(hoverId) : undefined;
  if (portShape && portShape.type !== "arrow" && portShape.type !== "pen") {
    portDots = (
      <g className="ocbd-ports">
        {portsOf(portShape)
          .filter((q) => q.id !== "center")
          .map((q) => {
            const at = portPoint(portShape, q.id);
            if (!at) return null;
            return (
              <circle key={q.id} data-port-of={portShape.id} data-port={q.id} cx={at[0]} cy={at[1]} r={5 / z} fill="var(--app)" stroke="var(--accent)" strokeWidth={1.5 / z} style={{ cursor: "crosshair" }}>
                <title>{`Port: ${q.id}`}</title>
              </circle>
            );
          })}
      </g>
    );
  }
  let hintDots: ReactNode = null;
  const hintShape = hint ? byId.get(hint.shapeId) : undefined;
  if (hint && hintShape) {
    const b = bbox(hintShape);
    hintDots = (
      <g pointerEvents="none" className="ocbd-hint">
        <rect x={b[0] - 4} y={b[1] - 4} width={b[2] - b[0] + 8} height={b[3] - b[1] + 8} rx={8} fill="none" stroke="var(--accent)" strokeOpacity={0.45} strokeWidth={1.5 / z} />
        {ANCHORS.map((a) => {
          const q = anchorPoint(hintShape, a);
          const on = a === hint.anchor;
          return <circle key={a} data-anchor={a} cx={q[0]} cy={q[1]} r={(on ? 5.5 : 3.5) / z} fill={on ? "var(--accent)" : "var(--app)"} stroke="var(--accent)" strokeWidth={1.5 / z} />;
        })}
      </g>
    );
  }

  // Other people's selections, outlined in their colour.
  const peerSel: ReactNode[] = [];
  for (const p of peers) {
    const list = p.sel.map((id) => byId.get(id)).filter((s): s is Shape => !!s);
    if (!list.length) continue;
    const u = unionBox(list)!;
    peerSel.push(
      <g key={p.id} pointerEvents="none" className="ocbd-peersel">
        {list.map((s) => {
          if (s.pts && s.pts.length > 1) return <path key={s.id} d={"M" + s.pts.map((q) => q.join(" ")).join(" L")} fill="none" stroke={p.color} strokeOpacity={0.6} strokeWidth={4 / z} strokeLinecap="round" strokeLinejoin="round" />;
          const b = bbox(s);
          return <rect key={s.id} x={b[0] - 4} y={b[1] - 4} width={b[2] - b[0] + 8} height={b[3] - b[1] + 8} rx={6} fill="none" stroke={p.color} strokeWidth={2 / z} />;
        })}
        <g transform={`translate(${u[0] - 4} ${u[1] - 4}) scale(${1 / z})`}>
          <rect x={0} y={-18} width={Math.min(140, p.name.length * 6.4 + 12)} height={17} rx={4} fill={p.color} />
          <text x={6} y={-6} fontSize={11} fontWeight={600} fill="#fff">{p.name.length > 20 ? p.name.slice(0, 19) + "…" : p.name}</text>
        </g>
      </g>,
    );
  }

  /* ---- contextual toolbar ---- */
  let swatch: ReactNode = null;
  if (selList.length && edit && !editing && !dragging && !marquee) {
    const u = unionBox(selList)!;
    const Wd = svgRef.current?.clientWidth || 600;
    // Kept inside the canvas (8 px gutter; past the ruler in diagram mode) by its measured width;
    // the guess only holds for the first frame.
    const edgeL = 8 + (dgm && dp.rulers ? 20 : 0), edgeR = 8;
    const half = (barW || (selList.length > 1 ? 400 : 300)) / 2;
    const lo = edgeL + half, hi = Wd - edgeR - half;
    const sx0 = lo > hi ? (edgeL + Wd - edgeR) / 2 : Math.max(lo, Math.min(hi, ((u[0] + u[2]) / 2) * z + tx));
    // Above the selection. Without room there it would sit on the board's own buttons and over the
    // shape, so it goes under the selection; only when neither fits is it pinned under the top edge.
    const minTop = compact ? 64 : 56;
    const above = u[1] * z + ty - 14, below = u[3] * z + ty + 14;
    const Hd = svgRef.current?.clientHeight ?? 0;
    let flip = above < minTop && below + (compact ? 56 : 44) <= Hd;
    let sy = flip ? below : Math.max(minTop, above);
    let sx = sx0;
    // BRD-10: never over the board's own controls (top actions, tool bar, zoom pill). If the usual
    // place covers one, try above, then below, each also moved sideways clear of the control.
    const svgR = svgRef.current?.getBoundingClientRect();
    const blocks: Box[] = svgR
      ? [...(rootRef.current?.querySelectorAll<HTMLElement>(".ocbd-top, .ocbd-tool, .ocbd-zoom") ?? [])]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => [r.left - svgR.left - 6, r.top - svgR.top - 6, r.right - svgR.left + 6, r.bottom - svgR.top + 6] as Box)
      : [];
    if (blocks.length) {
      const barH = barRef.current?.offsetHeight || (compact ? 44 : 36);
      const rect = (x: number, y: number, down: boolean): Box => (down ? [x - half, y, x + half, y + barH] : [x - half, y - barH, x + half, y]);
      const free = (b: Box) => !blocks.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
      if (!free(rect(sx, sy, flip))) {
        const xs = [sx, ...blocks.flatMap((o) => [o[0] - half, o[2] + half])].map((x) => (lo > hi ? x : Math.max(lo, Math.min(hi, x))));
        const ys: [number, boolean][] = [[above, false], [below, true], [sy, flip]];
        const fits = ([y, down]: [number, boolean]) => (down ? y + barH <= Hd : y - barH >= 0);
        let best: [number, number, boolean] | null = null;
        for (const yy of ys.filter(fits))
          for (const x of xs)
            if (free(rect(x, yy[0], yy[1])) && (!best || Math.abs(x - sx0) < Math.abs(best[0] - sx0))) best = [x, yy[0], yy[1]];
        if (best) [sx, sy, flip] = best;
      }
    }
    const s1 = selShape;
    const rawSel = s1 ? raw.find((q) => q.id === s1.id) : undefined;
    const btn = (label: string, I: LucideIcon, run: () => void, opts: { pressed?: boolean; disabled?: boolean; keys?: string } = {}) => (
      <button key={label} className="ocbd-ib" title={label + (opts.keys ? ` (${opts.keys})` : "")} aria-label={label} aria-pressed={opts.pressed} aria-keyshortcuts={opts.keys?.replace(/Ctrl/g, "Control")} disabled={opts.disabled} onClick={run}>
        <I size={14} strokeWidth={SW} />
      </button>
    );
    const sep = (k: string) => <span key={k} className="sep" />;
    const items: ReactNode[] = [];
    if (s1?.type === "sticky") {
      (["y", "p", "b", "g"] as const).forEach((c) =>
        items.push(
          <button key={c} data-c={c} style={{ background: STICKY[c] }} aria-label={{ y: "Yellow", p: "Pink", b: "Blue", g: "Green" }[c]} aria-pressed={(s1.fill ?? "y") === c} onClick={() => updateShape(doc, boardId, s1.id, { fill: c }, origin)} />,
        ),
      );
      items.push(sep("s1"));
    } else if (s1?.type === "swatch") {
      Object.keys(SWATCH).slice(0, 5).forEach((c) =>
        items.push(<button key={c} data-c={c} style={{ background: SWATCH[c] }} aria-label={c} aria-pressed={s1.fill === c} onClick={() => updateShape(doc, boardId, s1.id, { fill: c }, origin)} />),
      );
      items.push(sep("s1"));
    } else if (s1 && BOXY.includes(s1.type) && !s1.dashed) {
      items.push(
        <button key="none" data-c="none" className="none" style={{ background: "var(--app)" }} aria-label="No fill" aria-pressed={!s1.fill} onClick={() => updateShape(doc, boardId, s1.id, { fill: undefined }, origin)} />,
      );
      TONES.forEach((c) =>
        items.push(<button key={c} data-c={c} style={{ background: `var(--${c}-bg)`, boxShadow: `inset 0 0 0 1.5px var(--${c}-fg)` }} aria-label={`${TONE_NAME[c]} fill`} aria-pressed={s1.fill === c} onClick={() => updateShape(doc, boardId, s1.id, { fill: c }, origin)} />),
      );
      items.push(sep("s1"));
    } else if (s1?.type === "arrow") {
      ([["straight", MoveUpRight, "Straight connector"], ["elbow", CornerDownRight, "Elbow connector"]] as const).forEach(([r, I, label]) =>
        items.push(
          btn(label, I, () => {
            setRoute(r);
            doc.transact(() => {
              updateShape(doc, boardId, s1.id, { route: r }, origin);
              syncAfter([s1.id]);
            }, origin);
          }, { pressed: (rawSel?.route ?? "straight") === r }),
        ),
      );
      const way = rawSel ? wayOf(rawSel) : [];
      items.push(btn("Add waypoint", Spline, () => addWaypoint(s1.id), { keys: "W" }));
      if (wp !== null && wp < way.length) items.push(btn("Remove waypoint", CircleMinus, () => removeWaypoint(s1.id, wp), { keys: "Delete" }));
      if (way.length) items.push(btn("Clear waypoints", RouteOff, () => { setVia(s1.id, []); setWp(null); setLive("Waypoints cleared"); }));
      items.push(sep("s1"));
    }
    if (s1 && (s1.type === "text" || BOXY.includes(s1.type))) {
      const sizes = s1.type === "text" ? TEXT_SIZES : SHAPE_SIZES;
      const cur = s1.size ?? (s1.type === "text" ? 18 : 14);
      const i = sizes.indexOf(cur);
      const next = sizes[(i + 1) % sizes.length] ?? sizes[0];
      const names = ["Small", "Medium", "Large", "Extra large"];
      items.push(btn(`Text size: ${names[Math.max(0, i)] ?? cur + " px"}. Change to ${names[sizes.indexOf(next)]}`, ALargeSmall, () => updateShape(doc, boardId, s1.id, { size: next }, origin)));
    }
    if (s1 && TEXTUAL.includes(s1.type)) items.push(btn(s1.type === "arrow" ? "Edit label" : "Edit text", Type, () => startEdit(s1), { keys: "Enter" }));
    if (selList.length > 1) {
      items.push(btn("Align left", AlignStartVertical, () => align("left")));
      items.push(btn("Align centres horizontally", AlignCenterVertical, () => align("hcenter")));
      items.push(btn("Align right", AlignEndVertical, () => align("right")));
      items.push(btn("Align top", AlignStartHorizontal, () => align("top")));
      items.push(btn("Align middles", AlignCenterHorizontal, () => align("vcenter")));
      items.push(btn("Align bottom", AlignEndHorizontal, () => align("bottom")));
      if (selList.length > 2) {
        items.push(btn("Distribute horizontally", AlignHorizontalDistributeCenter, () => distribute("h")));
        items.push(btn("Distribute vertically", AlignVerticalDistributeCenter, () => distribute("v")));
      }
      items.push(sep("s2"));
      if (selList.filter((s) => s.type !== "arrow" && s.type !== "pen").length === 2) items.push(btn("Connect with an arrow", Waypoints, connectSel));
      const grouped = selList.length > 1 && selList.every((s) => s.group && s.group === selList[0].group);
      items.push(grouped ? btn("Ungroup", Ungroup, () => groupSel(false), { keys: "Ctrl+Shift+G" }) : btn("Group", Group, () => groupSel(true), { keys: "Ctrl+G" }));
    }
    if (dgm && selList.some((q) => q.type !== "arrow" && q.type !== "pen")) items.push(btn("Container", Frame, containSel));
    items.push(btn("Bring to front", BringToFront, () => zSel("front"), { keys: "Ctrl+Shift+]" }));
    items.push(btn("Send to back", SendToBack, () => zSel("back"), { keys: "Ctrl+Shift+[" }));
    items.push(btn("Duplicate", Copy, dupSel, { keys: "Ctrl+D" }));
    items.push(btn("Delete", Trash2, removeSel, { keys: "Delete" }));
    swatch = (
      <div ref={barRef} className="ocbd-swatch" style={{ left: sx, top: sy }} data-place={flip ? "below" : undefined} onPointerDown={(e) => e.stopPropagation()} role="toolbar" aria-label={selList.length > 1 ? `${selList.length} shapes` : "Shape options"}>
        {items}
      </div>
    );
  }

  let editor: ReactNode = null;
  if (editing) {
    const s = byId.get(editing.id);
    if (s) editor = <TextEditor s={s} view={view} compact={compact} value={editing.text} onChange={(text) => setEditing({ id: s.id, text })} onDone={commitEdit} />;
  }

  const content = (
    <div
      ref={rootRef}
      className={"ocbd" + (compact ? " ocbd-compact" : "") + (full ? " ocbd-full" : "") + (active ? " active" : "")}
      data-rail={rail ? "" : undefined}
      tabIndex={0}
      role="group"
      aria-roledescription="whiteboard"
      aria-label={`Whiteboard, ${shapes.length} ${shapes.length === 1 ? "shape" : "shapes"}`}
      aria-describedby={`${uid}-help`}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => (space.current = false)}
      onPointerLeave={() => !drag.current && publish(null)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-board={boardId}
    >
      <span id={`${uid}-help`} className="ocbd-sr">
        {edit
          ? "Tab moves through shapes. Arrow keys move the selection, Alt with arrows resizes, Enter edits text. Pick a tool with its letter and press Enter to place it. Control C, X, V, D copy, cut, paste and duplicate. On a connector, W adds a waypoint, Alt with left or right arrow picks one, arrows move it, Delete removes it. Shift 1 fits the board, Shift 2 zooms to the selection, M shows the minimap."
          : "Tab moves through shapes. Use the zoom buttons or Control plus and minus to zoom. Shift 1 fits the board, Shift 2 zooms to the selection, M shows the minimap."}
      </span>
      {lod ? (
        // Zoomed out (DGM-19): the background and the level-of-detail layer sit under the
        // (then transparent) board SVG, in their own composited layer moved by a CSS transform,
        // so a pan does not raster the whole board again (ADR-046 note).
        <div aria-hidden="true" style={{ position: "absolute", left: lodAt[0], top: lodAt[1], width: W, height: H, overflow: "hidden", zIndex: -1, pointerEvents: "none" }}>
          <svg width={W} height={H} style={{ position: "absolute", left: 0, top: 0 }}>{background}</svg>
          <LodLayer shapes={shapes} zb={zb} view={view} />
        </div>
      ) : null}
      <svg
        ref={svgRef}
        className="ocbd-svg"
        aria-hidden="true"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => drag.current && e.preventDefault()}
      >
        <defs>
          {!dgm ? (
            <pattern id={dots} width={22 * z} height={22 * z} x={tx % (22 * z)} y={ty % (22 * z)} patternUnits="userSpaceOnUse">
              <circle cx={z} cy={z} r={Math.max(0.6, z)} className="ocbd-dot" />
            </pattern>
          ) : null}
          {dgm ? (
            <>
              <pattern id={`${dots}-g`} width={dp.gridSize * z} height={dp.gridSize * z} x={tx % (dp.gridSize * z)} y={ty % (dp.gridSize * z)} patternUnits="userSpaceOnUse">
                <path d={`M${dp.gridSize * z} 0V${dp.gridSize * z}H0`} fill="none" stroke="var(--line)" strokeWidth={1} />
              </pattern>
              <pattern id={`${dots}-G`} width={100 * z} height={100 * z} x={tx % (100 * z)} y={ty % (100 * z)} patternUnits="userSpaceOnUse">
                <path d={`M${100 * z} 0V${100 * z}H0`} fill="none" stroke="var(--line-2)" strokeWidth={1} />
              </pattern>
            </>
          ) : null}
          <marker id={ah} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M1 1.5 L9 5 L1 8.5" fill="none" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
          {/* Connector ends from `props` (UML arrows, ERD cardinality): S2 presets, S4 panel. */}
          {Object.entries(HEADS).map(([name, h]) => (
            <marker key={name} id={`${ah}-${name}`} viewBox="0 0 20 20" refX={19} refY={10} markerWidth={18} markerHeight={18} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d={h.d} fill={h.fill ?? "none"} stroke="var(--fg-2)" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
            </marker>
          ))}
        </defs>
        {lod ? null : background}
        <g transform={`translate(${tx} ${ty}) scale(${z})`}>
          {visible.map((s) => (
            <ShapeView
              resolve={env.resolveAsset}
              key={s.id}
              s={s}
              ah={ah}
              hideText={editing?.id === s.id}
              growH={editing?.id === s.id && s.type === "sticky" ? stickyHeight(editing.text, s.w ?? 150, s.h ?? 110) : undefined}
            />
          ))}
          <KindMarks shapes={visible} />
          {lod ? null : <FrameNames frames={frm.frames} z={z} selected={new Set(sel)} />}
          {draft ?<ShapeView resolve={env.resolveAsset} s={draft.type === "arrow" ? { ...draft, pts: resolveArrow(draft, byId) } : draft} ah={ah} /> : null}
          {dgm ? <OrphanLayer boardId={boardId} shapes={shapes} z={z} /> : null}
          {peerSel}
          {selection}
          {hintDots}
          {portDots}
          {gaps ? (
            <g pointerEvents="none" className="ocbd-gaps">
              {gaps.map((m, i) => (
                <g key={i}>
                  <line x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke="var(--pink-fg)" strokeWidth={1 / z} />
                  <text x={(m.x1 + m.x2) / 2 + (m.x1 === m.x2 ? 4 / z : 0)} y={(m.y1 + m.y2) / 2 - (m.y1 === m.y2 ? 4 / z : 0)} fontSize={11 / z} fill="var(--pink-fg)" textAnchor={m.x1 === m.x2 ? "start" : "middle"}>{m.gap}</text>
                </g>
              ))}
            </g>
          ) : null}
          {guides ? (
            <g pointerEvents="none" className="ocbd-guides">
              {guides.gx.map((gx) => <line key={"x" + gx} x1={gx} x2={gx} y1={-ty / z} y2={(H - ty) / z} stroke="var(--pink-fg)" strokeWidth={1 / z} strokeDasharray={`${3 / z} ${3 / z}`} />)}
              {guides.gy.map((gy) => <line key={"y" + gy} y1={gy} y2={gy} x1={-tx / z} x2={(W - tx) / z} stroke="var(--pink-fg)" strokeWidth={1 / z} strokeDasharray={`${3 / z} ${3 / z}`} />)}
            </g>
          ) : null}
          {marquee ? <rect className="ocbd-marquee" x={marquee[0]} y={marquee[1]} width={marquee[2] - marquee[0]} height={marquee[3] - marquee[1]} fill="var(--accent-soft)" fillOpacity={0.5} stroke="var(--accent)" strokeWidth={1 / z} pointerEvents="none" /> : null}
        </g>
        <g pointerEvents="none">
          {peers.map((p) => {
            if (p.x === null || p.y === null) return null;
            const px = p.x * z + tx, py = p.y * z + ty;
            const w = Math.min(160, p.name.length * 6.6 + 16);
            return (
              <g key={p.id} transform={`translate(${px.toFixed(1)} ${py.toFixed(1)})`} style={{ transition: "transform 80ms linear" }}>
                <path d="M0 0 L5.5 15 L8 8.5 L14.5 6 Z" fill={p.color} stroke="var(--app)" strokeWidth="1.2" strokeLinejoin="round" />
                <rect x="12" y="15" width={w} height="20" rx="6" fill={p.color} />
                <text x="20" y="29" fontSize="11.5" fontWeight="600" fill="#fff">{p.name.length > 22 ? p.name.slice(0, 21) + "…" : p.name}</text>
              </g>
            );
          })}
        </g>
      </svg>
      {dgm && Dg && dp.rulers ? <Dg.Rulers view={view} size={size} span={sel.length ? unionBox(selShapes()) : null} /> : null}
      <div className="ocbd-sr" role="status" aria-live="polite">{live}</div>

      {!shapes.length && !draft ? (
        <EmptyBoard
          edit={edit}
          onTemplate={(t) => {
            // A starter template (decision 11): ordinary shapes and frames, one Undo step.
            const [cx, cy] = viewCenter();
            um?.stopCapturing();
            insertTemplate(doc, boardId, t, cx, cy, origin);
            um?.stopCapturing();
            setLive(`${t.name} template added. Undo removes it`);
            requestAnimationFrame(() => fitBox(contentBounds(S.current.shapes)));
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}

      <div className="ocbd-top">
        {edit ? (
          <>
            <button className="ocbd-ib" title="Undo (Ctrl+Z)" aria-label="Undo" aria-keyshortcuts="Control+Z Meta+Z" disabled={!um?.undoStack.length} onClick={() => undo()}>
              <Undo2 size={16} strokeWidth={SW} />
            </button>
            <button className="ocbd-ib" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" disabled={!um?.redoStack.length} onClick={() => undo(true)}>
              <Redo2 size={16} strokeWidth={SW} />
            </button>
          </>
        ) : null}
        {(W >= 560 || !W) && env.diagramming !== false ? (
          <button ref={dgmBtn} className="ocbd-dbtn" title="Open as a diagram (Shift+D). Full screen, with shape libraries, ports and auto-layout" aria-keyshortcuts="Shift+D" onClick={() => void openDiagram()}>
            <Workflow size={15} strokeWidth={SW} />
            Diagram
          </button>
        ) : null}
        <button className="ocbd-ib" title="Board options" aria-label="Board options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <Ellipsis size={16} strokeWidth={SW} />
        </button>
        <button className="ocbd-ib" title={full ? "Exit full screen (Esc)" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"} onClick={() => (full ? exitFull() : (setFull(true), setActive(true)))}>
          {full ? <Minimize2 size={16} strokeWidth={SW} /> : <Maximize2 size={16} strokeWidth={SW} />}
        </button>
      </div>

      {menu ? (
        <>
          <div className="ocbd-scrim" onPointerDown={() => setMenu(false)} />
          <div className="ocbd-menu" role="menu" aria-label="Board options">
            {!dgm && env.diagramming !== false ? (
              <button role="menuitem" className="ocbd-mi" aria-keyshortcuts="Shift+D" onClick={() => void openDiagram()}>
                <Workflow size={16} strokeWidth={SW} />
                Open as diagram
                <kbd className="ocbd-kbd" aria-hidden="true">⇧D</kbd>
              </button>
            ) : null}
            {!dgm && env.diagramming !== false ? <span className="ocbd-msep" /> : null}
            {edit ? (
              <button role="menuitem" className="ocbd-mi" onClick={() => { setMenu(false); fileRef.current?.click(); }}>
                <ImagePlus size={16} strokeWidth={SW} />
                Insert image
              </button>
            ) : null}
            {edit ? <span className="ocbd-msep" /> : null}
            {dgm && edit && env.importToBoard ? (
              <button role="menuitem" className="ocbd-mi" onClick={() => { setMenu(false); env.importToBoard!(boardId); }}>
                <FileUp size={16} strokeWidth={SW} />
                Import…
              </button>
            ) : null}
            {dgm ? (
              <button role="menuitem" className="ocbd-mi" onClick={() => { setMenu(false); setExporting(true); }}>
                <Download size={16} strokeWidth={SW} />
                Export…
              </button>
            ) : null}
            <ExportMenuItems x={xport} dialog={!dgm} close={() => setMenu(false)} />
          </div>
        </>
      ) : null}
      {xport.node}
      {frm.node}
      {edit ? (
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
            e.target.value = "";
            if (files.length) void insertImages(files, viewCenter());
          }}
        />
      ) : null}

      <Dock
        tools={TOOLS.filter(([t]) => edit || t === "select" || t === "hand")}
        tool={tool_}
        onTool={(t) => setTool(t as Tool)}
        compact={compact}
        rail={rail}
        onRail={setRail}
        z={z}
        canOut={z > ZMIN + 1e-6}
        canIn={z < ZMAX - 1e-6}
        onZoom={zoomCenter}
        onFit={fit}
        mini={mini}
        onMini={() => setMini((v) => !v)}
        frames={frm.frames.map((f) => ({ id: f.id, name: String(f.label || f.text || "Frame") }))}
        onFrame={(id) => {
          const f = S.current.byId.get(id);
          if (!f) return;
          const b = bbox(f);
          fitBox([b[0], b[1] - 24, b[2], b[3]], 2);
          setSel([id]);
        }}
        onPresent={() => void frm.present()}
      />
      {mini && W ? <Minimap shapes={shapes} view={view} size={size} onView={setView} /> : null}

      {swatch}
      {editor}

      {compact && !active && !full ? (
        <button
          className="ocbd-cover"
          onClick={() => {
            // 11a: a board made as a diagram (a named board, or diagram kinds in it) opens as one.
            if (asDiagram) return void openDiagram();
            setActive(true);
            setFull(true);
          }}
        >
          <span>
            {asDiagram ? <Maximize2 size={14} strokeWidth={SW} /> : <Pencil size={14} strokeWidth={SW} />}
            {asDiagram ? "Open diagram" : edit ? "Tap to open board" : "Tap to view board"}
          </span>
        </button>
      ) : null}
    </div>
  );

  const iconsCtx: DocIconsCtx = {
    list: docIcons.list,
    urls: docIcons.urls,
    api: env.icons,
    edit,
    place: (id) => addDocIcon(id),
    openAdd: (file) => openIconDialog({ kind: "add", file }),
    openManage: () => openIconDialog({ kind: "manage" }),
  };
  const iconDialogs =
    iconDlg && IconDlgs && typeof document !== "undefined"
      ? createPortal(<IconDlgs.IconDialogs state={iconDlg} doc={doc} list={docIcons.list} api={env.icons} onState={setIconDlg} onAdded={(id) => addDocIcon(id)} />, document.body)
      : null;

  if (dgm && Dg && typeof document !== "undefined") {
    const Shell = Dg.default;
    return (
      <DocIconsContext.Provider value={iconsCtx}>
        <div ref={phRef} className="ocbd-ph" style={{ height: phH || (compact ? 300 : 440) }}>Open as a diagram</div>
        {createPortal(
          <Shell
            doc={doc}
            boardId={boardId}
            env={env}
            anchor={() => phRef.current}
            place={place}
            closing={dgm === "closing"}
            onClosed={diagramClosed}
            onBack={closeDiagram}
            peers={peers}
            maxDocBytes={env.maxDocBytes}
            selected={sel.map((id) => byId.get(id)).filter((s): s is Shape => !!s)}
            shapes={shapes}
            undo={{ can: !!um?.undoStack.length, run: () => undo() }}
            redo={{ can: !!um?.redoStack.length, run: () => undo(true) }}
            menuOpen={menu}
            onMenu={() => setMenu((m) => !m)}
            origin={origin}
            onAddShape={(kind, icon, paths) => (kind.startsWith(PRESET) ? usePreset(kind) : addKind(kind, undefined, icon, paths))}
            prefs={dp}
            onPrefs={(patch) => setDp((v) => ({ ...v, ...patch }))}
            canvas={{ shapes, sel, select: setSel, reveal: revealShape, align, distribute }}
            view={view}
            selection={sel}
            exporting={exporting}
            onExportClose={() => setExporting(false)}
          >
            {content}
          </Shell>,
          document.body,
        )}
        {iconDialogs}
      </DocIconsContext.Provider>
    );
  }
  if (full && typeof document !== "undefined") {
    return (
      <DocIconsContext.Provider value={iconsCtx}>
        <div className="ocbd-ph" style={{ height: compact ? 300 : 440 }}>Open in full screen</div>
        {createPortal(content, document.body)}
        {iconDialogs}
      </DocIconsContext.Provider>
    );
  }
  return (
    <DocIconsContext.Provider value={iconsCtx}>
      {content}
      {iconDialogs}
    </DocIconsContext.Provider>
  );
}

/* ------------------------------------------------------------ minimap */

/**
 * The zoomed-out board (DGM-19): one path per style group, no text, not hit-tested (the board
 * hit-tests by position). Drawn at the zoom bucket `zb` into an SVG the size of the board's
 * box; the view moves and scales it (by z / zb, within 10 %) with a CSS transform, which the
 * compositor applies without rastering the paths again.
 */
function LodLayer({ shapes, zb, view }: { shapes: Shape[]; zb: number; view: View }) {
  const { groups, box } = useMemo(() => ({ groups: lodGroups(shapes, zb, STICKY, SWATCH), box: unionBox(shapes) ?? ([0, 0, 0, 0] as Box) }), [shapes, zb]);
  const [x0, y0, x1, y1] = box;
  const k = view.z / zb;
  return (
    <svg
      data-lod=""
      width={Math.ceil((x1 - x0) * zb) + 4}
      height={Math.ceil((y1 - y0) * zb) + 4}
      style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", willChange: "transform", transform: `translate(${view.tx + (x0 * zb - 2) * k}px, ${view.ty + (y0 * zb - 2) * k}px) scale(${k})` }}
    >
      <LodPaths groups={groups} zb={zb} x0={x0} y0={y0} />
    </svg>
  );
}

const LodPaths = memo(function LodPaths({ groups, zb, x0, y0 }: { groups: LodGroup[]; zb: number; x0: number; y0: number }) {
  return (
    <g transform={`translate(2 2) scale(${zb}) translate(${-x0} ${-y0})`}>
      {groups.map((g) => (
        <path key={g.key} d={g.d} fill={g.fill} stroke={g.stroke} strokeWidth={g.width || undefined} strokeLinejoin="round" />
      ))}
    </g>
  );
});

const MM = { w: 200, h: 132, pad: 8 };

/** Shapes drawn small, in board coordinates (the parent scales them). Memoised on the shapes. */
const MiniShapes = memo(function MiniShapes({ shapes }: { shapes: Shape[] }) {
  return (
    <>
      {shapes.map((s) => {
        if (s.pts && s.pts.length > 1) {
          return <path key={s.id} data-ms={s.id} d={"M" + s.pts.map((q) => q.join(" ")).join(" L")} fill="none" stroke={s.type === "pen" ? "var(--accent)" : "var(--fg-3)"} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />;
        }
        const [x0, y0, x1, y1] = bbox(s);
        const fill = s.type === "sticky" ? (STICKY[s.fill ?? "y"] ?? STICKY.y) : s.type === "swatch" ? (SWATCH[s.fill ?? "accent"] ?? SWATCH.accent) : s.type === "text" ? "var(--fg-4)" : s.fill && TONES.includes(s.fill as (typeof TONES)[number]) ? `var(--${s.fill}-bg)` : "var(--sunk)";
        return <rect key={s.id} data-ms={s.id} x={x0} y={y0} width={Math.max(1, x1 - x0)} height={Math.max(1, y1 - y0)} rx={3} fill={fill} stroke={s.dashed ? "var(--fg-4)" : "var(--line-2)"} strokeWidth={1} vectorEffect="non-scaling-stroke" fillOpacity={s.dashed ? 0 : 1} />;
      })}
    </>
  );
});

/**
 * Overview of the whole board with the visible area outlined. Click to centre the view on a
 * spot, drag the outline (or anywhere, after the click) to pan, or focus it and use the arrow
 * keys (Shift for bigger steps): the keyboard and single-pointer alternatives to dragging.
 */
function Minimap({ shapes, view, size, onView }: { shapes: Shape[]; view: View; size: [number, number]; onView: (v: View) => void }) {
  const [W, H] = size;
  const vb: Box = [-view.tx / view.z, -view.ty / view.z, (W - view.tx) / view.z, (H - view.ty) / view.z];
  const content = useMemo(() => contentBounds(shapes), [shapes]);
  // While dragging, the map's frame stays put so the outline doesn't swim under the pointer.
  const frozen = useRef<Box | null>(null);
  const B: Box = frozen.current ?? (content ? [Math.min(content[0], vb[0]), Math.min(content[1], vb[1]), Math.max(content[2], vb[2]), Math.max(content[3], vb[3])] : vb);
  const bw = Math.max(1, B[2] - B[0]), bh = Math.max(1, B[3] - B[1]);
  const k = Math.min((MM.w - MM.pad * 2) / bw, (MM.h - MM.pad * 2) / bh);
  const ox = MM.pad + (MM.w - MM.pad * 2 - bw * k) / 2 - B[0] * k;
  const oy = MM.pad + (MM.h - MM.pad * 2 - bh * k) / 2 - B[1] * k;
  const V = useRef({ view, k, W, H });
  V.current = { view, k, W, H };
  const ref = useRef<SVGSVGElement>(null);

  const centreOn = (wx: number, wy: number) => {
    const { view: v, W: w, H: h } = V.current;
    onView({ ...v, tx: w / 2 - wx * v.z, ty: h / 2 - wy * v.z });
  };
  /** Pan with the pointer: every map pixel moved is 1/k board units. */
  const track = (e: React.PointerEvent, from: View) => {
    frozen.current = B;
    const sx = e.clientX, sy = e.clientY;
    const move = (ev: PointerEvent) => {
      const kk = V.current.k;
      onView({ ...from, tx: from.tx - ((ev.clientX - sx) / kk) * from.z, ty: from.ty - ((ev.clientY - sy) / kk) * from.z });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      frozen.current = null;
      onView({ ...V.current.view });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if ((e.target as Element).classList?.contains("ocbd-mini-vp")) return track(e, view);
    // Click: centre there, then keep panning if the pointer moves on.
    const r = ref.current!.getBoundingClientRect();
    const wx = (e.clientX - r.left - ox) / k, wy = (e.clientY - r.top - oy) / k;
    const next = { ...view, tx: W / 2 - wx * view.z, ty: H / 2 - wy * view.z };
    onView(next);
    track(e, next);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = (e.shiftKey ? 0.5 : 0.1) * Math.min(W, H);
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (dx || dy) {
      e.preventDefault();
      e.stopPropagation();
      // Arrow right shows what is to the right: the view moves, the board slides left.
      onView({ ...view, tx: view.tx - dx, ty: view.ty - dy });
    } else if (e.key === "Home" && content) {
      e.preventDefault();
      e.stopPropagation();
      centreOn((content[0] + content[2]) / 2, (content[1] + content[3]) / 2);
    }
  };
  return (
    <div
      className="ocbd-mini"
      tabIndex={0}
      role="group"
      aria-roledescription="minimap"
      aria-label="Minimap. Arrow keys pan the view, Shift for larger steps, Home centres the board. Click to jump, drag the outline to pan."
      onKeyDown={onKey}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <svg ref={ref} width={MM.w} height={MM.h} onPointerDown={onDown} aria-hidden="true">
        <g className="ocbd-mini-world" transform={`translate(${ox} ${oy}) scale(${k})`}>
          <MiniShapes shapes={shapes} />
        </g>
        <rect className="ocbd-mini-vp" x={ox + vb[0] * k} y={oy + vb[1] * k} width={Math.max(4, (vb[2] - vb[0]) * k)} height={Math.max(4, (vb[3] - vb[1]) * k)} rx={3} />
      </svg>
    </div>
  );
}

/** Distance from `p` to the segment `a`–`b`. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

function snapArrow(a: Pt, b: Pt, shift: boolean): Pt {
  if (!shift) return b;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
}

/* ------------------------------------------------------------ shapes */

function Lines({ text, x, y, lh, anchor, size = 14, weight, wrap }: { text: string; x: number; y: number; lh: number; anchor?: boolean; size?: number; weight?: number; wrap?: number }) {
  const lines = wrap ? wrapText(text, wrap, size) : String(text || "").split("\n");
  return (
    <>
      {lines.map((l, i) => (
        <text key={i} x={x} y={y + i * lh} textAnchor={anchor ? "middle" : undefined} fontSize={size} fontWeight={weight} fill="currentColor">
          {l}
        </text>
      ))}
    </>
  );
}

function centered(s: Shape, lh: number, size: number, wrap: number) {
  const n = wrapText(String(s.text ?? ""), wrap, size).length;
  return (s.y ?? 0) + (s.h ?? 0) / 2 + size * 0.36 - ((n - 1) * lh) / 2;
}

const toneFill = (s: Shape) => (s.fill && TONES.includes(s.fill as (typeof TONES)[number]) ? { fill: `var(--${s.fill}-bg)`, stroke: `var(--${s.fill}-fg)` } : null);

/** A 24 × 24 stroked icon glyph (Lucide style) placed in a square. */
function IconGlyph({ paths, x, y, size, color }: { paths: readonly string[]; x: number; y: number; size: number; color: string }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${size / 24})`} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </g>
  );
}

/** An `icon:node` shape: the tile, its glyph (or the empty frame when the icon is missing, 6a), the label. */
function IconNodeView({ s, stroke, hideText }: { s: Shape; stroke: string; hideText?: boolean }) {
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
  const tone = toneFill(s);
  const icon = iconPathsOf(s);
  const g = iconGlyphBox(s);
  const lb = hideText ? null : iconLabelLayout(s);
  // An icon added to the document (DGM-17 part 3): the cleaned file as an <image> with a data:
  // URL, never inline markup.
  const { urls } = useDocIcons();
  const ref = iconProps(s).icon;
  const url = ref?.startsWith(DOC_PREFIX) ? urls.get(ref.slice(DOC_PREFIX.length)) : undefined;
  const im = Math.min(w, h) * 0.72;
  return (
    <g data-s={s.id} data-kind={s.kind} style={{ cursor: "move", color: "var(--fg)" }}>
      {url ? (
        <>
          <rect x={x} y={y} width={w} height={h} rx={12} fill={tone?.fill ?? "var(--app)"} stroke={tone ? "none" : "var(--line-2)"} strokeWidth={1} />
          <image href={url} x={x + (w - im) / 2} y={y + (h - im) / 2} width={im} height={im} preserveAspectRatio="xMidYMid meet" />
        </>
      ) : icon ? (
        <>
          <rect x={x} y={y} width={w} height={h} rx={12} fill={tone?.fill ?? "var(--app)"} stroke={tone ? "none" : stroke} strokeWidth={1.5} />
          <IconGlyph paths={icon} x={g.x} y={g.y} size={g.size} color={tone?.stroke ?? stroke} />
        </>
      ) : (
        <rect data-missing-icon="" x={x} y={y} width={w} height={h} rx={12} fill="var(--app)" stroke="var(--fg-3)" strokeWidth={1.25} strokeDasharray="4 3" />
      )}
      {lb
        ? lb.lines.map((l, i) => (
            <text key={i} x={lb.x} y={lb.y + i * ICON_LABEL.lh} textAnchor={lb.middle ? "middle" : undefined} fontSize={ICON_LABEL.size} fontWeight={600} fill="currentColor">
              {l}
            </text>
          ))
        : null}
    </g>
  );
}

const ShapeView = memo(function ShapeView({ s, ah, hideText, resolve, growH }: { s: Shape; ah: string; hideText?: boolean; resolve?: (src: string) => string; growH?: number }) {
  const stroke = s.stroke === "accent" ? "var(--accent)" : "var(--fg-2)";
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = growH ?? s.h ?? 0;
  const text = hideText ? "" : (s.text ?? "");
  const tone = toneFill(s);
  // A library kind with an outline (DGM-14 S2): its path, stretched to the box, and its text in
  // the kind's label box (`look.box`, default the whole shape). Any box base: the exporters and
  // 0.1.x clients draw the base type instead.
  const look = s.kind && (s.type === "rect" || s.type === "ellipse" || s.type === "diamond") ? descriptorOf(s).look : undefined;
  if (look?.path) {
    const size = s.size ?? 14, lh = Math.round(size * 1.3);
    const [bx, by, bw, bh] = look.box ?? [0, 0, 100, 100];
    const wrap = Math.max(20, (w * bw) / 100 - 12);
    const n = text ? wrapText(text, wrap, size).length : 0;
    const ty = y + (h * (by + bh / 2)) / 100 + size * 0.36 - ((n - 1) * lh) / 2;
    return (
      <g data-s={s.id} data-kind={s.kind} style={{ cursor: "move", color: "var(--fg)" }}>
        <path d={look.path} transform={`translate(${x} ${y}) scale(${w / 100} ${h / 100})`} fill={tone?.fill ?? "var(--app)"} stroke={tone?.stroke ?? stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeDasharray={s.dashed ? "6 5" : undefined} />
        {text ? <Lines text={text} x={x + (w * (bx + bw / 2)) / 100} y={ty} lh={lh} anchor size={size} wrap={wrap} /> : null}
      </g>
    );
  }
  switch (s.type) {
    case "sticky":
      return (
        <g data-s={s.id} style={{ cursor: "move", color: "var(--sticky-fg)" }}>
          <rect x={x + 1} y={y + 4} width={w} height={h} rx={6} fill="#000" opacity={0.07} />
          <rect x={x} y={y} width={w} height={h} rx={6} fill={STICKY[s.fill ?? "y"] ?? STICKY.y} />
          <Lines text={text} x={x + STICKY_TEXT.pad} y={y + STICKY_TEXT.top} lh={STICKY_TEXT.lh} wrap={w - STICKY_TEXT.pad * 2} />
        </g>
      );
    case "rect": {
      const size = s.size ?? 14, lh = Math.round(size * 1.3);
      // An icon shape (DGM-17): tinted tile, the glyph, the label below or to the right.
      if (s.kind === ICON_KIND) return <IconNodeView s={s} stroke={stroke} hideText={hideText} />;
      // A frame (BRD-21): its name is drawn above it by `FrameNames`.
      if (s.kind === CONTAINER) return <FrameView s={s} />;
      const glyph = look?.icon ? iconById(look.icon) : undefined;
      if (glyph) {
        // Network kinds drawn with a generic icon (DGM-17 decision 6): glyph on the left, text beside it.
        const gs = Math.min(22, h * 0.5), tx = x + 12 + gs + 6, tw = Math.max(20, x + w - 8 - tx);
        return (
          <g data-s={s.id} data-kind={s.kind} style={{ cursor: "move", color: "var(--fg)" }}>
            <rect x={x} y={y} width={w} height={h} rx={12} fill={tone?.fill ?? "var(--app)"} stroke={tone?.stroke ?? stroke} strokeWidth={1.5} />
            <IconGlyph paths={glyph.paths} x={x + 12} y={y + (h - gs) / 2} size={gs} color={tone?.stroke ?? stroke} />
            {text ? <Lines text={text} x={tx + tw / 2} y={centered(s, lh, size, tw)} lh={lh} anchor size={size} wrap={tw} /> : null}
          </g>
        );
      }
      return (
        <g data-s={s.id} style={{ cursor: "move", color: "var(--fg)" }}>
          <rect x={x} y={y} width={w} height={h} rx={12} fill={tone?.fill ?? "var(--app)"} fillOpacity={s.dashed ? 0.001 : 1} stroke={s.dashed ? "var(--fg-3)" : (tone?.stroke ?? stroke)} strokeWidth={1.5} strokeDasharray={s.dashed ? "6 5" : undefined} />
          {s.label ? (
            <text x={x + 14} y={y + 24} fontSize={11.5} fontWeight={600} fill="var(--fg-3)" letterSpacing=".6">{s.label.toUpperCase()}</text>
          ) : null}
          {text ? <Lines text={text} x={x + w / 2} y={centered(s, lh, size, Math.max(20, w - 16))} lh={lh} anchor size={size} wrap={Math.max(20, w - 16)} /> : null}
        </g>
      );
    }
    case "ellipse": {
      const size = s.size ?? 15, lh = Math.round(size * 1.27);
      return (
        <g data-s={s.id} style={{ cursor: "move", color: "var(--fg)" }}>
          <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={tone?.fill ?? "var(--app)"} stroke={tone?.stroke ?? stroke} strokeWidth={1.5} />
          {text ? <Lines text={text} x={x + w / 2} y={centered(s, lh, size, Math.max(20, w * 0.72))} lh={lh} anchor size={size} weight={600} wrap={Math.max(20, w * 0.72)} /> : null}
        </g>
      );
    }
    case "diamond": {
      const cx = x + w / 2, cy = y + h / 2;
      const size = s.size ?? 14, lh = Math.round(size * 1.3);
      return (
        <g data-s={s.id} style={{ cursor: "move", color: "var(--fg)" }}>
          <path d={`M${cx} ${y} L${x + w} ${cy} L${cx} ${y + h} L${x} ${cy} Z`} fill={tone?.fill ?? "var(--app)"} stroke={tone?.stroke ?? stroke} strokeWidth={1.5} strokeLinejoin="round" />
          {text ? <Lines text={text} x={cx} y={centered(s, lh, size, Math.max(20, w * 0.6))} lh={lh} anchor size={size} wrap={Math.max(20, w * 0.6)} /> : null}
        </g>
      );
    }
    case "image": {
      const clip = `${ah}-c-${s.id}`;
      return (
        <g data-s={s.id} style={{ cursor: "move" }}>
          <clipPath id={clip}>
            <rect x={x} y={y} width={w} height={h} rx={8} />
          </clipPath>
          <rect x={x} y={y} width={w} height={h} rx={8} fill="var(--sunk)" />
          {s.src ? (
            <image href={resolve ? resolve(s.src) : s.src} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clip})`}>
              <title>{s.alt ?? "Image"}</title>
            </image>
          ) : null}
          <rect x={x} y={y} width={w} height={h} rx={8} fill="none" stroke="var(--line-2)" />
        </g>
      );
    }
    case "swatch":
      return (
        <g data-s={s.id} style={{ cursor: "move" }}>
          <rect x={x} y={y} width={w} height={h} rx={12} fill={SWATCH[s.fill ?? "accent"] ?? SWATCH.accent} opacity={0.85} />
        </g>
      );
    case "text": {
      const size = s.size || 18;
      return (
        <g data-s={s.id} style={{ cursor: "move", color: "var(--fg)" }}>
          <rect x={x - 4} y={y - size} width={Math.max(24, bbox(s)[2] - x + 8)} height={bbox(s)[3] - y + size} fill="transparent" />
          <Lines text={text} x={x} y={y} lh={size * 1.3} size={size} weight={600} />
        </g>
      );
    }
    case "arrow": {
      if (!s.pts || s.pts.length < 2) return null;
      const d = "M" + s.pts.map((q) => q.join(" ")).join(" L");
      const label = text.trim();
      let tag: ReactNode = null;
      if (label) {
        const [mx, my] = midPoint(s.pts);
        const lines = wrapText(label, 180, 12.5);
        const lw = Math.max(...lines.map((l) => l.length)) * 12.5 * 0.56 + 14;
        const lh = 16, bh = lines.length * lh + 6;
        tag = (
          <g className="ocbd-alabel">
            <rect x={mx - lw / 2} y={my - bh / 2} width={lw} height={bh} rx={6} fill="var(--panel)" stroke="var(--line-2)" />
            {lines.map((l, i) => (
              <text key={i} x={mx} y={my - bh / 2 + 3 + lh * (i + 1) - 4} textAnchor="middle" fontSize={12.5} fontWeight={500} fill="var(--fg-2)">{l}</text>
            ))}
          </g>
        );
      }
      return (
        <g data-s={s.id} style={{ cursor: "move" }}>
          <path d={d} stroke="transparent" strokeWidth={14} fill="none" />
          <path d={d} stroke="var(--fg-2)" strokeWidth={1.6} fill="none" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "6 5" : undefined} {...ends(s, ah)} />
          {tag}
        </g>
      );
    }
    case "pen": {
      if (!s.pts?.length) return null;
      const d = smooth(s.pts);
      return (
        <g data-s={s.id} style={{ cursor: "move" }}>
          <path d={d} stroke="transparent" strokeWidth={14} fill="none" strokeLinecap="round" />
          <path d={d} stroke={stroke} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
    }
  }
  return <UnknownShape s={s} />;
});

/* ------------------------------------------------------- text editor */

function TextEditor({ s, view, compact, value, onChange, onDone }: { s: Shape; view: View; compact: boolean; value: string; onChange: (t: string) => void; onDone: (cancel?: boolean) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);
  const { tx, ty, z } = view;
  let style: React.CSSProperties;
  const base = s.type === "text" ? s.size || 18 : s.type === "ellipse" ? (s.size ?? 15) : s.type === "arrow" ? 12.5 : (s.size ?? 14);
  const fs = compact ? Math.max(16, base * z) : base * z;
  if (s.type === "text") {
    const b = bbox(s);
    style = { left: b[0] * z + tx - 4, top: b[1] * z + ty - 2, width: Math.max(160, (b[2] - b[0]) * z + 40), height: Math.max(fs * 1.5, (b[3] - b[1]) * z + 8), fontSize: fs, fontWeight: 600, color: "var(--fg)", padding: "0 4px" }; // px-ok: board-space text editor, sized with the zoom
  } else if (s.type === "sticky") {
    // Grows with the text, like the note itself does.
    const h = stickyHeight(value, s.w ?? 150, s.h ?? 110);
    style = { left: ((s.x ?? 0) + 10) * z + tx, top: ((s.y ?? 0) + 14) * z + ty, width: ((s.w ?? 150) - 20) * z, height: (h - 22) * z, fontSize: fs, color: "var(--sticky-fg)", lineHeight: `${STICKY_TEXT.lh * z}px`, padding: `0 ${4 * z}px` };
  } else if (s.type === "arrow") {
    const [mx, my] = midPoint(s.pts ?? []);
    style = { left: mx * z + tx - 90, top: my * z + ty - fs, width: 180, height: fs * 2.2, fontSize: fs, textAlign: "center", color: "var(--fg-2)", background: "var(--panel)", padding: "2px 6px" }; // px-ok: board-space label editor, sized with the zoom
  } else {
    style = { left: ((s.x ?? 0) + 8) * z + tx, top: ((s.y ?? 0) + 8) * z + ty, width: ((s.w ?? 140) - 16) * z, height: ((s.h ?? 80) - 16) * z, fontSize: fs, textAlign: "center", color: "var(--fg)", fontWeight: s.type === "ellipse" ? 600 : 400, display: "flex", paddingTop: Math.max(0, ((s.h ?? 80) - 16) * z / 2 - fs) };
  }
  return (
    <textarea
      ref={ref}
      className="ocbd-edit"
      style={style}
      value={value}
      aria-label={s.type === "arrow" ? "Connector label" : "Shape text"}
      placeholder={s.type === "text" ? "Type something" : s.type === "arrow" ? "Label" : ""}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onDone()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          // BRD-06: Escape ends editing and keeps the text (as other whiteboards do); Undo takes it back.
          e.preventDefault();
          onDone();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || ((s.type === "text" || s.type === "arrow") && !e.shiftKey))) {
          e.preventDefault();
          onDone();
        }
      }}
    />
  );
}
