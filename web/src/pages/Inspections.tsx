// Inspections: pick a day from the week bar and see that day as a timeline: each inspection, auction or EOI closing in
// time order with its cover photo, price, rooms and what each of you said (your most recent response: yes, maybe or
// no), and between two stops the drive from one to the next (a warning when it's long or you'd be late). Stops are
// numbered to match the route map. Two kinds of house are kept out of the timeline, each in a collapsed list for the
// day: ones you've already been to ("Already inspected", with Add again) and ones someone has said No to ("Passed on",
// with Add back). Adding one puts it on the To inspect list, which brings it back into the timeline (and going to an
// inspection takes it off the list again). On a computer the map and these lists sit in a column beside the timeline.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bath, BedDouble, CalendarDays, CalendarPlus, Car, Clock, LandPlot, Map as MapIcon, Navigation, Route, TriangleAlert, X } from "lucide-react";
import { Fragment, lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import ConfirmButton from "../ConfirmButton";
import { EVENT_LABEL, LABEL, landArea, minutes, moneyRange } from "../format";
import type { PlanStop } from "../map/PlanMap";
import type { OverviewPlace, OverviewRow } from "../overview/columns";
import { usePeople } from "../people";
import { routeDrives, type Leg } from "../route";
import { at, iso, useMedia, WeekBar, weekLabel, WeekNav } from "../WeekBar";

const PlanMap = lazy(() => import("../map/PlanMap"));

export type Event = { type: string; id: string; kind: string; state: string; starts_at: string; ends_at: string | null;
                      property_id: string; address: string; suburb: string };
type Person = { id: string; display_name: string; colour: string };

const DAYS = 90;
const timeParts = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });
const longDay = new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long" });
const shortDay = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" });
const weekdayLong = new Intl.DateTimeFormat("en-AU", { weekday: "long" });
const dayMonthLong = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long" });

const isSale = (e: Event) => e.type === "auction" || e.type === "eoi";
const clock = (t: number | string) => timeParts.format(new Date(t));
/** "9:30 am" as the 9:30 and the am, for the timeline. */
const splitTime = (t: string) => { const [h, ap] = clock(t).split(/\s+/); return [h, (ap ?? "").toLowerCase()] as const; };

/** A person's most recent response to a house, before or after inspecting. */
export const latestVerdict = (r: OverviewRow | undefined, personId: string) =>
  r?.[`latest_verdict:${personId}`] as "yes" | "maybe" | "no" | undefined;

/** Who has said No to this house (their most recent response). */
export const saidNo = (r: OverviewRow | undefined, people: Person[]) => people.filter((p) => latestVerdict(r, p.id) === "no");

/** Where an inspection or sale goes in a day's list. Adding a house to To inspect always puts it in the main list, and
 *  so does having been to this very inspection (it's today's, not a repeat). Otherwise a house someone has been to
 *  is "seen", and one someone said No to is "passed". */
export function sectionOf(e: Event, r: OverviewRow | undefined, people: Person[]): "main" | "seen" | "passed" {
  if (r?.to_inspect || e.state === "attended") return "main";
  if (((r?.attended_by as string[] | undefined) ?? []).length > 0) return "seen";
  return saidNo(r, people).length > 0 ? "passed" : "main";
}

export default function Inspections() {
  const queryClient = useQueryClient();
  const { active } = usePeople();
  const wide = useMedia("(min-width: 1000px)");
  const [params, setParams] = useSearchParams();
  const events = useQuery({ queryKey: ["inspections", DAYS], queryFn: () => api<Event[]>(`/api/inspections?days=${DAYS}`) });
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: OverviewRow[]; places: OverviewPlace[] }>("/api/overview") });
  const [error, setError] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);   // on a phone, the map is there when asked for
  const rows = new Map((overview.data?.rows ?? []).map((r) => [r.id, r]));

  const byDay = new Map<string, Event[]>();
  for (const e of events.data ?? []) {
    const k = iso(new Date(e.starts_at));
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const today = iso(new Date());
  const firstWithSomething = [...byDay.keys()].sort().find((k) => k >= today);
  const day = params.get("day") ?? (byDay.has(today) ? today : firstWithSomething ?? today);
  const pick = (d: string) => setParams({ day: d }, { replace: true });

  const onDay = (byDay.get(day) ?? []).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const section = (e: Event) => sectionOf(e, rows.get(e.property_id), active);
  const passed = onDay.filter((e) => section(e) === "passed");
  const seen = onDay.filter((e) => section(e) === "seen");
  const main = onDay.filter((e) => section(e) === "main");
  const countOn = (d: string) => (byDay.get(d) ?? []).filter((e) => section(e) === "main").length;
  const nextDay = [...byDay.keys()].sort().find((k) => k > day && (byDay.get(k) ?? []).some((e) => section(e) === "main"));

  // Getting from one to the next: the drive between the houses still to visit (in time order, pinned on the map), and
  // whether you'd make it. The drive shows between the two; it's a warning when you'd be late, or the drive is long.
  const route = main.filter((e) => e.type !== "eoi" && new Date(e.ends_at ?? e.starts_at).getTime() > Date.now()
    && rows.get(e.property_id)?.lat != null && rows.get(e.property_id)?.lon != null);
  const points = route.map((e) => [Number(rows.get(e.property_id)!.lon), Number(rows.get(e.property_id)!.lat)]);
  const legs = useQuery({
    queryKey: ["plan-legs", points],
    queryFn: () => api<{ legs: Leg[] }>("/api/plan/legs", { method: "POST", body: { points, mode: "drive" } }),
    enabled: points.length >= 2, staleTime: Infinity, retry: false,
  });
  const stopNo = new Map(route.map((e, i) => [e.id, i + 1]));
  const { drives, late, seconds: driving } = routeDrives(route, legs.data?.legs ?? [], { hasStart: false, stay: 15 });   // drives keyed by the stop you're driving to
  const mapStops: PlanStop[] = route.map((e) => {
    const r = rows.get(e.property_id)!;
    return { lon: Number(r.lon), lat: Number(r.lat), label: e.address, clash: late.has(e.id) };
  });

  async function call(fn: () => Promise<unknown>, also: unknown[][] = []) {
    setError(null);
    try {
      await fn();
      for (const key of [["inspections"], ["overview"], ...also]) queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError((err as Error).message);
    }
  }
  /** Not going: cancelled (kept on the house's page), not deleted. */
  const cancel = (e: Event) => call(() => api(`/api/inspections/${e.id}`, { method: "PATCH", body: { state: "cancelled" } }), [["property", e.property_id]]);
  const addBack = (e: Event) => call(() => api(`/api/properties/${e.property_id}/inspect-list`, { method: "PUT" }));

  const feed = `${location.host}/api/calendar.ics`;
  const canPlan = main.filter((e) => e.type !== "eoi").length > 1;
  const sideMap = wide && mapStops.length > 0;
  const planButton = canPlan && <Link to={`/plan?day=${day}`} className="plan-link"><Route /> Plan route</Link>;
  const visits = main.filter((e) => !isSale(e)).length, sales = main.length - visits;

  const mapBlock = mapStops.length > 0 && (
    <Suspense fallback={<div className="plan-map" />}><PlanMap stops={mapStops} /></Suspense>
  );

  return (
    <div className="inspections">
      <header className="insp-head">
        <div>
          <h1>Inspections</h1>
          <p className="muted">{weekLabel(day)}</p>
        </div>
        <div className="insp-head-actions"><WeekNav day={day} today={today} onPick={pick} /></div>
      </header>

      <WeekBar day={day} today={today} count={countOn} onPick={pick} />

      <div key={day} className="insp-fade">
          <div className="insp-dayhero">
            <div>
              <div className="insp-dayname">{day === today ? "Today" : weekdayLong.format(at(day))}</div>
              <div className="insp-daydate">{day === today ? longDay.format(at(day)) : dayMonthLong.format(at(day))}</div>
            </div>
          </div>
          {main.length > 0 && (
            <div className="insp-stats">
              {visits > 0 && <span className="insp-stat"><CalendarDays />{visits} {visits === 1 ? "inspection" : "inspections"}</span>}
              {sales > 0 && <span className="insp-stat"><CalendarDays />{sales} {sales === 1 ? "sale" : "sales"}</span>}
              {main.length > 1 && <span className="insp-stat"><Clock />{clock(main[0].starts_at)} – {clock(main[main.length - 1].starts_at)}</span>}
              {driving > 0 && <span className="insp-stat"><Car />about {minutes(driving)} driving</span>}
            </div>
          )}
          {error && <p className="error small">{error}</p>}

          <div className={`insp-layout ${wide && mapStops.length > 0 ? "" : "no-side"}`}>
          <div>
          {events.isPending ? <p className="muted">Loading…</p> : main.length === 0 ? (
            <div className="card insp-empty">
              <CalendarDays aria-hidden />
              <p>{passed.length + seen.length > 0 ? "Nothing else on this day." : (events.data?.length ?? 0) === 0
                ? "Nothing coming up. Add inspections from a house's page." : `Nothing on ${longDay.format(at(day))}.`}</p>
              {nextDay && <button className="small-btn" onClick={() => pick(nextDay)}>Next: {shortDay.format(at(nextDay))}</button>}
            </div>
          ) : (
            <ol className="tl">
              {main.map((e) => {
                const drive = drives.get(e.id), n = stopNo.get(e.id);
                return (
                  <Fragment key={`${e.type}-${e.id}`}>
                    {drive && (
                      <li className={`tl-gap ${drive.level ?? ""}`}>
                        <div className="tl-rail" />
                        <div className="tl-gapbody">
                          <span className="chip">{drive.level ? <TriangleAlert /> : <Car />}{drive.text}</span>
                        </div>
                      </li>
                    )}
                    <li className={`tl-item ${isSale(e) ? "sale" : ""}`}>
                      <div className="tl-rail">
                        <span className="tl-time">{splitTime(e.starts_at)[0]}<small>{splitTime(e.starts_at)[1]}</small></span>
                        <span className={`tl-dot ${n ? "" : "plain"}`} aria-label={n ? `Stop ${n}` : undefined}>{n ?? ""}</span>
                      </div>
                      <StopCard e={e} r={rows.get(e.property_id)} people={active}
                        foot={<InspectionActions e={e} r={rows.get(e.property_id)} onCancel={() => cancel(e)} />} />
                    </li>
                  </Fragment>
                );
              })}
            </ol>
          )}
          {!wide && mapStops.length > 0 && (
            <div className="insp-mapphone">
              {showMap ? <div className="insp-map">{mapBlock}</div>
                : <button className="small-btn" onClick={() => setShowMap(true)}><MapIcon /> Show the route on a map</button>}
            </div>
          )}

          {!sideMap && planButton && <div className="insp-planrow">{planButton}</div>}

          <div className="insp-after">
            {seen.length > 0 && (
              <details className="card insp-fold">
                <summary>Already inspected <span className="muted">· {seen.length}</span></summary>
                <p className="small muted">You've been to these. Add one again to put it in the list.</p>
                <SideList events={seen} rows={rows} action="Add again" onAdd={addBack}
                  note={(r) => `Inspected${(r?.attended_by as string[] | undefined)?.length === 1 ? ` by ${active.find((p) => p.id === (r?.attended_by as string[])[0])?.display_name ?? "one of you"}` : ""}`} />
              </details>
            )}
            {passed.length > 0 && (
              <details className="card insp-fold">
                <summary>Passed on <span className="muted">· {passed.length}</span></summary>
                <p className="small muted">Someone said No. Add one back to put it in the list.</p>
                <SideList events={passed} rows={rows} action="Add back" onAdd={addBack}
                  note={(r) => `No from ${saidNo(r, active).map((p) => p.display_name).join(" and ")}`} />
              </details>
            )}
            <div className="insp-calbar">
              <a className="insp-calbtn" href={`webcal://${feed}`} title="Inspections, auctions and EOI closings, with a reminder an hour before"><CalendarPlus /> Add to your phone's calendar</a>
              <button className="link small" onClick={() => navigator.clipboard?.writeText(`${location.protocol}//${feed}`)}>Copy link</button>
            </div>
          </div>
        </div>

        {wide && mapStops.length > 0 && (
          <aside className="insp-side">
            <div className="card insp-mapcard"><h3>Route</h3><div className="insp-map">{mapBlock}</div></div>
            {planButton}
          </aside>
        )}
        </div>
      </div>
    </div>
  );
}

/** The compact rows of a side list: photo, address, the time, a note about why it's here, and the button to add it back. */
function SideList({ events, rows, action, onAdd, note }: {
  events: Event[]; rows: Map<string, OverviewRow>; action: string; onAdd: (e: Event) => void;
  note: (r: OverviewRow | undefined) => string;
}) {
  return (
    <ul className="insp-pass-list">
      {events.map((e) => {
        const r = rows.get(e.property_id);
        return (
          <li key={`${e.type}-${e.id}`}>
            <Thumb r={r} />
            <div className="grow" style={{ minWidth: 0 }}>
              <Link to={`/p/${e.property_id}`}>{e.address.split(",")[0]}</Link>
              <div className="small muted">{clock(e.starts_at)} · {note(r)}</div>
            </div>
            <button className="small-btn" onClick={() => onAdd(e)}>{action}</button>
          </li>
        );
      })}
    </ul>
  );
}

/** A house's cover photo (or a plain house outline). */
export function Thumb({ r }: { r: OverviewRow | undefined }) {
  return (
    <span className="insp-thumb" aria-hidden>
      {r?.cover_id ? <img src={`/api/attachments/${String(r.cover_id)}/thumb`} alt="" loading="lazy" /> : (
        <svg viewBox="0 0 32 32"><path d="M7.5 15.5 16 8.5l8.5 7M10.5 13.5v10h11v-10M14.2 23.5v-5h3.6v5" /></svg>
      )}
    </span>
  );
}

/** What you can do about an inspection: directions, add it to a calendar, say you're not going. */
function InspectionActions({ e, r, onCancel }: { e: Event; r: OverviewRow | undefined; onCancel: () => void }) {
  const directions = r?.lat != null && r?.lon != null ? `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}` : null;
  return (
    <div className="ic-foot">
      {directions && <a href={directions} target="_blank" rel="noreferrer" title="Directions" aria-label="Directions"><Navigation /><span className="lbl">Directions</span></a>}
      <a className="ic-cal" href={`/api/events/${e.type}/${e.id}.ics`} title="Add this one to your calendar"><CalendarPlus /><span className="lbl">Calendar</span></a>
      {e.type === "inspection" && (
        <ConfirmButton className="link" title="Not going" label={<><X /><span className="lbl">Not going</span></>} question="Not going?" yes="Remove" onConfirm={onCancel} />
      )}
    </div>
  );
}

/** One inspection or sale: photo, address, price and rooms, each person's verdict, and `foot` along the bottom. */
export function StopCard({ e, r, people, foot, dim = false }: { e: Event; r: OverviewRow | undefined; people: Person[]; foot: ReactNode; dim?: boolean }) {
  const sale = isSale(e);
  const label = sale ? EVENT_LABEL[e.kind] : e.kind === "open" ? null : EVENT_LABEL[e.kind] ?? e.kind;
  const n = (k: string) => (r?.[k] as number | null | undefined) ?? null;
  const facts = [
    n("beds") != null && <span key="b"><BedDouble /> {n("beds")}</span>,
    n("baths") != null && <span key="ba"><Bath /> {n("baths")}</span>,
    n("car_spaces") != null && <span key="c"><Car /> {n("car_spaces")}</span>,
    n("land_m2") != null && <span key="l" className="land"><LandPlot /> {landArea(n("land_m2")!)}</span>,
  ].filter(Boolean);
  const price = n("guide_low") != null ? moneyRange(n("guide_low"), n("guide_high")) : null;
  return (
    <article className={`ic ${dim ? "dim" : ""}`}>
      <Link to={`/p/${e.property_id}`} className="ic-photo" aria-label={e.address}><Thumb r={r} /></Link>
      <div className="ic-body">
        <Link to={`/p/${e.property_id}`} className="ic-address">{e.address.split(",")[0]}</Link>
        <div className="ic-sub">
          <span>{e.suburb}</span>
          {price && <span className="ic-price-phone">{price}</span>}
          {label && <span className={`pill ${sale ? "cal-sale" : ""}`}>{label}</span>}
          {e.state !== "planned" && <span className="small">({e.state})</span>}
          {Boolean(r?.to_inspect) && <span className="pill">To inspect</span>}
        </div>
        {(facts.length > 0 || price) && (
          <div className="ic-line">
            {facts.length > 0 && <span className="pc-facts">{facts}</span>}
            {price && <strong>{price}</strong>}
          </div>
        )}
        <div className="ic-verdicts">
          {people.map((p) => {
            const v = latestVerdict(r, p.id), text = v ? LABEL.stance[v] : "no verdict yet";
            return (
              <span key={p.id} className={`ic-v ${v ?? "none"}`} title={`${p.display_name}: ${text}`} aria-label={`${p.display_name}: ${text}`}>
                <span className="ic-av" style={{ background: p.colour }}>{p.display_name[0]}</span>
                <span className="vtxt">{v ? LABEL.stance[v] : "Not yet"}</span>
                <span className="vsym" aria-hidden>{v === "yes" ? "✓" : v === "no" ? "✕" : v === "maybe" ? "?" : "·"}</span>
              </span>
            );
          })}
        </div>
      </div>
      {foot}
    </article>
  );
}
