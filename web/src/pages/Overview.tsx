// Overview (PLAN.md milestone 2.5, D15-D18): every house in one Excel-like grid. Edits save when you
// leave a cell, with per-field conflict checks; filters, sort and visible columns form shared views.
import { RevoGrid, Editor, type EditorType } from "@revolist/react-datagrid";
import type { ColumnRegular, HyperFunc, VNode } from "@revolist/revogrid";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, type Address } from "../api";
import { catalogue, display, editText, parseInput, type Column, type OverviewPlace, type OverviewRow } from "../overview/columns";
import { applyView, builtInDefault, describe, toCsv, useViews, type Filter, type Sort, type View } from "../overview/views";
import { usePeople } from "../people";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[] };
type CellState =
  | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string }
  | { kind: "conflict"; mine: unknown; theirs: unknown; by: string | null; at: string | null };
type Change = { rowId: string; column: string; before: unknown; after: unknown };

const LAYOUT_KEY = "housetrack.overview.widths";
const readWidths = (): Record<string, number> => {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}"); } catch { return {}; }
};

export default function Overview() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { all: persons } = usePeople();
  const views = useViews();
  const editingRef = useRef(false);

  const { data, refetch } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/api/overview"),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  // Local copy of the rows so edits show instantly; server refreshes merge in around pending cells.
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  useEffect(() => {
    if (!data || editingRef.current) return;
    setRows((prev) => {
      const local = new Map(prev.map((r) => [r.id, r]));
      return data.rows.map((r) => {
        const mine = local.get(r.id);
        if (!mine) return r;
        const keep = Object.entries(cellsRef.current).filter(([k, s]) => k.startsWith(`${r.id}|`) && s.kind !== "saved");
        return keep.length ? { ...r, ...Object.fromEntries(keep.map(([k]) => [k.split("|")[1], mine[k.split("|")[1]]])) } : r;
      });
    });
  }, [data]);

  const cols = useMemo(() => { const c = catalogue(persons, data?.places ?? []); registerEditFormats(c); return c; }, [persons, data?.places]);
  const byKey = useMemo(() => new Map(cols.map((c) => [c.key, c])), [cols]);

  // ─── current view ─────────────────────────────────────────────────
  const savedDefault = views.data?.find((v) => v.is_default);
  const [view, setView] = useState<View | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (view === null && views.data && cols.length) setView(savedDefault ?? builtInDefault(cols));
  }, [views.data, cols, view, savedDefault]);
  const current = view ?? builtInDefault(cols);
  const change = (patch: Partial<View>) => { setView({ ...current, ...patch }); setDirty(true); };

  const [search, setSearch] = useState("");
  const visibleCols = current.columns.map((k) => byKey.get(k)).filter((c): c is Column => !!c);
  const shown = useMemo(() => applyView(rows, current.filters, current.sort, search, cols),
    [rows, current.filters, current.sort, search, cols]);

  // ─── saving cells ─────────────────────────────────────────────────
  const [lastAction, setLastAction] = useState<Change[] | null>(null);
  const setCell = (key: string, s: CellState | null) =>
    setCells((prev) => { const next = { ...prev }; if (s) next[key] = s; else delete next[key]; return next; });

  const saveCell = useCallback(async (rowId: string, col: Column, value: unknown, check = true): Promise<boolean> => {
    const key = `${rowId}|${col.key}`;
    const row = rows.find((r) => r.id === rowId);
    if (!row) return false;
    const expected = col.history ? row._v?.[col.key] ?? null : row[col.key] ?? null;
    setCell(key, { kind: "saving" });
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, [col.key]: value } : r)));
    try {
      const fresh = await api<OverviewRow>("/api/overview/cell", {
        method: "POST", body: { property_id: rowId, column: col.key, value, expected, check },
      });
      setRows((prev) => prev.map((r) => (r.id === rowId ? fresh : r)));
      setCell(key, { kind: "saved" });
      setTimeout(() => setCells((prev) => (prev[key]?.kind === "saved" ? (() => { const n = { ...prev }; delete n[key]; return n; })() : prev)), 1500);
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) {
        const d = err.detail as { current: unknown; changed_by: string | null; changed_at: string | null };
        setCell(key, { kind: "conflict", mine: value, theirs: d.current, by: d.changed_by, at: d.changed_at });
      } else {
        setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, [col.key]: row[col.key] } : r)));
        setCell(key, { kind: "error", message: err.message });
      }
      return false;
    }
  }, [rows]);

  async function commit(edits: { rowId: string; col: Column; raw: unknown }[]) {
    const changes: Change[] = [];
    for (const { rowId, col, raw } of edits) {
      const key = `${rowId}|${col.key}`;
      if (!col.editable) continue;
      const parsed = parseInput(col, raw);
      if ("error" in parsed) { setCell(key, { kind: "error", message: parsed.error }); continue; }
      const row = rows.find((r) => r.id === rowId);
      if (!row || String(row[col.key] ?? "") === String(parsed.value ?? "")) continue;
      changes.push({ rowId, column: col.key, before: row[col.key] ?? null, after: parsed.value });
      await saveCell(rowId, col, parsed.value);
    }
    if (changes.length) setLastAction(changes);
    queryClient.invalidateQueries({ queryKey: ["overview"] });
  }

  async function undo() {
    if (!lastAction) return;
    const action = lastAction;
    setLastAction(null);
    for (const ch of [...action].reverse()) {
      const col = byKey.get(ch.column);
      // History fields can't go back to "nothing"; the earlier entry stays in their history anyway.
      if (col && !(col.history && ch.before == null)) await saveCell(ch.rowId, col, ch.before, false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !editingRef.current) { e.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const conflicts = Object.entries(cells).filter(([, s]) => s.kind === "conflict") as [string, Extract<CellState, { kind: "conflict" }>][];
  async function resolve(key: string, keep: "mine" | "theirs") {
    const [rowId, column] = key.split("|");
    const s = cells[key] as Extract<CellState, { kind: "conflict" }>;
    const col = byKey.get(column)!;
    if (keep === "mine") await saveCell(rowId, col, s.mine, false);
    else {
      const fresh = await api<OverviewRow>(`/api/overview/rows/${rowId}`);
      setRows((prev) => prev.map((r) => (r.id === rowId ? fresh : r)));
      setCell(key, null);
    }
  }

  // ─── grid columns ─────────────────────────────────────────────────
  const widths = useMemo(readWidths, []);
  const [filterFor, setFilterFor] = useState<{ key: string; x: number; y: number } | null>(null);

  const gridColumns: ColumnRegular[] = useMemo(() => {
    const open: ColumnRegular = {
      prop: "_open", name: "", size: 34, readonly: true, pin: "colPinStart",
      cellTemplate: (h: HyperFunc<VNode>, p) => h("a", { class: "open-link", href: `/p/${p.model.id}`, title: "Open",
        onClick: (e: MouseEvent) => { e.preventDefault(); navigate(`/p/${p.model.id}`); } }, "↗"),
    };
    return [open, ...visibleCols.map((col): ColumnRegular => {
      const sortIdx = current.sort.findIndex((s) => s.column === col.key);
      const filtered = current.filters.some((f) => f.column === col.key);
      return {
        prop: col.key,
        name: col.label,
        size: widths[col.key] ?? col.width ?? 110,
        readonly: !col.editable,
        sortable: true,
        pin: col.key === "address" ? "colPinStart" : undefined,
        editor: col.editable ? "house" : undefined,
        columnTemplate: (h: HyperFunc<VNode>) => h("span", { class: "col-head" }, [
          h("span", { class: "col-name", title: col.label }, col.label),
          sortIdx >= 0 ? h("span", { class: "col-sort" }, `${current.sort[sortIdx].dir === "asc" ? "▲" : "▼"}${current.sort.length > 1 ? sortIdx + 1 : ""}`) : null,
          h("button", {
            class: `col-filter ${filtered ? "on" : ""}`, title: "Filter",
            onClick: (e: MouseEvent) => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setFilterFor({ key: col.key, x: r.left, y: r.bottom }); },
          }, "⏷"),
        ]),
        cellProperties: (p) => {
          const s = cells[`${p.model.id}|${col.key}`];
          const classes = [col.editable ? "" : "ro", s ? `cell-${s.kind}` : "", col.kind === "verdict" && p.model[col.key] ? `v-${p.model[col.key]}` : ""];
          return { class: classes.filter(Boolean).join(" ") };
        },
        cellTemplate: (h: HyperFunc<VNode>, p) => {
          const v = p.model[col.key];
          const s = cells[`${p.model.id}|${col.key}`];
          let title = s?.kind === "error" ? s.message : s?.kind === "conflict" ? `${s.by ?? "Someone"} changed this` : undefined;
          if (col.kind === "verdict" && v) {
            const note = p.model[`${col.key}:note`], by = p.model[`${col.key}:by`];
            title = [note, by && `entered by ${by}`].filter(Boolean).join(" · ") || title;
          }
          if (col.kind === "url" && v) {
            return h("a", { href: String(v), target: "_blank", rel: "noreferrer", title: String(v) }, display(col, v));
          }
          return h("span", { title }, display(col, v));
        },
      };
    })];
  }, [visibleCols, current.sort, current.filters, cells, widths, navigate]);

  const editors = useMemo(() => ({ house: Editor(CellEditor) }), []);

  function onBeforeEdit(e: CustomEvent) {
    e.preventDefault(); // we own the data: save through the API, then re-render
    const d = e.detail as { prop: string; model: OverviewRow; val: unknown };
    const col = byKey.get(d.prop);
    if (col) commit([{ rowId: d.model.id, col, raw: d.val }]);
  }

  function onBeforeRangeEdit(e: CustomEvent) {
    e.preventDefault();
    const d = e.detail as { data: Record<number, Record<string, unknown>>; models: Record<number, OverviewRow | undefined> };
    const edits: { rowId: string; col: Column; raw: unknown }[] = [];
    for (const [idx, values] of Object.entries(d.data)) {
      const model = d.models[+idx] ?? shown[+idx];
      if (!model) continue;
      for (const [prop, raw] of Object.entries(values)) {
        const col = byKey.get(prop);
        if (col?.editable) edits.push({ rowId: model.id, col, raw });
      }
    }
    commit(edits);
  }

  function onBeforeSorting(e: CustomEvent) {
    e.preventDefault();
    const d = e.detail as { column: ColumnRegular; additive: boolean };
    const key = String(d.column.prop);
    if (key === "_open") return;
    const existing = current.sort.find((s) => s.column === key);
    const next: Sort = { column: key, dir: existing?.dir === "asc" ? "desc" : "asc" };
    if (d.additive) change({ sort: existing ? current.sort.map((s) => (s.column === key ? next : s)) : [...current.sort, next] });
    else change({ sort: existing?.dir === "desc" ? [] : [next] });
  }

  function onResize(e: CustomEvent) {
    const sizes = e.detail as Record<number, { prop: string; size: number }>;
    const w = readWidths();
    Object.values(sizes).forEach((c) => { if (c?.prop) w[c.prop] = c.size; });
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(w)); } catch { /* per-device nicety only */ }
  }

  // ─── views ────────────────────────────────────────────────────────
  const saveView = async (asNew: boolean) => {
    let body: View = current;
    if (asNew || !current.id) {
      const name = window.prompt("Name this view", asNew ? "" : current.name);
      if (!name) return;
      body = { ...current, id: undefined, name };
    }
    const saved = body.id
      ? await api<View>(`/api/views/${body.id}`, { method: "PATCH", body: { filters: body.filters, sort: body.sort, columns: body.columns } })
      : await api<View>("/api/views", { method: "POST", body });
    await queryClient.invalidateQueries({ queryKey: ["views"] });
    setView(saved);
    setDirty(false);
  };

  function exportCsv() {
    const blob = new Blob([toCsv(shown, visibleCols)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `houses-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const [picker, setPicker] = useState(false);

  return (
    <div className="overview">
      <div className="overview-bar">
        <select value={current.id ?? "__builtin"} aria-label="View"
          onChange={(e) => {
            const v = views.data?.find((x) => x.id === e.target.value);
            setView(v ?? builtInDefault(cols));
            setDirty(false);
          }}>
          {!savedDefault && <option value="__builtin">Active houses (built-in)</option>}
          {views.data?.map((v) => <option key={v.id} value={v.id}>{v.name}{v.is_default ? " ★" : ""}</option>)}
        </select>
        {dirty && <span className="small muted">Unsaved changes</span>}
        {current.id && dirty && <button onClick={() => saveView(false)}>Save view</button>}
        <button onClick={() => saveView(true)}>Save as…</button>
        {current.id && !current.is_default && (
          <button onClick={async () => { await api(`/api/views/${current.id}`, { method: "PATCH", body: { is_default: true } });
                                         queryClient.invalidateQueries({ queryKey: ["views"] }); setView({ ...current, is_default: true }); }}>
            Make default
          </button>
        )}
        {current.id && (
          <button onClick={async () => { if (!window.confirm(`Delete the view “${current.name}”?`)) return;
                                         await api(`/api/views/${current.id}`, { method: "DELETE" });
                                         await queryClient.invalidateQueries({ queryKey: ["views"] }); setView(null); }}>
            Delete view
          </button>
        )}
        <span className="spacer" />
        <input type="search" placeholder="Search address, agent, notes" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
        <button onClick={() => setPicker(!picker)}>Columns</button>
        <button onClick={exportCsv}>Export CSV</button>
        <button disabled={!lastAction} onClick={undo} title="Ctrl+Z">Undo</button>
      </div>

      <div className="overview-filters">
        {current.filters.map((f, i) => (
          <span key={i} className="pill">
            {describe(f, byKey.get(f.column))}{" "}
            <button className="link" onClick={() => change({ filters: current.filters.filter((_, j) => j !== i) })} aria-label="Remove filter">✕</button>
          </span>
        ))}
        <span className="small muted">{shown.length} of {rows.length} houses</span>
        {current.filters.length > 0 && <button className="link" onClick={() => change({ filters: [] })}>Show all</button>}
      </div>

      <div className="overview-main">
        <RevoGrid
          className="grid"
          theme={window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "darkCompact" : "compact"}
          source={shown}
          columns={gridColumns}
          editors={editors}
          range
          resize
          useClipboard
          canFocus
          filter={false}
          onBeforeedit={onBeforeEdit}
          onBeforerangeedit={onBeforeRangeEdit}
          onBeforesorting={onBeforeSorting}
          onAftercolumnresize={onResize}
          onBeforeeditstart={() => { editingRef.current = true; }}
          onAfteredit={() => { editingRef.current = false; }}
          onBeforefocuslost={() => { editingRef.current = false; }}
        />
        {picker && <ColumnPicker cols={cols} selected={current.columns} onChange={(columns) => change({ columns })} onClose={() => setPicker(false)} />}
        {conflicts.length > 0 && (
          <aside className="conflicts">
            <strong>Changed by someone else</strong>
            <p className="small muted">These saves were stopped because the value changed after you loaded it. History fields keep both entries whichever you choose.</p>
            {conflicts.map(([key, s]) => {
              const [rowId, column] = key.split("|");
              const col = byKey.get(column)!;
              const row = rows.find((r) => r.id === rowId);
              return (
                <div key={key} className="conflict">
                  <div className="small"><strong>{String(row?.address ?? "")}</strong> · {col.label}</div>
                  <div className="small">Yours: {display(col, s.mine) || "blank"} · {s.by ?? "Someone"}'s: {display(col, s.theirs) || "blank"}</div>
                  <div className="row">
                    <button onClick={() => resolve(key, "mine")}>Keep mine</button>
                    <button onClick={() => resolve(key, "theirs")}>Keep theirs</button>
                  </div>
                </div>
              );
            })}
            {conflicts.length > 1 && (
              <div className="row">
                <button onClick={() => conflicts.forEach(([k]) => resolve(k, "mine"))}>Keep all mine</button>
                <button onClick={() => conflicts.forEach(([k]) => resolve(k, "theirs"))}>Keep all theirs</button>
              </div>
            )}
          </aside>
        )}
      </div>

      <AddRow onAdded={() => refetch()} />

      {filterFor && byKey.get(filterFor.key) && (
        <FilterPopover col={byKey.get(filterFor.key)!} rows={rows} at={filterFor}
          existing={current.filters.find((f) => f.column === filterFor.key)}
          onApply={(fs) => { change({ filters: [...current.filters.filter((x) => x.column !== filterFor.key), ...fs] }); setFilterFor(null); }}
          onClose={() => setFilterFor(null)} />
      )}
      <p className="narrow-note small muted">Overview is designed for a desktop screen. On a phone, use <Link to="/">Houses</Link>.</p>
    </div>
  );
}

// ─── cell editor: shows what you'd type, e.g. "1250000", "17/10/26 11:00", "Y" ─
function CellEditor({ column, save, close, val, model, prop }: EditorType) {
  const col = column as unknown as { prop: string };
  const [text, setText] = useState<string>(() => {
    if (typeof val === "string" && val.length > 0) return val; // started by typing a character
    return editTextFor(String(prop ?? col.prop), model?.[prop ?? col.prop]);
  });
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref} className="cell-editor" value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); save(text); }
        else if (e.key === "Escape") { e.preventDefault(); close(); }
        e.stopPropagation();
      }}
      onBlur={() => save(text, true)}
    />
  );
}

// The editor doesn't receive our column catalogue, so it formats with a registry filled by the page.
const editFormat = new Map<string, Column>();
function editTextFor(prop: string, v: unknown): string {
  const col = editFormat.get(prop);
  return col ? editText(col, v) : v == null ? "" : String(v);
}
export function registerEditFormats(cols: Column[]) {
  cols.forEach((c) => editFormat.set(c.key, c));
}

// ─── column picker ────────────────────────────────────────────────────
function ColumnPicker({ cols, selected, onChange, onClose }: { cols: Column[]; selected: string[]; onChange: (c: string[]) => void; onClose: () => void }) {
  const groups = [...new Set(cols.map((c) => c.group))];
  const move = (key: string, delta: number) => {
    const i = selected.indexOf(key), j = i + delta;
    if (i < 0 || j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <aside className="picker">
      <div className="row"><strong className="grow">Columns</strong><button className="link" onClick={onClose}>Done</button></div>
      <p className="small muted">Tick to show; arrows change the order.</p>
      {groups.map((g) => (
        <div key={g}>
          <div className="small muted" style={{ marginTop: 8 }}>{g}</div>
          {cols.filter((c) => c.group === g).map((c) => {
            const on = selected.includes(c.key);
            return (
              <div key={c.key} className="picker-row">
                <label className="check grow">
                  <input type="checkbox" checked={on} onChange={() => onChange(on ? selected.filter((k) => k !== c.key) : [...selected, c.key])} />
                  {c.label}{!c.editable && <span className="muted small"> (read-only)</span>}
                </label>
                {on && <><button className="link" onClick={() => move(c.key, -1)}>↑</button><button className="link" onClick={() => move(c.key, 1)}>↓</button></>}
              </div>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

// ─── per-column filter popover ────────────────────────────────────────
function FilterPopover({ col, rows, at, existing, onApply, onClose }: {
  col: Column; rows: OverviewRow[]; at: { x: number; y: number }; existing?: Filter; onApply: (f: Filter[]) => void; onClose: () => void;
}) {
  const categorical = ["enum", "verdict", "bool"].includes(col.kind) || (col.kind === "text" && new Set(rows.map((r) => r[col.key])).size <= 25);
  const values = useMemo(() => [...new Set(rows.map((r) => r[col.key]).filter((v) => v != null && v !== "").map(String))].sort(), [rows, col.key]);
  const [picked, setPicked] = useState<string[]>(existing?.op === "in" ? (existing.value as string[]) : values);
  const [text, setText] = useState(existing?.op === "contains" ? String(existing.value) : "");
  const [min, setMin] = useState(existing?.op === "gte" ? String(existing.value) : "");  // shown as stored (ISO for dates)
  const [max, setMax] = useState(existing?.op === "lte" ? String(existing.value) : "");
  const numeric = ["int", "money", "minutes", "pct", "date", "datetime"].includes(col.kind);
  const asValue = (s: string) => { const p = parseInput({ ...col, history: false }, s); return "value" in p ? p.value : null; };
  return (
    <div className="popover" style={{ left: Math.min(at.x, window.innerWidth - 280), top: at.y + 4 }}>
      <div className="row"><strong className="grow">{col.label}</strong><button className="link" onClick={onClose}>✕</button></div>
      {categorical ? (
        <div className="popover-list">
          <label className="check"><input type="checkbox" checked={picked.length === values.length}
            onChange={(e) => setPicked(e.target.checked ? values : [])} /> (all)</label>
          {values.map((v) => (
            <label key={v} className="check">
              <input type="checkbox" checked={picked.includes(v)} onChange={(e) => setPicked(e.target.checked ? [...picked, v] : picked.filter((x) => x !== v))} />
              {display(col, col.kind === "bool" ? v === "true" : v)}
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

// ─── add a house (the "blank last row") ───────────────────────────────
function AddRow({ onAdded }: { onAdded: () => void }) {
  const [f, setF] = useState({ address: "", suburb: "", postcode: "" });
  const [msg, setMsg] = useState<{ text: string; id?: string } | null>(null);
  async function add() {
    setMsg(null);
    try {
      const parsed = await api<Address>(`/api/address/parse?text=${encodeURIComponent(`${f.address}, ${f.suburb} ${f.postcode}`)}`);
      await api("/api/properties", { method: "POST", body: { address: { ...parsed, suburb: f.suburb.trim(), postcode: f.postcode.trim() } } });
      setF({ address: "", suburb: "", postcode: "" });
      onAdded();
    } catch (e) {
      const err = e as ApiError;
      setMsg({ text: err.message, id: err.existingPropertyId ?? undefined });
    }
  }
  const ready = f.address.trim() && f.suburb.trim() && /^\d{4}$/.test(f.postcode.trim());
  return (
    <div className="add-row">
      <span className="muted">+</span>
      <input placeholder="Street address, e.g. 3/12 Smith St" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })}
        onKeyDown={(e) => e.key === "Enter" && ready && add()} />
      <input placeholder="Suburb" value={f.suburb} onChange={(e) => setF({ ...f, suburb: e.target.value })} onKeyDown={(e) => e.key === "Enter" && ready && add()} />
      <input placeholder="Postcode" value={f.postcode} style={{ width: 90 }} onChange={(e) => setF({ ...f, postcode: e.target.value })} onKeyDown={(e) => e.key === "Enter" && ready && add()} />
      <button disabled={!ready} onClick={add}>Add house</button>
      {msg && <span className="small error">{msg.text} {msg.id && <Link to={`/p/${msg.id}`}>Open it</Link>}</span>}
    </div>
  );
}
