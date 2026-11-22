// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

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
  /** Ids of people @mentioned in `text`, so the server can call the host's onMention (docs/06 §7). */
  mentions?: string[];
  /** docs/21: the `@label` the author inserted per mentioned id, so every viewer can show their
   *  own name for that person instead. */
  labels?: Record<string, string>;
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
    if (msg.mentions?.length) m.set("mentions", [...new Set(msg.mentions)]);
    if (msg.labels && Object.keys(msg.labels).length) m.set("labels", { ...msg.labels });
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

function readLabels(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, l] of Object.entries(v as Record<string, unknown>)) if (typeof l === "string" && l) out[k] = l;
  return Object.keys(out).length ? out : undefined;
}

/**
 * docs/21: comment text with current names. Each `@label` the author inserted for a mentioned
 * id is replaced by `name(id)` (the member's current name, so a rename shows everywhere).
 * Returns plain runs and mentions.
 */
export function viewMentions(text: string, labels: Record<string, string> | undefined, name: (id: string) => string): { text: string; mention: boolean }[] {
  const tags = Object.entries(labels ?? {})
    .map(([id, label]) => ({ tag: "@" + label, id }))
    .sort((a, b) => b.tag.length - a.tag.length);
  if (!tags.length) return [{ text, mention: false }];
  const out: { text: string; mention: boolean }[] = [];
  let i = 0;
  let plain = "";
  while (i < text.length) {
    const hit = tags.find((t) => text.startsWith(t.tag, i));
    if (hit) {
      if (plain) out.push({ text: plain, mention: false });
      plain = "";
      out.push({ text: "@" + name(hit.id), mention: true });
      i += hit.tag.length;
    } else plain += text[i++];
  }
  if (plain) out.push({ text: plain, mention: false });
  return out;
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
        mentions: Array.isArray(x.get("mentions")) ? (x.get("mentions") as unknown[]).map(String) : undefined,
        labels: readLabels(x.get("labels")),
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

// ---------- @mentions in comment text ----------

/** The `@query` being typed right before the caret, if any (`start` = index of the "@"). */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** Replaces `@query` (from `start` to `caret`) with `@Name ` and returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const ins = "@" + name + " ";
  const after = text.slice(caret).replace(/^ /, "");
  return { text: text.slice(0, start) + ins + after, caret: start + ins.length };
}

/** Ids of the people whose `@Name` appears in the text (longest names first, so "Sam Ortiz" wins over "Sam"). */
export function mentionsIn(text: string, people: { id: string; name: string }[]): string[] {
  const out: string[] = [];
  let rest = text;
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const tag = "@" + p.name;
    if (p.name && rest.includes(tag)) {
      out.push(p.id);
      rest = rest.split(tag).join(" ");
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits comment text into plain runs and `@Name` mentions of the given people, for display. */
export function splitMentions(text: string, names: string[]): { text: string; mention: boolean }[] {
  const sorted = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!sorted.length) return [{ text, mention: false }];
  const re = new RegExp("@(?:" + sorted.map(escapeRe).join("|") + ")", "g");
  const out: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), mention: false });
    out.push({ text: m[0], mention: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out;
}
