// The Overview column catalogue (PLAN.md §5, D15): every column, how it's typed in, shown, sorted and
// filtered. Shared by the desktop grid and the phone Houses tab.
import type { Person } from "../api";
import { LABEL, money, parseMoney } from "../format";

export type Kind = "text" | "int" | "money" | "date" | "datetime" | "enum" | "verdict" | "url" | "bool" | "minutes" | "pct" | "tags";

export type Column = {
  key: string;
  label: string;
  group: string;
  kind: Kind;
  editable?: boolean;
  byDefault?: boolean;
  width?: number;
  options?: Record<string, string>; // enum: value -> label
  history?: boolean; // version comes from row._v[key] (append-only field)
};

export type OverviewRow = Record<string, unknown> & { id: string; _v: Record<string, string | null> };
export type OverviewPlace = { id: string; kind: "station" | "destination"; name: string; person_id: string | null; is_favourite: boolean;
                              modes?: ("walk" | "drive" | "transit")[] };

const SOURCE = LABEL.guideSource;
const VERDICTS = { yes: "Yes", maybe: "Maybe", no: "No" };
/** The guide against the most we can bid (Settings → Budget). */
export const BUDGET = { within: "Within budget", stretch: "Stretch", over: "Over budget" };
const enumOf = (labels: Record<string, string>) => labels;

export function catalogue(persons: Person[], places: OverviewPlace[]): Column[] {
  const cols: Column[] = [
    { key: "address", label: "Address", group: "House", kind: "text", byDefault: true, width: 190 },
    { key: "suburb", label: "Suburb", group: "House", kind: "text", byDefault: true, width: 120 },
    { key: "postcode", label: "Postcode", group: "House", kind: "text", width: 80 },
    { key: "property_type", label: "Type", group: "House", kind: "enum", editable: true, byDefault: true, width: 95,
      options: { house: "House", townhouse: "Townhouse", unit: "Unit", apartment: "Apartment", land: "Land", other: "Other" } },
    { key: "build_status", label: "Build", group: "House", kind: "enum", editable: true, width: 110,
      options: { established: "Established", off_the_plan: "Off the plan", under_construction: "Under construction" } },
    { key: "beds", label: "Bed", group: "House", kind: "int", editable: true, byDefault: true, width: 55 },
    { key: "baths", label: "Bath", group: "House", kind: "int", editable: true, byDefault: true, width: 55 },
    { key: "car_spaces", label: "Car", group: "House", kind: "int", editable: true, byDefault: true, width: 55 },
    { key: "land_m2", label: "Land m²", group: "House", kind: "int", editable: true, byDefault: true, width: 80 },
    { key: "building_m2", label: "Building m²", group: "House", kind: "int", editable: true, width: 90 },
    { key: "plan_lot", label: "Lot\\plan", group: "House", kind: "text", width: 110 },
    { key: "owners_corp_fees_aud_pa", label: "OC fee/yr", group: "House", kind: "money", editable: true, width: 90 },
    { key: "council_rates_aud_pa", label: "Rates/yr", group: "House", kind: "money", editable: true, width: 90 },
    { key: "notes", label: "Notes", group: "House", kind: "text", editable: true, width: 200 },
    { key: "tags", label: "Tags", group: "House", kind: "tags", editable: true, byDefault: true, width: 160 },
    { key: "created_at", label: "Added", group: "House", kind: "date", width: 90 },
    { key: "pin_source", label: "Pin", group: "House", kind: "text", width: 80 },

    { key: "status", label: "Status", group: "Pipeline", kind: "enum", editable: true, history: true, byDefault: true, width: 105,
      options: enumOf(LABEL.status) },
    { key: "status_since", label: "Status since", group: "Pipeline", kind: "date", width: 95 },
    { key: "excluded", label: "Excluded (me)", group: "Pipeline", kind: "bool", byDefault: true, width: 90 },
    { key: "flagged_by", label: "Flagged by", group: "Pipeline", kind: "text", width: 95 },

    { key: "sale_method", label: "Method", group: "Campaign", kind: "enum", editable: true, byDefault: true, width: 95,
      options: enumOf(LABEL.method) },
    { key: "sale_at", label: "Auction / EOI", group: "Campaign", kind: "datetime", editable: true, byDefault: true, width: 140 },
    { key: "listed_on", label: "Listed", group: "Campaign", kind: "date", editable: true, width: 90 },
    { key: "days_on_market", label: "Days", group: "Campaign", kind: "int", byDefault: true, width: 60 },
    { key: "outcome", label: "Outcome", group: "Campaign", kind: "enum", editable: true, byDefault: true, width: 120,
      options: enumOf(LABEL.outcome) },
    { key: "outcome_on", label: "Outcome date", group: "Campaign", kind: "date", width: 95 },
    { key: "sold_price_aud", label: "Sold", group: "Campaign", kind: "money", editable: true, byDefault: true, width: 85 },
    { key: "passed_in_bid_aud", label: "Passed in", group: "Campaign", kind: "money", editable: true, width: 85 },
    { key: "listing_url", label: "Listing", group: "Campaign", kind: "url", editable: true, byDefault: true, width: 110 },
    { key: "relists", label: "Relists", group: "Campaign", kind: "int", width: 65 },

    { key: "agent_name", label: "Agent", group: "Agent", kind: "text", editable: true, byDefault: true, width: 120 },
    { key: "agency", label: "Agency", group: "Agent", kind: "text", width: 120 },
    { key: "agent_phone", label: "Agent phone", group: "Agent", kind: "text", editable: true, width: 115 },
    { key: "agent_email", label: "Agent email", group: "Agent", kind: "text", width: 150 },

    { key: "guide_low", label: "Guide low", group: "Price", kind: "money", editable: true, history: true, byDefault: true, width: 90 },
    { key: "guide_high", label: "Guide high", group: "Price", kind: "money", editable: true, history: true, byDefault: true, width: 90 },
    { key: "budget", label: "Budget", group: "Price", kind: "enum", byDefault: true, width: 95, options: enumOf(BUDGET) },
    { key: "guide_source", label: "Guide source", group: "Price", kind: "enum", editable: true, history: true, width: 150,
      options: enumOf(SOURCE) },
    { key: "guide_date", label: "Guide date", group: "Price", kind: "date", width: 90 },
    { key: "suburb_median", label: "Suburb median", group: "Price", kind: "money", width: 100 },
    { key: "guide_change", label: "Guide change", group: "Price", kind: "money", width: 95 },
    { key: "first_guide_low", label: "First guide low", group: "Price", kind: "money", width: 100 },
    { key: "first_guide_high", label: "First guide high", group: "Price", kind: "money", width: 100 },
    { key: "guide_changes", label: "Price changes", group: "Price", kind: "int", byDefault: true, width: 90 },
    { key: "last_guide_change", label: "Last price change", group: "Price", kind: "date", width: 110 },
    { key: "expected_sale", label: "We think it's worth", group: "Price", kind: "money", editable: true, history: true, byDefault: true, width: 120 },
    { key: "walk_away", label: "Our max", group: "Price", kind: "money", editable: true, history: true, byDefault: true, width: 90 },
    { key: "sold_vs_guide_pct", label: "Sold vs guide", group: "Price", kind: "pct", width: 95 },
    { key: "guide_per_m2", label: "Guide/m² land", group: "Price", kind: "money", width: 100 },
  ];
  for (const p of persons.filter((x) => x.active)) {
    cols.push(
      { key: `v:${p.id}:pre`, label: `${p.display_name} pre`, group: "Opinions", kind: "verdict", editable: true, history: true, byDefault: true, width: 90, options: VERDICTS },
      { key: `v:${p.id}:post`, label: `${p.display_name} post`, group: "Opinions", kind: "verdict", editable: true, history: true, byDefault: true, width: 95, options: VERDICTS },
      { key: `last_verdict:${p.id}`, label: `${p.display_name} last verdict`, group: "Opinions", kind: "date", width: 110 },
    );
  }
  cols.push(
    { key: "school_primary", label: "Primary zone", group: "Schools and planning", kind: "text", byDefault: true, width: 150 },
    { key: "school_secondary", label: "Secondary zone", group: "Schools and planning", kind: "text", width: 150 },
    { key: "planning", label: "Planning overlays", group: "Schools and planning", kind: "text", width: 220 },
  );
  for (const p of persons.filter((x) => x.active)) {
    cols.push({ key: `score:${p.id}`, label: `${p.display_name} score`, group: "Scores", kind: "int", width: 90 });
  }
  cols.push({ key: "score_avg", label: "Average score", group: "Scores", kind: "int", byDefault: true, width: 90 });
  cols.push(
    { key: "nearest_station", label: "Nearest station", group: "Getting around", kind: "text", byDefault: true, width: 120 },
    { key: "nearest_station_drive", label: "Drive to station", group: "Getting around", kind: "minutes", byDefault: true, width: 90 },
    { key: "nearest_station_km", label: "Station km", group: "Getting around", kind: "text", width: 80 },
    { key: "nearest_station_walk", label: "Walk to station", group: "Getting around", kind: "minutes", byDefault: true, width: 80 },
  );
  const owner = (pl: OverviewPlace) => (pl.person_id ? persons.find((p) => p.id === pl.person_id)?.display_name : null);
  for (const pl of places) {
    const name = owner(pl) ? `${owner(pl)}'s ${pl.name}` : pl.name;
    // One column per way of getting there that the place has switched on (the Places tab).
    const has = (m: "walk" | "drive" | "transit") => !pl.modes || pl.modes.includes(m);
    if (has("walk")) cols.push({ key: `walk:${pl.id}`, label: `Walk to ${name}`, group: "Getting around", kind: "minutes", width: 110 });
    if (pl.kind === "destination") {
      if (has("drive")) {
        // Peak hour (there by 9, home at 5), estimated from the road types; the no-traffic time is there if wanted.
        cols.push({ key: `drive:${pl.id}`, label: `Drive to ${name} (peak)`, group: "Getting around", kind: "minutes",
                    byDefault: pl.is_favourite, width: 120 });
        cols.push({ key: `drive_free:${pl.id}`, label: `Drive to ${name} (no traffic)`, group: "Getting around", kind: "minutes", width: 120 });
      }
      if (has("transit")) {
        cols.push({ key: `transit:${pl.id}`, label: `Public transport to ${name}`, group: "Getting around", kind: "minutes",
                    byDefault: pl.is_favourite, width: 110 });
        cols.push({ key: `transit_home:${pl.id}`, label: `Public transport home from ${name}`, group: "Getting around", kind: "minutes", width: 120 });
      }
    }
  }
  return cols;
}

// ─── typing values in ─────────────────────────────────────────────────
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Australian day-first dates: "17/10", "17/10/26", "17 Oct", "2026-10-17". Year defaults to the
 *  next occurrence (this year, or next year if the date has passed by more than a month). */
export function parseDate(text: string, now = new Date()): Date | null {
  const s = text.trim().toLowerCase();
  let d: number, m: number, y: number | null = null;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return new Date(+match[1], +match[2] - 1, +match[3]);
  match = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/);
  if (match) {
    [d, m] = [+match[1], +match[2]];
    if (match[3]) y = +match[3] < 100 ? 2000 + +match[3] : +match[3];
  } else {
    match = s.match(/^(\d{1,2})\s*([a-z]{3})[a-z]*\.?(?:\s+(\d{2,4}))?/);
    if (!match || !MONTHS.includes(match[2])) return null;
    [d, m] = [+match[1], MONTHS.indexOf(match[2]) + 1];
    if (match[3]) y = +match[3] < 100 ? 2000 + +match[3] : +match[3];
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y == null) {
    y = now.getFullYear();
    if (new Date(y, m - 1, d).getTime() < now.getTime() - 31 * 86400_000) y += 1;
  }
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 ? date : null;
}

/** Date plus optional time: "17/10 11am", "17 Oct 2:30pm", "17/10/26 11:00". */
export function parseDateTime(text: string, now = new Date()): Date | null {
  const date = parseDate(text, now);
  if (!date) return null;
  const t = text.trim().toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/);
  const hasTime = t && (t[2] || t[3]);
  if (hasTime) {
    let h = +t![1];
    if (t![3] === "pm" && h < 12) h += 12;
    if (t![3] === "am" && h === 12) h = 0;
    date.setHours(h, t![2] ? +t![2] : 0);
  }
  return date;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Typed text -> the value sent to the API, or an error message. */
export function parseInput(col: Column, raw: unknown): { value: unknown } | { error: string } {
  const text = raw == null ? "" : Array.isArray(raw) ? raw.join(",") : String(raw).trim();
  if (text === "" && col.kind === "tags") return { value: [] };
  if (text === "") return col.history ? { error: col.kind === "verdict" ? "Choose Yes, Maybe or No" : "This keeps history: enter a value" } : { value: null };
  switch (col.kind) {
    case "int": {
      const n = Number(text.replace(/,/g, ""));
      const max = ["beds", "baths", "car_spaces"].includes(col.key) ? 20 : 10_000_000;
      if (!/^[\d,]+$/.test(text) || !Number.isInteger(n)) return { error: "A whole number, e.g. 3" };
      return n <= max ? { value: n } : { error: `At most ${max.toLocaleString()}` };
    }
    case "money": {
      const n = parseMoney(text);
      return n != null ? { value: n } : { error: "Like 1.2m or 950k" };
    }
    case "date": {
      const d = parseDate(text);
      return d ? { value: iso(d) } : { error: "Like 17/10 or 17 Oct" };
    }
    case "datetime": {
      if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return { value: new Date(text).toISOString() };
      const d = parseDateTime(text);
      return d ? { value: d.toISOString() } : { error: "Like 17/10 11am" };
    }
    case "verdict": {
      const v = { y: "yes", yes: "yes", m: "maybe", maybe: "maybe", n: "no", no: "no" }[text.toLowerCase()];
      return v ? { value: v } : { error: "Type Y, M or N" };
    }
    case "enum": {
      const opts = col.options ?? {};
      const hit = Object.entries(opts).find(([k, label]) => k === text || label.toLowerCase() === text.toLowerCase())
        ?? Object.entries(opts).find(([, label]) => label.toLowerCase().startsWith(text.toLowerCase()));
      return hit ? { value: hit[0] } : { error: `One of: ${Object.values(opts).join(", ")}` };
    }
    case "url":
      return /^https?:\/\//.test(text) ? { value: text } : { error: "A web address starting https://" };
    case "tags":
      return { value: (Array.isArray(raw) ? raw : text.split(",")).map((t) => String(t).trim()).filter(Boolean) };
    default:
      return { value: text };
  }
}

// ─── showing values ───────────────────────────────────────────────────
const dayFmt = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "2-digit" });
const dtFmt = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function display(col: Column, v: unknown): string {
  if (v == null || v === "") return "";
  switch (col.kind) {
    case "tags": return (v as string[]).join(", ");
    case "money": return col.key === "guide_change" && (v as number) > 0 ? `+${money(v as number)}` : (v as number) < 0 ? `−${money(-(v as number))}` : money(v as number);
    case "date": return dayFmt.format(new Date(String(v).length === 10 ? `${v}T00:00` : String(v)));
    case "datetime": return dtFmt.format(new Date(String(v)));
    case "enum": return col.options?.[String(v)] ?? String(v);
    case "verdict": return LABEL.stance[v as "yes"] ?? String(v);
    case "bool": return v ? "Yes" : "";
    case "minutes": return `${v} min`;
    case "pct": return `${(v as number) > 0 ? "+" : ""}${v}%`;
    case "url": {
      const host = String(v).replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
      return host.includes("realestate") ? "realestate.com.au" : host;
    }
    default: return String(v);
  }
}

/** Text shown inside the editor when a cell is opened: what you'd type to get this value back. */
export function editText(col: Column, v: unknown): string {
  if (v == null) return "";
  if (col.kind === "money") return String(v);
  if (col.kind === "date") return display(col, v);
  if (col.kind === "datetime") {
    const d = new Date(String(v));
    return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (col.kind === "enum") return col.options?.[String(v)] ?? String(v);
  if (col.kind === "verdict") return String(v)[0].toUpperCase();
  if (col.kind === "tags") return (v as string[]).join(", ");
  return String(v);
}
