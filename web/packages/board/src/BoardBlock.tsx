import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  ArrowUpRight, Circle, Copy, Diamond, Hand, Maximize2, Minimize2, Minus, MousePointer2, Pencil, Plus, Shapes, Square,
  StickyNote, Trash2, Type, type LucideIcon,
} from "lucide-react";
import type { BlockEnv } from "@opencanvas/ui";
import {
  addShape, bbox, boardsRoot, contentBounds, deleteShape, duplicateShape, getBoardMap, readShapes, simplify, smooth, updateShape,
  type Pt, type Shape, type ShapeType,
} from "./model";
import { ensureStyles } from "./styles";

type Tool = "select" | "hand" | "pen" | "sticky" | "rect" | "ellipse" | "diamond" | "arrow" | "text";
const TOOLS: [Tool, LucideIcon, string, string][] = [
  ["select", MousePointer2, "Select", "V"],
  ["hand", Hand, "Pan", "H"],
  ["pen", Pencil, "Pen", "P"],
  ["sticky", StickyNote, "Sticky note", "N"],
  ["rect", Square, "Rectangle", "R"],
  ["ellipse", Circle, "Ellipse", "O"],
  ["diamond", Diamond, "Diamond", "D"],
  ["arrow", ArrowUpRight, "Arrow", "A"],
  ["text", Type, "Text", "T"],
];
const KEY_TOOL: Record<string, Tool> = { v: "select", h: "hand", p: "pen", n: "sticky", r: "rect", o: "ellipse", d: "diamond", a: "arrow", t: "text" };
const STICKY: Record<string, string> = { y: "var(--sticky-y)", p: "var(--sticky-p)", b: "var(--sticky-b)", g: "var(--sticky-g)" };
const SWATCH: Record<string, string> = { accent: "var(--accent)", amber: "var(--amber-fg)", green: "var(--green-fg)", pink: "var(--pink-fg)", purple: "var(--purple-fg)", red: "var(--red-fg)", blue: "var(--blue-fg)" };
const TEXTUAL: ShapeType[] = ["sticky", "rect", "ellipse", "diamond", "text"];
const SIZED: ShapeType[] = ["sticky", "rect", "ellipse", "diamond", "swatch"];
const SW = 1.75;
const ZMIN = 0.25, ZMAX = 3;

interface View { tx: number; ty: number; z: number }
interface Peer { id: number; name: string; color: string; x: number; y: number }

/* ------------------------------------------------------------- store */

function useShapes(doc: Y.Doc, boardId: string): Shape[] | null {
  const cache = useRef<{ ver: number; at: number; val: Shape[] | null; key: string }>({ ver: 0, at: -1, val: null, key: boardId });
  if (cache.current.key !== boardId) cache.current = { ver: 0, at: -1, val: null, key: boardId };
  const subscribe = useCallback(
    (cb: () => void) => {
      const root = boardsRoot(doc);
      let inner: Y.Map<unknown> | null = null;
      const bump = () => {
        cache.current.ver++;
        cb();
      };
      const attach = () => {
        const m = getBoardMap(doc, boardId);
        if (m === inner) return;
        inner?.unobserveDeep(bump);
        inner = m;
        inner?.observeDeep(bump);
      };
      const onRoot = (e: Y.YMapEvent<Y.Map<unknown>>) => {
        if (e.keysChanged.has(boardId)) {
          attach();
          bump();
        }
      };
      root.observe(onRoot);
      attach();
      return () => {
        root.unobserve(onRoot);
        inner?.unobserveDeep(bump);
      };
    },
    [doc, boardId],
  );
  const get = useCallback(() => {
    const c = cache.current;
    if (c.at !== c.ver) {
      const m = getBoardMap(doc, boardId);
      c.val = m ? readShapes(m) : null;
      c.at = c.ver;
    }
    return c.val;
  }, [doc, boardId]);
  return useSyncExternalStore(subscribe, get, get);
}

function usePeers(awareness: Awareness | undefined, boardId: string): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    if (!awareness) return;
    const read = () => {
      const out: Peer[] = [];
      awareness.getStates().forEach((st, id) => {
        if (id === awareness.clientID || !st) return;
        const b = st.board as { id?: string; x?: number; y?: number } | null | undefined;
        if (!b || b.id !== boardId || typeof b.x !== "number" || typeof b.y !== "number") return;
        const u = (st.user ?? {}) as { name?: string; color?: string };
        out.push({ id, name: String(u.name ?? "Someone"), color: String(u.color ?? "var(--u2)"), x: b.x, y: b.y });
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
  | { kind: "move"; sid: string; ox: number; oy: number; orig: Shape; moved: boolean }
  | { kind: "resize"; sid: string; ox: number; oy: number; orig: Shape; moved: boolean }
  | { kind: "pen" }
  | { kind: "arrow" }
  | { kind: "pinch"; d0: number; c0: [number, number]; v: View };

function Board({ doc, boardId, env, awareness, shapes }: { doc: Y.Doc; boardId: string; env: BlockEnv; awareness?: Awareness; shapes: Shape[] }) {
  const edit = env.role === "edit";
  const compact = env.compact;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const origin = useMemo(() => ({ board: boardId, local: uid }), [boardId, uid]);
  const [tool, setToolState] = useState<Tool>("select");
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, z: 1 });
  const [full, setFull] = useState(false);
  const [active, setActive] = useState(false);
  const [draft, setDraftState] = useState<Shape | null>(null);
  const [editing, setEditingState] = useState<{ id: string; text: string } | null>(null);
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
  const [dragging, setDragging] = useState(false);
  const peers = usePeers(awareness, boardId);
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, [number, number]>());
  const pending = useRef<{ sid: string; patch: Partial<Shape> } | null>(null);
  const raf = useRef(0);
  const cursorRaf = useRef(0);
  const fitted = useRef(false);

  // Always-fresh values for event handlers.
  const S = useRef({ shapes, view, tool, sel, edit, editing });
  S.current = { shapes, view, tool, sel, edit, editing };

  const tool_ = edit ? tool : tool === "hand" ? "hand" : "select";
  const setTool = (t: Tool) => setToolState(edit || t === "select" || t === "hand" ? t : "select");

  /* ---- undo ---- */
  const um = useMemo(() => {
    const m = getBoardMap(doc, boardId);
    return m ? new Y.UndoManager(m, { trackedOrigins: new Set([origin]), captureTimeout: 400 }) : null;
  }, [doc, boardId, origin]);
  useEffect(() => () => um?.destroy(), [um]);

  /* ---- fit content on first layout ---- */
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
  const fit = () => {
    const svg = svgRef.current;
    const b = contentBounds(S.current.shapes);
    if (!svg || !b) return setView({ tx: 0, ty: 0, z: 1 });
    const W = svg.clientWidth, H = svg.clientHeight;
    const pad = 32, bottom = 72;
    const bw = b[2] - b[0], bh = b[3] - b[1];
    const z = Math.max(ZMIN, Math.min(1, (W - pad * 2) / Math.max(bw, 1), (H - pad - bottom) / Math.max(bh, 1)));
    setView({ z, tx: (W - bw * z) / 2 - b[0] * z, ty: pad + (H - pad - bottom - bh * z) / 2 - b[1] * z });
  };

  /* ---- presence ---- */
  const publish = (x: number | null, y = 0) => {
    if (!awareness) return;
    cancelAnimationFrame(cursorRaf.current);
    if (x === null) {
      if (awareness.getLocalState()?.board) awareness.setLocalStateField("board", null);
      return;
    }
    cursorRaf.current = requestAnimationFrame(() => awareness.setLocalStateField("board", { id: boardId, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }));
  };
  useEffect(() => () => {
    cancelAnimationFrame(cursorRaf.current);
    if (awareness?.getLocalState()?.board) awareness.setLocalStateField("board", null);
  }, [awareness]);

  /* ---- writes ---- */
  const flush = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const p = pending.current;
    pending.current = null;
    if (p) updateShape(doc, boardId, p.sid, p.patch, origin);
  };
  const schedule = (sid: string, patch: Partial<Shape>) => {
    pending.current = { sid, patch };
    if (!raf.current) raf.current = requestAnimationFrame(flush);
  };

  const startEdit = (s: Shape) => {
    if (!S.current.edit || !TEXTUAL.includes(s.type)) return;
    setSel(s.id);
    setEditing({ id: s.id, text: s.text ?? "" });
  };
  const commitEdit = (cancel = false) => {
    const e = editRef.current;
    if (!e) return;
    setEditing(null);
    const s = S.current.shapes.find((x) => x.id === e.id);
    if (!s) return;
    if (!cancel && e.text !== (s.text ?? "")) updateShape(doc, boardId, s.id, { text: e.text }, origin);
    if (s.type === "text" && !(cancel ? s.text : e.text)?.trim()) {
      deleteShape(doc, boardId, s.id, origin);
      setSel(null);
    }
    rootRef.current?.focus({ preventScroll: true });
  };

  const removeSel = () => {
    const sid = S.current.sel;
    if (!sid) return;
    deleteShape(doc, boardId, sid, origin);
    setSel(null);
  };
  const dupSel = () => {
    const s = S.current.shapes.find((x) => x.id === S.current.sel);
    if (!s) return;
    um?.stopCapturing();
    setSel(duplicateShape(doc, boardId, s, 24, 24, origin));
  };

  /* ---- pointer ---- */
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current!;
    rootRef.current?.focus({ preventScroll: true });
    if (editRef.current) commitEdit();
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.current.size === 2) {
      // Pinch: cancel whatever the first finger started.
      const [a, b] = [...pointers.current.values()];
      const r = svg.getBoundingClientRect();
      if (drag.current?.kind === "pen" || drag.current?.kind === "arrow") setDraft(null);
      flush();
      drag.current = { kind: "pinch", d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, c0: [(a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top], v: S.current.view };
      try { svg.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    const [x, y] = toWorld(e.clientX, e.clientY);
    const target = (e.target as Element).closest?.("[data-s]") as Element | null;
    const sid = target?.getAttribute("data-s") ?? null;
    const t = S.current.tool;
    const cap = () => {
      try { svg.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    };
    if (t === "hand" || e.button === 1 || (!S.current.edit && t !== "select")) {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, v: S.current.view };
      cap();
      return;
    }
    if (t === "select") {
      if (sid) {
        setSel(sid);
        const s = S.current.shapes.find((q) => q.id === sid);
        if (s && S.current.edit) {
          um?.stopCapturing();
          const rz = (e.target as Element).classList?.contains("ocbd-rz");
          drag.current = { kind: rz ? "resize" : "move", sid, ox: x, oy: y, orig: JSON.parse(JSON.stringify(s)), moved: false };
          cap();
        }
      } else {
        setSel(null);
        drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, v: S.current.view };
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
      setDraft({ id: "draft", type: "arrow", pts: [[x, y], [x, y]] });
      drag.current = { kind: "arrow" };
      cap();
      return;
    }
    let s: Omit<Shape, "id">;
    if (t === "sticky") s = { type: "sticky", x: x - 75, y: y - 55, w: 150, h: 110, fill: ["y", "b", "p", "g"][S.current.shapes.filter((q) => q.type === "sticky").length % 4], text: "" };
    else if (t === "text") s = { type: "text", x, y: y + 9, text: "", size: 18 };
    else s = { type: t as ShapeType, x: x - 70, y: y - (t === "diamond" ? 50 : 40), w: 140, h: t === "diamond" ? 100 : 80, text: "" };
    const nidv = addShape(doc, boardId, s, origin);
    setSel(nidv);
    setTool("select");
    if (t === "sticky" || t === "text") setEditing({ id: nidv, text: "" });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" || pointers.current.has(e.pointerId)) {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      publish(wx, wy);
    }
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts;
      const r = svgRef.current!.getBoundingClientRect();
      const c: [number, number] = [(a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top];
      const z = Math.min(ZMAX, Math.max(ZMIN, d.v.z * (Math.hypot(a[0] - b[0], a[1] - b[1]) / d.d0)));
      // keep the world point under the initial centre under the current centre
      const wx = (d.c0[0] - d.v.tx) / d.v.z, wy = (d.c0[1] - d.v.ty) / d.v.z;
      setView({ z, tx: c[0] - wx * z, ty: c[1] - wy * z });
      return;
    }
    if (d.kind === "pan") {
      setView({ ...d.v, tx: d.v.tx + (e.clientX - d.sx), ty: d.v.ty + (e.clientY - d.sy) });
      return;
    }
    const [x, y] = toWorld(e.clientX, e.clientY);
    if (d.kind === "pen") {
      const p = draftRef.current;
      if (!p?.pts) return;
      const l = p.pts[p.pts.length - 1];
      if (Math.hypot(l[0] - x, l[1] - y) > 1.5 / S.current.view.z) setDraft({ ...p, pts: [...p.pts, [x, y]] });
      return;
    }
    if (d.kind === "arrow") {
      const p = draftRef.current;
      if (p?.pts) setDraft({ ...p, pts: [p.pts[0], snapArrow(p.pts[0], [x, y], e.shiftKey)] });
      return;
    }
    const dx = x - d.ox, dy = y - d.oy;
    if (!d.moved && Math.hypot(dx, dy) * S.current.view.z < 2) return;
    if (!d.moved) setDragging(true);
    d.moved = true;
    const o = d.orig;
    if (d.kind === "resize") {
      schedule(d.sid, { w: Math.max(40, (o.w ?? 0) + dx), h: Math.max(30, (o.h ?? 0) + dy) });
    } else if (o.pts) {
      schedule(d.sid, { pts: o.pts.map((p) => [p[0] + dx, p[1] + dy] as Pt) });
    } else {
      schedule(d.sid, { x: (o.x ?? 0) + dx, y: (o.y ?? 0) + dy });
    }
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
    if (!d) return;
    if (d.kind === "move" || d.kind === "resize") flush();
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
      if (p?.pts && Math.hypot(p.pts[1][0] - p.pts[0][0], p.pts[1][1] - p.pts[0][1]) > 6) {
        setSel(addShape(doc, boardId, { type: "arrow", pts: p.pts.map((q) => [Math.round(q[0]), Math.round(q[1])] as Pt) }, origin));
      }
      setTool("select");
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!S.current.edit) return;
    // Pointer capture retargets click/dblclick to the <svg>, so hit-test by position.
    const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(e.clientX, e.clientY) : null;
    const target = (hit ?? (e.target as Element)).closest?.("[data-s]");
    const sid = target?.getAttribute("data-s");
    const s = sid ? S.current.shapes.find((q) => q.id === sid) : null;
    if (s) {
      startEdit(s);
      return;
    }
    if (S.current.tool !== "select") return;
    const [x, y] = toWorld(e.clientX, e.clientY);
    const nidv = addShape(doc, boardId, { type: "text", x, y: y + 9, text: "", size: 18 }, origin);
    setSel(nidv);
    setEditing({ id: nidv, text: "" });
  };

  /* ---- wheel (non-passive) ---- */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      const r = svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
      } else if (full) {
        e.preventDefault();
        setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [full]);

  /* ---- keyboard ---- */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("textarea,input,[contenteditable='true']")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      if (S.current.sel) setSel(null);
      else if (full) exitFull();
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
    if (mod && e.key === "0") {
      e.preventDefault();
      setView((v) => ({ ...v, z: 1 }));
      return;
    }
    if (!S.current.edit) {
      if (!mod && (e.key === "v" || e.key === "h")) setTool(KEY_TOOL[e.key]);
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) um?.redo();
      else um?.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      um?.redo();
      return;
    }
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      dupSel();
      return;
    }
    const sel = S.current.shapes.find((x) => x.id === S.current.sel);
    if ((e.key === "Backspace" || e.key === "Delete") && sel) {
      e.preventDefault();
      removeSel();
      return;
    }
    if (e.key === "Enter" && sel) {
      e.preventDefault();
      startEdit(sel);
      return;
    }
    if (sel && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      if (sel.pts) updateShape(doc, boardId, sel.id, { pts: sel.pts.map((p) => [p[0] + dx, p[1] + dy] as Pt) }, origin);
      else updateShape(doc, boardId, sel.id, { x: (sel.x ?? 0) + dx, y: (sel.y ?? 0) + dy }, origin);
      return;
    }
    if (!mod && !e.altKey && KEY_TOOL[e.key.toLowerCase()]) setTool(KEY_TOOL[e.key.toLowerCase()]);
  };

  /* ---- full screen ---- */
  const exitFull = () => {
    setFull(false);
    if (compact) setActive(false);
  };
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editRef.current && !S.current.sel) exitFull();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [full]);

  // Refit when entering / leaving full screen (the viewport size changes a lot).
  const firstFull = useRef(true);
  useEffect(() => {
    if (firstFull.current) {
      firstFull.current = false;
      return;
    }
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
  }, [full]);

  // Drop selection if the shape disappears (remote delete).
  useEffect(() => {
    if (sel && !shapes.some((s) => s.id === sel)) setSel(null);
    if (editing && !shapes.some((s) => s.id === editing.id)) setEditing(null);
  }, [shapes, sel, editing]);

  /* ---- render ---- */
  const selShape = shapes.find((s) => s.id === sel) ?? null;
  const { tx, ty, z } = view;
  const ah = `ocbd-ah-${uid}`;
  const dots = `ocbd-dots-${uid}`;
  const cursor = tool_ === "hand" ? (drag.current?.kind === "pan" ? "grabbing" : "grab") : tool_ === "select" ? "default" : "crosshair";

  let selection: ReactNode = null;
  if (selShape && !editing) {
    const b = bbox(selShape);
    selection = (
      <>
        <rect x={b[0] - 6} y={b[1] - 6} width={b[2] - b[0] + 12} height={b[3] - b[1] + 12} rx={6} fill="none" stroke="var(--accent)" strokeWidth={1.5 / z} pointerEvents="none" />
        {edit && SIZED.includes(selShape.type) ? (
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
            strokeWidth={1.5 / z}
            style={{ cursor: "nwse-resize" }}
          />
        ) : null}
      </>
    );
  }

  let swatch: ReactNode = null;
  if (selShape && edit && !editing && !dragging) {
    const b = bbox(selShape);
    const W = svgRef.current?.clientWidth ?? 600;
    const sx = Math.max(110, Math.min(W - 110, ((b[0] + b[2]) / 2) * z + tx));
    const sy = Math.max(compact ? 64 : 56, b[1] * z + ty - 14);
    swatch = (
      <div className="ocbd-swatch" style={{ left: sx, top: sy }} onPointerDown={(e) => e.stopPropagation()} role="toolbar" aria-label="Shape options">
        {selShape.type === "sticky" ? (
          <>
            {(["y", "p", "b", "g"] as const).map((c) => (
              <button
                key={c}
                data-c={c}
                style={{ background: STICKY[c] }}
                aria-label={{ y: "Yellow", p: "Pink", b: "Blue", g: "Green" }[c]}
                aria-pressed={(selShape.fill ?? "y") === c}
                onClick={() => updateShape(doc, boardId, selShape.id, { fill: c }, origin)}
              />
            ))}
            <span className="sep" />
          </>
        ) : selShape.type === "swatch" ? (
          <>
            {Object.keys(SWATCH).slice(0, 5).map((c) => (
              <button key={c} data-c={c} style={{ background: SWATCH[c] }} aria-label={c} aria-pressed={selShape.fill === c} onClick={() => updateShape(doc, boardId, selShape.id, { fill: c }, origin)} />
            ))}
            <span className="sep" />
          </>
        ) : null}
        {TEXTUAL.includes(selShape.type) ? (
          <button className="ocbd-ib" title="Edit text" aria-label="Edit text" onClick={() => startEdit(selShape)}>
            <Type size={14} strokeWidth={SW} />
          </button>
        ) : null}
        <button className="ocbd-ib" title="Duplicate" aria-label="Duplicate" onClick={dupSel}>
          <Copy size={14} strokeWidth={SW} />
        </button>
        <button className="ocbd-ib" title="Delete" aria-label="Delete" onClick={removeSel}>
          <Trash2 size={14} strokeWidth={SW} />
        </button>
      </div>
    );
  }

  let editor: ReactNode = null;
  if (editing) {
    const s = shapes.find((q) => q.id === editing.id);
    if (s) editor = <TextEditor s={s} view={view} compact={compact} value={editing.text} onChange={(text) => setEditing({ id: s.id, text })} onDone={commitEdit} />;
  }

  const content = (
    <div
      ref={rootRef}
      className={"ocbd" + (compact ? " ocbd-compact" : "") + (full ? " ocbd-full" : "") + (active ? " active" : "")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerLeave={() => !drag.current && publish(null)}
      data-board={boardId}
    >
      <svg
        ref={svgRef}
        className="ocbd-svg"
        role="application"
        aria-label="Whiteboard"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => drag.current && e.preventDefault()}
      >
        <defs>
          <pattern id={dots} width={22 * z} height={22 * z} x={tx % (22 * z)} y={ty % (22 * z)} patternUnits="userSpaceOnUse">
            <circle cx={z} cy={z} r={Math.max(0.6, z)} className="ocbd-dot" />
          </pattern>
          <marker id={ah} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M1 1.5 L9 5 L1 8.5" fill="none" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${dots})`} />
        <g transform={`translate(${tx} ${ty}) scale(${z})`}>
          {shapes.map((s) => <ShapeView key={s.id} s={s} ah={ah} hideText={editing?.id === s.id} />)}
          {draft ? <ShapeView s={draft} ah={ah} /> : null}
          {selection}
        </g>
        <g pointerEvents="none">
          {peers.map((p) => {
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

      {!shapes.length && !draft ? (
        <div className="ocbd-empty">
          <Shapes size={22} strokeWidth={1.5} />
          <span>{edit ? "Pick a tool below, or double-click to add text." : "This board is empty."}</span>
        </div>
      ) : null}

      <div className="ocbd-top">
        <button className="ocbd-ib" title={full ? "Exit full screen (Esc)" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"} onClick={() => (full ? exitFull() : (setFull(true), setActive(true)))}>
          {full ? <Minimize2 size={16} strokeWidth={SW} /> : <Maximize2 size={16} strokeWidth={SW} />}
        </button>
      </div>

      <div className="ocbd-tool" role="toolbar" aria-label="Board tools">
        {TOOLS.filter(([t]) => edit || t === "select" || t === "hand").map(([t, I, label, key], i) => (
          <span key={t} style={{ display: "contents" }}>
            {i === 2 ? <span className="ocbd-vs" /> : null}
            <button className="ocbd-ib" title={`${label} (${key})`} aria-label={label} aria-pressed={tool_ === t} onClick={() => setTool(t)}>
              <I size={16} strokeWidth={SW} />
            </button>
          </span>
        ))}
      </div>

      <div className="ocbd-zoom">
        <button className="ocbd-ib" aria-label="Zoom out" onClick={() => zoomCenter(1 / 1.2)} disabled={z <= ZMIN + 1e-6}>
          <Minus size={14} strokeWidth={SW} />
        </button>
        <button className="ocbd-zl" title="Zoom to fit" aria-label={`Zoom ${Math.round(z * 100)}%. Zoom to fit`} onClick={fit}>
          {Math.round(z * 100)}%
        </button>
        <button className="ocbd-ib" aria-label="Zoom in" onClick={() => zoomCenter(1.2)} disabled={z >= ZMAX - 1e-6}>
          <Plus size={14} strokeWidth={SW} />
        </button>
      </div>

      {swatch}
      {editor}

      {compact && !active && !full ? (
        <button
          className="ocbd-cover"
          onClick={() => {
            setActive(true);
            setFull(true);
          }}
        >
          <span>
            <Pencil size={14} strokeWidth={SW} />
            {edit ? "Tap to open board" : "Tap to view board"}
          </span>
        </button>
      ) : null}
    </div>
  );

  if (full && typeof document !== "undefined") {
    return (
      <>
        <div className="ocbd-ph" style={{ height: compact ? 300 : 440 }}>Open in full screen</div>
        {createPortal(content, document.body)}
      </>
    );
  }
  return content;
}

function snapArrow(a: Pt, b: Pt, shift: boolean): Pt {
  if (!shift) return b;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
}

/* ------------------------------------------------------------ shapes */

function Lines({ text, x, y, lh, anchor, size = 14, weight }: { text: string; x: number; y: number; lh: number; anchor?: boolean; size?: number; weight?: number }) {
  const lines = String(text || "").split("\n");
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

function centered(s: Shape, lh: number) {
  const n = String(s.text ?? "").split("\n").length;
  return (s.y ?? 0) + (s.h ?? 0) / 2 + 5 - ((n - 1) * lh) / 2;
}

function ShapeView({ s, ah, hideText }: { s: Shape; ah: string; hideText?: boolean }) {
  const stroke = s.stroke === "accent" ? "var(--accent)" : "var(--fg-2)";
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
  const text = hideText ? "" : (s.text ?? "");
  switch (s.type) {
    case "sticky":
      return (
        <g data-s={s.id} style={{ cursor: "move", color: "var(--sticky-fg)" }}>
          <rect x={x + 1} y={y + 4} width={w} height={h} rx={6} fill="#000" opacity={0.07} />
          <rect x={x} y={y} width={w} height={h} rx={6} fill={STICKY[s.fill ?? "y"] ?? STICKY.y} />
          <Lines text={text} x={x + 14} y={y + 30} lh={20} />
        </g>
      );
    case "rect":
      return (
        <g data-s={s.id} style={{ cursor: "move", color: "var(--fg)" }}>
          <rect x={x} y={y} width={w} height={h} rx={12} fill="var(--app)" fillOpacity={s.dashed ? 0.001 : 1} stroke={s.dashed ? "var(--fg-3)" : stroke} strokeWidth={1.5} strokeDasharray={s.dashed ? "6 5" : undefined} />
          {s.label ? (
            <text x={x + 14} y={y + 24} fontSize={11.5} fontWeight={600} fill="var(--fg-3)" letterSpacing=".6">{s.label.toUpperCase()}</text>
          ) : null}
          {text ? <Lines text={text} x={x + w / 2} y={centered(s, 18)} lh={18} anchor /> : null}
        </g>
      );
    case "ellipse":
      return (
        <g data-s={s.id} style={{ cursor: "move", color: "var(--fg)" }}>
          <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill="var(--app)" stroke={stroke} strokeWidth={1.5} />
          {text ? <Lines text={text} x={x + w / 2} y={centered(s, 19)} lh={19} anchor size={15} weight={600} /> : null}
        </g>
      );
    case "diamond": {
      const cx = x + w / 2, cy = y + h / 2;
      return (
        <g data-s={s.id} style={{ cursor: "move", color: "var(--fg)" }}>
          <path d={`M${cx} ${y} L${x + w} ${cy} L${cx} ${y + h} L${x} ${cy} Z`} fill="var(--app)" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
          {text ? <Lines text={text} x={cx} y={centered(s, 18)} lh={18} anchor /> : null}
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
      return (
        <g data-s={s.id} style={{ cursor: "move" }}>
          <path d={d} stroke="transparent" strokeWidth={14} fill="none" />
          <path d={d} stroke="var(--fg-2)" strokeWidth={1.6} fill="none" strokeLinejoin="round" strokeLinecap="round" markerEnd={`url(#${ah})`} />
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
  return null;
}

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
  const base = s.type === "text" ? s.size || 18 : s.type === "ellipse" ? 15 : 14;
  const fs = compact ? Math.max(16, base * z) : base * z;
  if (s.type === "text") {
    const b = bbox(s);
    style = { left: b[0] * z + tx - 4, top: b[1] * z + ty - 2, width: Math.max(160, (b[2] - b[0]) * z + 40), height: Math.max(fs * 1.5, (b[3] - b[1]) * z + 8), fontSize: fs, fontWeight: 600, color: "var(--fg)", padding: "0 4px" };
  } else if (s.type === "sticky") {
    style = { left: ((s.x ?? 0) + 10) * z + tx, top: ((s.y ?? 0) + 14) * z + ty, width: ((s.w ?? 150) - 20) * z, height: ((s.h ?? 110) - 22) * z, fontSize: fs, color: "var(--sticky-fg)", lineHeight: `${20 * z}px`, padding: `0 ${4 * z}px` };
  } else {
    style = { left: ((s.x ?? 0) + 8) * z + tx, top: ((s.y ?? 0) + 8) * z + ty, width: ((s.w ?? 140) - 16) * z, height: ((s.h ?? 80) - 16) * z, fontSize: fs, textAlign: "center", color: "var(--fg)", fontWeight: s.type === "ellipse" ? 600 : 400, display: "flex", paddingTop: Math.max(0, ((s.h ?? 80) - 16) * z / 2 - fs) };
  }
  return (
    <textarea
      ref={ref}
      className="ocbd-edit"
      style={style}
      value={value}
      aria-label="Shape text"
      placeholder={s.type === "text" ? "Type something" : ""}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onDone()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onDone(true);
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (s.type === "text" && !e.shiftKey))) {
          e.preventDefault();
          onDone();
        }
      }}
    />
  );
}
