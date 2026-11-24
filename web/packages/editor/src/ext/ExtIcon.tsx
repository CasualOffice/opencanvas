// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// A block package's manifest icon (any Lucide name) on its tile, for the / menu, the insert sheet,
// the gallery and the badge popover. Names the editor bundles draw at once; any other Lucide
// icon loads lazily from the full set (the board's diagram icons, their own chunks); an unknown
// name keeps the puzzle icon. Path data is checked before it is drawn.
import { useEffect, useState } from "react";
import { Ic, ICONS } from "../icons";
import type { BlockPackage } from "./model";

const PATH_RE = /^[MLHVCSQTAZmlhvcsqtaz0-9 ,.-]{1,2000}$/;
const cache = new Map<string, Promise<string[] | null>>();

function load(name: string): Promise<string[] | null> {
  let p = cache.get(name);
  if (!p) {
    p = import("@opencanvas/board/src/lucide")
      .then((m) => m.lucidePaths(name))
      .then((paths) => (paths && paths.every((d) => PATH_RE.test(d)) ? paths : null))
      .catch(() => null);
    cache.set(name, p);
  }
  return p;
}

export function ExtIcon({ pkg, size = 18 }: { pkg: Pick<BlockPackage, "icon">; size?: number }) {
  const name = pkg.icon ?? "";
  const known = !!name && name in ICONS;
  const [paths, setPaths] = useState<string[] | null>(null);
  useEffect(() => {
    if (!name || known) return;
    let on = true;
    void load(name).then((p) => on && setPaths(p));
    return () => {
      on = false;
    };
  }, [name, known]);
  if (known) return <Ic name={name} size={size} />;
  if (!paths) return <Ic name="puzzle" size={size} />;
  return (
    <svg className="lucide" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
