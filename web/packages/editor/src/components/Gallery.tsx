import { useMemo, useState, type ReactNode } from "react";
import { Ic } from "../icons";
import type { TB } from "../editor/content";
import { BOARD_THUMB, CATS, DB_INFO, STARTS, TPL, type Template } from "../templates";
import { Modal } from "./overlay";

const FILL: Record<string, string> = {
  y: "var(--sticky-y)", p: "var(--sticky-p)", b: "var(--sticky-b)", g: "var(--sticky-g)",
  accent: "var(--accent)", amber: "var(--amber-fg)", green: "var(--green-fg)", pink: "var(--pink-fg)", purple: "var(--purple-fg)",
};

function Thumb({ blocks }: { blocks: TB[] }) {
  const out: ReactNode[] = [];
  let n = 0;
  blocks.forEach((b, i) => {
    if (n > 6) return;
    n++;
    const k = "b" + i;
    switch (b.k) {
      case "h1":
      case "h2":
      case "h3":
        out.push(<div key={k} className="l h2" style={{ width: `${30 + ((b.html.length * 7) % 30)}%` }} />);
        break;
      case "p":
        out.push(<div key={k} className="l" style={{ width: "92%" }} />, <div key={k + "x"} className="l" style={{ width: "64%" }} />);
        break;
      case "bul":
      case "num":
        out.push(
          <div key={k} className="row"><span className="dotb" /><div className="l" style={{ width: "60%" }} /></div>,
          <div key={k + "x"} className="row"><span className="dotb" /><div className="l" style={{ width: "46%" }} /></div>,
        );
        break;
      case "todo":
        b.items.slice(0, 3).forEach((it, j) =>
          out.push(<div key={k + j} className="row"><span className={"bx" + (it.done || j === 0 ? " on" : "")} /><div className="l" style={{ width: `${70 - j * 12}%` }} /></div>),
        );
        break;
      case "callout":
        out.push(<div key={k} className={`co tone-${b.tone}`} />);
        break;
      case "quote":
        out.push(<div key={k} className="row"><span style={{ width: 2, height: 16, background: "var(--fg-2)" }} /><div className="l" style={{ width: "70%" }} /></div>);
        break;
      case "table": {
        const c = Math.min(5, b.rows[0]?.length ?? 3);
        out.push(<div key={k} className="mg" style={{ gridTemplateColumns: `repeat(${c},1fr)` }}>{Array.from({ length: c * 3 }, (_, j) => <i key={j} />)}</div>);
        break;
      }
      case "db": {
        const info = DB_INFO[b.preset];
        const view = b.view ?? info.view;
        if (view === "board" && info.groups.length)
          out.push(
            <div key={k} className="mkan">
              {info.groups.slice(0, 3).map((c, j) => (
                <div key={j}>
                  <span className={`pillbar tone-${c}`} />
                  {Array.from({ length: Math.max(1, 3 - j) }, (_, x) => <i key={x} />)}
                </div>
              ))}
            </div>,
          );
        else if (view === "calendar")
          out.push(<div key={k} className="mg" style={{ gridTemplateColumns: "repeat(7,1fr)" }}>{Array.from({ length: 21 }, (_, j) => <i key={j} style={{ height: 10, background: [3, 9, 12, 17].includes(j) ? "var(--pink-bg)" : undefined }} />)}</div>);
        else if (view === "gallery")
          out.push(<div key={k} className="mg" style={{ gridTemplateColumns: "repeat(3,1fr)", gap: 4 }}>{["green", "blue", "gray"].map((c) => <i key={c} className={`tone-${c}`} style={{ height: 30 }} />)}</div>);
        else
          out.push(
            <div key={k} className="mg" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
              {Array.from({ length: Math.min(4, info.rows) }, (_, j) => [
                <i key={j + "a"} style={{ width: `${50 + ((j * 17) % 45)}%`, background: "var(--line-2)" }} />,
                <i key={j + "b"} className={info.groups.length ? `tone-${info.groups[j % info.groups.length]}` : ""} style={{ height: 7, width: "70%" }} />,
                <i key={j + "c"} style={{ width: "55%" }} />,
              ])}
            </div>,
          );
        n += 2;
        break;
      }
      case "board": {
        const sc = 0.13;
        out.push(
          <div key={k} className="mbd" style={{ height: 72 }}>
            {(BOARD_THUMB[b.preset] ?? []).slice(0, 12).map((s, j) => (
              <s
                key={j}
                style={{
                  left: s.x * sc + 4, top: s.y * sc + 3, width: Math.max(8, s.w * sc), height: Math.max(6, s.h * sc),
                  background: s.f === "box" ? "var(--app)" : FILL[s.f],
                  boxShadow: s.f === "box" ? "inset 0 0 0 1px var(--fg-3)" : undefined,
                  borderRadius: s.round ? "50%" : undefined,
                }}
              />
            ))}
          </div>,
        );
        n += 2;
        break;
      }
      case "image":
        out.push(<div key={k} style={{ height: 34, borderRadius: 5, background: "linear-gradient(135deg,var(--accent-soft),var(--sunk))", flex: "none" }} />);
        break;
      case "embed":
        out.push(<div key={k} style={{ height: 34, borderRadius: 5, background: "#1b2030", display: "grid", placeItems: "center", flex: "none" }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#fff" }} /></div>);
        break;
      case "cols":
        out.push(
          <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {[80, 70].map((w) => (
              <div key={w} className="sk"><div className="l h2" style={{ width: "50%" }} /><div className="l" style={{ width: `${w}%` }} /></div>
            ))}
          </div>,
        );
        break;
      case "code":
        out.push(<div key={k} style={{ height: 22, borderRadius: 5, background: "var(--sunk)", boxShadow: "inset 0 0 0 1px var(--line)", flex: "none" }} />);
        break;
      case "link":
      case "file":
        out.push(<div key={k} style={{ height: 18, borderRadius: 5, boxShadow: "inset 0 0 0 1px var(--line-2)", flex: "none" }} />);
        break;
      case "toggle":
        out.push(<div key={k} className="row"><span style={{ width: 0, height: 0, borderLeft: "4px solid var(--fg-3)", borderTop: "3px solid transparent", borderBottom: "3px solid transparent" }} /><div className="l" style={{ width: "40%" }} /></div>);
        break;
      default:
        break;
    }
  });
  return <>{out}</>;
}

function tags(t: Template): [string, string][] {
  const out: [string, string][] = [];
  if (t.blocks.some((b) => b.k === "db")) out.push(["database", "Database"]);
  if (t.blocks.some((b) => b.k === "board")) out.push(["shapes", "Whiteboard"]);
  if (t.blocks.some((b) => b.k === "todo")) out.push(["list-todo", "Checklist"]);
  return out.slice(0, 2);
}

export function TemplateThumb({ t, big }: { t: Template; big?: boolean }) {
  return (
    <div className="tthumb" style={big ? { boxShadow: "var(--sh-card)" } : undefined}>
      <div className="sk" style={big ? { gap: 8 } : undefined}>
        <span className={`ic0 tone-${t.tone}`} style={big ? { width: 26, height: 26, borderRadius: 7 } : undefined} />
        <div className="l h" />
        <Thumb blocks={t.blocks} />
      </div>
    </div>
  );
}

export function Gallery(props: {
  parent: string;
  canBack: boolean;
  onBack(): void;
  onUse(t: Template): void;
  onStart(kind: (typeof STARTS)[number][0]): void;
  onTeam(): void;
}) {
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [preview, setPreview] = useState<Template | null>(null);
  const ql = q.trim().toLowerCase();
  const list = useMemo(
    () => TPL.filter((t) => (cat === "all" || t.cat === cat) && (!ql || (t.name + " " + t.desc + " " + tags(t).map((x) => x[1]).join(" ")).toLowerCase().includes(ql))),
    [cat, ql],
  );
  const count = (c: string) => (c === "all" ? TPL.length : TPL.filter((t) => t.cat === c).length);
  const catName = CATS.find((c) => c[0] === cat)?.[1] ?? "";

  return (
    <>
      <div className="top">
        {props.canBack ? (
          <button className="ib" onClick={props.onBack} title="Back to canvas" aria-label="Back to canvas">
            <Ic name="arrow-left" />
          </button>
        ) : null}
        <div className="crumbs" style={{ paddingLeft: props.canBack ? 0 : 6 }}>
          <span className="cparent">{props.parent}</span>
          <span className="sep">/</span>
          <span className="cname">New canvas</span>
        </div>
      </div>
      <div className="tg">
        <nav className="tgside" aria-label="Template categories">
          <div className="mh">Templates</div>
          {CATS.map(([id, name, icon]) => (
            <button key={id} className={"mi" + (cat === id ? " on" : "")} onClick={() => (setCat(id), setQ(""))}>
              <Ic name={icon} />
              {name}
              <span className="cnt">{count(id)}</span>
            </button>
          ))}
          <div className="msep" style={{ margin: "12px 4px" }} />
          <div className="mh">From your team</div>
          <button className="mi" onClick={props.onTeam}>
            <Ic name="users-round" />
            Your team's templates
          </button>
        </nav>
        <div className="tgmain">
          <span className="eyebrow">
            <Ic name="sparkles" size={12} />
            New canvas
          </span>
          <h1>What are you working on?</h1>
          <p className="sub">Start blank or pick one of {TPL.length} templates. Everything stays editable, and your team edits it with you live.</p>
          <label className="tgsearch">
            <Ic name="search" />
            <input placeholder="Search templates: retro, roadmap, CSV…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search templates" />
          </label>
          <div className="tgchips">
            {CATS.map(([id, name, icon]) => (
              <button key={id} aria-pressed={cat === id} onClick={() => (setCat(id), setQ(""))}>
                <Ic name={icon} size={14} />
                {name}
              </button>
            ))}
          </div>
          {!ql && cat === "all" ? (
            <>
              <div className="tgsec">Start blank</div>
              <div className="starts">
                {STARTS.map(([id, name, desc, icon, tone]) => (
                  <button key={id} className="start" onClick={() => props.onStart(id)}>
                    <span className={`stile tone-${tone}`}>
                      <Ic name={icon} />
                    </span>
                    <b>{name}</b>
                    <span>{desc}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <div className="tgsec">
            {ql ? "Results" : catName} <span>{list.length}</span>
          </div>
          {list.length ? (
            <div className="tgrid">
              {list.map((t) => (
                <button key={t.id} className="tcard" onClick={() => setPreview(t)}>
                  <div className="tshell">
                    <TemplateThumb t={t} />
                  </div>
                  <div className="tinfo">
                    <span className={`ttile tone-${t.tone}`}>
                      <Ic name={t.icon} size={15} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <b>{t.name}</b>
                      <span className="td">{t.desc}</span>
                      <div className="ttags">
                        {tags(t).map(([i, l]) => (
                          <span key={l} className="ttag">
                            <Ic name={i} size={11} />
                            {l}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty">
              <Ic name="search" size={22} />
              <p>No templates match “{q}”. Try “meeting” or “tracker”.</p>
            </div>
          )}
        </div>
      </div>
      {preview ? <Preview t={preview} onClose={() => setPreview(null)} onUse={() => (setPreview(null), props.onUse(preview))} /> : null}
    </>
  );
}

function Preview({ t, onClose, onUse }: { t: Template; onClose(): void; onUse(): void }) {
  const inside: [string, string][] = [];
  const db = t.blocks.find((b) => b.k === "db");
  if (db && db.k === "db") {
    const info = DB_INFO[db.preset];
    inside.push(["database", `Database “${info.name}”: ${info.fields} fields, opens in ${db.view ?? info.view} view`]);
  }
  if (t.blocks.some((b) => b.k === "board")) inside.push(["shapes", "Whiteboard with starter shapes"]);
  const heads = t.blocks.filter((b) => b.k === "h1" || b.k === "h2" || b.k === "h3").map((b) => ("html" in b ? b.html : "")).filter(Boolean);
  if (heads.length) inside.push(["heading-2", `Sections: ${heads.slice(0, 4).join(", ")}`]);
  if (t.blocks.some((b) => b.k === "todo")) inside.push(["list-todo", "Checklist"]);
  if (t.blocks.some((b) => b.k === "table")) inside.push(["table", "Simple table"]);
  if (t.blocks.some((b) => b.k === "callout")) inside.push(["info", "Callout"]);
  const cat = CATS.find((c) => c[0] === t.cat)?.[1] ?? "";
  return (
    <Modal onClose={onClose} wide label={t.name}>
      <div className="tprev">
        <div className="tpl">
          <TemplateThumb t={t} big />
        </div>
        <div className="tpr">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className={`ttile tone-${t.tone}`} style={{ width: 34, height: 34, borderRadius: 9 }}>
              <Ic name={t.icon} />
            </span>
            <span className="ttag">{cat}</span>
            <button className="ib" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto" }}>
              <Ic name="x" />
            </button>
          </div>
          <h2>{t.name}</h2>
          <p>{t.desc}</p>
          <ul className="inside">
            {inside.map(([i, l]) => (
              <li key={l}>
                <Ic name={i} size={14} />
                {l}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn primary pill" onClick={onUse} data-autofocus>
              Use template
              <span className="bub">
                <Ic name="arrow-right" size={14} />
              </span>
            </button>
            <button className="btn ghost" onClick={onClose}>
              Keep browsing
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
