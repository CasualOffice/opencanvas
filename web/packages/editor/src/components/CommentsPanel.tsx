import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import type { OcUser, Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import { addMessage, insertMention, mentionQuery, mentionsIn, setResolved, splitMentions, type Thread } from "../lib/comments";
import { rel, useTick } from "../lib/meta";
import { toast } from "../lib/store";
import { Avatar } from "./overlay";

export function CommentsPanel(props: {
  doc: Y.Doc;
  threads: Thread[];
  active: string | null;
  role: Role;
  me: OcUser;
  /** People who can be @mentioned (the host's users plus whoever is here). */
  users: OcUser[];
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
        <h2>Comments</h2>
        <span>{open.length} open</span>
        <span className="grow" />
        {resolved.length ? (
          <button
            className="ib"
            title={showResolved ? "Hide resolved" : `Show resolved (${resolved.length})`}
            aria-label={showResolved ? "Hide resolved comments" : `Show ${resolved.length} resolved`}
            aria-pressed={showResolved}
            onClick={() => setShowResolved(!showResolved)}
          >
            <Ic name="circle-check" />
          </button>
        ) : null}
        <button className="ib" onClick={props.onClose} aria-label="Close comments">
          <Ic name="x" />
        </button>
      </div>
      <div className="sbd">
        {list.length ? (
          list.map((t) => <ThreadCard key={t.id} {...props} t={t} canWrite={canWrite} />)
        ) : (
          <div className="empty">
            <Ic name="message-square" size={22} />
            <p>
              <b>No open comments</b>
              <br />
              {canWrite ? "Select text in the canvas and choose Comment to start a thread. Type @ to mention someone." : "Comments from people with access show up here."}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}

function MessageText({ text, names }: { text: string; names: string[] }) {
  return (
    <div className="mt">
      {splitMentions(text, names).map((r, i) =>
        r.mention ? (
          <span key={i} className="cmention">
            {r.text}
          </span>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </div>
  );
}

function ThreadCard({
  t,
  active,
  doc,
  me,
  users,
  canWrite,
  onActivate,
  onJump,
}: {
  t: Thread;
  active: string | null;
  doc: Y.Doc;
  me: OcUser;
  users: OcUser[];
  canWrite: boolean;
  onActivate(id: string): void;
  onJump(id: string): void;
}) {
  const [draft, setDraft] = useState("");
  const [mq, setMq] = useState<{ start: number; query: string } | null>(null);
  const [sel, setSel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const isActive = active === t.id;
  const listId = `mq-${t.id}`;
  useEffect(() => {
    if (isActive) {
      ta.current?.focus();
      ta.current?.closest(".thread")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [isActive]);
  const names = useMemo(() => users.map((u) => u.name).concat(t.messages.map((m) => m.name)), [users, t.messages]);
  const matches = useMemo(() => {
    if (!mq) return [];
    const q = mq.query.toLowerCase();
    return users.filter((u) => u.id !== me.id && u.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mq, users, me.id]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const mentions = mentionsIn(text, users);
    addMessage(doc, t.id, { user: me.id, name: me.name, color: me.color, text, mentions });
    setDraft("");
    setMq(null);
  };
  const sync = (el: HTMLTextAreaElement) => {
    const q = mentionQuery(el.value, el.selectionStart ?? el.value.length);
    setMq(q);
    setSel(0);
  };
  const pick = (u: OcUser) => {
    const el = ta.current;
    if (!el || !mq) return;
    const r = insertMention(draft, mq.start, el.selectionStart ?? draft.length, u.name);
    setDraft(r.text);
    setMq(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
  };
  const showList = !!mq && matches.length > 0;
  return (
    <div className={"thread" + (isActive ? " active" : "") + (t.resolved ? " resolved" : "")} onClick={() => onActivate(t.id)} onFocus={() => !isActive && onActivate(t.id)}>
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
      <button className="tq" onClick={() => onJump(t.id)} title="Show in canvas" aria-label={`Show in canvas: ${t.quote || "Comment"}`}>
        {t.quote || "Comment"}
      </button>
      {t.messages.map((m, i) => (
        <div className="msg" key={i}>
          <Avatar name={m.name} color={m.color} />
          <div className="mb">
            <b>{m.name}</b>
            <time dateTime={m.at ? new Date(m.at).toISOString() : undefined}>{rel(m.at)}</time>
            <MessageText text={m.text} names={names} />
          </div>
        </div>
      ))}
      {canWrite ? (
        <div className="reply">
          <textarea
            ref={ta}
            rows={1}
            placeholder={t.messages.length ? "Reply, @ to mention" : "Add a comment, @ to mention"}
            aria-label={t.messages.length ? "Reply" : "Add a comment"}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={showList ? listId : undefined}
            aria-activedescendant={showList ? `${listId}-${sel}` : undefined}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              sync(e.target);
              e.target.style.height = "36px";
              e.target.style.height = Math.min(140, e.target.scrollHeight) + "px";
            }}
            onSelect={(e) => sync(e.currentTarget)}
            onBlur={() => window.setTimeout(() => setMq(null), 150)}
            onKeyDown={(e) => {
              if (showList) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = matches.length;
                  setSel((s) => (s + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pick(matches[sel] ?? matches[0]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setMq(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="ib" onClick={send} aria-label="Send" style={{ color: "var(--accent)" }} disabled={!draft.trim()}>
            <Ic name="arrow-up" />
          </button>
          {showList ? (
            <div className="mlist" role="listbox" id={listId} aria-label="People">
              {matches.map((u, i) => (
                <div
                  key={u.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === sel}
                  className={"mi" + (i === sel ? " on" : "")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(u);
                  }}
                  onMouseEnter={() => setSel(i)}
                >
                  <Avatar name={u.name} color={u.color} avatar={u.avatar} />
                  {u.name}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
