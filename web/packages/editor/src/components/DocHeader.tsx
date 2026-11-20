import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { Tone } from "@opencanvas/ui";
import { Ic, PICKABLE } from "../icons";
import { rel, setMeta, useTick, type Meta } from "../lib/meta";
import { Popover, type Anchor } from "./overlay";

const TONES: Tone[] = ["gray", "blue", "green", "amber", "red", "purple", "pink"];

export function DocHeader(props: {
  doc: Y.Doc;
  meta: Meta;
  editable: boolean;
  hostName: string;
  lastEdit: number | null;
  lastEditBy: string | null;
  peopleHere: number;
  onEnter(): void;
}) {
  useTick(20000);
  const { meta } = props;
  const ref = useRef<HTMLHeadingElement>(null);
  const [pick, setPick] = useState<Anchor | null>(null);

  // Keep the DOM in sync with Y unless the user is typing in it.
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== meta.title) el.textContent = meta.title;
  }, [meta.title]);

  return (
    <div className="dhead">
      {props.editable ? (
        <button className={`dicon tone-${meta.tone}`} onClick={(e) => setPick(e.currentTarget)} title="Change icon" aria-label="Change icon">
          <Ic name={meta.icon} size={26} style={{ strokeWidth: 1.6 }} />
        </button>
      ) : (
        <div className={`dicon tone-${meta.tone}`}>
          <Ic name={meta.icon} size={26} />
        </div>
      )}
      <h1
        ref={ref}
        className="dtitle"
        contentEditable={props.editable}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-label="Title"
        onInput={(e) => setMeta(props.doc, { title: (e.currentTarget.textContent ?? "").slice(0, 200) })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            props.onEnter();
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s+/g, " "));
        }}
      />
      <div className="dmeta">
        {props.lastEdit ? (
          <span>
            <Ic name="clock" size={14} />
            Edited {rel(props.lastEdit)}
            {props.lastEditBy ? ` by ${props.lastEditBy}` : ""}
          </span>
        ) : null}
        {props.peopleHere > 1 ? (
          <span>
            <Ic name="users-round" size={14} />
            {props.peopleHere} people here now
          </span>
        ) : null}
        <span>
          <Ic name="shield-check" size={14} />
          Stored in {props.hostName}
        </span>
      </div>
      {pick ? (
        <Popover anchor={pick} onClose={() => setPick(null)} title="Icon" minWidth={280}>
          <div className="mh">Colour</div>
          <div className="tones">
            {TONES.map((t) => (
              <button key={t} className={`tone-${t}` + (meta.tone === t ? " on" : "")} aria-label={t} onClick={() => setMeta(props.doc, { tone: t })} />
            ))}
          </div>
          <div className="mh">Icon</div>
          <div className="icongrid">
            {PICKABLE.map((n) => (
              <button
                key={n}
                className={meta.icon === n ? "on" : ""}
                aria-label={n}
                onClick={() => {
                  setMeta(props.doc, { icon: n });
                  setPick(null);
                }}
              >
                <Ic name={n} size={18} />
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
