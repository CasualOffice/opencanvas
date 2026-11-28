// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The @mention list and the paste-link menus (WEB-08 budget: off the first screen; fetched
// right after first paint).
import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { Ic } from "../icons";
import { bookmarkNode, hostOf, resolveEmbed } from "../lib/embeds";
import { markPending } from "../lib/unfurl";
import { Popover } from "../components/overlay";
import { insertRef } from "../live/state";
import { readableOn } from "../lib/color";
import { dismissSuggest, type SuggestState } from "./suggest";
import { initialsOf, pasteStore, type PasteOffer } from "./CanvasEditor";

export function MentionMenu({ s }: { s: SuggestState }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(".mi.on")?.scrollIntoView({ block: "nearest" });
  }, [s.sel]);
  const close = () => dismissSuggest();
  const hold = (e: React.MouseEvent | React.PointerEvent) => e.preventDefault();
  const items = s.items as { id: string; label: string; color: string; avatar?: string; initials?: string; second?: string; note?: string; dup?: boolean; warn?: string; date?: string; pick?: boolean }[];
  const people = items.filter((u) => !u.date).length;
  let last = "";
  return (
    <Popover anchor={s.rect!} onClose={close} title="Mention" minWidth={240} kind="listbox">
      <div ref={listRef} onMouseDown={hold}>
        {!people ? (
          <div className="mh" style={{ textTransform: "none", letterSpacing: 0, fontSize: ".8125rem" }}>
            No one matches “{s.query}”
          </div>
        ) : null}
        {items.map((u, i) => {
          const group = u.date ? "Dates" : "People";
          const head = group !== last ? <div className="mh">{group}</div> : null;
          last = group;
          return (
            <span key={u.id} style={{ display: "contents" }}>
              {head}
              <button className={"mi" + (i === s.sel ? " on" : "") + (u.dup ? " dup" : "")} onClick={() => s.pick(u)}>
                {u.date ? (
                  <span className="ftile tone-blue dateic" aria-hidden="true">
                    <Ic name={u.pick ? "calendar-plus" : "calendar"} size={14} />
                  </span>
                ) : (
                  <span className="av sm" style={{ background: u.color, color: readableOn(u.color) }} aria-hidden="true">
                    {u.avatar ? <img src={u.avatar} alt="" /> : u.initials ?? initialsOf(u.label)}
                  </span>
                )}
                {u.date ? (
                  u.label
                ) : (
                  // Every person has a second line (docs/21): detail, e-mail if allowed, last seen, or the id's end.
                  <span className="pl">
                    <span>{u.label}</span>
                    <span className="p2">{[u.second, u.note].filter(Boolean).join(" · ")}</span>
                    {u.warn ? (
                      <span className="warn">
                        <Ic name="triangle-alert" size={12} />
                        {u.warn}
                      </span>
                    ) : null}
                  </span>
                )}
                {u.date && !u.pick ? <span className="mk">{new Date(u.date + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span> : null}
              </button>
            </span>
          );
        })}
      </div>
    </Popover>
  );
}

export function PasteOfferMenu({ editor, o }: { editor: Editor; o: PasteOffer }) {
  const close = () => pasteStore.set(null);
  if (o.block) return <PasteBlock editor={editor} o={o} />;
  const embed = resolveEmbed(o.url);
  const replace = (node: object) => {
    close();
    const $p = editor.state.doc.resolve(o.from);
    const blockEnd = $p.after(1);
    const blockEmpty = editor.state.doc.textBetween($p.before(1), blockEnd).trim() === o.url;
    let c = editor.chain().focus().deleteRange({ from: o.from, to: o.to });
    if (blockEmpty) c = c.insertContent(node);
    else c = c.insertContentAt(blockEnd - (o.to - o.from), node);
    c.run();
  };
  return (
    <Popover anchor={o.rect} onClose={close} title="Paste link" minWidth={200} autoFocus={false}>
      <div onMouseDown={(e) => e.preventDefault()}>
        <div className="mh">Paste as</div>
        <button className="mi" onClick={close}>
          <Ic name="link" />
          Link
        </button>
        <button className="mi" onClick={() => {
            markPending(o.url);
            replace(bookmarkNode(o.url));
          }}>
          <Ic name="panel-top" />
          Link preview
        </button>
        <button className="mi" disabled={!embed} title={embed ? undefined : "Only YouTube, Vimeo, Loom, Figma and Maps can be embedded"} onClick={() => embed && replace({ type: "embed", attrs: { provider: embed.provider, url: o.url, title: hostOf(o.url) } })}>
          <Ic name="circle-play" />
          Embed
        </button>
      </div>
    </Popover>
  );
}

/** 1d: a pasted block link becomes a live block, a reference or stays a link. */
function PasteBlock({ editor, o }: { editor: Editor; o: PasteOffer }) {
  const close = () => pasteStore.set(null);
  const l = o.block!;
  // A link to a block of an ordinary canvas cannot become a live block (1d).
  const liveOk = !l.blockId || !!l.live;
  const refOk = !!l.blockId;
  const first = liveOk && (l.live || !l.blockId) ? "live" : refOk ? "ref" : "link";
  const take = (what: "live" | "ref" | "link") => {
    close();
    if (what === "link") return;
    const $p = editor.state.doc.resolve(o.from);
    const blockEmpty = editor.state.doc.textBetween($p.before(1), $p.after(1)).trim() === o.url;
    const range = blockEmpty ? { from: $p.before(1), to: $p.after(1) } : { from: o.from, to: o.to };
    insertRef(editor, what === "ref" ? { fileId: l.fileId, refBlockId: l.blockId } : { fileId: l.fileId }, range);
  };
  const takeRef = useRef(take);
  takeRef.current = take;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        takeRef.current(first);
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [first]);
  return (
    <Popover anchor={o.rect} onClose={close} title="Paste link" minWidth={260} autoFocus={false} className="lb-paste">
      <div onMouseDown={(e) => e.preventDefault()}>
        <div className="mh">Paste as</div>
        <button className="mi" disabled={!liveOk} onClick={() => take("live")}>
          <Ic name="radio" />
          <span className="pl">
            <span>Live block</span>
            <span className="p2">{liveOk ? "Edit it here; changes show everywhere" : "Make it live in its canvas first"}</span>
          </span>
          {first === "live" ? <span className="mk">↵</span> : null}
        </button>
        <button className="mi" disabled={!refOk} onClick={() => take("ref")}>
          <Ic name="link-2" />
          <span className="pl">
            <span>Reference</span>
            <span className="p2">{refOk ? "Read only, updates when the source changes" : "Copy a link to one block for a reference"}</span>
          </span>
          {first === "ref" ? <span className="mk">↵</span> : null}
        </button>
        <button className="mi" onClick={() => take("link")}>
          <Ic name="link" />
          <span className="pl">
            <span>Link</span>
            <span className="p2">Just the address</span>
          </span>
        </button>
      </div>
    </Popover>
  );
}
