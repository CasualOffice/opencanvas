// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The text colour swatches and the date picker (UX-02): only opened from the selection
// toolbar and a date chip, so off the first screen (WEB-08 budget).
import { useState } from "react";
import { Ic } from "../icons";
import { Popover, type Anchor } from "../components/overlay";
import { addDays, COLOR_NAME, ISO, isoDate, TEXT_COLORS, type TextColor } from "./inline";

/** Swatches for the selection toolbar. */
export function ColorPicker({ current, onPick }: { current: string | null; onPick(c: TextColor | null): void }) {
  return (
    <div className="tcpick" role="group" aria-label="Text colour">
      <button className={"tcsw none" + (!current ? " on" : "")} aria-label="Default colour" aria-pressed={!current} title="Default" onClick={() => onPick(null)}>
        <span aria-hidden="true">A</span>
      </button>
      {TEXT_COLORS.map((c) => (
        <button key={c} className={`tcsw tc-${c}` + (current === c ? " on" : "")} aria-label={COLOR_NAME[c]} aria-pressed={current === c} title={COLOR_NAME[c]} onClick={() => onPick(c)}>
          <span aria-hidden="true">A</span>
        </button>
      ))}
    </div>
  );
}

export function DatePicker({ value, onPick, onRemove }: { value: string; onPick(d: string): void; onRemove?(): void }) {
  const [v, setV] = useState(ISO.test(value) ? value : isoDate(new Date()));
  const now = new Date();
  const quick: [string, Date][] = [
    ["Today", now],
    ["Tomorrow", addDays(now, 1)],
    ["Next week", addDays(now, 7)],
  ];
  return (
    <div className="datepick">
      <label className="dlab">
        <span>Date</span>
        <input
          type="date"
          value={v}
          data-autofocus
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ISO.test(v)) (e.preventDefault(), onPick(v));
          }}
        />
      </label>
      <div className="dquick">
        {quick.map(([l, d]) => (
          <button key={l} className="btn sm" onClick={() => onPick(isoDate(d))}>
            {l}
          </button>
        ))}
      </div>
      <div className="dfoot">
        {onRemove ? (
          <button className="btn sm" onClick={onRemove}>
            <Ic name="trash-2" size={14} />
            Remove
          </button>
        ) : (
          <span />
        )}
        <button className="btn sm primary" disabled={!ISO.test(v)} onClick={() => onPick(v)}>
          Done
        </button>
      </div>
    </div>
  );
}

/** A date chip's picker in its popover. */
export function DatePopover({ anchor, onClose, ...p }: { anchor: Anchor; onClose(): void; value: string; onPick(d: string): void; onRemove?(): void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} title="Date" kind="dialog" minWidth={240}>
      <DatePicker {...p} />
    </Popover>
  );
}
