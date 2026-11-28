// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// BRD-22: the style panel (decision 4). Docked to the board's right edge, a sheet on narrow
// boards; in diagram mode the same controls sit in the Properties panel (`embedded`). Its own
// lazy chunk: loaded the first time someone opens Style. Only the sections that apply to the
// selection are shown; a value that differs across the selection shows "Mixed".
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { RotateCcw, RotateCw, SlidersHorizontal, X } from "lucide-react";
import type { Shape } from "../model";
import { applies, fontOf, opOf, rotOf, SIZE_NAMES, sizeOf, sizesFor, STROKES, TONES, type StyleKey } from "./style";

const SW = 1.75;
const NAME: Record<string, string> = { ink: "Ink", gray: "Gray", blue: "Blue", green: "Green", amber: "Amber", red: "Red", purple: "Purple", pink: "Pink", none: "None", y: "Yellow", p: "Pink", b: "Blue", g: "Green" };
const STICKY_BG: Record<string, string> = { y: "var(--sticky-y)", p: "var(--sticky-p)", b: "var(--sticky-b)", g: "var(--sticky-g)" };
const TYPE: Record<string, string> = { rect: "Rectangle", ellipse: "Ellipse", diamond: "Diamond", sticky: "Sticky note", text: "Text", arrow: "Connector", pen: "Drawing", image: "Image", swatch: "Colour swatch" };
const MIXED = Symbol("mixed");

export type StyleSet = (k: StyleKey | "ah0" | "ah1", v: string | number | null) => void;

/** The value all shapes the key applies to share; MIXED when they differ; undefined when none apply. */
function common<T>(list: Shape[], k: StyleKey, read: (s: Shape) => T): T | typeof MIXED | undefined {
  const ls = list.filter((s) => applies(s, k));
  if (!ls.length) return undefined;
  const v = ls.map(read);
  return v.every((x) => x === v[0]) ? v[0] : MIXED;
}

/** A radio group of buttons: arrows move and pick, one Tab stop. */
function Group({ label, options, value, onPick, swatch }: { label: string; options: { v: string | number; name: string; node?: ReactNode; bg?: string }[]; value: unknown; onPick: (v: string | number) => void; swatch?: boolean }) {
  const on = options.findIndex((o) => o.v === value);
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const bs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    const j = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % bs.length : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + bs.length) % bs.length : -1;
    if (j < 0 || i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    bs[j].focus();
    onPick(options[j].v);
  };
  return (
    <div className={swatch ? "ocst-sw" : "ocst-seg"} role="radiogroup" aria-label={label} onKeyDown={keys}>
      {options.map((o, i) => (
        <button
          key={String(o.v)}
          type="button"
          role="radio"
          aria-checked={i === on}
          aria-label={o.name}
          title={o.name}
          tabIndex={i === (on < 0 ? 0 : on) ? 0 : -1}
          className={o.v === "none" ? "none" : undefined}
          style={o.bg ? { background: o.bg } : undefined}
          onClick={() => onPick(o.v)}
        >
          {o.node}
        </button>
      ))}
    </div>
  );
}
const line = (w: number, dash?: string) => (
  <svg className="ocst-g" viewBox="0 0 24 14" aria-hidden="true">
    <path d="M2 7h20" strokeWidth={w} strokeDasharray={dash} strokeLinecap="round" />
  </svg>
);
const HEAD_GLYPH: Record<string, ReactNode> = {
  none: <path d="M3 7h18" strokeWidth={2} />,
  arrow: <path d="M3 7h17M15 3l5 4-5 4" strokeWidth={2} fill="none" />,
  triangle: (
    <>
      <path d="M3 7h13" strokeWidth={2} />
      <path d="M15 3l6 4-6 4z" fill="currentColor" />
    </>
  ),
  circle: (
    <>
      <path d="M3 7h12" strokeWidth={2} />
      <circle cx={18} cy={7} r={3} fill="currentColor" />
    </>
  ),
};

function Sec({ label, mixed, children }: { label: string; mixed?: boolean; children: ReactNode }) {
  return (
    <div className="ocst-sec">
      <div className="ocst-l">
        <span>{label}</span>
        {mixed ? <span>Mixed</span> : null}
      </div>
      {children}
    </div>
  );
}

export interface StylePanelProps {
  list: Shape[];
  onSet: StyleSet;
  onClose?: () => void;
  /** A bottom sheet (narrow boards, phones). */
  sheet?: boolean;
  /** Inside another panel (diagram Properties): no title bar, not a dialog. */
  embedded?: boolean;
}

export default function StylePanel({ list, onSet, onClose, sheet, embedded }: StylePanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!embedded) ref.current?.querySelector<HTMLElement>("button[tabindex='0']:not([aria-label='Close style panel']), input")?.focus({ preventScroll: true });
  }, [embedded]);
  const has = (k: StyleKey) => list.some((s) => applies(s, k));
  const stroke = common(list, "stroke", (s) => s.stroke ?? "");
  const fill = common(list, "fill", (s) => s.fill ?? "none");
  const sticky = common(list, "sticky", (s) => s.fill ?? "y");
  const sw = common(list, "sw", (s) => s.sw ?? 2);
  const dash = common(list, "dash", (s) => s.dash ?? "solid");
  const font = common(list, "font", (s) => fontOf(s) ?? "sans");
  const size = common(list, "size", (s) => sizesFor(s).indexOf(sizeOf(s)));
  const op = common(list, "op", (s) => Math.round((opOf(s) ?? 1) * 100));
  const rot = common(list, "rot", (s) => rotOf(s));
  const arrows = list.filter((s) => s.type === "arrow");
  const head = (i: 0 | 1) => {
    const v = arrows.map((s) => String(((s.props ?? {}) as Record<string, unknown>)[i ? "endArrow" : "startArrow"] ?? (i ? "arrow" : "none")));
    return v.every((x) => x === v[0]) ? v[0] : MIXED;
  };
  const [opv, setOpv] = useState<number | null>(null);
  const [rotv, setRotv] = useState<string | null>(null);
  const title = list.length === 1 ? TYPE[list[0].type] ?? "Shape" : `${list.length} shapes`;

  const body = (
    <>
      {has("stroke") ? (
        <Sec label={list.every((s) => s.type === "text") ? "Text colour" : "Stroke"} mixed={stroke === MIXED}>
          <Group swatch label="Stroke colour" value={stroke} onPick={(v) => onSet("stroke", v)} options={STROKES.map((t) => ({ v: t, name: NAME[t], bg: t === "ink" ? "var(--fg)" : `var(--${t}-fg)` }))} />
        </Sec>
      ) : null}
      {has("fill") ? (
        <Sec label="Fill" mixed={fill === MIXED}>
          <Group swatch label="Fill colour" value={fill} onPick={(v) => onSet("fill", v)} options={["none", ...TONES].map((t) => ({ v: t, name: NAME[t], bg: t === "none" ? undefined : `var(--${t}-bg)` }))} />
        </Sec>
      ) : null}
      {has("sticky") ? (
        <Sec label="Note colour" mixed={sticky === MIXED}>
          <Group swatch label="Note colour" value={sticky} onPick={(v) => onSet("sticky", v)} options={["y", "p", "b", "g"].map((t) => ({ v: t, name: NAME[t], bg: STICKY_BG[t] }))} />
        </Sec>
      ) : null}
      {has("sw") || has("dash") ? (
        <div className="ocst-two">
          {has("sw") ? (
            <Sec label="Width" mixed={sw === MIXED}>
              <Group label="Stroke width" value={sw} onPick={(v) => onSet("sw", v)} options={[{ v: 1, name: "Thin", node: line(1) }, { v: 2, name: "Medium", node: line(2) }, { v: 4, name: "Bold", node: line(3.5) }]} />
            </Sec>
          ) : null}
          {has("dash") ? (
            <Sec label="Line" mixed={dash === MIXED}>
              <Group label="Stroke style" value={dash} onPick={(v) => onSet("dash", v === "solid" ? null : v)} options={[{ v: "solid", name: "Solid", node: line(2) }, { v: "dashed", name: "Dashed", node: line(2, "4 3") }, { v: "dotted", name: "Dotted", node: line(2.2, "0.1 4") }]} />
            </Sec>
          ) : null}
        </div>
      ) : null}
      {arrows.length ? (
        <>
          {([0, 1] as const).map((i) => (
            <Sec key={i} label={i ? "End arrowhead" : "Start arrowhead"} mixed={head(i) === MIXED}>
              <Group
                label={i ? "End arrowhead" : "Start arrowhead"}
                value={head(i)}
                onPick={(v) => onSet(i ? "ah1" : "ah0", v)}
                options={(["none", "arrow", "triangle", "circle"] as const).map((h) => ({
                  v: h,
                  name: h === "circle" ? "Dot" : h[0].toUpperCase() + h.slice(1),
                  node: (
                    <svg className="ocst-g" viewBox="0 0 24 14" aria-hidden="true" style={i ? undefined : { transform: "scaleX(-1)" }}>
                      {HEAD_GLYPH[h]}
                    </svg>
                  ),
                }))}
              />
            </Sec>
          ))}
        </>
      ) : null}
      {has("font") ? (
        <Sec label="Font" mixed={font === MIXED}>
          <Group label="Font" value={font} onPick={(v) => onSet("font", v === "sans" ? null : v)} options={[{ v: "sans", name: "Sans", node: <span style={{ fontFamily: "var(--font)" }}>Sans</span> }, { v: "serif", name: "Serif", node: <span className="ocst-serif">Serif</span> }, { v: "mono", name: "Mono", node: <span className="ocst-mono">Mono</span> }]} />
        </Sec>
      ) : null}
      {has("size") ? (
        <Sec label="Text size" mixed={size === MIXED}>
          <Group label="Text size" value={size} onPick={(v) => onSet("size", v)} options={SIZE_NAMES.map((n, i) => ({ v: i, name: n, node: ["S", "M", "L", "XL"][i] }))} />
        </Sec>
      ) : null}
      {has("op") ? (
        <Sec label="Opacity" mixed={op === MIXED}>
          <div className="ocst-row">
            <input
              type="range"
              min={10}
              max={100}
              step={10}
              aria-label="Opacity"
              value={opv ?? (op === MIXED || op === undefined ? 100 : op)}
              onChange={(e) => {
                const v = Number(e.target.value);
                setOpv(v);
                onSet("op", v);
              }}
              onPointerUp={() => setOpv(null)}
              onBlur={() => setOpv(null)}
            />
            <output>{opv !== null ? `${opv}%` : op === MIXED ? "Mixed" : `${op ?? 100}%`}</output>
          </div>
        </Sec>
      ) : null}
      {has("rot") ? (
        <Sec label="Rotation" mixed={rot === MIXED}>
          <div className="ocst-row">
            <input
              className="ocst-num"
              type="number"
              step={1}
              aria-label="Rotation in degrees"
              placeholder={rot === MIXED ? "Mixed" : undefined}
              value={rotv ?? (rot === MIXED || rot === undefined ? "" : String(rot))}
              onChange={(e) => setRotv(e.target.value)}
              onBlur={() => {
                if (rotv !== null && rotv.trim() !== "" && Number.isFinite(Number(rotv))) onSet("rot", Number(rotv));
                setRotv(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (rotv !== null && rotv.trim() !== "" && Number.isFinite(Number(rotv))) onSet("rot", Number(rotv));
                  setRotv(null);
                } else if (e.key === "Escape") {
                  if (rotv !== null) {
                    e.preventDefault();
                    setRotv(null);
                  } else onClose?.();
                }
              }}
            />
            <span aria-hidden="true">°</span>
            <span className="ocst-sp" />
            <button type="button" className="ocbd-ib" aria-label="Rotate 15 degrees anticlockwise" title="Rotate −15° (Alt+Shift+R)" onClick={() => onSet("rot", (rot === MIXED || rot === undefined ? 0 : rot) - 15)}>
              <RotateCcw size={14} strokeWidth={SW} />
            </button>
            <button type="button" className="ocbd-ib" aria-label="Rotate 15 degrees clockwise" title="Rotate +15° (Shift+R)" onClick={() => onSet("rot", (rot === MIXED || rot === undefined ? 0 : rot) + 15)}>
              <RotateCw size={14} strokeWidth={SW} />
            </button>
          </div>
          <p className="ocst-hint">The handle snaps to 15° steps; hold Alt to rotate freely.</p>
        </Sec>
      ) : null}
    </>
  );
  if (embedded) return <div className="ocst ocst-embedded">{body}</div>;
  return (
    <div
      ref={ref}
      className={"ocst" + (sheet ? " sheet" : "")}
      role="dialog"
      aria-label="Style"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose?.();
        } else e.stopPropagation(); // arrows in a slider or group must not move the selection
      }}
    >
      {sheet ? <span className="ocbd-grab" aria-hidden="true" /> : null}
      <div className="ocst-h">
        <SlidersHorizontal size={15} strokeWidth={SW} aria-hidden="true" />
        <span>Style · {title}</span>
        <button type="button" className="ocbd-ib" aria-label="Close style panel" title="Close (Esc)" onClick={onClose}>
          <X size={14} strokeWidth={SW} />
        </button>
      </div>
      {body}
    </div>
  );
}
