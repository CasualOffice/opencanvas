// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// A small history router: paths under /ws/.

import { useEffect, useState } from "react";

const listeners = new Set<() => void>();

export function go(path: string, replace = false) {
  const url = path.startsWith("/ws") ? path : `/ws${path}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const read = () => location.pathname.replace(/^\/ws/, "") || "/";
  const [p, setP] = useState(read);
  useEffect(() => {
    const on = () => setP(read());
    listeners.add(on);
    window.addEventListener("popstate", on);
    return () => {
      listeners.delete(on);
      window.removeEventListener("popstate", on);
    };
  }, []);
  return p;
}

/** Plain left clicks on in-app links navigate without a reload. */
export function onLink(e: React.MouseEvent, path: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(path);
}
