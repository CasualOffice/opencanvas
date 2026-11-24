// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The insert gallery, "Browse all blocks" (BSDK-03, frames 6e-6f): categories on the left (the
// editor's groups, then "From your organisation" last), cards with a static preview (a sketch
// drawn from the manifest, or the package's `preview.png`, decision 7: a block is never run to
// make a thumbnail), and a detail pane with what the selected block can do. Arrow keys move
// between cards, Enter inserts, Escape closes. The organisation category is the one place with
// an empty state (6f). Lazy.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Ic } from "../icons";
import { Modal, ModalHead } from "../components/overlay";
import { filterSlash, ORG_GROUP, type SlashItem } from "../editor/slash";
import { ExtIcon } from "./ExtIcon";
import { canDo } from "./Chrome";

const CATS = ["Basic", "Data", "Media", "Layout", ORG_GROUP] as const;
const CAT_ICON: Record<string, string> = { Basic: "type", Data: "database", Media: "image", Layout: "columns-2", [ORG_GROUP]: "building-2" };

/** Docs for admins: how SDK blocks are added (the site page of docs/32). */
export const BLOCKS_DOCS = "https://github.com/CasualOffice/opencanvas/blob/main/docs/32-BLOCK-SDK.md";

function Preview({ x }: { x: SlashItem }) {
  const [broken, setBroken] = useState(false);
  if (x.ext?.preview && !broken) return <img className="oc-gal-img" src={x.ext.preview} alt="" onError={() => setBroken(true)} />;
  return (
    <div className="oc-gal-sketch" aria-hidden="true">
      <span className={"tile" + (x.ext ? " ext" : "")}>{x.ext ? <ExtIcon pkg={x.ext} size={20} /> : <Ic name={x.icon} size={20} />}</span>
      <i />
      <i />
      <i className="s" />
    </div>
  );
}

export default function Gallery({ editor, category, onClose }: { editor: Editor; category?: string; onClose(): void }) {
  const all = useMemo(() => filterSlash(""), []);
  const [cat, setCat] = useState<string>(category ?? (all.some((x) => x.group === ORG_GROUP) ? ORG_GROUP : "Basic"));
  const items = all.filter((x) => x.group === cat);
  const [sel, setSel] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const cur = items[Math.min(sel, items.length - 1)];
  useEffect(() => setSel(0), [cat]);
  useEffect(() => {
    grid.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.focus();
  }, [sel, cat]);

  const insert = (x: SlashItem) => {
    onClose();
    x.run(editor, null);
  };
  const key = (e: React.KeyboardEvent) => {
    const cols = grid.current ? Math.max(1, Math.round(grid.current.clientWidth / 180)) : 3;
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      setSel((s) => Math.max(0, Math.min(items.length - 1, s + move)));
    } else if (e.key === "Enter" && cur) {
      e.preventDefault();
      insert(cur);
    }
  };

  return (
    <Modal onClose={onClose} wide label="Insert a block">
      <ModalHead title="Insert a block" onClose={onClose} />
      <div className="oc-gal">
        <nav className="oc-gal-cats" aria-label="Categories">
          {CATS.map((c) => (
            <button key={c} className={"mi" + (c === cat ? " on" : "")} aria-pressed={c === cat} onClick={() => setCat(c)}>
              <Ic name={CAT_ICON[c]} />
              {c}
              <span className="cnt">{all.filter((x) => x.group === c).length}</span>
            </button>
          ))}
        </nav>
        {items.length ? (
          <>
            <div className="oc-gal-grid" ref={grid} role="listbox" aria-label={cat} onKeyDown={key}>
              {items.map((x, i) => (
                <button
                  key={x.id}
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  tabIndex={i === sel ? 0 : -1}
                  className={"oc-gal-card" + (i === sel ? " on" : "")}
                  onClick={() => setSel(i)}
                  onDoubleClick={() => insert(x)}
                >
                  <Preview x={x} />
                  <b>{x.title}</b>
                  <span>{x.desc}</span>
                </button>
              ))}
            </div>
            {cur ? (
              <aside className="oc-gal-detail">
                <Preview x={cur} />
                <h3>{cur.title}</h3>
                {cur.ext ? (
                  <>
                    <p className="meta">
                      {cur.ext.publisher ? `by ${cur.ext.publisher} · ` : ""}
                      {cur.ext.type} {cur.ext.version}
                    </p>
                    {cur.ext.description ? <p>{cur.ext.description}</p> : null}
                    <h4>This block can</h4>
                    {canDo(cur.ext).length ? (
                      <ul>
                        {canDo(cur.ext).map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>Nothing outside the canvas: no internet, no member list.</p>
                    )}
                  </>
                ) : (
                  <p>{cur.desc}</p>
                )}
                <button className="btn primary" onClick={() => insert(cur)}>
                  Insert
                </button>
              </aside>
            ) : null}
          </>
        ) : (
          <div className="empty oc-gal-empty">
            <Ic name="building-2" size={28} />
            <b>Nothing from your organisation yet</b>
            <p>Blocks your organisation adds for this app show up here. If you expected one, ask your administrator.</p>
            <a href={BLOCKS_DOCS} target="_blank" rel="noopener noreferrer">
              How blocks are added
            </a>
          </div>
        )}
      </div>
    </Modal>
  );
}
