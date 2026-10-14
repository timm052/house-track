// Blocks (the map's Blocks mode, Settings → Blocks, a house's Location tab): what's known about a property's block from
// Vicmap (api/app/blocks.py), the household's block preferences, and the pieces each screen shows: the words for a
// block's slope, whether it fits the preferences and why not, the drop diagram (a section from the street to the back
// fence), and the block card.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";

export type Direction = "level" | "up" | "down" | "across";
export type BlockPrefs = {
  min_m2: number; max_m2: number; max_incline: number; directions: Direction[]; include_units: boolean;
  split: Record<string, number | null>; split_frontage: number;
};
export type Block = {
  pfi: string; suburb: string; address: string | null; is_unit: boolean; addresses: number;
  area_m2: number | null; frontage_m: number | null; depth_m: number | null; regularity: number | null; battleaxe: boolean;
  fall_m: number | null; cross_fall_m: number | null; along_pct: number | null; across_pct: number | null;
  incline_pct: number | null; steepest_pct: number | null; direction: Direction | null; profile: number[] | null;
  rear_bearing: number | null; zone_code: string | null; rear_facing: string | null; split_lots: number; fits: boolean | null;
  tracked?: { id: string; status: string | null } | null;
};
export type BlockSuburb = { suburb: string; status: "pending" | "running" | "done" | "error"; error: string | null; blocks: number | null;
                            analysed_at: string | null; created_at: string };

export const DIRECTIONS: [Direction, string][] = [["level", "Level"], ["down", "Slopes down from the street"],
  ["up", "Slopes up from the street"], ["across", "Slopes across"]];
export const DIRECTION_SHORT: Record<Direction, string> = { level: "Level", down: "Slopes down", up: "Slopes up", across: "Slopes across" };
/** The named slope bands (a % slope: 1 m of fall over 100 m is 1%). */
export const BANDS: { max: number; label: string; hint: string }[] = [
  { max: 3, label: "Flat", hint: "under 3%" }, { max: 8, label: "Gentle", hint: "3–8%" },
  { max: 15, label: "Moderate", hint: "8–15%" }, { max: Infinity, label: "Steep", hint: "15% and over" },
];
export const band = (pct: number) => BANDS.find((b) => pct < b.max) ?? BANDS[BANDS.length - 1];
export const ZONES: [string, string][] = [["NRZ", "Neighbourhood Residential"], ["GRZ", "General Residential"],
  ["RGZ", "Residential Growth"], ["MUZ", "Mixed Use"]];

export function useBlockPrefs() {
  return useQuery({ queryKey: ["block-prefs"], queryFn: () => api<BlockPrefs>("/api/blocks/prefs"), staleTime: 60_000 });
}
export function useBlockSuburbs(enabled = true) {
  return useQuery({
    queryKey: ["block-suburbs"], queryFn: () => api<BlockSuburb[]>("/api/blocks/suburbs"), enabled,
    // While one is being downloaded and measured, keep checking.
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === "pending" || s.status === "running") ? 5000 : false),
  });
}

/** "Box Hill North" from Vicmap's "BOX HILL NORTH". */
export const suburbName = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
/** A height to one decimal place (the diagram and the words use this one, so they always agree). */
const m = (n: number) => `${(Math.round(Math.abs(n) * 10) / 10).toFixed(1).replace(/\.0$/, "")} m`;

/** "Falls 2.4 m to the back", "Rises 1.1 m to the back", "Level". */
export function fallText(b: Pick<Block, "fall_m" | "direction">): string | null {
  if (b.fall_m == null || b.direction == null) return null;
  if (Math.abs(b.fall_m) < 0.2) return "Level front to back";
  return `${b.fall_m < 0 ? "Falls" : "Rises"} ${m(b.fall_m)} to the back`;
}
/** Across the block, looking from the street: the pairs are left minus right, so positive falls to the right. */
export function acrossText(b: Pick<Block, "cross_fall_m">): string | null {
  if (b.cross_fall_m == null) return null;
  if (Math.abs(b.cross_fall_m) < 0.2) return "Level side to side";
  return `Falls ${m(b.cross_fall_m)} to the ${b.cross_fall_m > 0 ? "right" : "left"}`;
}
/** "Gentle · slopes down 4.5%", for a badge. */
export function inclineText(b: Pick<Block, "incline_pct" | "direction">): string | null {
  if (b.incline_pct == null || b.direction == null) return null;
  if (b.direction === "level") return `Level · ${b.incline_pct}%`;
  return `${band(b.incline_pct).label} · ${DIRECTION_SHORT[b.direction].toLowerCase()} ${b.incline_pct}%`;
}
export function shapeText(b: Pick<Block, "battleaxe" | "regularity">): string {
  const r = b.regularity ?? 0;
  return b.battleaxe ? "Battle-axe" : r >= 0.9 ? "Regular" : r >= 0.75 ? "Slightly irregular" : "Irregular";
}

/** The zone family a subdivision rule is set for: "GRZ1" → "GRZ". */
export const zoneFamily = (code: string | null | undefined) => (code ? code.replace(/[^A-Za-z]/g, "") || null : null);

/** The same rules as the server (api/app/blocks.py), so the map can apply preferences being tried out. */
export function splitLots(b: { area_m2?: number | null; frontage_m?: number | null; battleaxe?: boolean; is_unit?: boolean; zone_code?: string | null },
                          p: BlockPrefs): number {
  const smallest = p.split?.[zoneFamily(b.zone_code) ?? ""];
  if (!smallest || b.is_unit || !b.area_m2) return 0;
  if ((b.frontage_m ?? 0) < p.split_frontage && !b.battleaxe) return 1;
  return Math.min(Math.floor(b.area_m2 / smallest), 9);
}

/** Whether a block meets the preferences: true, false, or null when its slope isn't known (as the server's fits()). */
export function fitsBlock(b: Pick<Block, "is_unit" | "area_m2" | "incline_pct" | "direction">, p: BlockPrefs): boolean | null {
  if (b.is_unit && !p.include_units) return false;
  if (b.area_m2 == null || b.area_m2 < p.min_m2 || b.area_m2 > p.max_m2) return false;
  if (b.incline_pct == null) return null;
  return b.incline_pct <= p.max_incline && b.direction != null && p.directions.includes(b.direction);
}

/** Why a block falls outside the preferences (empty when it fits; null slope is reported as unknown, not a reason). */
export function whyNot(b: Pick<Block, "is_unit" | "area_m2" | "incline_pct" | "direction">, p: BlockPrefs): string[] {
  const out: string[] = [];
  if (b.is_unit && !p.include_units) out.push("A unit's shared lot");
  if (b.area_m2 != null && b.area_m2 < p.min_m2) out.push(`Under ${p.min_m2.toLocaleString()} m²`);
  if (b.area_m2 != null && b.area_m2 > p.max_m2) out.push(`Over ${p.max_m2.toLocaleString()} m²`);
  if (b.incline_pct != null && b.incline_pct > p.max_incline) out.push(`Steeper than ${p.max_incline}%`);
  if (b.direction && b.direction !== "level" && !p.directions.includes(b.direction)) out.push(DIRECTIONS.find(([d]) => d === b.direction)![1]);
  if (b.direction === "level" && !p.directions.includes("level")) out.push("Level");
  return out;
}

/** The drop across a block as a section from the street to the back fence: the ground from the nine heights measured
 *  along the middle, the street's level as a dashed line, and the fall marked at the back. Heights are drawn taller
 *  than they are (said underneath) so a gentle slope still reads. */
export function FallDiagram({ b, compact = false }: { b: Pick<Block, "profile" | "depth_m" | "fall_m">; compact?: boolean }) {
  if (!b.profile || !b.depth_m || b.profile.length < 2) return null;
  const W = 320, H = compact ? 118 : 150, left = 44, right = 46, top = 16, bottom = 30;
  const plotW = W - left - right, plotH = H - top - bottom;
  const depth = b.depth_m, hs = b.profile, n = hs.length;
  const lo = Math.min(0, ...hs), hi = Math.max(0, ...hs), range = hi - lo;
  // Metres per pixel at true scale is depth / plotW. Heights are stretched (up to 10×) until the drop fills most of the
  // box, or squashed if a very steep block wouldn't fit it.
  const trueScale = depth / plotW;
  const ex = range > 0.01 ? Math.min(10, (plotH * 0.8 * trueScale) / range) : 10;
  const perPx = trueScale / ex;
  const mid = (lo + hi) / 2;
  const y = (h: number) => top + plotH / 2 - (h - mid) / perPx;
  const x = (i: number) => left + (0.03 + (0.94 * i) / (n - 1)) * plotW;
  const ground = hs.map((h, i) => `${x(i).toFixed(1)},${y(h).toFixed(1)}`);
  const base = H - bottom + 4;
  const fill = `M${left},${y(hs[0]).toFixed(1)} L${ground.join(" L")} L${left + plotW},${y(hs[n - 1]).toFixed(1)} L${left + plotW},${base} L${left},${base} Z`;
  const fall = b.fall_m ?? hs[n - 1] - hs[0];
  const yFront = y(hs[0]), yBack = y(hs[n - 1]);
  const big = Math.abs(fall) >= 0.2;
  const label = big ? `${fall > 0 ? "+" : "−"}${m(fall)}` : "level";
  return (
    <figure className="fall-diagram">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Section from the street to the back: ${label} over ${Math.round(depth)} m`}>
        <defs>
          <pattern id="soil" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="fd-hatch" />
          </pattern>
        </defs>
        {/* the street, at the front */}
        <rect x={6} y={yFront} width={left - 6} height={6} rx={1} className="fd-street" />
        <text x={(left + 6) / 2} y={yFront - 5} textAnchor="middle" className="fd-small">Street</text>
        <path d={fill} className="fd-ground" />
        <path d={fill} fill="url(#soil)" />
        <polyline points={ground.join(" ")} className="fd-line" />
        {/* the street's level, carried back */}
        <line x1={left} x2={left + plotW} y1={yFront} y2={yFront} className="fd-datum" />
        {/* boundary posts front and back */}
        <line x1={left} x2={left} y1={yFront - 10} y2={base} className="fd-post" />
        <line x1={left + plotW} x2={left + plotW} y1={yBack - 10} y2={base} className="fd-post" />
        <text x={left + 3} y={top - 4} className="fd-small">Front</text>
        <text x={left + plotW - 3} y={top - 4} textAnchor="end" className="fd-small">Back</text>
        {/* the fall, marked at the back */}
        {big && <>
          <line x1={left + plotW + 10} x2={left + plotW + 10} y1={yFront} y2={yBack} className="fd-dim" />
          <line x1={left + plotW + 6} x2={left + plotW + 14} y1={yFront} y2={yFront} className="fd-dim" />
          <line x1={left + plotW + 6} x2={left + plotW + 14} y1={yBack} y2={yBack} className="fd-dim" />
        </>}
        <text x={left + plotW + 16} y={(yFront + yBack) / 2 + 4} className={`fd-fall ${fall < -0.2 ? "down" : fall > 0.2 ? "up" : ""}`}>{label}</text>
        {/* the depth */}
        <line x1={left} x2={left + plotW} y1={H - 12} y2={H - 12} className="fd-dim" />
        <line x1={left} x2={left} y1={H - 16} y2={H - 8} className="fd-dim" />
        <line x1={left + plotW} x2={left + plotW} y1={H - 16} y2={H - 8} className="fd-dim" />
        <text x={left + plotW / 2} y={H - 15} textAnchor="middle" className="fd-small fd-bg">{Math.round(depth)} m deep</text>
      </svg>
      <figcaption className="small muted">{ex > 1.05 ? `Heights drawn ${ex < 2 ? ex.toFixed(1) : Math.round(ex)}× taller than they are.`
        : ex < 0.95 ? "Heights drawn shorter than they are, to fit." : "Drawn to scale."}</figcaption>
    </figure>
  );
}

/** Everything about a block: whether it fits and why not, the drop diagram, and its measures. */
export function BlockFacts({ b, prefs }: { b: Block; prefs: BlockPrefs | undefined }) {
  // Worked out here, so preferences being tried on the map apply to the card too.
  const reasons = prefs ? whyNot(b, prefs) : [];
  const fit = prefs ? fitsBlock(b, prefs) : b.fits;
  const lots = prefs ? splitLots(b, prefs) : b.split_lots;
  const rows: [string, string | null][] = [
    ["Size", b.area_m2 != null ? `${b.area_m2.toLocaleString()} m²` : null],
    ["Frontage", b.frontage_m != null && b.frontage_m > 0 ? `${b.frontage_m} m` : null],
    ["Depth", b.depth_m != null ? `${b.depth_m} m` : null],
    ["Shape", b.regularity != null || b.battleaxe ? shapeText(b) : null],
    ["Incline", b.incline_pct != null ? `${band(b.incline_pct).label}, ${b.incline_pct}%${b.steepest_pct != null && b.steepest_pct > b.incline_pct + 1 ? ` (steepest stretch ${b.steepest_pct}%)` : ""}` : null],
    ["Front to back", fallText(b)],
    ["Side to side", acrossText(b)],
    ["Back faces", b.rear_facing],
    ["Zone", b.zone_code],
    ["Could split", lots >= 2 ? `Into ${lots} lots, under your ${zoneFamily(b.zone_code)} rule` : lots === 1 ? "No: frontage too narrow" : null],
  ];
  return (
    <div className="block-facts">
      <div className="block-fit">
        {b.is_unit ? <span className="pill">Unit lot</span>
          : fit === true ? <span className="pill tone-good">Fits your block preferences</span>
          : fit === false ? <span className="pill tone-warn">Outside your preferences{reasons.length ? `: ${reasons.join(", ").toLowerCase()}` : ""}</span>
          : <span className="pill quiet">Slope unknown</span>}
        {b.direction && <span className={`pill dir-${b.direction}`}>{b.direction === "level" ? "Level" : DIRECTIONS.find(([d]) => d === b.direction)![1]}</span>}
      </div>
      {b.is_unit && <p className="small muted">Units share a strata block, so its size and slope aren't the unit's own.</p>}
      <FallDiagram b={b} />
      <dl className="block-dl">
        {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <p className="small muted">From Vicmap property boundaries and 1–5 m contours: approximate, not a survey.</p>
    </div>
  );
}

/** The block preferences as a form: size range, steepest incline (a named band or a custom %), which ways it may
 *  fall, and units. With `full`, the subdivision rules too (Settings). */
export function PrefsEditor({ value, onChange, full = false }: { value: BlockPrefs; onChange: (p: BlockPrefs) => void; full?: boolean }) {
  const set = (patch: Partial<BlockPrefs>) => onChange({ ...value, ...patch });
  const num = (s: string) => (s.trim() === "" ? 0 : Math.max(0, Number(s.replace(/[^\d.]/g, "")) || 0));
  const presets = [3, 8, 15];
  const custom = !presets.includes(value.max_incline);
  return (
    <div className="block-prefs">
      <div className="bp-row">
        <span className="bp-label">Block size</span>
        <div className="bp-range">
          <input inputMode="numeric" aria-label="Smallest block, m²" value={value.min_m2 || ""} placeholder="0"
            onChange={(e) => set({ min_m2: num(e.target.value) })} />
          <span>to</span>
          <input inputMode="numeric" aria-label="Largest block, m²" value={value.max_m2 || ""} placeholder="any"
            onChange={(e) => set({ max_m2: num(e.target.value) || 1_000_000 })} />
          <span className="muted">m²</span>
        </div>
      </div>
      {value.max_m2 < value.min_m2 && <p className="error small">The largest is below the smallest.</p>}
      <div className="bp-row">
        <span className="bp-label">Steepest incline</span>
        <div className="chips">
          {presets.map((p, i) => (
            <button key={p} className={`chip ${value.max_incline === p ? "on" : ""}`} onClick={() => set({ max_incline: p })}>
              {BANDS[i].label} <span className="muted">{i === 0 ? "<3%" : `≤${p}%`}</span></button>
          ))}
          <label className={`chip bp-custom ${custom ? "on" : ""}`}>
            Custom <input inputMode="decimal" aria-label="Steepest incline, %" value={custom ? value.max_incline : ""} placeholder="%"
              onChange={(e) => set({ max_incline: Math.min(100, num(e.target.value)) })} />%</label>
        </div>
      </div>
      <div className="bp-row">
        <span className="bp-label">Which way it may fall</span>
        <div className="chips">
          {DIRECTIONS.map(([d, label]) => {
            const on = value.directions.includes(d);
            return <button key={d} className={`chip ${on ? "on" : ""}`} aria-pressed={on}
              onClick={() => { const next = on ? value.directions.filter((x) => x !== d) : [...value.directions, d]; if (next.length) set({ directions: next }); }}>
              {label}</button>;
          })}
        </div>
      </div>
      <label className="bp-check"><input type="checkbox" checked={value.include_units} onChange={(e) => set({ include_units: e.target.checked })} />
        <span>Include unit lots <span className="muted small">(a unit's shared strata block)</span></span></label>
      {full && (
        <div className="bp-row">
          <span className="bp-label">Could be split</span>
          <p className="small muted" style={{ margin: 0 }}>The smallest lot a subdivision could make in each zone (blank: never), and the street
            frontage it needs for a driveway beside the house.</p>
          <div className="bp-zones">
            {ZONES.map(([z, name]) => (
              <label key={z}><span>{name} <span className="muted">{z}</span></span>
                <span className="bp-unit"><input inputMode="numeric" value={value.split[z] ?? ""} placeholder="never"
                  onChange={(e) => set({ split: { ...value.split, [z]: e.target.value.trim() ? num(e.target.value) : null } })} /> m²</span></label>
            ))}
            <label><span>Frontage needed</span>
              <span className="bp-unit"><input inputMode="decimal" value={value.split_frontage || ""}
                onChange={(e) => set({ split_frontage: num(e.target.value) })} /> m</span></label>
          </div>
        </div>
      )}
    </div>
  );
}

export const samePrefs = (a: BlockPrefs | null | undefined, b: BlockPrefs | null | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** Add a suburb to analyse: typed (Victoria's suburbs offered as you type, from the address data), or one of the
 *  suburbs your houses are in. */
export function AddSuburb({ have, suggestions }: { have: string[]; suggestions: string[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = name.trim();
  const matches = useQuery({
    queryKey: ["localities", typed.toLowerCase()], enabled: typed.length >= 2, staleTime: Infinity, placeholderData: (prev) => prev,
    queryFn: () => api<{ suburb: string; postcode: string }[]>(`/api/address/localities?q=${encodeURIComponent(typed)}`),
  });
  // One row per suburb (a suburb can have more than one postcode), leaving out ones already analysed.
  const hits = [...new Map((typed.length >= 2 ? matches.data ?? [] : []).map((r) => [r.suburb.toUpperCase(), r])).entries()]
    .filter(([key]) => !have.includes(key)).slice(0, 6);
  const add = async (s: string) => {
    setError(null);
    try {
      await api("/api/blocks/suburbs", { method: "POST", body: { suburb: s.trim() } });
      setName("");
      queryClient.invalidateQueries({ queryKey: ["block-suburbs"] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const offer = [...new Set(suggestions.map((s) => s.toUpperCase()))].filter((s) => !have.includes(s)).slice(0, 6);
  return (
    <div className="stack bk-add" style={{ gap: 8 }}>
      <form className="row bk-add-form" onSubmit={(e) => { e.preventDefault(); if (typed) { add(hits[0] && hits[0][0].toLowerCase().startsWith(typed.toLowerCase()) ? hits[0][0] : typed); setOpen(false); } }}>
        <div className="grow bk-add-field">
          <input placeholder="Suburb, e.g. Rosanna" aria-label="Suburb to analyse" value={name} autoComplete="off"
            role="combobox" aria-expanded={open && hits.length > 0} aria-autocomplete="list"
            onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onChange={(e) => { setName(e.target.value); setOpen(true); }}
            onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} />
          {open && hits.length > 0 && (
            <ul className="bk-add-hits" role="listbox">
              {hits.map(([key, r]) => (
                <li key={key} role="option" aria-selected={false}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { add(key); setOpen(false); }}>
                    {suburbName(r.suburb)} <span className="muted">{r.postcode}</span></button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="primary" disabled={typed.length < 2}>Add</button>
      </form>
      {offer.length > 0 && (
        <div className="chips">
          <span className="small muted">Your houses' suburbs:</span>
          {offer.map((s) => <button key={s} className="chip" onClick={() => add(s)}>+ {suburbName(s)}</button>)}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** A house's block on its Location tab: the card with the drop diagram once its suburb is analysed, else the way to
 *  analyse it. Units and apartments sit on a shared strata block, so for them it says so instead. */
export function HouseBlockCard({ propertyId, suburb, propertyType }: { propertyId: string; suburb: string | null; propertyType: string | null }) {
  const queryClient = useQueryClient();
  const block = useQuery({ queryKey: ["property-block", propertyId], queryFn: () => api<Block | null>(`/api/properties/${propertyId}/block`) });
  const prefs = useBlockPrefs();
  const suburbs = useBlockSuburbs(block.data === null);
  const [error, setError] = useState<string | null>(null);
  const strata = propertyType === "unit" || propertyType === "apartment";
  const theirs = suburbs.data?.find((x) => x.suburb === suburb?.toUpperCase());
  // Once its suburb finishes, fetch the block again.
  const done = theirs?.status === "done";
  const [wasDone, setWasDone] = useState(done);
  if (done !== wasDone) {
    setWasDone(done);
    if (done) queryClient.invalidateQueries({ queryKey: ["property-block", propertyId] });
  }
  if (block.isPending || (strata && !block.data)) return null;
  const add = async () => {
    setError(null);
    try {
      await api("/api/blocks/suburbs", { method: "POST", body: { suburb } });
      queryClient.invalidateQueries({ queryKey: ["block-suburbs"] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card stack house-block">
      <h2>The block</h2>
      {block.data ? <BlockFacts b={block.data} prefs={prefs.data} /> : (
        <>
          <p className="small muted" style={{ margin: 0 }}>
            {theirs?.status === "pending" || theirs?.status === "running" ? `${suburbName(theirs.suburb)} is being analysed: its size, slope and drop will show here in a minute or two.`
              : theirs?.status === "done" ? "No property boundary was found under this house's pin. Check the pin is on the right block."
              : theirs?.status === "error" ? `${suburbName(theirs.suburb)} couldn't be analysed. Try again in Settings → Blocks.`
              : `See the block's size, frontage, slope and which way it falls, measured from Victoria's open map data, by analysing ${suburb ?? "its suburb"}. It also adds every block there to the map's Blocks mode.`}
          </p>
          {!theirs && suburb && <button className="small-btn" style={{ justifySelf: "start" }} onClick={add}>Analyse {suburb}</button>}
          {error && <p className="error small">{error}</p>}
        </>
      )}
    </div>
  );
}
