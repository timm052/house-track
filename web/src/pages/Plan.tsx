// Inspection planner: pick a day, and the day's open-for-inspections and auctions become a route in time
// order, with the drive between each (from the routing engine), when you'd arrive, and any you'd miss. When the
// To inspect list has houses, the route is built from them by default, with the ones not open that day listed below.
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { EVENT_LABEL, minutes } from "../format";
import type { OverviewPlace, OverviewRow } from "../overview/columns";
import type { PlanStop } from "../map/PlanMap";

const PlanMap = lazy(() => import("../map/PlanMap"));
type Event = { type: string; id: string; kind: string; state: string; starts_at: string; ends_at: string | null;
               property_id: string; address: string; suburb: string };
type Place = { id: string; kind: string; name: string; lon: number; lat: number };
type Leg = { distance_m: number; duration_s: number } | null;

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayLabel = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" });
const time = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });
const KIND = EVENT_LABEL;

export default function Plan() {
  const [params, setParams] = useSearchParams();
  const events = useQuery({ queryKey: ["inspections", 14], queryFn: () => api<Event[]>("/api/inspections?days=14") });
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: OverviewRow[]; places: OverviewPlace[] }>("/api/overview") });
  const places = useQuery({ queryKey: ["places"], queryFn: () => api<Place[]>("/api/places") });
  const [skip, setSkip] = useState<string[]>([]);
  const [startId, setStartId] = useState("");
  const [stay, setStay] = useState(15);

  const byId = new Map((overview.data?.rows ?? []).map((r) => [r.id, r]));
  const listed = (overview.data?.rows ?? []).filter((r) => r.to_inspect);
  const [onlyList, setOnlyList] = useState(() => { try { return localStorage.getItem("housetrack.plan.onlyList") !== "0"; } catch { return true; } });
  const useList = onlyList && listed.length > 0;
  const flipList = () => { try { localStorage.setItem("housetrack.plan.onlyList", onlyList ? "0" : "1"); } catch { /* ignore */ } setOnlyList(!onlyList); setSkip([]); };
  const allUpcoming = (events.data ?? []).filter((e) => e.type !== "eoi" && new Date(e.ends_at ?? e.starts_at).getTime() > Date.now());
  const upcoming = useList ? allUpcoming.filter((e) => byId.get(e.property_id)?.to_inspect) : allUpcoming;
  const days = [...new Set(upcoming.map((e) => dayKey(new Date(e.starts_at))))].sort();
  // Default: the next Saturday with something on, else the next day with anything.
  const day = params.get("day") ?? days.find((d) => new Date(`${d}T12:00`).getDay() === 6) ?? days[0];
  const onDay = upcoming.filter((e) => dayKey(new Date(e.starts_at)) === day).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const pinned = (e: Event) => { const r = byId.get(e.property_id); return r?.lat != null && r?.lon != null ? { lon: Number(r.lon), lat: Number(r.lat) } : null; };
  const visits = onDay.filter((e) => !skip.includes(e.id) && pinned(e));
  const start = (places.data ?? []).find((p) => p.id === startId) ?? null;
  const points = [...(start ? [[start.lon, start.lat]] : []), ...visits.map((e) => { const p = pinned(e)!; return [p.lon, p.lat]; })];
  const legs = useQuery({
    queryKey: ["plan-legs", points],
    queryFn: () => api<{ legs: Leg[] }>("/api/plan/legs", { method: "POST", body: { points, mode: "drive" } }),
    enabled: points.length >= 2, staleTime: Infinity, retry: false,
  });

  // Arrival times: leave the start in time for the first opening, then drive, stay, drive…
  const timeline = useMemo(() => {
    const out = new Map<string, { arrive: number; leg: Leg; late: "no" | "after-start" | "missed" }>();
    const legList = legs.data?.legs ?? [];
    let clock: number | null = null;
    visits.forEach((e, i) => {
      const opens = new Date(e.starts_at).getTime(), closes = new Date(e.ends_at ?? e.starts_at).getTime();
      const leg = start ? legList[i] ?? null : i > 0 ? legList[i - 1] ?? null : null;
      const drive = leg ? leg.duration_s * 1000 : 0;
      const arrive: number = clock == null ? opens : clock + drive;
      const late = arrive > closes ? "missed" : arrive > opens + 5 * 60_000 ? "after-start" : "no";
      out.set(e.id, { arrive, leg: i === 0 && !start ? null : leg, late });
      clock = Math.max(arrive, opens) + (e.type === "auction" ? 30 : stay) * 60_000;
    });
    return out;
  }, [visits, legs.data, start, stay]);

  const stops: PlanStop[] = [
    ...(start ? [{ lon: start.lon, lat: start.lat, label: start.name, start: true }] : []),
    ...visits.map((e) => ({ ...pinned(e)!, label: e.address, clash: timeline.get(e.id)?.late === "missed" })),
  ];
  const mapsUrl = stops.length >= 2 ? (() => {
    const at = (s: PlanStop) => `${s.lat},${s.lon}`;
    const u = new URL("https://www.google.com/maps/dir/");
    u.searchParams.set("api", "1");
    u.searchParams.set("origin", at(stops[0]));
    u.searchParams.set("destination", at(stops[stops.length - 1]));
    if (stops.length > 2) u.searchParams.set("waypoints", stops.slice(1, -1).map(at).join("|"));
    u.searchParams.set("travelmode", "driving");
    return u.toString();
  })() : null;
  const missed = [...timeline.values()].filter((t) => t.late === "missed").length;
  // On the list but not open this day: when they next are, if at all.
  const notToday = useList ? listed.filter((r) => !onDay.some((e) => e.property_id === r.id)).map((r) => ({
    r, next: allUpcoming.find((e) => e.property_id === r.id && e.type === "inspection"),
  })) : [];

  return (
    <div style={{ marginTop: 12 }}>
      <h1>Plan the inspections</h1>
      <p className="small muted">A day's inspections in order, with drive and arrival times. Drives assume no traffic.</p>
      {listed.length > 0 && (
        <label className="check small plan-only"><input type="checkbox" checked={onlyList} onChange={flipList} />
          Only houses on To inspect ({listed.length})</label>
      )}
      {events.isPending ? <p className="muted">Loading…</p> : days.length === 0 ? (
        <div className="card empty">{useList ? "None of the To inspect houses are open in the next two weeks." : "No inspections in the next two weeks."}</div>
      ) : (
        <>
          <div className="chips" aria-label="Day">
            {days.map((d) => {
              const n = upcoming.filter((e) => dayKey(new Date(e.starts_at)) === d).length;
              return <button key={d} className={`chip ${d === day ? "on" : ""}`} onClick={() => { setParams({ day: d }); setSkip([]); }}>
                {dayLabel.format(new Date(`${d}T12:00`))} · {n}</button>;
            })}
          </div>
          <div className="filter-bar">
            <select value={startId} onChange={(e) => setStartId(e.target.value)} aria-label="Start from">
              <option value="">Start at the first house</option>
              {(places.data ?? []).filter((p) => p.kind === "destination").map((p) => <option key={p.id} value={p.id}>Start from {p.name}</option>)}
            </select>
            <select value={stay} onChange={(e) => setStay(Number(e.target.value))} aria-label="Minutes at each">
              {[10, 15, 20, 30].map((m) => <option key={m} value={m}>{m} min at each</option>)}
            </select>
            {mapsUrl && <a className="button-like small-btn" href={mapsUrl} target="_blank" rel="noreferrer">Open in Google Maps</a>}
            <span className={`small grow ${missed ? "tone-bad" : "muted"}`} style={{ textAlign: "right" }}>
              {visits.length} {visits.length === 1 ? "stop" : "stops"}{missed ? ` · you'd miss ${missed}` : ""}
            </span>
          </div>
          <div className="plan-grid">
            <ol className="plan-list">
              {start && <li className="plan-start"><span className="plan-num">●</span><div><strong>{start.name}</strong><div className="small muted">Start</div></div></li>}
              {onDay.map((e) => {
                const t = timeline.get(e.id), off = skip.includes(e.id), where = pinned(e);
                const n = visits.indexOf(e) + 1;
                return (
                  <li key={e.id} className={`${off || !where ? "off" : ""} ${t?.late === "missed" ? "missed" : ""}`}>
                    <span className="plan-num">{n > 0 ? n : "–"}</span>
                    <div className="grow">
                      {t?.leg && <div className="plan-leg small muted">{minutes(t.leg.duration_s)} drive · {(t.leg.distance_m / 1000).toFixed(1)} km</div>}
                      {t?.leg === null && (n > 1 || start) && !off && legs.isFetched && <div className="plan-leg small muted">No drive time</div>}
                      <div><strong>{time.format(new Date(e.starts_at))}{e.ends_at && `–${time.format(new Date(e.ends_at))}`}</strong> {KIND[e.kind] ?? "Inspection"}</div>
                      <div><Link to={`/p/${e.property_id}`}>{e.address.split(",")[0]}</Link> <span className="muted small">{e.suburb}</span></div>
                      {!where && <div className="small tone-warn">Not on the map, so it's not in the route. <Link to={`/map?pin=${e.property_id}`}>Set the pin</Link></div>}
                      {t && !off && (
                        <div className={`small ${t.late === "missed" ? "tone-bad" : t.late === "after-start" ? "tone-warn" : "tone-good"}`}>
                          {t.late === "missed" ? `You'd get there at ${time.format(t.arrive)}, after it closes` : `Arrive ${time.format(t.arrive)}`}
                        </div>
                      )}
                    </div>
                    {where && <label className="check small"><input type="checkbox" checked={!off}
                      onChange={() => setSkip(off ? skip.filter((x) => x !== e.id) : [...skip, e.id])} /> Go</label>}
                  </li>
                );
              })}
            </ol>
            <div>
              {legs.isError && <p className="error small">{(legs.error as Error).message}</p>}
              {stops.length > 0 && <Suspense fallback={<div className="plan-map" />}><PlanMap stops={stops} /></Suspense>}
              {notToday.length > 0 && (
                <div className="card plan-not-today">
                  <h3>To inspect, not open this day</h3>
                  <ul className="history small">
                    {notToday.map(({ r, next }) => (
                      <li key={r.id}><Link to={`/p/${r.id}`}>{String(r.address)}</Link> <span className="muted">{String(r.suburb)}</span>
                        <div className="muted">{next ? `Next: ${dayLabel.format(new Date(next.starts_at))}, ${time.format(new Date(next.starts_at))}`
                          : "No inspection scheduled"}</div></li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
