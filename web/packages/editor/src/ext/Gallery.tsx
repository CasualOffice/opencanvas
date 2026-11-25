// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The insert gallery, "Browse all blocks" (BSDK-03 frames 6e-6f; INS-01 frame 8a): All blocks and
// the insert menu's five categories on the left, with counts after the editor profile; cards with
// a static preview (a sketch, or the package's `preview.png`, decision 7: a block is never run to
// make a thumbnail); a detail pane with a variant block's choices as chips and what an SDK block
// can do. Arrow keys move between cards, Enter inserts, Escape closes. Extensions is the one
// category with an empty state (6f). Lazy.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Ic } from "../icons";
import { Modal, ModalHead } from "../components/overlay";
import { ExtIcon } from "./ExtIcon";
import { canDo } from "./Chrome";
import { CATS, ORG_HEAD } from "../editor/insert/catalogue";
import { catBlocks, cats, currentVariant, offered, variantsOf, type Block } from "../editor/insert/model";
import { insertCtx, insertRowAtSelection } from "../editor/insert/controller";
import { DiagramSketch } from "../editor/insert/InsertMenu";

/** Docs for admins: how SDK blocks are added (the site page of docs/33). */
export const BLOCKS_DOCS = "https://github.com/CasualOffice/opencanvas/blob/main/docs/33-BLOCK-SDK.md";

const ALL = "all";

function Preview({ b }: { b: Block }) {
  const [broken, setBroken] = useState(false);
  if (b.ext?.preview && !broken) return <img className="oc-gal-img" src={b.ext.preview} alt="" onError={() => setBroken(true)} />;
  if (b.key === "diagram")
    return (
      <div className="oc-gal-sketch dg" aria-hidden="true">
        <DiagramSketch id="flowchart" lg />
      </div>
    );
  return (
    <div className="oc-gal-sketch" aria-hidden="true">
      <span className={"tile" + (b.ext ? " ext" : "")}>{b.ext ? <ExtIcon pkg={b.ext} size={20} /> : <Ic name={b.icon} size={20} />}</span>
      <i />
      <i />
      <i className="s" />
    </div>
  );
}

export default function Gallery({ editor, category, onClose }: { editor: Editor; category?: string; onClose(): void }) {
  const ctx = useMemo(() => insertCtx(), []);
  const all = useMemo(() => offered(ctx).filter((b) => b.action !== "assistant"), [ctx]);
  const navCats = useMemo(() => {
    const c = cats(ctx);
    // Extensions stays listed (with its empty state) even with no SDK blocks (6f).
    return c.some((x) => x.id === "ext") ? c : [...c, CATS.find((x) => x.id === "ext")!];
  }, [ctx]);
  const [cat, setCat] = useState<string>(category ?? ALL);
  const items = useMemo(() => {
    if (cat === ALL) return all;
    const { own, org } = catBlocks(cat as (typeof CATS)[number]["id"], ctx);
    return [...own, ...org];
  }, [cat, all, ctx]);
  const [sel, setSel] = useState(0);
  const [vsel, setVsel] = useState<Record<string, string>>({});
  const grid = useRef<HTMLDivElement>(null);
  const cur = items[Math.min(sel, items.length - 1)];
  const curVariants = cur ? variantsOf(cur, ctx) : [];
  const curVariant = cur ? curVariants.find((v) => v.id === vsel[cur.key]) ?? currentVariant(cur, ctx) : undefined;
  useEffect(() => setSel(0), [cat]);
  useEffect(() => {
    grid.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.focus();
  }, [sel, cat]);

  const insert = (b: Block) => {
    onClose();
    const v = b === cur ? curVariant : currentVariant(b, ctx);
    insertRowAtSelection(editor, { key: b.key, block: b, variant: v, fixed: true });
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
  const count = (id: string) => (id === ALL ? all.filter((b) => !b.action).length : catBlocks(id as (typeof CATS)[number]["id"], ctx).own.filter((b) => !b.action).length + catBlocks(id as (typeof CATS)[number]["id"], ctx).org.length);

  return (
    <Modal onClose={onClose} wide label="Insert a block">
      <ModalHead title="Insert a block" onClose={onClose} />
      <div className="oc-gal">
        <nav className="oc-gal-cats" aria-label="Categories">
          {[{ id: ALL, icon: "layout-grid", title: "All blocks" }, ...navCats].map((c) => (
            <button key={c.id} className={"mi" + (c.id === cat ? " on" : "")} aria-pressed={c.id === cat} onClick={() => setCat(c.id)}>
              <Ic name={c.icon} />
              {c.title}
              <span className="cnt">{count(c.id)}</span>
            </button>
          ))}
        </nav>
        {items.length ? (
          <>
            <div className="oc-gal-grid" ref={grid} role="listbox" aria-label={cat === ALL ? "All blocks" : CATS.find((c) => c.id === cat)?.title} onKeyDown={key}>
              {items.map((b, i) => (
                <button
                  key={b.key}
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  tabIndex={i === sel ? 0 : -1}
                  className={"oc-gal-card" + (i === sel ? " on" : "")}
                  onClick={() => setSel(i)}
                  onDoubleClick={() => insert(b)}
                >
                  <Preview b={b} />
                  <b>{b.title}</b>
                  <span>{b.desc}</span>
                </button>
              ))}
            </div>
            {cur ? (
              <aside className="oc-gal-detail">
                <Preview b={cur} />
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
                {curVariants.length > 1 ? (
                  <>
                    <h4>{cur.segLabel ? cur.segLabel[0].toUpperCase() + cur.segLabel.slice(1) : "Variant"}</h4>
                    <div className="oc-gal-vars" role="radiogroup" aria-label={cur.segLabel ?? "Variant"}>
                      {curVariants.map((v) => (
                        <button key={v.id} role="radio" aria-checked={v.id === curVariant?.id} className={"oc-gal-var" + (v.id === curVariant?.id ? " on" : "")} onClick={() => setVsel({ ...vsel, [cur.key]: v.id })}>
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
                <button className="btn primary" onClick={() => insert(cur)}>
                  <Ic name="plus" size={15} />
                  {curVariants.length > 1 && curVariant ? `Insert ${curVariant.label}` : "Insert"}
                </button>
              </aside>
            ) : null}
          </>
        ) : (
          <div className="empty oc-gal-empty">
            <Ic name="building-2" size={28} />
            <b>Nothing {ORG_HEAD.toLowerCase()} yet</b>
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
