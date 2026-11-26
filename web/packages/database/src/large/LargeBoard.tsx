// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The board for large databases (prototype 1d, DB-A5): lanes by the group field, each lane's
// cards virtualized in its own scroller, a sticky lane header with the lane's full count, lanes
// that collapse to their header. Cards open the row; moving a card is done in the row or by
// bulk edit at this size.

import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { groupField, sortsOf, titleField } from "../query";
import type { CellValue, DbField, DbRow } from "../types";
import { Ic } from "../ui";
import { useSorted } from "./useSorted";
import { countLabel, type LargeCtx } from "./LargeTable";

const CARD_REM = 5.25;
const fmt = (n: number) => n.toLocaleString("en-US");

export function LargeBoard({ ctx, value }: { ctx: LargeCtx; value: (f: DbField, v: CellValue | undefined) => ReactNode }) {
  const { db } = ctx;
  const { rows } = useSorted(ctx.rows, db.fields, sortsOf(db, ctx.prefs), ctx.people.pickable);
  const g = groupField(db, ctx.prefs);
  const lanes = useMemo(() => {
    const keys = g ? [...(g.options ?? []).map((o) => o.v), ""] : [""];
    const by = new Map<string, DbRow[]>(keys.map((k) => [k, []]));
    for (const r of rows) {
      const k = g ? String(r.v[g.id] ?? "") : "";
      (by.get(k) ?? by.get("")!).push(r);
    }
    return [...by.entries()].filter(([k, list]) => k !== "" || list.length);
  }, [rows, g]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const tf = titleField(db);
  const meta = db.fields.filter((f) => f.id !== g?.id && (f.type === "person" || f.type === "date" || f.type === "select")).slice(0, 3);
  return (
    <div className="ocdb-lb" role="list" aria-label={`${db.name || "Board"}: ${countLabel(rows.length, db.rows.length, "cards")}`}>
      {lanes.map(([k, list]) => (
        <Lane
          key={k}
          name={k || `No ${g?.name.toLowerCase() ?? "group"}`}
          tone={g?.options?.find((o) => o.v === k)?.c}
          list={list}
          tf={tf}
          meta={meta}
          value={value}
          closed={closed.has(k)}
          onToggle={() => setClosed((s) => {
            const n = new Set(s);
            if (n.has(k)) n.delete(k);
            else n.add(k);
            return n;
          })}
          onOpen={ctx.setPeek}
        />
      ))}
    </div>
  );
}

const Lane = memo(function Lane({ name, tone, list, tf, meta, value, closed, onToggle, onOpen }: {
  name: string;
  tone?: string;
  list: DbRow[];
  tf: DbField | undefined;
  meta: DbField[];
  value: (f: DbField, v: CellValue | undefined) => ReactNode;
  closed: boolean;
  onToggle: () => void;
  onOpen: (rid: string) => void;
}) {
  const sc = useRef<HTMLDivElement>(null);
  const px = useMemo(() => (typeof document === "undefined" ? 16 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16), []);
  const h = Math.round(CARD_REM * px);
  const [w, setW] = useState({ a: 0, b: 30 });
  const measure = () => {
    const el = sc.current;
    if (!el) return;
    const screen = Math.max(1, Math.ceil((el.clientHeight || 600) / h));
    const first = Math.floor(el.scrollTop / h);
    const a = Math.max(0, Math.floor((first - screen) / screen) * screen);
    const b = Math.min(list.length, a + 4 * screen);
    setW((o) => (o.a === a && o.b === b ? o : { a, b }));
  };
  useLayoutEffect(measure, [list.length, closed]); // eslint-disable-line react-hooks/exhaustive-deps
  const raf = useRef(0);
  const cards: ReactNode[] = [];
  for (let i = w.a; i < Math.min(w.b, list.length); i++) {
    const r = list[i];
    cards.push(
      <button key={r.id} role="listitem" className="ocdb-lb-card" style={{ transform: `translateY(${i * h}px)`, height: h - 8 }} data-row={r.id} onClick={() => onOpen(r.id)}>
        <span className="t">{String(r.v[tf?.id ?? ""] ?? "") || "Untitled"}</span>
        <span className="m">{meta.map((f) => <span key={f.id}>{value(f, r.v[f.id] as CellValue | undefined)}</span>)}</span>
      </button>,
    );
  }
  const below = Math.max(0, list.length - w.b);
  return (
    <section className={"ocdb-lb-lane" + (closed ? " closed" : "")} aria-label={`${name}, ${fmt(list.length)} cards`}>
      <header className="ocdb-lb-hd">
        <button className="ocdb-lb-tg" aria-expanded={!closed} onClick={onToggle} aria-label={`${closed ? "Expand" : "Collapse"} ${name}`}>
          <Ic i={closed ? ChevronRight : ChevronDown} s={14} />
        </button>
        <span className={`ocdb-pill st ocdb-c-${tone ?? "gray"}`}>{name}</span>
        <span className="ocdb-lb-n">{fmt(list.length)}</span>
      </header>
      {closed ? null : (
        <div ref={sc} className="ocdb-lb-sc" onScroll={() => (cancelAnimationFrame(raf.current), (raf.current = requestAnimationFrame(measure)))}>
          <div style={{ height: list.length * h, position: "relative" }} role="list">{cards}</div>
          {below ? <p className="ocdb-lb-more" aria-hidden="true">{fmt(below)} more below · loaded as you scroll</p> : null}
        </div>
      )}
    </section>
  );
});
