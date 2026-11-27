// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Placeholders for heavy blocks before they load (prototype large-tables 2a-2d, 4b; ADR-076):
// static grey shapes sized from the header (no shimmer), "Loading" only after 400 ms, failed
// loads retried with backoff and a visible countdown (five tries, then only Retry now), and
// "Not on this device" for blocks never loaded while offline.

import { Component, lazy, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";

/** Loading text only after this long (2b). */
export const LOADING_AFTER_MS = 400;
/** Automatic retries before the countdown stops (2c). */
export const MAX_TRIES = 5;
export const backoffS = (fails: number) => Math.min(60, 2 ** fails);

export interface PhInfo {
  kind: "db" | "board" | "sheet" | "chart";
  name?: string | null;
  count?: number;
  fields?: number;
  view?: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function useOnline() {
  const [on, setOn] = useState(typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const f = () => setOn(navigator.onLine !== false);
    addEventListener("online", f);
    addEventListener("offline", f);
    return () => (removeEventListener("online", f), removeEventListener("offline", f));
  }, []);
  return on;
}

export function BlockPlaceholder({ info, failed }: { info: PhInfo; failed?: { fails: number; retryAt: number; retry: () => void } }) {
  const { kind, count, view = "table" } = info;
  const name = info.name || (kind === "db" ? "Database" : kind === "sheet" ? "Spreadsheet" : kind === "chart" ? "Chart" : "Board");
  const [late, setLate] = useState(false);
  const [, tick] = useState(0);
  const online = useOnline();
  useEffect(() => {
    const t = setTimeout(() => setLate(true), LOADING_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  const waiting = failed && failed.fails < MAX_TRIES;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const what = kind === "db" ? (view === "board" ? "board" : "table") : kind === "sheet" ? "spreadsheet" : kind === "chart" ? "chart" : "board";
  const sub = count == null ? null : kind === "db" && view !== "board" ? `${fmt(count)} rows${info.fields ? ` · ${info.fields} fields` : ""}` : `${fmt(count)} cards`;
  let msg: ReactNode = null;
  if (!online) msg = <p className="bph-msg off">Not on this device. {name} wasn’t opened before you went offline, so it loads when you reconnect.</p>;
  else if (failed) {
    const s = Math.max(0, Math.ceil((failed.retryAt - Date.now()) / 1000));
    msg = (
      <p className="bph-msg err" role="alert">
        Couldn’t load {name}. The rest of the canvas works.{waiting ? ` Trying again in ${s} s.` : ""}
        <button className="btn" onClick={failed.retry}>Retry now</button>
      </p>
    );
  } else if (late) msg = <p className="bph-msg">Loading {what}…</p>;
  // Sized from the header: the real height, capped at the view height for tables.
  const lines = kind === "db" ? Math.max(1, Math.min(count ?? 3, Math.floor((typeof innerHeight === "number" ? innerHeight : 800) / 41) - 4)) : 0;
  return (
    <div className={"bskel " + (kind === "db" ? "db" : "board")} aria-busy={!failed && online} aria-label={`${name}${sub ? `, ${sub}` : ""}`}>
      <div className="bsh">
        <i style={{ width: "1.5rem", height: "1.5rem", borderRadius: ".4375rem" }} />
        <b className="bph-name">{name}</b>
        {sub ? <span className="bph-sub">{sub}</span> : null}
      </div>
      {msg}
      {kind === "db" && view === "table" ? (
        <div className="bst">
          {Array.from({ length: lines + 1 }, (_, i) => (
            <div key={i} className={i ? "r" : "r h"}>
              <i style={{ width: "30%" }} />
              <i style={{ width: "16%" }} />
              <i style={{ width: "20%" }} />
              <i style={{ width: "12%" }} />
            </div>
          ))}
        </div>
      ) : kind === "db" ? (
        <i className="bsg" style={{ height: view === "calendar" ? "32.5rem" : "18.75rem" }} />
      ) : null}
    </div>
  );
}

class Catch extends Component<{ onError: () => void; children: ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() {
    return { err: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.err ? null : this.props.children;
  }
}

/**
 * A lazily loaded block component with the failure states of 2c: each failure schedules a retry
 * (2, 4, 8 … 60 s) until five, Retry now skips the wait.
 */
export function useRetryingLazy<P>(load: () => Promise<{ default: ComponentType<P> }>) {
  const [attempt, setAttempt] = useState(0);
  const [fail, setFail] = useState<{ fails: number; retryAt: number; at: number } | null>(null);
  const Comp = useMemo(() => lazy(load), [attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const showing = !!fail && fail.at === attempt;
  useEffect(() => {
    if (!fail || !showing || fail.fails >= MAX_TRIES) return;
    const t = setTimeout(() => setAttempt((a) => a + 1), Math.max(0, fail.retryAt - Date.now()));
    return () => clearTimeout(t);
  }, [fail, showing]);
  const retry = () => setAttempt((a) => a + 1);
  const onError = () =>
    setFail((f) => {
      const fails = (f?.fails ?? 0) + 1;
      return { fails, retryAt: Date.now() + backoffS(fails) * 1000, at: attempt };
    });
  const failed = showing && fail ? { fails: fail.fails, retryAt: fail.retryAt, retry } : undefined;
  /** The block (in its error boundary), or the failed placeholder until the next attempt. */
  const wrap = (children: ReactNode, ph: ReactNode) => (failed ? ph : <Catch key={attempt} onError={onError}>{children}</Catch>);
  return { Comp, failed, wrap };
}
