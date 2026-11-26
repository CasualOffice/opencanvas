// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// How formula, rollup and relation values show (prototype 1d, 1e, 2d, 3b): error cells with the
// code and the reason on hover or focus, a dash when empty, lists as chips, booleans as a
// read-only check, relation chips with the related titles or "No access".

import { createContext, useContext, type ReactNode } from "react";
import { Check, Lock, Radio } from "lucide-react";
import { fmtDate } from "../query";
import type { DbField, DbRow } from "../types";
import { Ic } from "../ui";
import { isErr, type ComputeOut, type FValue } from "./engine";

/** What value cells need beyond the row: related titles, access, engine state. */
export interface AdvInfo {
  out: ComputeOut | null;
  /** Title of a related row (`undefined` when that row is not there). */
  title: (f: DbField, id: string) => string | undefined;
  noAccess: (f: DbField) => boolean;
  /** Target database gone (links kept 30 days). */
  gone: (f: DbField) => boolean;
}

export const AdvContext = createContext<AdvInfo | null>(null);
export const useAdv = () => useContext(AdvContext);

const fmtNum = (n: number) => (Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "");

export const Dash = () => <span className="ocdb-dash" aria-label="Empty">—</span>;

/** An error cell: the code; the reason on hover or focus (and to screen readers). */
export function ErrCell({ code, msg }: { code: string; msg: string }) {
  return (
    <span className="ocdb-ferr" tabIndex={0} data-tip={msg} aria-label={`${code}: ${msg}`} title={msg}>
      {code}
    </span>
  );
}

/** The engine's static result type in words (prototype 1e). */
export const TYPE_WORD: Record<string, string> = { number: "Number", text: "Text", boolean: "Yes / no", date: "Date", list: "List", any: "Empty" };

export function computedValue(f: DbField, v: FValue | undefined): ReactNode {
  if (v === undefined || v === null || v === "") return <Dash />;
  if (isErr(v)) return <ErrCell code={v.err} msg={v.msg} />;
  if (typeof v === "number") return f.roll?.fn === "percent" ? `${fmtNum(v)}%` : fmtNum(v);
  if (typeof v === "boolean") return <span className={"ocdb-fbool" + (v ? " on" : "")} role="img" aria-label={v ? "Yes" : "No"}>{v ? <Check size={12} strokeWidth={3} /> : null}</span>;
  if (Array.isArray(v)) return v.length ? <>{v.map((x, i) => <span key={i} className="ocdb-pill">{typeof x === "object" ? "" : String(x)}</span>)}</> : <Dash />;
  // Dates come back as `YYYY-MM-DD` and show like date fields.
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
  return String(v);
}

/** Relation chips: related titles, the live icon across canvases, "No access" without counts. */
export function RelationChips({ f, v }: { f: DbField; v: unknown }) {
  const adv = useAdv();
  const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  if (adv?.noAccess(f)) {
    return (
      <span className="ocdb-pill ocdb-noacc">
        <Ic i={Lock} s={11} />
        No access
      </span>
    );
  }
  if (!ids.length) return <Dash />;
  if (adv?.gone(f)) return <span className="ocdb-pill ocdb-gone" title="The linked database was deleted. Links are kept for 30 days.">{ids.length} kept</span>;
  const shown = ids.slice(0, 3);
  return (
    <>
      {shown.map((id) => (
        <span key={id} className="ocdb-pill ocdb-rel">
          {f.rel?.file ? <Ic i={Radio} s={11} /> : null}
          {adv?.title(f, id) ?? "Untitled"}
        </span>
      ))}
      {ids.length > shown.length ? <span className="ocdb-more">+{ids.length - shown.length}</span> : null}
    </>
  );
}

/** Footer for a computed number column: the sum, skipping error cells and saying how many. */
export function computedFoot(f: DbField, rows: DbRow[]): ReactNode {
  let sum = 0, nums = 0, errs = 0;
  for (const r of rows) {
    const v = r.v[f.id] as FValue | undefined;
    if (typeof v === "number") (sum += v), nums++;
    else if (isErr(v)) errs++;
  }
  if (!nums && !errs) return null;
  return (
    <div className="ocdb-cin ocdb-num">
      Sum<b>{fmtNum(sum)}</b>
      {errs ? <span className="ocdb-skip">({errs} error{errs === 1 ? "" : "s"} skipped)</span> : null}
    </div>
  );
}
