// The hills on the walk to the station (api/app/walks.py): the ground from the house to the station as a profile,
// the climbing each way rated like a running route, and how it compares with the household's benchmark walks.
// Also the benchmarks' own settings.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AddressHit } from "./api";
import AddressSearch from "./AddressSearch";
import ConfirmButton from "./ConfirmButton";

export type Rating = "Flat" | "Gentle" | "Rolling" | "Hilly" | "Steep";
export type Walk = {
  distance_m: number; heights: number[]; climb_to: number; climb_home: number; steepest_up: number; steepest_down: number;
  start_m: number; end_m: number; rating_to: Rating; rating_home: Rating; rating: Rating; flat_m_to: number; flat_m_home: number;
  climb_per_km: number; contours: "1 m" | "10 m" | null;
} | { error: string };
export type Benchmark = { id: string; name: string; station: string; lon: number; lat: number; walk: Walk | null };
type StationWalk = { station: string | null; walk: Walk | null; pending: boolean; benchmarks: Benchmark[] };

export const RATING_TONE: Record<Rating, string> = { Flat: "yes", Gentle: "yes", Rolling: "maybe", Hilly: "no", Steep: "no" };
const isDone = (w: Walk | null | undefined): w is Extract<Walk, { climb_to: number }> => !!w && "climb_to" in w;
const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
/** Colour of a stretch by its slope (either way). */
const gradeColour = (pct: number) => (pct < 3 ? "#3f9a5a" : pct < 6 ? "#d6b43c" : pct < 10 ? "#e08a35" : "#c9452f");

/** The ground from the house (left) to the station (right), heights stretched to fit, each stretch coloured by its
 *  slope. Heights are every 10 m. */
export function WalkProfile({ walk, from = "House", to }: { walk: Extract<Walk, { climb_to: number }>; from?: string; to: string }) {
  const W = 600, H = 170, left = 40, right = 12, top = 14, bottom = 30;
  const h = walk.heights, n = h.length;
  const lo = Math.min(...h), hi = Math.max(...h);
  const range = Math.max(hi - lo, 10);                      // at least 10 m tall, so a flat walk reads flat
  const base = lo - (range - (hi - lo)) / 2;
  const xOf = (i: number) => left + ((W - left - right) * i) / (n - 1);
  const yOf = (v: number) => top + (H - top - bottom) * (1 - (v - base) / range);
  const area = `${xOf(0)},${H - bottom} ${h.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ")} ${xOf(n - 1)},${H - bottom}`;
  const step = Math.max(1, Math.round(50 / 10));             // colour by 50 m stretches
  const segs: { x1: number; y1: number; x2: number; y2: number; c: string }[] = [];
  for (let i = 0; i < n - 1; i += step) {
    const j = Math.min(i + step, n - 1);
    const pct = Math.abs(h[j] - h[i]) / ((j - i) * 10) * 100;
    segs.push({ x1: xOf(i), y1: yOf(h[i]), x2: xOf(j), y2: yOf(h[j]), c: gradeColour(pct) });
  }
  const ticks = [lo, hi].map((v) => Math.round(v));
  return (
    <svg className="walk-profile" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Height along the walk: ${Math.round(walk.start_m)} m at the house, ${Math.round(walk.end_m)} m at the station; climbs ${Math.round(walk.climb_to)} m going, ${Math.round(walk.climb_home)} m coming home`}>
      <polygon points={area} className="wp-ground" />
      {ticks.map((v) => (
        <g key={v}><line x1={left} x2={W - right} y1={yOf(v)} y2={yOf(v)} className="wp-grid" />
          <text x={left - 6} y={yOf(v) + 4} textAnchor="end" className="wp-label">{v} m</text></g>
      ))}
      {segs.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.c} className="wp-line" />)}
      <circle cx={xOf(0)} cy={yOf(h[0])} r={4} className="wp-end" />
      <circle cx={xOf(n - 1)} cy={yOf(h[n - 1])} r={4} className="wp-end" />
      <text x={left} y={H - 9} className="wp-label">{from}</text>
      <text x={(left + W - right) / 2} y={H - 9} textAnchor="middle" className="wp-label">{km(walk.distance_m / 2)}</text>
      <text x={W - right} y={H - 9} textAnchor="end" className="wp-label">{to} · {km(walk.distance_m)}</text>
    </svg>
  );
}

/** "Hillier than", "about as hilly as" or "less hilly than" a benchmark, by climbing per km both ways. */
export function compareWords(mine: number, theirs: number): string {
  if (!theirs) return mine < 3 ? "about as flat as" : "hillier than";
  const r = mine / theirs;
  return r < 0.85 ? "less hilly than" : r > 1.15 ? "hillier than" : "about as hilly as";
}

function Direction({ label, climb, steepest, rating, flat }: { label: string; climb: number; steepest: number; rating: Rating; flat: number }) {
  return (
    <div className="wd">
      <div className="row" style={{ gap: 8 }}><strong>{label}</strong><span className={`pill ${RATING_TONE[rating]}`}>{rating}</span></div>
      <span className="small">Climbs {Math.round(climb)} m · steepest {steepest}%</span>
      <span className="small muted">Feels like {km(flat)} on the flat</span>
    </div>
  );
}

/** A house's walk to its station: the profile, each direction rated, and the benchmarks beside it. */
export function StationWalkCard({ propertyId }: { propertyId: string }) {
  const { data } = useQuery({
    queryKey: ["station-walk", propertyId], queryFn: () => api<StationWalk>(`/api/properties/${propertyId}/station-walk`),
    refetchInterval: (q) => (q.state.data?.pending ? 5000 : false),
  });
  if (!data?.station) return null;
  const w = data.walk;
  const marks = data.benchmarks.filter((b) => isDone(b.walk)) as (Benchmark & { walk: Extract<Walk, { climb_to: number }> })[];
  const main = marks[0];
  return (
    <div className="card stack walk-card">
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>Walk to {data.station}</h2>
        {isDone(w) && <span className={`pill ${RATING_TONE[w.rating]}`}>{w.rating}</span>}</div>
      {data.pending && <p className="small muted" style={{ margin: 0 }}>Measuring the hills on the way. This takes a moment.</p>}
      {w && !isDone(w) && <p className="small muted" style={{ margin: 0 }}>{w.error}</p>}
      {isDone(w) && <>
        <WalkProfile walk={w} to={data.station} />
        <div className="walk-dirs">
          <Direction label="Going" climb={w.climb_to} steepest={w.steepest_up} rating={w.rating_to} flat={w.flat_m_to} />
          <Direction label="Coming home" climb={w.climb_home} steepest={w.steepest_down} rating={w.rating_home} flat={w.flat_m_home} />
        </div>
        {main && <p className="small" style={{ margin: 0 }}>
          {w.climb_per_km.toFixed(0)} m of climbing per km, {compareWords(w.climb_per_km, main.walk.climb_per_km)} the walk from {main.name} to {main.station}
          {" "}({main.walk.climb_per_km.toFixed(0)} m per km).</p>}
        {marks.length > 0 && <BenchmarkBars mine={w} marks={marks} />}
        <p className="small muted" style={{ margin: 0 }}>Heights from Vicmap {w.contours === "10 m" ? "10 m contours (none finer here), so only a rough guide" : "1 m contours"} along the walking route.
          {" "}<a href="/settings#walks">Benchmarks</a></p>
      </>}
    </div>
  );
}

function BenchmarkBars({ mine, marks }: { mine: Extract<Walk, { climb_to: number }>; marks: (Benchmark & { walk: Extract<Walk, { climb_to: number }> })[] }) {
  const rows = [{ name: "This walk", v: mine.climb_per_km, me: true }, ...marks.map((b) => ({ name: `${b.name} → ${b.station}`, v: b.walk.climb_per_km, me: false }))];
  const max = Math.max(...rows.map((r) => r.v), 1);
  return (
    <div className="walk-bars" role="list" aria-label="Climbing per km, there and back">
      {rows.map((r) => (
        <div key={r.name} className={`wb ${r.me ? "me" : ""}`} role="listitem">
          <span className="wb-name small">{r.name}</span>
          <span className="wb-bar"><i style={{ width: `${Math.max(2, (r.v / max) * 100)}%` }} /></span>
          <span className="wb-v small">{r.v.toFixed(0)} m/km</span>
        </div>
      ))}
    </div>
  );
}

/** Settings: the benchmark walks, the first of which houses are compared with. */
export function WalkBenchmarkSettings() {
  const queryClient = useQueryClient();
  const marks = useQuery({
    queryKey: ["walk-benchmarks"], queryFn: () => api<Benchmark[]>("/api/walk-benchmarks"),
    refetchInterval: (q) => (q.state.data?.some((b) => !b.walk) ? 5000 : false),
  });
  const [hit, setHit] = useState<AddressHit | null>(null);
  const [name, setName] = useState("");
  const [station, setStation] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const near = useQuery({
    queryKey: ["stations-near", hit?.lon, hit?.lat], enabled: !!hit,
    queryFn: () => api<{ osm_id: string; name: string; km: number }[]>(`/api/stations/near?lon=${hit!.lon}&lat=${hit!.lat}`),
  });
  const reload = () => {
    for (const key of [["walk-benchmarks"], ["station-walk"], ["overview"]]) queryClient.invalidateQueries({ queryKey: key });
  };
  const run = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    try { await fn(); reload(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="card stack" id="walks">
      <h2>Walk benchmarks</h2>
      <p className="small muted">Walks to a station you know, to compare each house's walk with. Houses are compared with the first.</p>
      <ul className="bench-list">
        {(marks.data ?? []).map((b, i) => {
          const w = b.walk;
          return (
            <li key={b.id}>
              <div className="grow">
                <strong>{b.name}</strong> <span className="muted">→ {b.station}</span>
                <div className="small muted">{!w ? "Measuring…" : isDone(w)
                  ? `${km(w.distance_m)} · climbs ${Math.round(w.climb_to)} m going, ${Math.round(w.climb_home)} m home · ${w.climb_per_km.toFixed(0)} m per km`
                  : w.error}</div>
              </div>
              {isDone(w) && <span className={`pill ${RATING_TONE[w.rating]}`}>{w.rating}</span>}
              {i === 0 ? <span className="pill quiet">Main</span>
                : <button className="link small" onClick={() => run(() => api(`/api/walk-benchmarks/${b.id}/main`, { method: "POST" }))}>Make main</button>}
              <ConfirmButton className="link small danger-link" label="Remove" question="Remove?" yes="Remove"
                onConfirm={() => run(() => api(`/api/walk-benchmarks/${b.id}`, { method: "DELETE" }))} />
            </li>
          );
        })}
      </ul>
      <div className="stack" style={{ gap: 8 }}>
        <AddressSearch placeholder="Add a benchmark: start typing an address" onPick={(h) => { setHit(h); setName(h.display.replace(/ \d{4}$/, "")); setStation(""); }} />
        {hit && <>
          <div className="grid2">
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>To station
              <select value={station} onChange={(e) => setStation(e.target.value)}>
                <option value="">Nearest{near.data?.[0] ? ` (${near.data[0].name})` : ""}</option>
                {(near.data ?? []).map((s) => <option key={s.osm_id} value={s.osm_id}>{s.name} · {s.km} km</option>)}
              </select></label>
          </div>
          <div className="row">
            <button className="primary" disabled={!name.trim()} onClick={() => run(async () => {
              await api("/api/walk-benchmarks", { method: "POST", body: { name: name.trim(), lon: hit.lon, lat: hit.lat,
                                                                          station_osm_id: station ? Number(station) : null } });
              setHit(null); setName("");
            })}>Add benchmark</button>
            <button className="link" onClick={() => setHit(null)}>Cancel</button>
          </div>
        </>}
      </div>
      {msg && <p className="error small">{msg}</p>}
    </div>
  );
}

/** One line for the map's house panel: the walk's hills and how it compares with the main benchmark. */
export function WalkHillsLine({ propertyId }: { propertyId: string }) {
  const { data } = useQuery({ queryKey: ["station-walk", propertyId], queryFn: () => api<StationWalk>(`/api/properties/${propertyId}/station-walk`) });
  const w = data?.walk;
  if (!isDone(w)) return null;
  const main = data!.benchmarks.find((b) => isDone(b.walk));
  return (
    <div className="tiny muted">
      <span className={`pill ${RATING_TONE[w.rating]}`}>{w.rating}</span> climbs {Math.round(w.climb_to)} m there, {Math.round(w.climb_home)} m home
      {main && isDone(main.walk) ? `, ${compareWords(w.climb_per_km, main.walk.climb_per_km)} ${main.name}` : ""}
    </div>
  );
}
