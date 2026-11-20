// Comment threads live in the `comments` root (docs/15 §4) so commenters can
// write them without touching content. Thread anchors in the text are the
// `commentMark(threadId)` mark, added by editors only (commenters can't change
// `content`; their threads are anchored by the quote).
import * as Y from "yjs";
import { useEffect, useState } from "react";

export interface Message {
  user: string;
  name: string;
  color: string;
  text: string;
  at: number;
}
export interface Thread {
  id: string;
  quote: string;
  resolved: boolean;
  messages: Message[];
  createdAt: number;
}

export const commentsRoot = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("comments");

export function newThreadId(): string {
  return "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function createThread(doc: Y.Doc, id: string, quote: string): void {
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    commentsRoot(doc).set(id, m);
    m.set("quote", quote.slice(0, 280));
    m.set("resolved", false);
    m.set("createdAt", Date.now());
    m.set("messages", new Y.Array<Y.Map<unknown>>());
  });
}

export function addMessage(doc: Y.Doc, id: string, msg: Omit<Message, "at">): void {
  const t = commentsRoot(doc).get(id);
  if (!t) return;
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    (t.get("messages") as Y.Array<Y.Map<unknown>>).push([m]);
    m.set("user", msg.user);
    m.set("name", msg.name);
    m.set("color", msg.color);
    m.set("text", msg.text);
    m.set("at", Date.now());
    // A reply re-opens a resolved thread (docs/06 §1).
    if (t.get("resolved")) t.set("resolved", false);
  });
}

export function setResolved(doc: Y.Doc, id: string, resolved: boolean): void {
  commentsRoot(doc).get(id)?.set("resolved", resolved);
}

export function deleteThread(doc: Y.Doc, id: string): void {
  commentsRoot(doc).delete(id);
}

function snapshot(doc: Y.Doc): Thread[] {
  const out: Thread[] = [];
  commentsRoot(doc).forEach((m, id) => {
    const msgs = (m.get("messages") as Y.Array<Y.Map<unknown>> | undefined)?.toArray() ?? [];
    out.push({
      id,
      quote: String(m.get("quote") ?? ""),
      resolved: !!m.get("resolved"),
      createdAt: Number(m.get("createdAt") ?? 0),
      messages: msgs.map((x) => ({
        user: String(x.get("user") ?? ""),
        name: String(x.get("name") ?? x.get("user") ?? "Someone"),
        color: String(x.get("color") ?? "#6b7280"),
        text: String(x.get("text") ?? ""),
        at: Number(x.get("at") ?? 0),
      })),
    });
  });
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function useThreads(doc: Y.Doc): Thread[] {
  const [threads, setThreads] = useState(() => snapshot(doc));
  useEffect(() => {
    const root = commentsRoot(doc);
    const fn = () => setThreads(snapshot(doc));
    root.observeDeep(fn);
    fn();
    return () => root.unobserveDeep(fn);
  }, [doc]);
  return threads;
}
