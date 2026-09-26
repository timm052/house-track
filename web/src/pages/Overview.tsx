// Overview (PLAN.md milestone 2.5, D15-D18): every house in one Excel-like grid. Edits save when you
// leave a cell, with per-field conflict checks; filters, sort and visible columns form shared views.
import { RevoGrid, Editor, type EditorType } from "@revolist/react-datagrid";
import type { ColumnRegular, HyperFunc, VNode } from "@revolist/revogrid";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, whilePending, type Address } from "../api";
import { catalogue, display, editText, parseInput, type Column, type OverviewPlace, type OverviewRow } from "../overview/columns";
import { applyView, builtInDefault, describe, toCsv, useViews, type Sort, type View } from "../overview/views";
import FilterPopover from "../overview/FilterPopover";
import AddressSearch from "../AddressSearch";
import { usePeople } from "../people";
import { CLOSED, STATUS_COLOUR, budgetTone, changeTone, minutesTone, soonTone, suburbClass, suburbSlots, tagStyle, type Tone, useDarkMode, useTagColours } from "../colour";
import type { Status } from "../api";
import ConfirmButton from "../ConfirmButton";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[]; pending?: number };
type CellState =
  | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string }
  | { kind: "conflict"; mine: unknown; theirs: unknown; by: string | null; at: string | null };
type Change = { rowId: string; column: string; before: unknown; after: unknown };

const LAYOUT_KEY = "housetrack.overview.widths";
const readWidths = (): Record<string, number> => {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}"); } catch { return {}; }
};

// ─── auto column widths ─────────────────────────────────────────────
// Each column is as wide as its longest value or its header, whichever is wider, measured in the grid's own
// font. A width you drag by hand is kept on this device until you choose "Fit width" in the header menu.
const HEAD_EXTRA = 30 + 4 + 17 + 4;  // header padding and sort control, the gap, the ⏷ button, sub-pixel slack
const SORT_EXTRA = 13;           // ▲ plus its gap, when the column is sorted
const CELL_EXTRA = 32;           // cell padding either side, plus a little air
const MIN_WIDTH = 44, MAX_WIDTH = 360;
let measurer: CanvasRenderingContext2D | null = null;
const textWidths = new Map<string, number>();
function textWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  let w = textWidths.get(key);
  if (w == null) {
    measurer ??= document.createElement("canvas").getContext("2d");
    if (!measurer) return text.length * 8;
    measurer.font = font;
    w = measurer.measureText(text).width;
    if (textWidths.size > 20_000) textWidths.clear();
    textWidths.set(key, w);
  }
  return w;
}
function gridFont(weight = "400"): string {
  const el = document.querySelector("revo-grid") ?? document.body;
  return `${weight} 14px ${getComputedStyle(el).fontFamily}`;
}
function fitWidth(col: Column, rows: OverviewRow[], sorted: boolean): number {
  const head = textWidth(col.label, gridFont("600")) + HEAD_EXTRA + (sorted ? SORT_EXTRA : 0);
  const body = gridFont(col.kind === "verdict" || col.key === "suburb" ? "600" : "400");
  let widest = 0;
  for (const r of rows) {
    const v = r[col.key];
    const w = col.kind === "tags"
      ? ((v as string[] | null) ?? []).reduce((sum, t) => sum + textWidth(`#${t}`, body) * 0.86 + 22, 0)  // 12px chips
      : textWidth(display(col, v), body) + (col.key === "status" ? 14 : 0);                              // status dot
    widest = Math.max(widest, w);
  }
  return Math.ceil(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, head, widest + CELL_EXTRA)));
}

export default function Overview() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { all: persons } = usePeople();
  const views = useViews();
  const editingRef = useRef(false);

  const { data, refetch } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/api/overview"),
    refetchInterval: (q) => whilePending(q) || 30_000,
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
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api<{ name: string }[]>("/api/tags") });
  const tagColours = useTagColours();
  const isDark = useDarkMode();
  useEffect(() => registerTags((tags.data ?? []).map((t) => t.name)), [tags.data]);
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
  const shownIds = useMemo(() => new Set(shown.map((r) => r.id)), [shown]);

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
      if (!row || JSON.stringify(row[col.key] ?? null) === JSON.stringify(parsed.value ?? null)) continue;
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
  const [widths, setWidths] = useState(readWidths);
  const fitColumn = (key: string) => {
    const w = readWidths();
    delete w[key];
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(w)); } catch { /* per-device nicety only */ }
    setWidths(w);
  };
  const [filterFor, setFilterFor] = useState<{ key: string; x: number; y: number } | null>(null);

  // Row colour = suburb (a faint tint on every cell, a stripe on the open link); closed or excluded houses fade.
  const slots = useMemo(() => suburbSlots(rows), [rows]);
  const rowClass = (m: OverviewRow) => [
    "tint", suburbClass(slots, m.suburb),
    (m.excluded || CLOSED.includes(m.status as Status)) ? "dim" : "",
  ];
  const toneOf = (col: Column, v: unknown): Tone =>
    col.kind === "minutes" ? minutesTone(v, col.key.startsWith("drive") || col.key === "nearest_station_drive" ? "drive" : col.key.startsWith("transit") ? "transit" : "walk") : col.key === "guide_change" ? changeTone(v) : col.key === "sale_at" ? soonTone(v) : col.key === "budget" ? budgetTone(v) : "";

  const gridColumns: ColumnRegular[] = useMemo(() => {
    const open: ColumnRegular = {
      prop: "_open", name: "", size: 34, readonly: true, pin: "colPinStart",
      cellProperties: (p) => ({ class: [...rowClass(p.model as OverviewRow), "stripe"].filter(Boolean).join(" ") }),
      cellTemplate: (h: HyperFunc<VNode>, p) => h("a", { class: "open-link", href: `/p/${p.model.id}`, title: "Open",
        onClick: (e: MouseEvent) => { e.preventDefault(); navigate(`/p/${p.model.id}`); } }, "↗"),
    };
    return [open, ...visibleCols.map((col): ColumnRegular => {
      const sortIdx = current.sort.findIndex((s) => s.column === col.key);
      const filtered = current.filters.some((f) => f.column === col.key);
      return {
        prop: col.key,
        name: col.label,
        size: widths[col.key] ?? fitWidth(col, rows, sortIdx >= 0),
        readonly: !col.editable,
        sortable: true,
        pin: col.key === "address" ? "colPinStart" : undefined,
        editor: col.editable ? "house" : undefined,
        columnTemplate: (h: HyperFunc<VNode>) => h("span", {
          class: "col-head",
          onContextMenu: (e: MouseEvent) => { e.preventDefault(); setFilterFor({ key: col.key, x: e.clientX, y: e.clientY }); },
        }, [
          h("span", { class: "col-name", title: col.label }, col.label),
          sortIdx >= 0 ? h("span", { class: "col-sort" }, `${current.sort[sortIdx].dir === "asc" ? "▲" : "▼"}${current.sort.length > 1 ? sortIdx + 1 : ""}`) : null,
          h("button", {
            class: `col-filter ${filtered ? "on" : ""}`, title: "Column options. Or right-click the header.",
            onClick: (e: MouseEvent) => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setFilterFor({ key: col.key, x: r.left, y: r.bottom }); },
          }, "⏷"),
        ]),
        cellProperties: (p) => {
          const s = cells[`${p.model.id}|${col.key}`];
          const tone = toneOf(col, p.model[col.key]);
          const classes = [...rowClass(p.model as OverviewRow), col.editable ? "" : "ro", s ? `cell-${s.kind}` : "",
            col.kind === "verdict" && p.model[col.key] ? `v-${p.model[col.key]}` : "", tone && `tone-${tone}`,
            col.key === "suburb" ? "suburb-cell" : ""];
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
          if (col.key === "status" && v) {
            return h("span", { title, class: "status-cell" }, [
              h("span", { class: "status-dot", style: { background: STATUS_COLOUR[v as Status] } }), h("span", {}, display(col, v))]);
          }
          if (col.kind === "tags" && Array.isArray(v)) {
            return h("span", { title: (v as string[]).map((t) => `#${t}`).join(" ") },
              (v as string[]).map((t) => h("span", { class: "tag", style: tagStyle(tagColours, t) }, `#${t}`)));
          }
          if (col.key === "sale_at" && soonTone(v)) title = "In the next seven days";
          if (col.kind === "url" && v) {
            return h("a", { href: String(v), target: "_blank", rel: "noreferrer", title: String(v) }, display(col, v));
          }
          return h("span", { title }, display(col, v));
        },
      };
    })];
  }, [visibleCols, current.sort, current.filters, cells, widths, rows, navigate, slots, tagColours]); // eslint-disable-line react-hooks/exhaustive-deps

  const editors = useMemo(() => ({ house: Editor(CellEditor) }), []);

  function onBeforeEdit(e: CustomEvent) {
    e.preventDefault(); // we own the data: save through the API, then re-render
    const d = e.detail as { prop: string; model: OverviewRow; val: unknown };
    const col = byKey.get(d.prop);
    if (col) commit([{ rowId: d.model.id, col, raw: d.val }]).then(() => { if (col.kind === "tags") queryClient.invalidateQueries({ queryKey: ["tags"] }); });
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
    queryClient.invalidateQueries({ queryKey: ["tags"] });
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
    setWidths(w);
  }

  // ─── column order: drag headers, or the header menu ───────────────
  // Address is pinned on the left, so "start" means just after it.
  const shownKeys = visibleCols.map((c) => c.key);
  const moveColumn = (key: string, where: "start" | "end") => {
    const rest = shownKeys.filter((k) => k !== key);
    const at = where === "end" ? rest.length : rest[0] === "address" ? 1 : 0;
    rest.splice(at, 0, key);
    change({ columns: rest });
  };
  function onBeforeColumnDragEnd(e: CustomEvent) {
    // We own the order (it is part of the view), so stop the grid moving it and re-render from the view instead.
    e.preventDefault();
    const d = e.detail as { pin?: string; startPosition: { itemIndex: number }; newPosition: { itemIndex: number } };
    if (d.pin) return; // Address and the open link stay pinned
    const scrolling = shownKeys.filter((k) => k !== "address");
    const from = d.startPosition.itemIndex, to = Math.min(d.newPosition.itemIndex, scrolling.length - 1);
    if (from === to || !scrolling[from]) return;
    const [moved] = scrolling.splice(from, 1);
    scrolling.splice(to, 0, moved);
    change({ columns: shownKeys.includes("address") ? ["address", ...scrolling] : scrolling });
  }

  // The React wrapper has no prop for this event, so listen on the grid element itself.
  const mainRef = useRef<HTMLDivElement>(null);
  const dragEndRef = useRef(onBeforeColumnDragEnd);
  dragEndRef.current = onBeforeColumnDragEnd;
  useEffect(() => {
    const grid = mainRef.current?.querySelector("revo-grid");
    if (!grid) return;
    const handler = (e: Event) => dragEndRef.current(e as CustomEvent);
    grid.addEventListener("beforecolumndragend", handler);
    return () => grid.removeEventListener("beforecolumndragend", handler);
  }, []);

  // ─── views ────────────────────────────────────────────────────────
  const [naming, setNaming] = useState<string | null>(null);  // the "Save as" name box, when open
  const saveView = async (asNew: boolean, name?: string) => {
    let body: View = current;
    if (asNew || !current.id) {
      if (!name?.trim()) { setNaming(asNew ? "" : current.name); return; }
      body = { ...current, id: undefined, name: name.trim() };
    }
    setNaming(null);
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
        {naming == null ? <button onClick={() => saveView(true)}>Save as…</button> : (
          <span className="row" style={{ gap: 4 }}>
            <input autoFocus placeholder="Name this view" value={naming} style={{ width: 180 }} onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveView(true, naming); if (e.key === "Escape") setNaming(null); }} />
            <button className="primary" disabled={!naming.trim()} onClick={() => saveView(true, naming)}>Save</button>
            <button onClick={() => setNaming(null)}>Cancel</button>
          </span>
        )}
        {current.id && !current.is_default && (
          <button onClick={async () => { await api(`/api/views/${current.id}`, { method: "PATCH", body: { is_default: true } });
                                         queryClient.invalidateQueries({ queryKey: ["views"] }); setView({ ...current, is_default: true }); }}>
            Make default
          </button>
        )}
        {current.id && (
          <ConfirmButton className="" label="Delete view" question={`Delete “${current.name}” for everyone?`} yes="Delete view"
            onConfirm={async () => { await api(`/api/views/${current.id}`, { method: "DELETE" });
                                     await queryClient.invalidateQueries({ queryKey: ["views"] }); setView(null); }} />
        )}
        <span className="spacer" />
        <input type="search" placeholder="Search address, agent, notes" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
        <button onClick={() => setPicker(!picker)}>Columns</button>
        <button onClick={exportCsv}>Export CSV</button>
        <button disabled={!lastAction} onClick={undo} title="Undo (Ctrl+Z)">Undo</button>
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

      <div className="overview-main" ref={mainRef}>
        <RevoGrid
          className="grid"
          theme={isDark ? "darkCompact" : "compact"}
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
          canMoveColumns
          onBeforeeditstart={() => { editingRef.current = true; }}
          onAfteredit={() => { editingRef.current = false; }}
          onBeforefocuslost={() => { editingRef.current = false; }}
        />
        {picker && <ColumnPicker cols={cols} selected={current.columns}
          onFitAll={Object.keys(widths).length ? () => { try { localStorage.removeItem(LAYOUT_KEY); } catch { /* ignore */ } setWidths({}); } : undefined} onChange={(columns) => change({ columns })} onClose={() => setPicker(false)} />}
        {conflicts.length > 0 && (
          <aside className="conflicts">
            <strong>Changed by someone else</strong>
            <p className="small muted">Someone changed these after you loaded them. Choose which value to keep. History fields keep both either way.</p>
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

      <AddRow onAdded={() => refetch()} shownIds={shownIds} />

      {filterFor && byKey.get(filterFor.key) && (
        <FilterPopover col={byKey.get(filterFor.key)!} rows={rows} at={filterFor}
          actions={<>
            {widths[filterFor.key] != null && <button className="link" onClick={() => { fitColumn(filterFor.key); setFilterFor(null); }}>Fit width</button>}
            {filterFor.key !== "address" && <>
            <button className="link" onClick={() => { moveColumn(filterFor.key, "start"); setFilterFor(null); }}>Move to start</button>
            <button className="link" onClick={() => { moveColumn(filterFor.key, "end"); setFilterFor(null); }}>Move to end</button>
            <button className="link" onClick={() => { change({ columns: shownKeys.filter((k) => k !== filterFor.key) }); setFilterFor(null); }}>Hide column</button>
            </>}
          </>}
          existing={current.filters.find((f) => f.column === filterFor.key)}
          onApply={(fs) => { change({ filters: [...current.filters.filter((x) => x.column !== filterFor.key), ...fs] }); setFilterFor(null); }}
          onClose={() => setFilterFor(null)} />
      )}
      <p className="narrow-note small muted">Overview needs a bigger screen. On a phone, use <Link to="/">Houses</Link>.</p>
    </div>
  );
}

// ─── cell editors: a dropdown for fixed choices, a pick-list for tags, and a checked text box ─
// The editor doesn't receive our column catalogue, so it looks columns up in a registry the page fills.
const editFormat = new Map<string, Column>();
let knownTags: string[] = [];
export function registerEditFormats(cols: Column[]) {
  cols.forEach((c) => editFormat.set(c.key, c));
}
export function registerTags(names: string[]) {
  knownTags = names;
}

function CellEditor(props: EditorType) {
  const key = String(props.prop ?? (props.column as unknown as { prop: string }).prop);
  const col = editFormat.get(key);
  if (col?.kind === "tags") return <TagsEditor col={col} {...props} />;
  if (col?.options) return <ChoiceEditor col={col} {...props} />;
  return <TextEditor col={col} {...props} />;
}

/** Fixed choices: a dropdown; typing a letter first (e.g. "y" for Yes) picks straight away. */
function ChoiceEditor({ col, save, close, val, model, prop }: EditorType & { col: Column }) {
  const ref = useRef<HTMLSelectElement>(null);
  // Only a single typed character is a shortcut; a double-click hands over the cell's whole current value.
  const typed = typeof val === "string" && val.length === 1 ? parseInput(col, val) : null;
  useEffect(() => {
    if (typed && "value" in typed) { save(typed.value); return; }
    ref.current?.focus();
    try { ref.current?.showPicker?.(); } catch { /* not supported: the focused select still works with arrow keys */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = model?.[String(prop)];
  return (
    <select ref={ref} className="cell-editor" defaultValue={current == null ? "" : String(current)}
      onChange={(e) => e.target.value && save(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } e.stopPropagation(); }}
      onBlur={() => close()}>
      <option value="" disabled>Choose…</option>
      {Object.entries(col.options ?? {}).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
    </select>
  );
}

/** Free text, numbers, money and dates: checked as you type; an invalid value can't be saved. */
function TextEditor({ col, save, close, val, model, prop }: EditorType & { col?: Column }) {
  const [text, setText] = useState<string>(() => {
    if (typeof val === "string" && val.length > 0) return val; // started by typing a character
    const v = model?.[String(prop)];
    return col ? editText(col, v) : v == null ? "" : String(v);
  });
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const check = col ? parseInput(col, text) : { value: text };
  const error = "error" in check ? check.error : null;
  const box = ref.current?.getBoundingClientRect();
  return (
    <>
      <input
        ref={ref} className={`cell-editor ${error ? "invalid" : ""}`} value={text} aria-invalid={!!error}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); if (!error) save(text); }
          else if (e.key === "Escape") { e.preventDefault(); close(); }
          e.stopPropagation();
        }}
        onBlur={() => (error ? close() : save(text, true))}
      />
      {error && box && createPortal(<div className="cell-hint" style={{ left: box.left, top: box.bottom + 2 }}>{error}</div>, document.body)}
    </>
  );
}

/** Tags: tick existing ones or type a new one. */
function TagsEditor({ save, close, model, prop }: EditorType & { col: Column }) {
  const start = (model?.[String(prop)] as string[] | undefined) ?? [];
  const [picked, setPicked] = useState<string[]>(start);
  const [fresh, setFresh] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  useEffect(() => setBox(anchor.current?.getBoundingClientRect() ?? null), []);
  const all = [...new Set([...knownTags, ...picked])].sort((a, b) => a.localeCompare(b));
  const done = () => save([...picked, ...(fresh.trim() ? [fresh.trim()] : [])]);
  return (
    <span ref={anchor} className="cell-editor">
      {box && createPortal(
        <div className="popover tags-popover" style={{ left: Math.min(box.left, window.innerWidth - 260), top: box.top }}
             onKeyDown={(e) => { if (e.key === "Escape") close(); e.stopPropagation(); }}>
          <div className="popover-list">
            {all.map((t) => (
              <label key={t} className="check">
                <input type="checkbox" checked={picked.includes(t)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, t] : picked.filter((x) => x !== t))} />{t}
              </label>
            ))}
          </div>
          <input autoFocus placeholder="New tag" value={fresh} onChange={(e) => setFresh(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); done(); } }} />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="primary" onClick={done}>Save tags</button>
            <button onClick={() => close()}>Cancel</button>
          </div>
        </div>, document.body)}
    </span>
  );
}

// ─── column picker ────────────────────────────────────────────────────
function ColumnPicker({ cols, selected, onChange, onClose, onFitAll }: {
  cols: Column[]; selected: string[]; onChange: (c: string[]) => void; onClose: () => void; onFitAll?: () => void;
}) {
  // Show and hide only: order is set by dragging headers in the grid. Groups keep every column in a fixed place.
  const groupOf = new Map(cols.map((c) => [c.key, c.group]));
  const shown = selected.filter((k) => groupOf.has(k));
  const groups = [...new Set(cols.map((c) => c.group))];
  const [find, setFind] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const match = (c: Column) => !find || `${c.label} ${c.group}`.toLowerCase().includes(find.toLowerCase());
  // A newly shown column goes after the last shown column from its own group, so related columns sit together.
  const show = (keys: string[]) => {
    const next = [...shown];
    for (const key of keys) {
      if (next.includes(key)) continue;
      let at = next.length;
      next.forEach((k, i) => { if (groupOf.get(k) === groupOf.get(key)) at = i + 1; });
      next.splice(at, 0, key);
    }
    onChange(next);
  };
  const hide = (keys: string[]) => onChange(shown.filter((k) => !keys.includes(k)));
  return (
    <aside className="picker">
      <div className="row"><strong className="grow">Columns</strong><button className="link" onClick={onClose}>Done</button></div>
      <input type="search" placeholder="Find a column" value={find} onChange={(e) => setFind(e.target.value)} style={{ margin: "6px 0" }} />
      <p className="small muted">To reorder, drag a column's header in the grid, or use its ⏷ menu.
        Widths fit the longest value; a width you drag is kept on this device.
        {onFitAll && <> <button className="link" onClick={onFitAll}>Fit all widths</button></>}</p>
      {groups.map((g) => {
        const inGroup = cols.filter((c) => c.group === g);
        const matching = inGroup.filter(match);
        if (!matching.length) return null;
        const on = inGroup.filter((c) => shown.includes(c.key)).length;
        const expanded = !!find || (open[g] ?? on > 0);
        return (
          <div key={g} className="picker-group">
            <div className="picker-group-head">
              <button className="link grow" aria-expanded={expanded} onClick={() => setOpen({ ...open, [g]: !expanded })}>
                {expanded ? "▾" : "▸"} {g}
              </button>
              <span className="small muted">{on} of {inGroup.length}</span>
              <input type="checkbox" aria-label={`Show all ${g} columns`} checked={on === inGroup.length}
                ref={(el) => { if (el) el.indeterminate = on > 0 && on < inGroup.length; }}
                onChange={(e) => (e.target.checked ? show(inGroup.map((c) => c.key)) : hide(inGroup.map((c) => c.key)))} />
            </div>
            {expanded && matching.map((c) => {
              const ticked = shown.includes(c.key);
              return (
                <label key={c.key} className="check picker-row">
                  <input type="checkbox" checked={ticked} onChange={() => (ticked ? hide([c.key]) : show([c.key]))} />
                  {c.label}{!c.editable && <span className="muted small"> (read-only)</span>}
                </label>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}

// ─── add a house (the "blank last row") ───────────────────────────────
/** Quick add: search the national address file and pick a match (pinned on the map straight away), or type
 *  the address for an off-the-plan lot or one the file doesn't have. Details go in the grid afterwards. */
function AddRow({ onAdded, shownIds }: { onAdded: () => void; shownIds: Set<string> }) {
  const [typing, setTyping] = useState(false);
  const [f, setF] = useState({ address: "", suburb: "", postcode: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; id?: string; added?: boolean } | null>(null);
  async function save(address: Record<string, unknown>, gnafPid: string | null, label: string) {
    setMsg(null);
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("/api/properties", { method: "POST", body: { address, gnaf_pid: gnafPid } });
      setF({ address: "", suburb: "", postcode: "" });
      setMsg({ text: `Added ${label}`, id, added: true });
      onAdded();
    } catch (e) {
      const err = e as ApiError;
      setMsg({ text: err.message, id: err.existingPropertyId ?? undefined });
    } finally {
      setBusy(false);
    }
  }
  async function addTyped() {
    const parsed = await api<Address>(`/api/address/parse?text=${encodeURIComponent(`${f.address}, ${f.suburb} ${f.postcode}`)}`);
    await save({ ...parsed, suburb: f.suburb.trim(), postcode: f.postcode.trim() }, null, `${f.address.trim()}, ${f.suburb.trim()}`);
  }
  const ready = f.address.trim() && f.suburb.trim() && /^\d{4}$/.test(f.postcode.trim());
  const enter = (e: React.KeyboardEvent) => e.key === "Enter" && ready && !busy && addTyped();
  return (
    <div className="add-row">
      <span className="muted">+</span>
      {typing ? (
        <>
          <input placeholder="Street address, e.g. 3/12 Smith St" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} onKeyDown={enter} autoFocus />
          <SuburbInput value={f.suburb} onChange={(suburb) => setF({ ...f, suburb })}
            onPick={(l) => setF({ ...f, suburb: l.suburb, postcode: l.postcode })} onKeyDown={enter} />
          <input placeholder="Postcode" value={f.postcode} style={{ width: 90 }} onChange={(e) => setF({ ...f, postcode: e.target.value })} onKeyDown={enter} />
          <button disabled={!ready || busy} onClick={addTyped}>Add house</button>
          <button className="link" onClick={() => setTyping(false)}>Search instead</button>
        </>
      ) : (
        <>
          <div className="add-search">
            <AddressSearch dropUp clearOnPick placeholder="Add a house: start typing its address"
              onPick={(hit) => save({ unit: hit.unit, street_number: hit.street_number, street: hit.street, suburb: hit.suburb,
                                      postcode: hit.postcode }, hit.pid, hit.display)} />
          </div>
          <button className="link" onClick={() => setTyping(true)}>Not listed? Type it</button>
        </>
      )}
      {busy && <span className="small muted">Adding…</span>}
      {msg && (
        <span className={`small ${msg.added ? "" : "error"}`}>
          {msg.text}{msg.id && <> · <Link to={`/p/${msg.id}`}>Open it</Link></>}
          {msg.added && msg.id && !shownIds.has(msg.id) && <span className="muted"> · this view's filters hide it</span>}
        </span>
      )}
    </div>
  );
}

/** A suburb box that suggests suburbs from the national address file (with their postcodes), so a typed
 *  address still gets the proper spelling (and the suburb its colour) even when the street isn't listed. */
function SuburbInput({ value, onChange, onPick, onKeyDown }: {
  value: string; onChange: (v: string) => void; onPick: (l: { suburb: string; postcode: string }) => void; onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(value.trim()), 200); return () => clearTimeout(t); }, [value]);
  const { data = [] } = useQuery({
    queryKey: ["localities", term], enabled: term.length >= 2, staleTime: 300_000,
    queryFn: () => api<{ suburb: string; postcode: string }[]>(`/api/address/localities?q=${encodeURIComponent(term)}`),
  });
  const exact = data.some((l) => l.suburb.toLowerCase() === value.trim().toLowerCase() && data.length === 1);
  return (
    <div className="address-search drop-up">
      <input placeholder="Suburb" value={value} autoComplete="off" onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && term.length >= 2 && data.length > 0 && !exact && (
        <ul className="suggestions">
          {data.map((l) => (
            <li key={`${l.suburb}-${l.postcode}`}>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(l); setOpen(false); }}>{l.suburb} {l.postcode}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
