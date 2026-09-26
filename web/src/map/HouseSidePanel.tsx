// The map's house panel: a side bar on wide screens (a sheet at the bottom on phones) with enough about the house
// to judge it without leaving the map: photo, price and sale (as on the house card), rooms, commute times (the nearest
// station's routes are drawn on the map), verdicts with their notes, the next inspection, the agent and any flags.
import { useQuery } from "@tanstack/react-query";
import { Bath, BedDouble, Building2, Car, ExternalLink, LandPlot, MapPin, Mountain, Timer, UserRound, X } from "lucide-react";
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
/** A verdict's note (the map's summary verdicts have none; the house's full ones do). */
const noteOf = (v: unknown): string | null => (v && typeof v === "object" && "note" in v && typeof v.note === "string" && v.note ? v.note : null);

export default function HouseSidePanel({ p, route, routeError, onClose }: {
  p: MapProperty; route?: StationRoute; routeError?: Error | null; onClose: () => void;
}) {
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
    <aside className="map-side" aria-label={`About ${d?.address ?? "this house"}`}>
      <button className="map-side-close" aria-label="Close" onClick={onClose}><X /></button>
      {cover && <Link to={`/p/${p.id}`} className="map-side-photo"><img src={`/api/attachments/${cover}/thumb`} alt="" /></Link>}
      <div className="map-side-body">
        <div className="map-side-head">
          <h2>{d ? d.address.split(",")[0] : "…"}</h2>
          <div className="row small">
            <span className="muted grow">{p.suburb}</span>
            <span className="pill status-pill"><span className="status-dot" style={{ background: STATUS_COLOUR[p.status] }} />{LABEL.status[p.status]}</span>
          </div>
        </div>

        {c && (
          <section className="map-side-price">
            {isSold(c.outcome) && c.sold_price_aud != null ? <>
              <div className="price">{money(c.sold_price_aud)}</div>
              <SoldAgainst sold={c.sold_price_aud} firstLow={num("first_guide_low")} firstHigh={num("first_guide_high")}
                ours={c.judgements.find((j) => j.kind === "expected_sale")?.amount_aud ?? null} />
            </> : guide ? <div className="price">{moneyRange(guide.low_aud, guide.high_aud)}</div> : <div className="muted small">No guide yet</div>}
            {!isSold(c.outcome) && <div className="row small" style={{ gap: 6 }}>
              {change != null && change !== 0 && <span className={`pill tone-${changeTone(change)}`}>guide {change > 0 ? "↑" : "↓"} {money(Math.abs(change))}</span>}
              {(row?.budget === "over" || row?.budget === "stretch") && (
                <span className={`pill tone-${budgetTone(row.budget)}`}>{row.budget === "over" ? "Over budget" : "Stretch"}</span>)}
              {walkAway && <span className="pill">our max {money(walkAway.amount_aud)}</span>}
            </div>}
            <div className="small">
              {c.outcome ? <>{LABEL.outcome[c.outcome]}{c.sold_price_aud != null && ` · ${money(c.sold_price_aud)}`}</> : <>
                {saleWhen(c)}{soon && <span className={`pill tone-${soonTone(c.sale_method === "auction" ? c.auction_at : c.eoi_closes_at)}`} style={{ marginLeft: 6 }}>{soon}</span>}</>}
            </div>
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
          <Link to={`/p/${p.id}`}><button className="primary"><ExternalLink /> Open the house</button></Link>
          <Link to={`/map?pin=${p.id}`}><button><MapPin /> Move pin</button></Link>
        </div>
      </div>
    </aside>
  );
}
