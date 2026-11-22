// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { useSyncExternalStore } from "react";

/** A tiny observable value, for state that lives outside React (editor plugins, Yjs). */
export interface Store<T> {
  get(): T;
  set(v: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let v = initial;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(n) {
      const next = typeof n === "function" ? (n as (p: T) => T)(v) : n;
      if (Object.is(next, v)) return;
      v = next;
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

// ---------- toasts ----------

export interface ToastMsg {
  id: number;
  icon?: string;
  avatar?: { name: string; color: string };
  text: string;
  action?: { label: string; run: () => void };
}

export const toastStore = createStore<ToastMsg | null>(null);
let toastSeq = 0;
let toastTimer: number | undefined;

export function toast(text: string, opts: { icon?: string; avatar?: ToastMsg["avatar"]; action?: ToastMsg["action"] } = {}) {
  const id = ++toastSeq;
  toastStore.set({ id, text, ...opts });
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (toastStore.get()?.id === id) toastStore.set(null);
  }, opts.action ? 5000 : 3000);
}
