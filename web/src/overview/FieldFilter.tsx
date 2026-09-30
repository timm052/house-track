// Filtering on any field, made easy: pick the field by typing (suggested as you go), then an editor that suits it,
// with suggestions from the houses themselves: the values that occur (and how many houses have each), ranges that
// split the houses sensibly, dates relative to today. The search box's suggestions come from here too: a field's
// name, a value ("townhouse"), or a phrase ("3 bed", "land over 600", "price under 1.2m").
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { money, parseMoney } from "../format";
import { display, type Column, type OverviewRow } from "./columns";
import type { Filter } from "./views";

const NUMERIC = new Set(["int", "money", "minutes", "pct"]);
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysFromNow = (n: number) => isoDay(new Date(Date.now() + n * 86400_000));

/** A number rounded to something a person would type: $50k steps for prices, two figures otherwise. */
function nice(n: number, kind: string): number {
  if (kind === "money") return n >= 1_000_000 ? Math.round(n / 50_000) * 50_000 : Math.round(n / 25_000) * 25_000;
  if (n < 20) return Math.round(n);
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}
const show = (col: Column, n: number) => (col.kind === "money" ? money(n) : col.kind === "minutes" ? `${n} min` : String(n));
const parseNum = (col: Column, text: string) => (col.kind === "money" ? parseMoney(text) : text.trim() === "" ? null : Number(text.replace(/[^\d.-]/g, "")));

// Words people use for fields, so "3 bed", "land over 600" and "price under 1.2m" find the right column.
const ALIASES: [RegExp, string | ((op: "gte" | "lte") => string)][] = [
  [/^(beds?|bedrooms?)$/, "beds"], [/^(baths?|bathrooms?)$/, "baths"], [/^(cars?|parking|garages?|car spaces?)$/, "car_spaces"],
  [/^(land|block|lot|land size|land m2|land m²)$/, "land_m2"], [/^(building|floor|house size|floor area)$/, "building_m2"],
  [/^(price|guide|guide price|asking)$/, (op) => (op === "gte" ? "guide_low" : "guide_high")],
  [/^(sold|sold price|sale price)$/, "sold_price_aud"], [/^(rates|council rates)$/, "council_rates_aud_pa"],
  [/^(walk|walk to station|station walk)$/, "nearest_station_walk"], [/^(drive|drive to station|station drive)$/, "nearest_station_drive"],
  [/^(days|days listed|days on market)$/, "days_on_market"], [/^(score|average score)$/, "score_avg"],
];
const OPS: [RegExp, "gte" | "lte"][] = [
  [/^(>=|>|over|above|more than|at least|min|from)$/, "gte"], [/^(<=|<|under|below|less than|at most|max|up to)$/, "lte"],
];

function columnFor(words: string, op: "gte" | "lte", cols: Column[]): Column | undefined {
  const w = words.trim().toLowerCase();
  for (const [re, key] of ALIASES) if (re.test(w)) return cols.find((c) => c.key === (typeof key === "string" ? key : key(op)));
  return cols.find((c) => NUMERIC.has(c.kind) && c.label.toLowerCase() === w) ?? cols.find((c) => NUMERIC.has(c.kind) && c.label.toLowerCase().startsWith(w));
}

export type FieldOffer = { key: string; kind: string; label: string; filters?: Filter[]; column?: string };

/** What the search box offers from the fields: a phrase made into a filter, a value, or a field to filter on. */
export function fieldOffers(text: string, cols: Column[]): FieldOffer[] {
  const q = text.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: FieldOffer[] = [];
  // "3 bed", "2+ baths", "4 bedrooms": at least that many
  const count = q.match(/^(\d+)\s*\+?\s*(beds?|bedrooms?|baths?|bathrooms?|cars?|car spaces?)$/);
  if (count) {
    const col = columnFor(count[2], "gte", cols);
    if (col) out.push({ key: `f:${col.key}:gte`, kind: "Filter", label: `${col.label} at least ${count[1]}`, filters: [{ column: col.key, op: "gte", value: Number(count[1]) }] });
  }
  // "land over 600", "price under 1.2m", "walk < 15"
  const phrase = q.match(/^(.+?)\s*(>=|<=|>|<|over|above|more than|at least|under|below|less than|at most|up to)\s*\$?([\d.,]+\s*[km]?)\s*(m2|m²|mins?|minutes)?$/);
  if (phrase) {
    const op = OPS.find(([re]) => re.test(phrase[2]))?.[1];
    const col = op && columnFor(phrase[1], op, cols);
    const n = col ? (col.kind === "money" ? parseMoney(phrase[3]) : Number(phrase[3].replace(/,/g, ""))) : null;
    if (op && col && n != null && !Number.isNaN(n)) {
      out.push({ key: `f:${col.key}:${op}`, kind: "Filter", label: `${col.label} ${op === "gte" ? "at least" : "at most"} ${show(col, n)}`,
                 filters: [{ column: col.key, op, value: n }] });
    }
  }
  // A value of a list field ("townhouse", "off the plan", "passed in")
  for (const col of cols) {
    if (col.kind !== "enum" || !col.options || ["status", "sale_method"].includes(col.key)) continue;
    for (const [value, label] of Object.entries(col.options)) {
      if (label.toLowerCase().startsWith(q) || (q.length >= 4 && label.toLowerCase().includes(q))) {
        out.push({ key: `e:${col.key}:${value}`, kind: col.label, label, filters: [{ column: col.key, op: "in", value: [value] }] });
      }
    }
  }
  // A field to filter on ("agent", "listed", "school")
  for (const col of cols) {
    if (col.key === "address") continue;
    const l = col.label.toLowerCase();
    if (l.startsWith(q) || l.split(/[\s/]+/).some((w) => w.startsWith(q))) out.push({ key: `c:${col.key}`, kind: "Field", label: `Filter by ${col.label}…`, column: col.key });
  }
  return out.slice(0, 6);
}

const UNITS: Record<string, string> = { land_m2: "m²", building_m2: "m²" };
const dayFmt = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** The houses' values as dots along a line from lowest to highest, with the chosen range shaded. */
function RangeStrip({ nums, lo, hi }: { nums: number[]; lo: number | null; hi: number | null }) {
  const min = nums[0], max = nums[nums.length - 1], span = max - min || 1;
  const at = (n: number) => `${Math.min(100, Math.max(0, ((n - min) / span) * 100))}%`;
  const inside = (n: number) => (lo == null || n >= lo) && (hi == null || n <= hi);
  return (
    <div className="range-strip" aria-hidden>
      {(lo != null || hi != null) && <span className="range-band" style={{ left: at(lo ?? min), right: `calc(100% - ${at(hi ?? max)})` }} />}
      {nums.map((n, i) => <span key={i} className={`range-dot ${inside(n) ? "in" : ""}`} style={{ left: at(n) }} />)}
    </div>
  );
}

/** Pick a field (type to find it), then set its filter. */
export default function FieldFilter({ cols, rows, current, start, onApply }: {
  cols: Column[]; rows: OverviewRow[]; current: Filter[];
  start?: string | null;                                  // a field to open straight away (from the search box)
  onApply: (column: string, filters: Filter[]) => void;   // the column's filters, replacing any it had ([] clears it)
}) {
  const [picked, setPicked] = useState<string | null>(start ?? null);
  const [q, setQ] = useState("");
  const col = cols.find((c) => c.key === picked);
  const matches = useMemo(() => {
    const w = q.trim().toLowerCase();
    return cols.filter((c) => c.key !== "address" && (!w || c.label.toLowerCase().includes(w) || c.group.toLowerCase().includes(w))).slice(0, 40);
  }, [q, cols]);
  if (col) return <FieldEditor key={col.key} col={col} rows={rows} current={current.filter((f) => f.column === col.key)}
    onApply={(fs) => { onApply(col.key, fs); setPicked(null); setQ(""); }} onBack={() => setPicked(null)} />;
  const groups = [...new Set(matches.map((c) => c.group))];
  return (
    <div className="field-filter">
      <input type="search" placeholder="Type a field: land, agent, listed, school zone…" aria-label="Find a field to filter on"
        value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) setPicked(matches[0].key); }} />
      {q.trim() && (
        <div className="field-list">
          {groups.map((g) => (
            <div key={g}>
              <div className="field-group">{g}</div>
              <div className="chips">
                {matches.filter((c) => c.group === g).map((c) => (
                  <button key={c.key} className={`chip ${current.some((f) => f.column === c.key) ? "on" : ""}`} onClick={() => setPicked(c.key)}>{c.label}</button>
                ))}
              </div>
            </div>
          ))}
          {matches.length === 0 && <p className="small muted">No field called that.</p>}
        </div>
      )}
    </div>
  );
}

/** The editor for one field, suited to its kind, with suggestions from the houses. */
function FieldEditor({ col, rows, current, onApply, onBack }: {
  col: Column; rows: OverviewRow[]; current: Filter[]; onApply: (fs: Filter[]) => void; onBack: () => void;
}) {
  const values = rows.map((r) => r[col.key]).filter((v) => v != null && v !== "" && !(Array.isArray(v) && !v.length));
  const was = (op: Filter["op"]) => current.find((f) => f.op === op)?.value;
  const [picked, setPicked] = useState<string[]>(() => ((was("in") as unknown[] | undefined) ?? []).map(String));
  const [lo, setLo] = useState(() => (was("gte") != null ? String(was("gte")) : ""));
  const [hi, setHi] = useState(() => (was("lte") != null ? String(was("lte")) : ""));
  const [text, setText] = useState(() => String(was("contains") ?? ""));
  const flip = (v: string) => setPicked(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]);
  const numeric = NUMERIC.has(col.kind), dated = col.kind === "date" || col.kind === "datetime";
  const listed = col.kind === "enum" || col.kind === "verdict" || col.kind === "bool" || col.kind === "tags";

  // The values that occur, most common first, with how many houses have each.
  const counts = new Map<string, number>();
  for (const v of values) for (const x of Array.isArray(v) ? v : [v]) counts.set(String(x), (counts.get(String(x)) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const options: [string, string][] = col.kind === "bool" ? [["true", "Yes"], ["false", "No"]]
    : col.options ? Object.entries(col.options) : common.map(([v]) => [v, display(col, col.kind === "tags" ? [v] : v)]);

  // Numbers: "at least" steps when there are few values (beds), otherwise ranges that split the houses into quarters.
  const nums = values.map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const distinct = [...new Set(nums)];
  const quarter = (f: number) => nice(nums[Math.min(nums.length - 1, Math.floor(nums.length * f))], col.kind);
  const ranges: { label: string; lo?: number; hi?: number }[] = !numeric || !nums.length ? []
    : col.kind === "minutes" ? [10, 15, 20, 30, 45].map((m) => ({ label: `${m} min or less`, hi: m }))
    : col.kind === "int" && distinct.length <= 8 && nums[nums.length - 1] <= 12   // counts like beds: steps up
      ? distinct.filter((n) => n > 0).map((n) => ({ label: `${n} or more`, lo: n }))
    : [...new Set([quarter(0.25), quarter(0.5), quarter(0.75)])].flatMap((n) => [{ label: `Under ${show(col, n)}`, hi: n }, { label: `${show(col, n)} or more`, lo: n }]);
  const dates: { label: string; lo?: string; hi?: string }[] = [
    { label: "Next 7 days", lo: daysFromNow(0), hi: daysFromNow(7) }, { label: "Next 30 days", lo: daysFromNow(0), hi: daysFromNow(30) },
    { label: "Last 7 days", lo: daysFromNow(-7), hi: daysFromNow(0) }, { label: "Last 30 days", lo: daysFromNow(-30), hi: daysFromNow(0) },
    { label: "Last 90 days", lo: daysFromNow(-90), hi: daysFromNow(0) },
  ];

  function apply() {
    const fs: Filter[] = [];
    if (listed && picked.length) fs.push({ column: col.key, op: "in", value: picked });
    if (numeric || dated) {
      const a = dated ? lo : parseNum(col, lo), b = dated ? hi : parseNum(col, hi);
      if (a != null && a !== "") fs.push({ column: col.key, op: "gte", value: a });
      if (b != null && b !== "") fs.push({ column: col.key, op: "lte", value: dated && col.kind === "datetime" ? `${b}T23:59` : b });
    }
    if (!listed && !numeric && !dated) {
      if (picked.length) fs.push({ column: col.key, op: "in", value: picked });
      else if (text.trim()) fs.push({ column: col.key, op: "contains", value: text.trim() });
    }
    onApply(fs);
  }
  // What the range means, in words and on a strip of the houses' own values.
  const unit = UNITS[col.key] ?? (col.kind === "minutes" ? "min" : col.kind === "pct" ? "%" : "");
  const a = numeric ? parseNum(col, lo) : null, b = numeric ? parseNum(col, hi) : null;
  const inRange = (n: number) => (a == null || n >= a) && (b == null || n <= b);
  const numberSummary = a == null && b == null ? null
    : `${col.label} ${a != null && b != null ? `from ${show(col, a)} to ${show(col, b)}` : a != null ? `${show(col, a)} or more` : `${show(col, b!)} or less`}${unit && col.kind !== "minutes" ? ` ${unit}` : ""}`;
  const dateAt = (v: unknown) => new Date(String(v).length === 10 ? `${v}T00:00` : String(v)).getTime();
  const dayOf = (iso: string) => { const d = new Date(`${iso}T00:00`); return Number.isNaN(d.getTime()) ? iso : dayFmt.format(d); };
  const dateSummary = !dated || (!lo && !hi) ? null : `${col.label} ${lo && hi ? `from ${dayOf(lo)} until ${dayOf(hi)}` : lo ? `from ${dayOf(lo)} on` : `until ${dayOf(hi)}`}`;
  const matching = numeric ? nums.filter(inRange).length
    : dated ? values.filter((v) => (!lo || dateAt(v) >= dateAt(lo)) && (!hi || dateAt(v) <= dateAt(hi) + 86400_000 - 1)).length : 0;

  return (
    <div className="field-editor">
      <div className="row">
        <strong className="grow">{col.label} <span className="muted small">{col.group}</span></strong>
        <button className="link small" onClick={onBack}>Another field</button>
      </div>
      {listed && (
        <div className="chips">
          {options.map(([v, label]) => (
            <button key={v} className={`chip ${picked.includes(v) ? "on" : ""}`} onClick={() => flip(v)}>
              {label}{counts.get(v) ? <span className="field-n">{counts.get(v)}</span> : null}</button>
          ))}
        </div>
      )}
      {numeric && <>
        <div className="chips">
          {ranges.map((r) => (
            <button key={r.label} className="chip" onClick={() => { setLo(r.lo != null ? String(r.lo) : ""); setHi(r.hi != null ? String(r.hi) : ""); }}>{r.label}</button>
          ))}
        </div>
        <div className="field-range">
          <label>At least
            <span className="field-box">{col.kind === "money" && <span className="field-unit">$</span>}
              <input inputMode="decimal" placeholder={nums.length ? `lowest ${col.kind === "money" ? money(nums[0]).slice(1) : nums[0]}` : "any"}
                value={lo} onChange={(e) => setLo(e.target.value)} />
              {unit && <span className="field-unit">{unit}</span>}</span>
          </label>
          <label>At most
            <span className="field-box">{col.kind === "money" && <span className="field-unit">$</span>}
              <input inputMode="decimal" placeholder={nums.length ? `highest ${col.kind === "money" ? money(nums[nums.length - 1]).slice(1) : nums[nums.length - 1]}` : "any"}
                value={hi} onChange={(e) => setHi(e.target.value)} />
              {unit && <span className="field-unit">{unit}</span>}</span>
          </label>
        </div>
        {nums.length > 1 && <RangeStrip nums={nums} lo={a} hi={b} />}
        <p className="small field-summary">{numberSummary
          ? <><strong>{numberSummary}</strong> · {matching} of {nums.length} {nums.length === 1 ? "house" : "houses"}</>
          : <span className="muted">Leave a box empty for no limit that way.{col.kind === "money" ? " Type 1.2m or 950k." : ""}</span>}</p>
      </>}
      {dated && <>
        <div className="chips">
          {dates.map((d) => (
            <button key={d.label} className={`chip ${lo === d.lo && hi === d.hi ? "on" : ""}`} onClick={() => { setLo(d.lo ?? ""); setHi(d.hi ?? ""); }}>{d.label}</button>
          ))}
        </div>
        <div className="field-range">
          <label>From<span className="field-box"><input type="date" value={lo} onChange={(e) => setLo(e.target.value)} /></span></label>
          <label>Until<span className="field-box"><input type="date" value={hi} onChange={(e) => setHi(e.target.value)} /></span></label>
        </div>
        <p className="small field-summary">{dateSummary
          ? <><strong>{dateSummary}</strong> · {matching} of {values.length} {values.length === 1 ? "house" : "houses"}</>
          : <span className="muted">Choose a period, or enter dates.</span>}</p>
      </>}
      {!listed && !numeric && !dated && <>
        {common.length > 0 && common.length <= 30 && (
          <div className="chips">
            {common.slice(0, 12).map(([v, n]) => (
              <button key={v} className={`chip ${picked.includes(v) ? "on" : ""}`} onClick={() => flip(v)}>{display(col, v)}<span className="field-n">{n}</span></button>
            ))}
          </div>
        )}
        <input list={`field-${col.key}`} placeholder={`${col.label} contains…`} value={text} onChange={(e) => setText(e.target.value)} />
        <datalist id={`field-${col.key}`}>{common.slice(0, 50).map(([v]) => <option key={v} value={display(col, v)} />)}</datalist>
      </>}
      <div className="row">
        <button className="link small" onClick={() => onApply([{ column: col.key, op: "notempty" }])}>Has a value</button>
        <button className="link small" onClick={() => onApply([{ column: col.key, op: "empty" }])}>Is empty</button>
        <span className="grow" />
        {current.length > 0 && <button className="small-btn" onClick={() => onApply([])}><X /> Remove</button>}
        <button className="primary" onClick={apply}>Apply</button>
      </div>
    </div>
  );
}
