// Plan the route: pick a day from the week bar, and that day's inspections and auctions become a route in time order:
// where to start, the drive between each stop (from the routing engine), when you'd arrive and whether you'd make it,
// with the map beside it and a button that opens the whole route in Google Maps. Each stop can be skipped and the route
// reworks itself. With houses on the To inspect list, the route is built from them (a switch turns that off), and the
// ones not open that day are listed beside it. Same look as the Inspections page, which it opens from.
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Clock, House, Map as MapIcon, Navigation, Plus, TriangleAlert } from "lucide-react";
import { Fragment, lazy, Suspense, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { minutes } from "../format";
import type { OverviewPlace, OverviewRow } from "../overview/columns";
import type { PlanStop } from "../map/PlanMap";
import { usePeople } from "../people";
import { routeDrives, type Leg } from "../route";
import { at, iso, useMedia, WeekBar, weekLabel, WeekNav } from "../WeekBar";
import { sectionOf, StopCard, type Event } from "./Inspections";

const PlanMap = lazy(() => import("../map/PlanMap"));
type Place = { id: string; kind: string; name: string; lon: number; lat: number };

const DAYS = 90;
const MAX_STOPS = 10;   // what Google Maps takes in one route (with the start and finish)
const STAYS = [10, 15, 20, 30];
const clockFmt = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });
const longDay = new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long" });
const weekdayLong = new Intl.DateTimeFormat("en-AU", { weekday: "long" });
const dayMonthLong = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long" });
const shortDay = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" });
const clock = (t: number | string) => clockFmt.format(new Date(t));
const splitTime = (t: number | string) => { const [h, ap] = clock(t).split(/\s+/); return [h, (ap ?? "").toLowerCase()] as const; };
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* per-device nicety */ } };

export default function Plan() {
  const [params, setParams] = useSearchParams();
  const { active } = usePeople();
  const wide = useMedia("(min-width: 1000px)");
  const events = useQuery({ queryKey: ["inspections", DAYS], queryFn: () => api<Event[]>(`/api/inspections?days=${DAYS}`) });
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: OverviewRow[]; places: OverviewPlace[] }>("/api/overview") });
  const places = useQuery({ queryKey: ["places"], queryFn: () => api<Place[]>("/api/places") });
  const [skip, setSkip] = useState<string[]>([]);
  const [startId, setStartId] = useState(() => stored("housetrack.plan.start") ?? "");
  const [stay, setStay] = useState(() => Number(stored("housetrack.plan.stay")) || 15);
  const [onlyList, setOnlyList] = useState(() => stored("housetrack.plan.onlyList") !== "0");
  const [showMap, setShowMap] = useState(false);

  const rows = new Map((overview.data?.rows ?? []).map((r) => [r.id, r]));
  const listed = (overview.data?.rows ?? []).filter((r) => r.to_inspect);
  const useList = onlyList && listed.length > 0;
  // Still to come, and worth going to: not houses you've been to or passed on (unless they're on To inspect).
  const everything = (events.data ?? []).filter((e) => e.type !== "eoi" && new Date(e.ends_at ?? e.starts_at).getTime() > Date.now()
    && sectionOf(e, rows.get(e.property_id), active) === "main");
  const upcoming = useList ? everything.filter((e) => rows.get(e.property_id)?.to_inspect) : everything;
  const byDay = new Map<string, Event[]>();
  for (const e of upcoming) { const k = iso(new Date(e.starts_at)); byDay.set(k, [...(byDay.get(k) ?? []), e]); }
  const days = [...byDay.keys()].sort();
  const today = iso(new Date());
  // Default: the next Saturday with something on, else the next day with anything.
  const day = params.get("day") ?? days.find((d) => at(d).getDay() === 6) ?? days[0] ?? today;
  const pick = (d: string) => { setParams({ day: d }, { replace: true }); setSkip([]); };

  const onDay = (byDay.get(day) ?? []).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const pinned = (e: Event) => { const r = rows.get(e.property_id); return r?.lat != null && r?.lon != null ? { lon: Number(r.lon), lat: Number(r.lat) } : null; };
  const visits = onDay.filter((e) => !skip.includes(e.id) && pinned(e)).slice(0, MAX_STOPS);
  const start = (places.data ?? []).find((p) => p.id === startId) ?? null;
  const points = [...(start ? [[start.lon, start.lat]] : []), ...visits.map((e) => { const p = pinned(e)!; return [p.lon, p.lat]; })];
  const legs = useQuery({
    queryKey: ["plan-legs", points],
    queryFn: () => api<{ legs: Leg[] }>("/api/plan/legs", { method: "POST", body: { points, mode: "drive" } }),
    enabled: points.length >= 2, staleTime: Infinity, retry: false,
  });
  // Arrival times: leave the start in time for the first opening, then drive, stay, drive…
  const { stops: timing, drives, late, seconds: driving } = routeDrives(visits, legs.data?.legs ?? [], { hasStart: !!start, stay });
  const stopNo = new Map(visits.map((e, i) => [e.id, i + 1]));

  const first = visits[0], last = visits[visits.length - 1];
  const leaveAt = start && first && timing.get(first.id)?.leg ? new Date(first.starts_at).getTime() - timing.get(first.id)!.leg!.duration_s * 1000 : null;
  const doneAt = last && timing.get(last.id) ? Math.max(timing.get(last.id)!.arrive, new Date(last.starts_at).getTime()) + (last.type === "auction" ? 30 : stay) * 60_000 : null;
  const missed = late.size;

  const mapStops: PlanStop[] = [
    ...(start ? [{ lon: start.lon, lat: start.lat, label: start.name, start: true }] : []),
    ...visits.map((e) => ({ ...pinned(e)!, label: e.address, clash: late.has(e.id) })),
  ];
  const mapsUrl = mapStops.length >= 2 ? (() => {
    const pt = (s: PlanStop) => `${s.lat},${s.lon}`;
    const u = new URL("https://www.google.com/maps/dir/");
    u.searchParams.set("api", "1");
    u.searchParams.set("origin", pt(mapStops[0]));
    u.searchParams.set("destination", pt(mapStops[mapStops.length - 1]));
    if (mapStops.length > 2) u.searchParams.set("waypoints", mapStops.slice(1, -1).map(pt).join("|"));
    u.searchParams.set("travelmode", "driving");
    return u.toString();
  })() : null;
  // On the list but not open this day: when they next are, if at all.
  const notToday = useList ? listed.filter((r) => !onDay.some((e) => e.property_id === r.id)).map((r) => ({
    r, next: everything.find((e) => e.property_id === r.id && e.type === "inspection"),
  })) : [];

  const mapBlock = mapStops.length > 0 && <Suspense fallback={<div className="plan-map" />}><PlanMap stops={mapStops} /></Suspense>;
  const cta = mapsUrl && (
    <a className="pl-maps" href={mapsUrl} target="_blank" rel="noreferrer"><Navigation /> Open in Google Maps</a>
  );

  const controls = (
    <div className="pl-controls">
      <label className="pl-field">
        <span>Start</span>
        <select value={start ? startId : ""} onChange={(e) => { setStartId(e.target.value); store("housetrack.plan.start", e.target.value); }}>
          <option value="">The first house</option>
          {(places.data ?? []).filter((p) => p.kind === "destination").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <div className="pl-field">
        <span>Time at each</span>
        <div className="segmented" role="radiogroup" aria-label="Minutes at each stop">
          {STAYS.map((m) => (
            <button key={m} role="radio" aria-checked={stay === m} className={stay === m ? "on" : ""}
              onClick={() => { setStay(m); store("housetrack.plan.stay", String(m)); }}>{m} min</button>
          ))}
        </div>
      </div>
      {listed.length > 0 && (
        <button className={`chip ${useList ? "on" : ""}`} aria-pressed={useList}
          onClick={() => { setOnlyList(!onlyList); store("housetrack.plan.onlyList", onlyList ? "0" : "1"); setSkip([]); }}>
          Only To inspect · {listed.length}</button>
      )}
    </div>
  );

  return (
    <div className="inspections plan">
      <header className="insp-head">
        <div>
          <Link to={`/inspections?day=${day}`} className="pl-back"><ArrowLeft /> Back to inspections</Link>
          <h1>Plan the route</h1>
          <p className="muted">{weekLabel(day)}</p>
        </div>
        <div className="insp-head-actions"><WeekNav day={day} today={today} onPick={pick} /></div>
      </header>

      <WeekBar day={day} today={today} count={(d) => byDay.get(d)?.length ?? 0} onPick={pick} noun="stop" />

      {!wide && controls}

      <div key={day} className="insp-fade">
          <div className="insp-dayhero">
            <div>
              <div className="insp-dayname">{day === today ? "Today" : weekdayLong.format(at(day))}</div>
              <div className="insp-daydate">{day === today ? longDay.format(at(day)) : dayMonthLong.format(at(day))}</div>
            </div>
          </div>
          {visits.length > 0 && (
            <div className="insp-stats">
              <span className="insp-stat">{visits.length} {visits.length === 1 ? "stop" : "stops"}</span>
              {leaveAt != null && <span className="insp-stat"><House />Leave {clock(leaveAt)}</span>}
              {doneAt != null && <span className="insp-stat"><Clock />Done about {clock(doneAt)}</span>}
              {driving > 0 && <span className="insp-stat">about {minutes(driving)} driving</span>}
              {missed > 0 && <span className="insp-stat pl-bad">You'd miss {missed}</span>}
            </div>
          )}
          {onDay.length > MAX_STOPS && <p className="small muted">Google Maps takes up to {MAX_STOPS} stops, so the route stops at the first {MAX_STOPS} you're going to.</p>}

          <div className={`insp-layout ${wide && mapStops.length > 0 ? "" : "no-side"}`}>
          <div>
          {wide && controls}
          {events.isPending ? <p className="muted">Loading…</p> : onDay.length === 0 ? (
            <div className="card insp-empty">
              <Navigation aria-hidden />
              <p>{useList ? "None of the To inspect houses are open on this day." : `Nothing to plan on ${longDay.format(at(day))}.`}</p>
              {days.find((d) => d > day) && <button className="small-btn" onClick={() => pick(days.find((d) => d > day)!)}>Next: {shortDay.format(at(days.find((d) => d > day)!))}</button>}
            </div>
          ) : (
            <ol className="tl">
              {start && (
                <li className="tl-item pl-start">
                  <div className="tl-rail">
                    <span className="tl-time">{leaveAt != null ? <>{splitTime(leaveAt)[0]}<small>{splitTime(leaveAt)[1]}</small></> : ""}</span>
                    <span className="tl-dot start"><House /></span>
                  </div>
                  <div className="pl-startcard"><strong>{start.name}</strong><span className="muted small">{leaveAt != null ? `Leave at ${clock(leaveAt)}` : "Start"}</span></div>
                </li>
              )}
              {onDay.map((e) => {
                const n = stopNo.get(e.id), where = pinned(e), going = n != null, t = timing.get(e.id), drive = drives.get(e.id), r = rows.get(e.property_id);
                return (
                  <Fragment key={e.id}>
                    {drive && going && (
                      <li className={`tl-gap ${drive.level ?? ""}`}>
                        <div className="tl-rail" />
                        <div className="tl-gapbody"><span className="chip">{drive.level ? <TriangleAlert /> : <Navigation />}{drive.text}</span></div>
                      </li>
                    )}
                    <li className={`tl-item ${e.type === "auction" ? "sale" : ""}`}>
                      <div className="tl-rail">
                        <span className="tl-time">{splitTime(e.starts_at)[0]}<small>{splitTime(e.starts_at)[1]}</small></span>
                        <span className={`tl-dot ${going ? "" : "plain"}`} aria-label={going ? `Stop ${n}` : undefined}>{n ?? ""}</span>
                      </div>
                      <StopCard e={e} r={r} people={active} dim={!going}
                        foot={
                          <div className="ic-foot plan">
                            {going && t && (
                              <span className={`pl-arrive ${t.late}`}><Clock />Arrive {clock(Math.max(t.arrive, new Date(e.starts_at).getTime()))}
                                {t.late === "missed" ? ", after it closes" : t.late === "after-start" ? ", after it starts" : ""}</span>
                            )}
                            {!where && <span className="pl-note">Not on the map, so it's left out. <Link to={`/map?pin=${e.property_id}`}>Set the pin</Link></span>}
                            {where && (
                              <button className={`pl-go ${going ? "on" : ""}`} aria-pressed={going}
                                onClick={() => setSkip(going ? [...skip, e.id] : skip.filter((x) => x !== e.id))}>
                                {going ? <><Check />Going</> : <><Plus />Skipped</>}</button>
                            )}
                          </div>
                        } />
                    </li>
                  </Fragment>
                );
              })}
            </ol>
          )}
          {legs.isError && <p className="error small">{(legs.error as Error).message}</p>}
          {!wide && mapStops.length > 0 && (
            <div className="insp-mapphone">
              {showMap ? <div className="insp-map">{mapBlock}</div>
                : <button className="small-btn" onClick={() => setShowMap(true)}><MapIcon /> Show the route on a map</button>}
            </div>
          )}

          <div className="insp-after">
            {notToday.length > 0 && (
              <details className="card insp-fold">
                <summary>To inspect, not open this day <span className="muted">· {notToday.length}</span></summary>
                <ul className="insp-pass-list">
                  {notToday.map(({ r, next }) => (
                    <li key={r.id}>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <Link to={`/p/${r.id}`}>{String(r.address)}</Link> <span className="muted small">{String(r.suburb)}</span>
                        <div className="small muted">{next ? `Next: ${shortDay.format(new Date(next.starts_at))}, ${clock(next.starts_at)}` : "No inspection scheduled"}</div>
                      </div>
                      {next && <button className="small-btn" onClick={() => pick(iso(new Date(next.starts_at)))}>Plan that day</button>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>

        {wide && mapStops.length > 0 && (
          <aside className="insp-side">
            <div className="card insp-mapcard"><h3>Route</h3><div className="insp-map">{mapBlock}</div></div>
            {cta}
          </aside>
        )}
        </div>
      </div>

      {!wide && cta && <div className="pl-cta">{cta}</div>}
    </div>
  );
}
