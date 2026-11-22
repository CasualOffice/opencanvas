// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { secondLine, type OcUser, type Role } from "@opencanvas/ui";
import { peopleRef } from "../lib/people";
import { Ic } from "../icons";
import { addMessage, insertMention, mentionQuery, mentionsIn, setResolved, splitMentions, viewMentions, type Message, type Thread } from "../lib/comments";
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

function MessageText({ m, names }: { m: Message; names: string[] }) {
  // Messages that recorded their labels are shown with this viewer's names (docs/21); older
  // ones highlight known names as before.
  const people = peopleRef.current;
  const runs = m.labels && people ? viewMentions(m.text, m.labels, (id) => people.get(id, m.labels?.[id]).name) : splitMentions(m.text, names);
  return (
    <div className="mt">
      {runs.map((r, i) =>
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
  const people = peopleRef.current;
  const matches = useMemo(() => {
    if (!mq) return [];
    const q = foldQ(mq.query);
    return users
      .filter((u) => u.id !== me.id && (foldQ(u.name).includes(q) || foldQ(u.detail ?? "").includes(q)))
      .sort((a, b) => foldQ(a.name).localeCompare(foldQ(b.name)) || (a.detail ?? "").localeCompare(b.detail ?? ""))
      .slice(0, 6);
  }, [mq, users, me.id]);
  // Who was picked for each inserted `@label`, so two people with the same name stay apart.
  const picked = useRef(new Map<string, string>());

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const labels: Record<string, string> = {};
    for (const [label, id] of picked.current) if (text.includes("@" + label)) labels[id] = label;
    const rest = Object.values(labels).reduce((s, l) => s.split("@" + l).join(" "), text);
    for (const id of mentionsIn(rest, users)) labels[id] ??= users.find((u) => u.id === id)?.name ?? id;
    const mentions = Object.keys(labels);
    addMessage(doc, t.id, { user: me.id, name: me.name, color: me.color, text, mentions, labels });
    picked.current.clear();
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
    picked.current.set(u.name, u.id);
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
      {t.messages.map((m, i) => {
        // The author's current name (docs/21), not the name stored with the message.
        const a: OcUser = people ? people.get(m.user, m.name) : { id: m.user, name: m.name, color: m.color };
        const color = m.color;
        return (
          <div className="msg" key={i}>
            <Avatar name={a.name} color={color} avatar={a.avatar} />
            <div className="mb">
              <b data-person-id={m.user} tabIndex={0}>
                {a.name}
              </b>
              <time dateTime={m.at ? new Date(m.at).toISOString() : undefined}>{rel(m.at)}</time>
              <MessageText m={m} names={names} />
            </div>
          </div>
        );
      })}
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
                  <span className="pl">
                    <span>{u.name}</span>
                    <span className="p2">{secondLine(u)}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const foldQ = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
