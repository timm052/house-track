// The map's house panel, with enough about the house to judge it without leaving the map: photo, price and sale (as
// on the house card), rooms, commute times (the nearest station's routes are drawn on the map), verdicts with their
// notes, the next inspection, the agent and any flags. A side bar on wide screens; on phones a sheet over the bottom
// of the map that shows just its summary at first, so the map stays in view, and drags up for the rest.
import { useQuery } from "@tanstack/react-query";
import { Bath, BedDouble, Building2, Car, ExternalLink, LandPlot, MapPin, Mountain, Timer, UserRound, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import Commute from "../Commute";
import { api, type MapProperty, type PropertyDetail } from "../api";
import { budgetTone, changeTone, soonTone, STATUS_COLOUR, tagStyle, useTagColours } from "../colour";
import { isSold, km, LABEL, landArea, money, moneyRange, saleWhen, when } from "../format";
import SoldAgainst from "../SoldAgainst";
import { heightAt } from "./terrain";
import type { OverviewRow } from "../overview/columns";
import { usePeople } from "../people";

/** A sale the agent compared this house with (from its Statement of Information, or entered by hand). Not a house
 *  we track: it's only drawn while its house is selected. */
export type Comparable = { id: string; source: string; address: string; sold_price_aud: number | null; sold_on: string | null;
  beds: number | null; baths: number | null; car_spaces: number | null; land_m2: number | null; sale_method: string | null;
  lon: number | null; lat: number | null };

/** The selected house's comparable sales (the house page's cache and the map share them). */
export function useComparables(propertyId: string | null) {
  const { data: d } = useQuery({
    queryKey: ["property", propertyId], enabled: !!propertyId,
    queryFn: () => api<PropertyDetail>(`/api/properties/${propertyId}`),
  });
  const c = d?.campaigns.find((x) => !x.outcome) ?? d?.campaigns[0] ?? null;
  return useQuery({
    queryKey: ["comparables", c?.id], enabled: !!c,
    queryFn: () => api<{ entered: Comparable[] }>(`/api/campaigns/${c!.id}/comparables`).then((r) => r.entered),
  });
}

const monthYear = new Intl.DateTimeFormat("en-AU", { month: "short", year: "numeric" });
export const comparableLabel = (x: Comparable) =>
  [x.sold_price_aud != null ? money(x.sold_price_aud) : null, x.sold_on ? monthYear.format(new Date(x.sold_on)) : null].filter(Boolean).join(" · ");

export type RouteLeg = { distance_m: number | null; duration_s: number | null; geometry: GeoJSON.LineString | null };
export type StationRoute = { station: { name: string; lon: number; lat: number }; walk: RouteLeg; drive: RouteLeg };

const countdown = (at: string | null) => {
  if (!at) return null;
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400_000);
  return days < 0 ? null : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
};
// ─── the phone sheet ────────────────────────────────────────────────
const PHONE = "(max-width: 799px)";
const REDUCED_MOTION = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
type Stop = "peek" | "half" | "full";

export function usePhone() {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(PHONE).matches);
  useEffect(() => {
    const m = window.matchMedia(PHONE), on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

/** The sheet's three stops, as heights showing: its summary (peek), half the map, or nearly all of it. */
function stopsFor(sheet: HTMLElement, grab: HTMLElement): Record<Stop, number> {
  const area = sheet.parentElement?.clientHeight ?? window.innerHeight;
  const full = Math.max(grab.offsetHeight + 120, area - 64);
  return { peek: Math.min(grab.offsetHeight, full), half: Math.min(full, Math.max(grab.offsetHeight + 120, Math.round(area * 0.55))), full };
}

/** A phone's bottom sheet. Its top (handle and summary) drags it: it follows the finger with nothing smoothed, and on
 *  letting go it settles on the nearest stop, or the next one on in the direction of a flick (over 0.35 px/ms, and not
 *  after a rest of 60 ms), over
 *  180 to 360 ms depending on distance (easing.decelerate). A new touch catches it wherever it is. Dragged well below
 *  its summary, it closes. Moves under the touch slop (8 px) are taps, so its buttons still work. */
function useSheet(sheet: RefObject<HTMLElement | null>, grab: RefObject<HTMLElement | null>, phone: boolean,
                  onClose: () => void, onHeight?: (px: number, stop: Stop) => void) {
  const [stop, setStop] = useState<Stop>("peek");
  const g = useRef<{ id: number; y: number; from: number; moved: boolean; samples: { y: number; t: number }[] } | null>(null);
  const full = () => (sheet.current && grab.current ? stopsFor(sheet.current, grab.current).full : 0);
  const showing = () => {   // how much shows right now, mid-animation included
    const el = sheet.current;
    return el ? full() - new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 : 0;
  };
  const place = (px: number, animate: boolean) => {
    const el = sheet.current;
    if (!el) return;
    const distance = Math.abs(px - showing()), ms = Math.round(Math.min(360, 180 + distance * 0.4));
    el.style.height = `${full()}px`;
    el.style.transition = animate && !REDUCED_MOTION ? `transform ${ms}ms cubic-bezier(0, 0, 0.2, 1)` : "none";
    el.style.transform = `translateY(${full() - px}px)`;
    return ms;
  };
  const settle = (to: Stop) => {
    const el = sheet.current, handle = grab.current;
    if (!el || !handle) return;
    const px = stopsFor(el, handle)[to];
    place(px, true);
    el.style.setProperty("--sheet-body", `${Math.max(0, px - handle.offsetHeight)}px`);
    setStop(to);
    onHeight?.(px, to);
  };

  const stopRef = useRef(stop);
  stopRef.current = stop;
  // Opening slides it up from below to its summary; a new house, or turning the phone, settles it again.
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!phone || !el) { if (el) { el.style.cssText = ""; } onHeight?.(0, "peek"); return; }
    place(0, false);
    void el.offsetHeight;   // start from below before sliding up
    settle("peek");
    const onResize = () => settle(stopRef.current);
    window.addEventListener("resize", onResize);
    // The summary grows as the house's details and photo arrive: its stop grows with it, so the buttons stay in view.
    let seen = grab.current?.offsetHeight ?? 0;
    const ro = new ResizeObserver(() => {
      const h = grab.current?.offsetHeight ?? 0;
      if (h !== seen && !g.current) { seen = h; settle(stopRef.current); }
    });
    if (grab.current) ro.observe(grab.current);
    return () => { window.removeEventListener("resize", onResize); ro.disconnect(); };
  }, [phone]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlers = phone ? {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const now = showing();
      place(now, false);   // catch it where it is
      g.current = { id: e.pointerId, y: e.clientY, from: now, moved: false, samples: [{ y: e.clientY, t: e.timeStamp }] };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = g.current;
      if (!d || d.id !== e.pointerId || !sheet.current || !grab.current) return;
      const up = d.y - e.clientY;
      if (!d.moved) {
        if (Math.abs(up) < (e.pointerType === "touch" ? 8 : 4)) return;
        d.moved = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* already gone */ }
      }
      const s = stopsFor(sheet.current, grab.current);
      let px = d.from + up;
      if (px > s.full) px = s.full + (px - s.full) * 0.2;   // resist past the top
      place(Math.max(0, px), false);
      d.samples.push({ y: e.clientY, t: e.timeStamp });
      while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > 100) d.samples.shift();
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = g.current;
      g.current = null;
      if (!d || !sheet.current || !grab.current) return;
      if (!d.moved) { settle(stop); return; }   // a tap: put it back, let the click through
      const first = d.samples[0], last = d.samples[d.samples.length - 1];
      // px/ms, upward positive; none if the finger rested before letting go
      const flick = last.t > first.t && e.timeStamp - last.t < 60 ? (first.y - last.y) / (last.t - first.t) : 0;
      const s = stopsFor(sheet.current, grab.current), now = showing();
      if (now < s.peek * 0.6 || (flick < -0.35 && now < s.peek)) {   // pulled down off its summary: close
        const ms = place(0, true) ?? 0;
        window.setTimeout(onClose, ms);
        return;
      }
      const order: Stop[] = ["peek", "half", "full"];
      const to = Math.abs(flick) > 0.35
        ? (flick > 0 ? order.find((k) => s[k] > now + 4) ?? "full" : [...order].reverse().find((k) => s[k] < now - 4) ?? "peek")
        : order.reduce((a, b) => (Math.abs(s[b] - now) < Math.abs(s[a] - now) ? b : a));
      settle(to);
    },
    onPointerCancel: () => { g.current = null; settle(stop); },
  } : {};
  const toggle = () => settle(stop === "peek" ? "half" : "peek");
  return { stop, handlers, toggle, settle };
}

/** A verdict's note (the map's summary verdicts have none; the house's full ones do). */
const noteOf = (v: unknown): string | null => (v && typeof v === "object" && "note" in v && typeof v.note === "string" && v.note ? v.note : null);

export default function HouseSidePanel({ p, route, routeError, onClose, onTravel, onSheetHeight }: {
  p: MapProperty; route?: StationRoute; routeError?: Error | null; onClose: () => void;
  onTravel: () => void;                      // show travel times from this house on the map
  onSheetHeight?: (px: number, stop: Stop) => void;   // how much of the map a phone's sheet covers, to keep the house clear of it
}) {
  const phone = usePhone();
  const sheet = useRef<HTMLElement>(null), grab = useRef<HTMLDivElement>(null);
  const { stop, handlers, toggle, settle } = useSheet(sheet, grab, phone, onClose, onSheetHeight);
  // Another house picked while it's open: back to its summary, so the map shows where it is.
  useEffect(() => { if (phone) settle("peek"); }, [p.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { active, byId } = usePeople();
  const tagColours = useTagColours();
  // The same data (and cache) as the house page, kept fresh while travel times are being worked out.
  const { data: d } = useQuery({
    queryKey: ["property", p.id], queryFn: () => api<PropertyDetail>(`/api/properties/${p.id}`),
    refetchInterval: (q) => (q.state.data?.travel.pending ? 4000 : false),
  });
  const c = d?.campaigns.find((x) => !x.outcome) ?? d?.campaigns[0] ?? null;
  const guide = c?.price_guides[0];
  const next = d?.inspections.filter((i) => new Date(i.starts_at).getTime() > Date.now()).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const verdict = (personId: string) => {
    const mine = (d?.opinions ?? p.opinions).filter((o) => o.person_id === personId);
    return mine.find((o) => o.stage === "post_inspection") ?? mine.find((o) => o.stage === "pre_inspection");
  };
  const walkS = route?.walk.duration_s ?? p.nearest_station_walk_s, driveS = route?.drive.duration_s ?? p.nearest_station_drive_s ?? null;
  const cover = p.cover_id ?? d?.cover_id ?? null;
  // The house list's row for this house (days listed, guide change, budget, score), from the shared cache.
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: OverviewRow[] }>("/api/overview") });
  const { data: elevation } = useQuery({ queryKey: ["height", d?.lon, d?.lat], enabled: d?.lat != null && d?.lon != null, staleTime: Infinity,
    queryFn: () => heightAt(d!.lon!, d!.lat!) });
  const row = overview.data?.rows.find((r) => r.id === p.id);
  const num = (k: string) => (row?.[k] == null ? null : Number(row[k]));
  const change = num("guide_change"), score = num("score_avg"), days = num("days_on_market");
  const walkAway = c?.judgements.find((j) => j.kind === "walk_away");
  const lead = c?.agents.find((a) => a.is_lead) ?? c?.agents[0];
  const soon = c && !c.outcome ? countdown(c.sale_method === "auction" ? c.auction_at : c.sale_method === "eoi" ? c.eoi_closes_at : null) : null;
  const comparables = useComparables(p.id).data ?? [];

  return (
    <aside ref={sheet} className={`map-side stop-${stop}`} aria-label={`About ${d?.address ?? "this house"}`}>
      <button className="map-side-close" aria-label="Close" onClick={onClose}><X /></button>
      <div ref={grab} className="map-side-grab" {...handlers}>
        <button className="map-side-handle" aria-label={stop === "peek" ? "Show more" : "Show less"} aria-expanded={stop !== "peek"} onClick={toggle} />
        {cover && <Link to={`/p/${p.id}`} className="map-side-photo"><img src={`/api/attachments/${cover}/thumb`} alt="" draggable={false} /></Link>}
        <div className="map-side-summary">
          {cover && <img className="map-side-thumb" src={`/api/attachments/${cover}/thumb`} alt="" draggable={false} />}
          <div className="map-side-head">
            <h2>{d ? d.address.split(",")[0] : "…"}</h2>
            <div className="small map-side-sub">
              <span className="muted">{p.suburb}</span>
              <span className="pill status-pill"><span className="status-dot" style={{ background: STATUS_COLOUR[p.status] }} />{LABEL.status[p.status]}</span>
            </div>
            {c && (
              <div className="map-side-quick">
                <strong>{isSold(c.outcome) && c.sold_price_aud != null ? money(c.sold_price_aud) : guide ? moneyRange(guide.low_aud, guide.high_aud) : "No guide yet"}</strong>
                <span className="small muted"> · {c.outcome ? LABEL.outcome[c.outcome] : saleWhen(c)}</span>
                {soon && <span className={`pill tone-${soonTone(c.sale_method === "auction" ? c.auction_at : c.eoi_closes_at)}`}>{soon}</span>}
              </div>
            )}
          </div>
        </div>
        <div className="map-side-primary">
          <Link to={`/p/${p.id}`}><button className="primary"><ExternalLink /> Open the house</button></Link>
          <button onClick={onTravel} title="Shade how far you can get from here"><Timer /> Travel time</button>
        </div>
      </div>
      <div className="map-side-body">
        {c && (
          <section className="map-side-price">
            {isSold(c.outcome) && c.sold_price_aud != null && (
              <SoldAgainst sold={c.sold_price_aud} firstLow={num("first_guide_low")} firstHigh={num("first_guide_high")}
                ours={c.judgements.find((j) => j.kind === "expected_sale")?.amount_aud ?? null} />
            )}
            {!isSold(c.outcome) && <div className="row small" style={{ gap: 6 }}>
              {change != null && change !== 0 && <span className={`pill tone-${changeTone(change)}`}>guide {change > 0 ? "↑" : "↓"} {money(Math.abs(change))}</span>}
              {(row?.budget === "over" || row?.budget === "stretch") && (
                <span className={`pill tone-${budgetTone(row.budget)}`}>{row.budget === "over" ? "Over budget" : "Stretch"}</span>)}
              {walkAway && <span className="pill">our max {money(walkAway.amount_aud)}</span>}
            </div>}
            {days != null && <div className="tiny muted">Listed {days} {days === 1 ? "day" : "days"}</div>}
          </section>
        )}

        {d && (
          <div className="map-side-facts small">
            {d.beds != null && <span><BedDouble /> {d.beds}</span>}
            {d.baths != null && <span><Bath /> {d.baths}</span>}
            {d.car_spaces != null && <span><Car /> {d.car_spaces}</span>}
            {d.land_m2 != null && <span><LandPlot /> {landArea(d.land_m2)}</span>}
            {d.building_m2 != null && <span><Building2 /> {d.building_m2.toLocaleString()} m²</span>}
            <span className="muted">{d.property_type[0].toUpperCase() + d.property_type.slice(1)}{d.build_status !== "established" ? `, ${d.build_status.replace(/_/g, " ")}` : ""}</span>
            {elevation != null && <span title="Height above sea level, from 30 m survey data"><Mountain /> about {Math.round(elevation)} m</span>}
          </div>
        )}

        {(p.excluded || p.warned || p.others_flags.length > 0) && (
          <section className="small">
            {p.excluded && <div className="tone-bad">Excluded by you: {p.reasons.join(", ")}</div>}
            {!p.excluded && p.warned && <div className="tone-warn">Warning: {p.reasons.join(", ")}</div>}
            {p.others_flags.map((f, i) => (
              <div key={i} className="muted"><span className="dot" style={{ background: byId.get(f.owner_id)?.colour }} />
                {byId.get(f.owner_id)?.display_name} {f.kind === "hard_exclude" ? "excludes" : "warns about"} this: {f.name}</div>
            ))}
          </section>
        )}

        <section>
          <div className="section-title">Commute times</div>
          {d ? (
            <Commute travel={d.travel}
              station={p.nearest_station ? { name: route?.station.name ?? p.nearest_station, walk_s: walkS ?? null, drive_s: driveS } : null}
              stationNote={<>
                {route?.walk.distance_m != null && <div className="tiny muted">{km(route.walk.distance_m)} walk to the station, drawn on the map</div>}
                {routeError && <div className="tiny muted">Couldn't draw the route: {routeError.message}</div>}
              </>} />
          ) : <div className="small muted">…</div>}
        </section>

        {comparables.length > 0 && (
          <section>
            <div className="section-title">Comparable sales</div>
            <div className="small map-side-comps">
              {comparables.map((x) => (
                <div key={x.id}>
                  <span className="comp-key" aria-hidden />
                  <span className="grow">{x.address.split(",")[0]}
                    <span className="muted">{[x.beds != null && `${x.beds} bed`, x.land_m2 != null && landArea(x.land_m2), x.sale_method].filter(Boolean).map((t) => ` · ${t}`).join("")}</span>
                    {x.lon == null && <span className="muted tiny"> (not on the map)</span>}</span>
                  <strong>{comparableLabel(x)}</strong>
                </div>
              ))}
            </div>
            <div className="tiny muted">{comparables.some((x) => x.source === "price_statement") ? "From the Statement of Information. " : ""}
              Shown as hollow markers while this house is selected.</div>
          </section>
        )}

        <section>
          <div className="section-title">Verdicts{score != null && <span className="pill score-pill" style={{ marginLeft: 8 }}>Score {score}</span>}</div>
          <div className="map-side-verdicts small">
            {active.map((person) => {
              const v = verdict(person.id);
              return (
                <div key={person.id}>
                  <span className="dot" style={{ background: person.colour }} />{person.display_name}{" "}
                  {v ? <><span className={`pill ${v.stance}`}>{LABEL.stance[v.stance]}</span>
                    <span className="muted"> {v.stage === "post_inspection" ? "after inspecting" : "before inspecting"}</span></> : <span className="muted">none yet</span>}
                  {noteOf(v) && <div className="map-side-note">“{noteOf(v)}”</div>}
                </div>
              );
            })}
          </div>
        </section>

        {(next || lead) && (
          <section className="small">
            {next && <div><Timer /> Next inspection {when(next.starts_at)}</div>}
            {lead && (
              <div style={{ marginTop: 4 }}><UserRound /> {lead.name}{lead.agency_name && <span className="muted"> · {lead.agency_name}</span>}
                {lead.mobile && <> · <a href={`tel:${lead.mobile.replace(/\s/g, "")}`}>{lead.mobile}</a></>}</div>
            )}
          </section>
        )}

        {d?.notes && <section className="small map-side-note">{d.notes.length > 220 ? `${d.notes.slice(0, 220)}…` : d.notes}</section>}

        {d && d.tags.length > 0 && (
          <div>{d.tags.map((t) => <span key={t} className="tag" style={tagStyle(tagColours, t)}>#{t}</span>)}</div>
        )}

        <div className="map-side-actions">
          <Link to={`/map?pin=${p.id}`}><button><MapPin /> Move pin</button></Link>
        </div>
      </div>
    </aside>
  );
}
