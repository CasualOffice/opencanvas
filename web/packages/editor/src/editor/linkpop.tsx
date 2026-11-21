// Link popover: edit a link (⌘K, toolbar, phone bar) or act on one that was
// clicked (open, edit, copy, remove). Lazy: loads the first time it is shown.
import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Ic } from "../icons";
import { Popover } from "../components/overlay";
import { bridge } from "../lib/bridge";
import { toast } from "../lib/store";
import { hostOf } from "../lib/embeds";
import { applyLink, linkStore, normalizeHref, removeLink, type LinkEdit } from "./linkstate";

export function openHref(href: string) {
  bridge.linkClick?.(href);
  window.open(href, "_blank", "noopener,noreferrer");
}

export function LinkPopover({ editor, edit }: { editor: Editor; edit: LinkEdit }) {
  const [draft, setDraft] = useState(edit.href);
  const [err, setErr] = useState("");
  const close = () => linkStore.set(null);
  const done = () => {
    close();
    editor.commands.focus();
  };
  const anchor = new DOMRect(edit.rect.left, edit.rect.top, Math.max(1, edit.rect.right - edit.rect.left), edit.rect.bottom - edit.rect.top);

  if (edit.mode === "view") {
    return (
      <Popover key="view" anchor={anchor} onClose={close} title="Link" kind="menu" autoFocus={false} minWidth={260}>
        <div className="lk-url" title={edit.href}>
          <Ic name="globe" size={14} />
          <span>{edit.href.replace(/^mailto:/, "") || "No address"}</span>
        </div>
        <div className="msep" />
        <button className="mi" onClick={() => (close(), openHref(edit.href))}>
          <Ic name="external-link" />
          Open {hostOf(edit.href) && /^https?:/.test(edit.href) ? hostOf(edit.href) : "link"}
        </button>
        <button className="mi" onClick={() => linkStore.set({ ...edit, mode: "edit" })}>
          <Ic name="pencil" />
          Edit link
        </button>
        <button
          className="mi"
          onClick={() => {
            void navigator.clipboard?.writeText(edit.href).catch(() => undefined);
            toast("Link copied", { icon: "copy" });
            done();
          }}
        >
          <Ic name="copy" />
          Copy link
        </button>
        <button className="mi danger" onClick={() => (close(), removeLink(editor, edit))}>
          <Ic name="unlink" />
          Remove link
        </button>
      </Popover>
    );
  }

  const submit = () => {
    if (!draft.trim()) {
      if (edit.href) removeLink(editor, edit);
      return done();
    }
    if (!normalizeHref(draft)) return setErr("That doesn't look like a web address or email.");
    applyLink(editor, edit, draft);
    close();
  };
  return (
    <Popover key="edit" anchor={anchor} onClose={close} title={edit.href ? "Edit link" : "Add link"} kind="dialog" minWidth={300}>
      <form
        className="lk-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Ic name="link" size={15} />
        <input
          data-autofocus
          value={draft}
          placeholder="Paste or type a link"
          aria-label="Link address"
          aria-invalid={!!err}
          aria-describedby={err ? "lk-err" : undefined}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => (setDraft(e.target.value), setErr(""))}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              done();
            }
          }}
        />
        <button className="btn sm primary" type="submit" disabled={!draft.trim() && !edit.href}>
          {edit.href ? "Save" : "Link"}
        </button>
      </form>
      {err ? (
        <p className="lk-err" id="lk-err" role="alert">
          {err}
        </p>
      ) : null}
      {edit.href ? (
        <>
          <div className="msep" />
          <button className="mi danger" type="button" onClick={() => (close(), removeLink(editor, edit))}>
            <Ic name="unlink" />
            Remove link
          </button>
        </>
      ) : null}
    </Popover>
  );
}
