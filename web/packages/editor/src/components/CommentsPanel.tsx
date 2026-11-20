import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { OcUser, Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import { addMessage, setResolved, type Thread } from "../lib/comments";
import { rel, useTick } from "../lib/meta";
import { toast } from "../lib/store";
import { Avatar } from "./overlay";

export function CommentsPanel(props: {
  doc: Y.Doc;
  threads: Thread[];
  active: string | null;
  role: Role;
  me: OcUser;
  onActivate(id: string): void;
  onJump(id: string): void;
  onClose(): void;
}) {
  useTick(30000);
  const [showResolved, setShowResolved] = useState(false);
  const open = props.threads.filter((t) => !t.resolved);
  const resolved = props.threads.filter((t) => t.resolved);
  const list = showResolved ? props.threads : open;
  const canWrite = props.role !== "view";

  return (
    <aside className="side" aria-label="Comments">
      <div className="shd">
        <b>Comments</b>
        <span>{open.length} open</span>
        <span className="grow" />
        {resolved.length ? (
          <button className="ib" title={showResolved ? "Hide resolved" : `Show resolved (${resolved.length})`} aria-pressed={showResolved} onClick={() => setShowResolved(!showResolved)}>
            <Ic name="circle-check" />
          </button>
        ) : null}
        <button className="ib" onClick={props.onClose} aria-label="Close comments">
          <Ic name="x" />
        </button>
      </div>
      <div className="sbd">
        {list.length ? (
          list.map((t) => (
            <ThreadCard key={t.id} {...props} t={t} canWrite={canWrite} />
          ))
        ) : (
          <div className="empty">
            <Ic name="message-square" size={22} />
            <p>{canWrite ? "No open comments. Select text to start one." : "No open comments."}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function ThreadCard({ t, active, doc, me, canWrite, onActivate, onJump }: { t: Thread; active: string | null; doc: Y.Doc; me: OcUser; canWrite: boolean; onActivate(id: string): void; onJump(id: string): void }) {
  const [draft, setDraft] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const isActive = active === t.id;
  useEffect(() => {
    if (isActive) {
      ta.current?.focus();
      ta.current?.closest(".thread")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [isActive]);
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    addMessage(doc, t.id, { user: me.id, name: me.name, color: me.color, text });
    setDraft("");
  };
  return (
    <div className={"thread" + (isActive ? " active" : "") + (t.resolved ? " resolved" : "")} onClick={() => onActivate(t.id)}>
      {canWrite ? (
        <div className="tacts">
          <button
            className="ib"
            title={t.resolved ? "Re-open" : "Resolve"}
            aria-label={t.resolved ? "Re-open thread" : "Resolve thread"}
            onClick={(e) => {
              e.stopPropagation();
              setResolved(doc, t.id, !t.resolved);
              if (!t.resolved) toast("Comment resolved", { icon: "circle-check", action: { label: "Undo", run: () => setResolved(doc, t.id, false) } });
            }}
          >
            <Ic name={t.resolved ? "rotate-ccw" : "check"} size={14} />
          </button>
        </div>
      ) : null}
      <div className="tq" onClick={() => onJump(t.id)} title="Show in canvas">
        {t.quote || "Comment"}
      </div>
      {t.messages.map((m, i) => (
        <div className="msg" key={i}>
          <Avatar name={m.name} color={m.color} />
          <div className="mb">
            <b>{m.name}</b>
            <time>{rel(m.at)}</time>
            <div>{m.text}</div>
          </div>
        </div>
      ))}
      {canWrite ? (
        <div className="reply">
          <textarea
            ref={ta}
            rows={1}
            placeholder={t.messages.length ? "Reply" : "Add a comment"}
            aria-label={t.messages.length ? "Reply" : "Add a comment"}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "36px";
              e.target.style.height = Math.min(140, e.target.scrollHeight) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="ib" onClick={send} aria-label="Send" style={{ color: "var(--accent)" }} disabled={!draft.trim()}>
            <Ic name="arrow-up" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
