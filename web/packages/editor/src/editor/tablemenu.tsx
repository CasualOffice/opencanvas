// Table tools (WEB-02): a small "Table" handle above the table that holds the
// caret, opening rows / columns / header / delete actions. Lazy.
import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Ic } from "../icons";
import { Popover, useShell } from "../components/overlay";
import { toast } from "../lib/store";
import { loadTables } from "./table";
import type { TableAt } from "./tablestate";

type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;
type Tables = Awaited<ReturnType<typeof loadTables>>;

export function TableMenu({ editor, at }: { editor: Editor; at: TableAt }) {
  const { root } = useShell();
  const [t, setT] = useState<Tables | null>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const [open, setOpen] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let off = false;
    void loadTables().then((m) => !off && setT(m));
    return () => {
      off = true;
    };
  }, []);

  // Follow the table while the page scrolls or the table changes size.
  useLayoutEffect(() => {
    if (!root) return;
    let raf = 0;
    const place = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const dom = editor.view.nodeDOM(at.pos) as HTMLElement | null;
        const el = dom?.closest?.(".tableWrapper") ?? dom;
        if (!el?.getBoundingClientRect) return setBox(null);
        const r = el.getBoundingClientRect();
        const ar = root.getBoundingClientRect();
        const top = r.top - ar.top - 34;
        setBox(top < 52 || r.bottom - ar.top < 60 ? null : { left: Math.max(8, Math.min(r.left - ar.left, ar.width - 140)), top });
      });
    };
    place();
    const sc = root.querySelector(".scroll");
    sc?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    editor.on("update", place);
    return () => {
      cancelAnimationFrame(raf);
      sc?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      editor.off("update", place);
    };
  }, [root, editor, at.pos]);

  if (!root || !box) return null;
  const run = (cmd: Cmd, done?: string) => () => {
    setOpen(null);
    editor.commands.focus();
    if (!cmd(editor.state, editor.view.dispatch)) return toast("That doesn't work on this selection", { icon: "table" });
    if (done) toast(done, { icon: "table", action: { label: "Undo", run: () => editor.commands.undo() } });
  };
  const can = (cmd: Cmd) => !!t && cmd(editor.state);
  return createPortal(
    <>
      <div className="tblh" style={{ left: box.left, top: box.top }} onMouseDown={(e) => e.preventDefault()}>
        <button
          className="ib"
          aria-label="Add row below"
          title="Add row below"
          disabled={!t}
          onClick={t ? run(t.addRowAfter) : undefined}
        >
          <Ic name="between-horizontal-end" size={15} />
        </button>
        <button
          className="ib"
          aria-label="Add column right"
          title="Add column right"
          disabled={!t}
          onClick={t ? run(t.addColumnAfter) : undefined}
        >
          <Ic name="between-vertical-end" size={15} />
        </button>
        <span className="vs" />
        <button className="tsel" aria-haspopup="menu" aria-expanded={!!open} onClick={(e) => setOpen(open ? null : e.currentTarget)}>
          <Ic name="table" size={14} />
          Table
          <Ic name="chevron-down" size={12} />
        </button>
      </div>
      {open && t ? (
        <Popover anchor={open} onClose={() => setOpen(null)} title="Table" minWidth={230}>
          <div className="mh">Rows</div>
          <button className="mi" onClick={run(t.addRowBefore)}>
            <Ic name="between-horizontal-start" />
            Add row above
          </button>
          <button className="mi" onClick={run(t.addRowAfter)}>
            <Ic name="between-horizontal-end" />
            Add row below
          </button>
          <button className="mi" disabled={!can(t.deleteRow)} onClick={run(t.deleteRow, "Row deleted")}>
            <Ic name="trash-2" />
            Delete row
          </button>
          <div className="msep" />
          <div className="mh">Columns</div>
          <button className="mi" onClick={run(t.addColumnBefore)}>
            <Ic name="between-vertical-start" />
            Add column left
          </button>
          <button className="mi" onClick={run(t.addColumnAfter)}>
            <Ic name="between-vertical-end" />
            Add column right
          </button>
          <button className="mi" disabled={!can(t.deleteColumn)} onClick={run(t.deleteColumn, "Column deleted")}>
            <Ic name="trash-2" />
            Delete column
          </button>
          <div className="msep" />
          <button className="mi" onClick={run(t.toggleHeaderRow)}>
            <Ic name="panel-top" />
            Header row
            {t.rowIsHeader(t.TableMap.get(editor.state.doc.nodeAt(at.pos)!), editor.state.doc.nodeAt(at.pos)!, 0) ? (
              <span className="chk">
                <Ic name="check" size={14} />
              </span>
            ) : null}
          </button>
          <button className="mi" disabled={!can(t.mergeCells)} onClick={run(t.mergeCells)}>
            <Ic name="rows-2" />
            Merge cells
          </button>
          <button className="mi" disabled={!can(t.splitCell)} onClick={run(t.splitCell)}>
            <Ic name="columns-2" />
            Split cell
          </button>
          <div className="msep" />
          <button className="mi danger" onClick={run(t.deleteTable, "Table deleted")}>
            <Ic name="trash-2" />
            Delete table
          </button>
        </Popover>
      ) : null}
    </>,
    root,
  );
}
