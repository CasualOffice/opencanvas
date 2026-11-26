// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// A read-only projection (LIVE-04, ADR-072) drawn from its document JSON: what a reference
// card shows, and what a live block shows while it connects or cannot (frames 3a-3c, 5a, 5b).
// Text only, no script, no HTML from the source: React escapes every string. Databases show
// their first rows (up to 5) and "Showing 3 of 11 rows"; boards a one-line placeholder.
import type { ReactNode } from "react";
import { Ic } from "../icons";

type J = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: J[]; marks?: { type: string; attrs?: Record<string, unknown> }[] };
type Doc = { content?: unknown[]; databases?: Record<string, unknown>; boards?: Record<string, unknown> };

const ROWS = 5;

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.map(cell).join(", ");
  if (typeof v === "object") return cell((v as { v?: unknown }).v);
  return String(v);
}

function marks(text: string, ms: J["marks"], key: number): ReactNode {
  let out: ReactNode = text;
  for (const m of ms ?? []) {
    if (m.type === "bold") out = <strong>{out}</strong>;
    else if (m.type === "italic") out = <em>{out}</em>;
    else if (m.type === "strike") out = <s>{out}</s>;
    else if (m.type === "code") out = <code>{out}</code>;
    else if (m.type === "underline") out = <u>{out}</u>;
  }
  return <span key={key}>{out}</span>;
}

function inline(n: J[] | undefined): ReactNode[] {
  return (n ?? []).map((c, i) => {
    if (c.type === "text") return marks(c.text ?? "", c.marks, i);
    if (c.type === "hardBreak") return <br key={i} />;
    if (c.type === "mention") return <span key={i} className="mention">@{String(c.attrs?.label ?? "")}</span>;
    return <span key={i}>{inline(c.content)}</span>;
  });
}

function Database({ doc, id }: { doc: Doc; id: string }) {
  const db = (doc.databases?.[id] ?? {}) as { name?: string; fields?: { id: string; name: string }[]; order?: string[]; rows?: Record<string, Record<string, unknown>> };
  const fields = (db.fields ?? []).slice(0, 6);
  const order = db.order ?? Object.keys(db.rows ?? {});
  const shown = order.slice(0, ROWS);
  return (
    <div className="lv-db">
      <table className="lv-tbl">
        <thead>
          <tr>{fields.map((f) => <th key={f.id}>{f.name}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r}>{fields.map((f) => <td key={f.id}>{cell(db.rows?.[r]?.[f.id])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {order.length > shown.length ? <p className="lv-more">Showing {shown.length} of {order.length} rows.</p> : null}
    </div>
  );
}

function block(n: J, i: number, doc: Doc): ReactNode {
  const kids = (n.content ?? []) as J[];
  switch (n.type) {
    case "paragraph":
      return <p key={i}>{inline(kids)}</p>;
    case "heading": {
      const l = Math.min(3, Math.max(1, Number(n.attrs?.level) || 2));
      return l === 1 ? <h3 key={i}>{inline(kids)}</h3> : l === 2 ? <h4 key={i}>{inline(kids)}</h4> : <h5 key={i}>{inline(kids)}</h5>;
    }
    case "bulletList":
      return <ul key={i}>{kids.map((c, j) => block(c, j, doc))}</ul>;
    case "orderedList":
      return <ol key={i}>{kids.map((c, j) => block(c, j, doc))}</ol>;
    case "listItem":
      return <li key={i}>{kids.map((c, j) => block(c, j, doc))}</li>;
    case "taskList":
      return (
        <ul key={i} className="lv-tasks">
          {kids.map((c, j) => block(c, j, doc))}
        </ul>
      );
    case "taskItem": {
      const done = n.attrs?.checked === true;
      return (
        <li key={i} className={done ? "done" : undefined}>
          <span className={"lv-check" + (done ? " on" : "")} role="img" aria-label={done ? "Done" : "Not done"}>
            {done ? <Ic name="check" size={12} /> : null}
          </span>
          <span className="lv-tx">{((n.content ?? []) as J[]).map((c) => inline(c.content))}</span>
        </li>
      );
    }
    case "blockquote":
      return <blockquote key={i}>{kids.map((c, j) => block(c, j, doc))}</blockquote>;
    case "codeBlock":
      return (
        <pre key={i}>
          <code>{kids.map((c) => c.text ?? "").join("")}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr key={i} />;
    case "callout":
    case "toggle":
    case "toggleSummary":
    case "toggleContent":
    case "columns":
    case "column":
      return (
        <div key={i} className="lv-group">
          {kids.map((c, j) => block(c, j, doc))}
        </div>
      );
    case "database":
      return <Database key={i} doc={doc} id={String(n.attrs?.dbId ?? "")} />;
    case "board":
      return (
        <p key={i} className="lv-ph">
          <Ic name="shapes" size={14} /> Whiteboard
        </p>
      );
    case "image":
      return n.attrs?.alt ? (
        <p key={i} className="lv-ph">
          <Ic name="image" size={14} /> {String(n.attrs.alt)}
        </p>
      ) : null;
    default:
      return kids.length ? <div key={i}>{kids.map((c, j) => block(c, j, doc))}</div> : null;
  }
}

/** The projection's blocks, read only. */
export function Projected({ doc }: { doc: Doc | null | undefined }) {
  const content = (doc?.content ?? []) as J[];
  if (!content.length) return <p className="lv-empty">Nothing here yet.</p>;
  return <>{content.map((n, i) => block(n, i, doc ?? {}))}</>;
}

/** The node's own snapshot (`[host.live] snapshot = "content"`): its Markdown as plain lines. */
export function SnapshotText({ markdown }: { markdown: string }) {
  return (
    <>
      {markdown
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 40)
        .map((l, i) => (
          <p key={i}>{l.replace(/^[#>*-]+\s*|\[[ x]\]\s*/g, "")}</p>
        ))}
    </>
  );
}
