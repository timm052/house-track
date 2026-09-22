// Per-column filter: tick values for choices and tags, a range for numbers, money and dates, or text.
import { useMemo, useState, type ReactNode } from "react";
import { display, parseInput, type Column, type OverviewRow } from "./columns";
import type { Filter } from "./views";

export default function FilterPopover({ col, rows, at, existing, onApply, onClose, actions }: {
  actions?: ReactNode; col: Column; rows: OverviewRow[]; at: { x: number; y: number }; existing?: Filter; onApply: (f: Filter[]) => void; onClose: () => void;
}) {
  const categorical = ["enum", "verdict", "bool", "tags"].includes(col.kind) || (col.kind === "text" && new Set(rows.map((r) => r[col.key])).size <= 40);
  const values = useMemo(() => [...new Set(rows.flatMap((r) => (Array.isArray(r[col.key]) ? r[col.key] as unknown[] : [r[col.key]]))
    .filter((v) => v != null && v !== "").map(String))].sort(), [rows, col.key]);
  const [picked, setPicked] = useState<string[]>(existing?.op === "in" ? (existing.value as string[]) : values);
  const [text, setText] = useState(existing?.op === "contains" ? String(existing.value) : "");
  const [min, setMin] = useState(existing?.op === "gte" ? String(existing.value) : "");  // shown as stored (ISO for dates)
  const [max, setMax] = useState(existing?.op === "lte" ? String(existing.value) : "");
  const numeric = ["int", "money", "minutes", "pct", "date", "datetime"].includes(col.kind);
  const asValue = (s: string) => { const p = parseInput({ ...col, history: false }, s); return "value" in p ? p.value : null; };
  return (
    <div className="popover" style={{ left: Math.min(at.x, window.innerWidth - 280), top: at.y + 4 }}>
      <div className="row"><strong className="grow">{col.label}</strong><button className="link" onClick={onClose}>✕</button></div>
      {actions && <div className="popover-actions">{actions}</div>}
      {categorical ? (
        <div className="popover-list">
          <label className="check"><input type="checkbox" checked={picked.length === values.length}
            onChange={(e) => setPicked(e.target.checked ? values : [])} /> (all)</label>
          {values.map((v) => (
            <label key={v} className="check">
              <input type="checkbox" checked={picked.includes(v)} onChange={(e) => setPicked(e.target.checked ? [...picked, v] : picked.filter((x) => x !== v))} />
              {col.kind === "tags" ? v : display(col, col.kind === "bool" ? v === "true" : v)}
            </label>
          ))}
        </div>
      ) : numeric ? (
        <div className="grid2">
          <input placeholder="From" value={min} onChange={(e) => setMin(e.target.value)} />
          <input placeholder="To" value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
      ) : (
        <input placeholder="Contains" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={() => {
          if (categorical) onApply(picked.length === values.length ? [] : [{ column: col.key, op: "in", value: picked }]);
          else if (numeric) onApply([
            ...(min ? [{ column: col.key, op: "gte" as const, value: asValue(min) }] : []),
            ...(max ? [{ column: col.key, op: "lte" as const, value: asValue(max) }] : []),
          ]);
          else onApply(text ? [{ column: col.key, op: "contains", value: text }] : []);
        }}>Apply</button>
        <button onClick={() => onApply([{ column: col.key, op: "empty" }])}>Blank</button>
        <button onClick={() => onApply([{ column: col.key, op: "notempty" }])}>Not blank</button>
        {col.kind === "datetime" && <button onClick={() => onApply([{ column: col.key, op: "thisweek" }])}>This week</button>}
        <button onClick={() => onApply([])}>Clear</button>
      </div>
    </div>
  );
}

