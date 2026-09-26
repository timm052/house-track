// Filtering, sorting and saved views (D18), shared by the Overview grid and the phone Houses tab.
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { display, type Column, type OverviewRow } from "./columns";

export type FilterOp = "contains" | "in" | "gte" | "lte" | "empty" | "notempty" | "thisweek";
export type Filter = { column: string; op: FilterOp; value?: unknown };
export type Sort = { column: string; dir: "asc" | "desc" };
export type View = { id?: string; name: string; is_default: boolean; filters: Filter[]; sort: Sort[]; columns: string[] };

/** Used until someone saves a default view of their own. */
export function builtInDefault(cols: Column[]): View {
  return {
    name: "Active houses",
    is_default: true,
    filters: [{ column: "status", op: "in", value: ["watching", "interested", "shortlisted", "offering"] }],
    sort: [{ column: "sale_at", dir: "asc" }],
    columns: cols.filter((c) => c.byDefault).map((c) => c.key),
  };
}

export function useViews() {
  return useQuery({ queryKey: ["views"], queryFn: () => api<View[]>("/api/views") });
}

function comparable(v: unknown): number | string | null {
  if (Array.isArray(v)) return v.length ? v.join(", ").toLowerCase() : null;
  if (v == null || v === "") return null;
  if (typeof v === "number" || typeof v === "boolean") return Number(v);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(s).getTime() : s.toLowerCase();
}

export function matches(row: OverviewRow, f: Filter, col: Column | undefined): boolean {
  const v = row[f.column];
  switch (f.op) {
    case "empty": return v == null || v === "" || (Array.isArray(v) && v.length === 0);
    case "notempty": return !(v == null || v === "" || (Array.isArray(v) && v.length === 0));
    case "in": {
      const wanted = (f.value as unknown[]).map(String);
      return Array.isArray(v) ? v.some((x) => wanted.includes(String(x))) : wanted.includes(String(v));
    }
    case "contains": return (col ? display(col, v) : String(v ?? "")).toLowerCase().includes(String(f.value ?? "").toLowerCase());
    case "gte": { const a = comparable(v), b = comparable(f.value); return a != null && b != null && a >= b; }
    case "lte": { const a = comparable(v), b = comparable(f.value); return a != null && b != null && a <= b; }
    case "thisweek": {
      if (!v) return false;
      const t = new Date(String(v)).getTime(), now = Date.now();
      return t >= now - 86400_000 && t <= now + 7 * 86400_000;
    }
  }
}

export function applyView(rows: OverviewRow[], filters: Filter[], sort: Sort[], search: string, cols: Column[]): OverviewRow[] {
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const q = search.trim().toLowerCase();
  const out = rows.filter((r) =>
    filters.every((f) => matches(r, f, byKey.get(f.column))) &&
    (!q || String(r.full_address ?? "").toLowerCase().includes(q) || String(r.agent_name ?? "").toLowerCase().includes(q) ||
      String(r.notes ?? "").toLowerCase().includes(q)));
  return out.sort((a, b) => {
    for (const s of sort) {
      const x = comparable(a[s.column]), y = comparable(b[s.column]);
      if (x === y) continue;
      if (x == null) return 1; // blanks last, whichever direction
      if (y == null) return -1;
      return (x < y ? -1 : 1) * (s.dir === "asc" ? 1 : -1);
    }
    return 0;
  });
}

export function describe(f: Filter, col: Column | undefined): string {
  const label = col?.label ?? f.column;
  const val = (v: unknown) => (col ? display(col, v) : String(v));
  switch (f.op) {
    case "in": return `${label}: ${(f.value as unknown[]).map(val).join(", ")}`;
    case "contains": return `${label} contains “${f.value}”`;
    case "gte": return `${label} ≥ ${val(f.value)}`;
    case "lte": return `${label} ≤ ${val(f.value)}`;
    case "empty": return `${label} is blank`;
    case "notempty": return `${label} is set`;
    case "thisweek": return `${label} this week`;
  }
}

export function toCsv(rows: OverviewRow[], cols: Column[]): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [cols.map((c) => cell(c.label)).join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => {
      const v = r[c.key];
      // Money and counts stay plain numbers so a spreadsheet can sum them; links stay full.
      if (v == null) return "";
      if (Array.isArray(v)) return cell(v.join("; "));
      if (["money", "int", "minutes", "pct"].includes(c.kind) || c.kind === "url") return cell(String(v));
      return cell(display(c, v));
    }).join(","));
  }
  return lines.join("\n");
}
