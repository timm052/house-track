// Colour used for meaning across the app, so the same thing always looks the same:
//   suburbs  — an identity colour each (row tint in Overview, card stripe, swatches in filters and Trends);
//   status   — one colour per pipeline stage (dots on pills, and map pins);
//   tones    — good / warn / bad for times, price changes and upcoming dates;
//   tags     — the colour stored with each tag.
// Colour is never the only signal: the suburb name, status label or value is always shown next to it.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { api, type Status } from "./api";

// ─── suburbs ────────────────────────────────────────────────────────────
// Twelve hues, 30° apart, in an order where each next one is far from the ones before it, so the first
// suburbs you add are the easiest to tell apart. A suburb keeps its colour for good: colours are handed out
// in the order each suburb first appeared (its earliest-added house), so adding a new suburb never repaints
// the others. Past twelve suburbs the hues repeat; the name next to the colour tells repeats apart.
const HUES = [215, 25, 145, 290, 55, 185, 340, 95, 250, 5, 165, 310];
export const SUBURB_SLOTS = HUES.length;

(function injectSuburbCss() {
  if (typeof document === "undefined" || document.getElementById("suburb-colours")) return;
  const light = HUES.map((h, i) => `--sub-${i}-tint: hsl(${h} 75% 96%); --sub-${i}-ink: hsl(${h} 60% 42%);`).join(" ");
  const dark = HUES.map((h, i) => `--sub-${i}-tint: hsl(${h} 50% 50% / 0.2); --sub-${i}-ink: hsl(${h} 65% 64%);`).join(" ");
  const classes = HUES.map((_, i) => `.sub-${i} { --sub-tint: var(--sub-${i}-tint); --sub-ink: var(--sub-${i}-ink); }`).join("\n");
  const el = document.createElement("style");
  el.id = "suburb-colours";
  el.textContent = `:root { ${light} }\n@media (prefers-color-scheme: dark) { :root { ${dark} } }\n${classes}`;
  document.head.appendChild(el);
})();

type HasSuburb = Record<string, unknown>;

/** suburb (lower-case) → colour slot, from every house you've added (not just the ones on screen). */
export function suburbSlots(rows: HasSuburb[]): Map<string, number> {
  const first = new Map<string, string>();
  for (const r of rows) {
    const s = String(r.suburb ?? "").trim().toLowerCase();
    if (!s) continue;
    const at = String(r.created_at ?? "");
    const seen = first.get(s);
    if (seen == null || at < seen) first.set(s, at);
  }
  const order = [...first.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  return new Map(order.map(([s], i) => [s, i % SUBURB_SLOTS]));
}

/** CSS class that sets --sub-tint and --sub-ink for a suburb, or "" if it isn't known. */
export function suburbClass(slots: Map<string, number>, suburb: unknown): string {
  const i = slots.get(String(suburb ?? "").trim().toLowerCase());
  return i == null ? "" : `sub-${i}`;
}

/** The shared overview rows are the source of suburb colours; pages that already load them pass them in. */
export function useSuburbSlots(): Map<string, number> {
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: HasSuburb[] }>("/api/overview"), staleTime: 60_000 });
  return useMemo(() => suburbSlots(q.data?.rows ?? []), [q.data]);
}

// ─── status ─────────────────────────────────────────────────────────────
// Active stages get strong colours that build towards "bidding"; closed ones are greys; "bought" is gold.
export const STATUS_COLOUR: Record<Status, string> = {
  watching: "#64748b", inspecting: "#0284c7", shortlisted: "#16a34a", bidding: "#9333ea",
  rejected: "#9ca3af", lost: "#78716c", withdrawn: "#a8a29e", bought: "#ca8a04",
};
export const CLOSED: Status[] = ["rejected", "lost", "withdrawn"];

// ─── tones ──────────────────────────────────────────────────────────────
export type Tone = "good" | "warn" | "bad" | "";
/** Walking minutes: ten or less is easy, over twenty is a trek. Driving: fifteen and thirty. */
export const minutesTone = (m: unknown, mode: "walk" | "drive" = "walk"): Tone => {
  if (typeof m !== "number") return "";
  const [ok, far] = mode === "walk" ? [10, 20] : [15, 30];
  return m <= ok ? "good" : m <= far ? "warn" : "bad";
};
/** A price guide going up is bad news for a buyer; down is good. */
export const changeTone = (d: unknown): Tone =>
  typeof d !== "number" || d === 0 ? "" : d > 0 ? "bad" : "good";
/** An auction or closing date in the next seven days. */
export const soonTone = (iso: unknown): Tone => {
  if (typeof iso !== "string" || !iso) return "";
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000;
  return days >= -0.5 && days <= 7 ? "warn" : "";
};

// ─── tags ───────────────────────────────────────────────────────────────
export function useTagColours(): Map<string, string> {
  const q = useQuery({ queryKey: ["tags"], queryFn: () => api<{ name: string; colour: string }[]>("/api/tags") });
  return useMemo(() => new Map((q.data ?? []).map((t) => [t.name.toLowerCase(), t.colour])), [q.data]);
}
/** Inline style for a tag chip: its colour as a tint and an edge, readable in light and dark. */
export const tagStyle = (colours: Map<string, string>, name: string) => {
  const c = colours.get(name.toLowerCase());
  return c ? { background: `color-mix(in srgb, ${c} 16%, transparent)`, borderColor: `color-mix(in srgb, ${c} 55%, transparent)` } : undefined;
};

// ─── light / dark ───────────────────────────────────────────────────────
// Components that pick colours in code (the grid's theme, the map's basemap) must follow the system setting
// live, not just read it once, or switching modes leaves them on the old palette.
const darkQuery = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
export function useDarkMode(): boolean {
  return useSyncExternalStore(
    (onChange) => { darkQuery?.addEventListener("change", onChange); return () => darkQuery?.removeEventListener("change", onChange); },
    () => darkQuery?.matches ?? false,
  );
}
