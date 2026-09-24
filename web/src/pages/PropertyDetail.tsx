import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  api, PROPERTY_TYPES, STATUSES,
  type Campaign, type GuideSource, type JudgementKind, type PropertyDetail as Detail,
  type PropertyType, type SaleMethod, type Stage, type Stance, type Status, ApiError } from "../api";
import { parseMoney, day, fromLocalInput, LABEL, minutes, money, moneyRange, toLocalInput, saleWhen, streetLine, when } from "../format";
import { newId, sendOrQueue } from "../outbox";
import { usePeople } from "../people";
import { STATUS_COLOUR, changeTone, minutesTone, soonTone, suburbClass, tagStyle, useSuburbSlots, useTagColours } from "../colour";
import { Checklist, Comparables, CostAt, PriceHistory } from "./MoneyExtras";
import { Files, Inspections } from "./PropertyExtras";
import { ScoresCard } from "./Decide";
import { Bath, BedDouble, Building2, CalendarDays, CalendarPlus, Camera, Car, CircleDollarSign, CircleHelp, DollarSign, Gavel, House, ImagePlus, LandPlot, MapPin, Paperclip, PartyPopper, Scale, School, Tag, ThumbsDown, ThumbsUp, TrainFront, TramFront, Trash2, TriangleAlert } from "lucide-react";
import Commute from "../Commute";
import ConfirmButton from "../ConfirmButton";
import { OutcomeForm, outcomeStatus, statusOutOfStep } from "../Outcome";

const MiniMap = lazy(() => import("../map/MiniMap"));

/** Run a write, then refresh this property and the list. A conflict (someone else changed it first) also
 *  refreshes, so the page shows their value next to the message. */
function useWrite(propertyId: string) {
  const queryClient = useQueryClient();
  const reload = () => {
    queryClient.invalidateQueries({ queryKey: ["property", propertyId] });
    queryClient.invalidateQueries({ queryKey: ["overview"] });
  };
  return useMutation({
    mutationFn: ({ path, method = "POST", body }: { path: string; method?: string; body?: unknown }) =>
      api(path, { method, body }),
    onSuccess: reload,
    onError: (e) => { if (e instanceof ApiError && e.status === 409) reload(); },
  });
}

type Tab = "about" | "sale" | "location" | "inspections" | "files";
const TABS: [Tab, string][] = [["about", "About"], ["sale", "Price & sale"], ["location", "Location"], ["inspections", "Inspections"], ["files", "Photos & docs"]];

export default function PropertyDetail() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([t]) => t === params.get("tab")) ? params.get("tab") : "about") as Tab;
  const setTab = (t: Tab) => setParams(t === "about" ? {} : { tab: t }, { replace: true });
  const { data: p, isPending, isError } = useQuery({
    queryKey: ["property", id],
    queryFn: () => api<Detail>(`/api/properties/${id}`),
    // Keep checking while the worker is still geocoding or routing this property.
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && ((d.lat == null && d.geocode_status === "pending") || d.travel.pending > 0) ? 3000 : false;
    },
  });
  if (isPending) return <p className="muted">Loading…</p>;
  if (isError || !p) return <p className="error">Couldn't load this property. <Link to="/">Back to the list</Link></p>;

  const live = p.campaigns.find((c) => !c.outcome) ?? null;
  const past = p.campaigns.filter((c) => c.outcome);
  const latest = live ?? p.campaigns[p.campaigns.length - 1] ?? null;
  // The chart only earns its space once there's a change to see.
  const pricePoints = p.campaigns.reduce((n, c) => n + c.price_guides.length + (c.sold_price_aud ? 1 : 0), 0);
  return (
    <div className="listing">
      <div className="listing-head">
        <Banner p={p} />
        <Title p={p} />
      </div>
      <div className="listing-tabs"><Tabs tab={tab} setTab={setTab} p={p} /></div>

      <aside className="listing-side">
        <PriceBox p={p} c={latest} />
        <Opinions p={p} />
        <Actions p={p} setTab={setTab} />
      </aside>

      <div className="listing-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "about" && (
          <div className="tab-grid">
            <div><About p={p} /><DetailsTable p={p} /></div>
            <div><AtAGlance p={p} c={latest} setTab={setTab} /><Timeline p={p} /></div>
          </div>
        )}
        {tab === "sale" && (
          <>
            {live ? <SaleTab p={p} c={live} showChart={pricePoints >= 2} /> : <NewCampaign p={p} />}
            {past.length > 0 && (
              <details className="card">
                <summary><strong>Earlier campaigns</strong> <span className="muted">({past.length})</span></summary>
                {past.map((c) => <PastCampaign key={c.id} c={c} />)}
              </details>
            )}
          </>
        )}
        {tab === "location" && (
          <>
            {p.lat != null && p.lon != null && (
              <div className="card location-map">
                <Suspense fallback={<div className="map-frame" />}><MiniMap lon={p.lon} lat={p.lat} interactive zoom={15} className="map-frame" /></Suspense>
              </div>
            )}
            <WhereAndGettingAround p={p} />
            <SchoolsAndPlanning p={p} />
          </>
        )}
        {tab === "inspections" && (
          <div className="tab-grid">
            <div><Inspections propertyId={p.id} inspections={p.inspections} /></div>
            <div><ScoresCard propertyId={p.id} /><VerdictHistory p={p} /></div>
          </div>
        )}
        {tab === "files" && (
          <>
            {!p.attachments.some((a) => a.caption === "From the listing") && <ListingPhoto p={p} />}
            <Files propertyId={p.id} attachments={p.attachments} coverId={p.cover_id} address={p.address} />
          </>
        )}
      </div>
    </div>
  );
}

// The API lists price guides newest first; these views read them oldest first.
const oldestFirst = (c: Campaign | null) => [...(c?.price_guides ?? [])].sort((a, b) => a.observed_at.localeCompare(b.observed_at));

// ─── listing head ─────────────────────────────────────────────────────
const isPhoto = (a: Detail["attachments"][number]) => a.kind === "photo" && !!a.sha256 && !!a.mime_type?.startsWith("image/");

/** The newest photo and a map of the spot side by side (phones show the photo), else whichever exists,
 *  else a prompt to set the pin or fetch the listing's photo. */
function Banner({ p }: { p: Detail }) {
  const photos = p.attachments.filter(isPhoto);
  const slots = useSuburbSlots();
  const cover = photos.find((a) => a.id === p.cover_id) ?? photos[0];
  const hasPin = p.lat != null && p.lon != null;
  const map = hasPin && <Suspense fallback={<div className="banner-empty" />}><MiniMap lon={p.lon!} lat={p.lat!} /></Suspense>;
  return (
    <div className={`banner-media ${cover && hasPin ? "split" : ""} ${suburbClass(slots, p.suburb)}`}>
      {cover && (
        <a href={`/api/attachments/${cover.id}/file`} target="_blank" rel="noreferrer" className="banner-photo">
          <img src={`/api/attachments/${cover.id}/file`} alt={cover.caption ?? "Photo of the house"} />
          <span className="banner-badge"><Camera /> {photos.length} {photos.length === 1 ? "photo" : "photos"}</span>
        </a>
      )}
      {cover && hasPin && <div className="banner-map">{map}<Link className="banner-badge top" to="/map">Open the full map</Link></div>}
      {!cover && hasPin && <>{map}<Link className="banner-badge top" to="/map">Open the full map</Link><ListingPhoto p={p} compact /></>}
      {!cover && !hasPin && (
        <div className="banner-empty">
          <MapPin aria-hidden className="big-icon" />
          <strong style={{ fontSize: "1rem" }}>{p.geocode_status === "pending" ? "Finding it on the map…" : "Not on the map yet"}</strong>
          <div className="row" style={{ justifyContent: "center" }}>
            <Link to={`/map?pin=${p.id}`}><button className="primary">Set the pin</button></Link>
            <ListingPhoto p={p} compact />
          </div>
        </div>
      )}
    </div>
  );
}

/** Fetch the listing's main photo from its link (often blocked by the portals; the bookmarklet is the fallback). */
function ListingPhoto({ p, compact = false }: { p: Detail; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  const links = p.campaigns.flatMap((c) => c.links);
  if (!links.length) return compact ? null : (
    <p className="small muted">Add the listing link on the Price &amp; sale tab to fetch its main photo, or upload photos below.</p>
  );
  // Domain and realestate.com.au refuse server reads: their photos come in with the + House Track button.
  if (links.every((l) => l.portal === "domain" || l.portal === "rea")) return compact ? null : (
    <p className="small muted">To add the listing's photos, open the listing and click <strong>+ House Track</strong> in your bookmarks
      bar (<Link to="/settings#bookmarklets">set it up</Link>), or upload photos below.</p>
  );
  async function fetchIt() {
    setState({ busy: true, msg: null });
    try {
      await api(`/api/properties/${p.id}/listing-photo`, { method: "POST" });
      setState({ busy: false, msg: null });
      queryClient.invalidateQueries({ queryKey: ["property", p.id] });
    } catch (e) {
      setState({ busy: false, msg: (e as Error).message });
    }
  }
  return (
    <div className={compact ? "banner-action" : "row"} style={compact ? undefined : { marginTop: 12 }}>
      <button onClick={fetchIt} disabled={state.busy}>{state.busy ? "Fetching…" : <><Camera /> Get the listing photo</>}</button>
      {state.msg && <span className={`small ${compact ? "banner-msg" : "error"}`}>{state.msg}</span>}
    </div>
  );
}

function Title({ p }: { p: Detail }) {
  const slots = useSuburbSlots();
  const street = streetLine(p);
  const facts: [React.ReactNode, string, string][] = [
    [<BedDouble />, p.beds != null ? String(p.beds) : "—", p.beds === 1 ? "bed" : "beds"],
    [<Bath />, p.baths != null ? String(p.baths) : "—", p.baths === 1 ? "bath" : "baths"],
    [<Car />, p.car_spaces != null ? String(p.car_spaces) : "—", p.car_spaces === 1 ? "car" : "cars"],
  ];
  // Unknown land is left out (like building area); acreage reads better in hectares.
  if (p.land_m2 != null) facts.push(p.land_m2 >= 10_000
    ? [<LandPlot />, (p.land_m2 / 10_000).toLocaleString(undefined, { maximumFractionDigits: 2 }), "ha land"]
    : [<LandPlot />, Number(p.land_m2).toLocaleString(), "m² land"]);
  if (p.building_m2 != null) facts.push([<Building2 />, Number(p.building_m2).toLocaleString(), "m² building"]);
  facts.push([<House />, p.property_type[0].toUpperCase() + p.property_type.slice(1),
              p.build_status === "established" ? "established" : p.build_status.replace(/_/g, " ")]);
  return (
    <div className="listing-title">
      <h1>{street || p.address}</h1>
      <div className={`row ${suburbClass(slots, p.suburb)}`}>
        <span><span className="suburb-swatch" /><span className="suburb-name">{p.suburb}</span> <span className="muted">{p.postcode}</span></span>
      </div>
      <div className="facts">
        {facts.map(([icon, value, label]) => (
          <div key={label} className="fact"><span className="fact-icon" aria-hidden>{icon}</span><strong>{value}</strong><span className="muted small">{label}</span></div>
        ))}
      </div>
    </div>
  );
}

function Tabs({ tab, setTab, p }: { tab: Tab; setTab: (t: Tab) => void; p: Detail }) {
  const counts: Partial<Record<Tab, number>> = { inspections: p.inspections.length, files: p.attachments.length };
  return (
    <div className="tabs" role="tablist" aria-label="House sections">
      {TABS.map(([t, label]) => (
        <button key={t} id={`tab-${t}`} role="tab" aria-selected={tab === t} aria-controls={`panel-${t}`}
          className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
          {label}{counts[t] ? <span className="tab-count">{counts[t]}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ─── the side panel: price, sale, status, verdicts, actions ──────────────
function PriceBox({ p, c }: { p: Detail; c: Campaign | null }) {
  const guides = oldestFirst(c);
  const guide = guides[guides.length - 1];
  const first = guides[0];
  const saleAt = c && (c.sale_method === "auction" ? c.auction_at : c.eoi_closes_at);
  const soon = c && !c.outcome ? soonTone(saleAt) : "";
  const listedDays = c?.listed_on ? Math.max(0, Math.round((Date.now() - new Date(c.listed_on).getTime()) / 86_400_000)) : null;
  const link = c?.links[0];
  return (
    <div className="card price-box">
      <div className="muted small">{c?.outcome ? LABEL.outcome[c.outcome] : guide ? `Price guide · ${LABEL.guideSource[guide.source]}` : "Price"}</div>
      <div className="price-big">
        {c?.outcome && c.sold_price_aud ? money(c.sold_price_aud) : guide ? moneyRange(guide.low_aud, guide.high_aud) : <span className="muted">No guide yet</span>}
      </div>
      {guide && first && guides.length > 1 && (
        <div className={`small tone-${changeTone((guide.low_aud + guide.high_aud) / 2 - (first.low_aud + first.high_aud) / 2)}`}>
          {(guide.low_aud + guide.high_aud) > (first.low_aud + first.high_aud) ? "↑" : "↓"} from {moneyRange(first.low_aud, first.high_aud)} · changed {guides.length - 1}×
        </div>
      )}
      {c && !c.outcome && (
        <div className={`sale-when ${soon ? `tone-${soon}` : ""}`}>
          <CalendarDays /> {saleWhen(c)}{listedDays != null && <span className="muted small"> · listed {listedDays} {listedDays === 1 ? "day" : "days"}</span>}
        </div>
      )}
      {link && <a className="small" href={link.url} target="_blank" rel="noreferrer">View listing on {link.portal} ↗</a>}
      <StatusCard p={p} bare />
    </div>
  );
}

function Actions({ p, setTab }: { p: Detail; setTab: (t: Tab) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    try {
      await api(`/api/properties/${p.id}`, { method: "DELETE" });
      queryClient.removeQueries({ queryKey: ["property", p.id] });
      queryClient.invalidateQueries();
      navigate("/");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="card actions">
      <button onClick={() => setTab("inspections")}><CalendarPlus /> Add inspection</button>
      <button onClick={() => setTab("files")}><ImagePlus /> Add photos</button>
      <Link to={`/compare?ids=${p.id}`}><button><Scale /> Compare</button></Link>
      <Link to={`/map?pin=${p.id}`}><button><MapPin /> {p.lat == null ? "Set pin" : "Move pin"}</button></Link>
      <div className="actions-foot">
        <ConfirmButton label={<><Trash2 /> Delete house</>} yes="Delete it"
          question="For mistakes and duplicates: everything recorded about it goes. Ruled it out? Set its status instead." onConfirm={remove} />
        {error && <p className="error small">{error}</p>}
      </div>
    </div>
  );
}

// ─── about tab ─────────────────────────────────────────────────────────
function DetailsTable({ p }: { p: Detail }) {
  const first = [...p.status_history].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))[0];
  const since = [...p.status_history].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0];
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1).replace(/_/g, " ");
  const rows: [string, string | null][] = [
    ["Type", cap(p.property_type)],
    ["Build", cap(p.build_status)],
    ["Bedrooms", p.beds?.toString() ?? null],
    ["Bathrooms", p.baths?.toString() ?? null],
    ["Car spaces", p.car_spaces?.toString() ?? null],
    ["Land", p.land_m2 != null ? `${Number(p.land_m2).toLocaleString()} m²` : null],
    ["Building", p.building_m2 != null ? `${Number(p.building_m2).toLocaleString()} m²` : null],
    ["Owners corp", p.owners_corp_fees_aud_pa != null ? `${money(p.owners_corp_fees_aud_pa)} a year` : null],
    ["Council rates", p.council_rates_aud_pa != null ? `${money(p.council_rates_aud_pa)} a year` : null],
    ["Title", p.plan_number || p.lot_number ? [p.lot_number && `Lot ${p.lot_number}`, p.plan_number].filter(Boolean).join(" on ") : null],
    ["Status", since ? `${LABEL.status[p.status]} since ${day(since.occurred_at)}` : LABEL.status[p.status]],
    ["Tracking since", first ? day(first.occurred_at) : null],
  ];
  return (
    <div className="card">
      <h2>Details</h2>
      <table className="kv">
        <tbody>
          {rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v ?? <span className="muted">—</span>}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

/** One line per thing worth knowing, each pointing at the tab with the detail. */
function AtAGlance({ p, c, setTab }: { p: Detail; c: Campaign | null; setTab: (t: Tab) => void }) {
  const station = p.travel.nearest;
  const schools = p.overlays.filter((o) => o.code.includes("school"));
  const flags = p.overlays.filter((o) => !o.code.includes("school") && o.effect !== "info");
  const guides = oldestFirst(c);
  const guide = guides[guides.length - 1];
  const median = [...guides].reverse().find((g) => g.statement_suburb_median_aud)?.statement_suburb_median_aud;
  const next = p.inspections.filter((i) => new Date(i.starts_at).getTime() > Date.now()).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const items: { icon: React.ReactNode; text: React.ReactNode; tab: Tab }[] = [];
  if (station) items.push({ icon: <TrainFront />, tab: "location", text: <>
    {station.walk_s != null && <><span className={`tone-${minutesTone(station.walk_s / 60)}`}>{minutes(station.walk_s)}</span> walk</>}
    {station.walk_s != null && station.drive_s != null && " · "}
    {station.drive_s != null && <><span className={`tone-${minutesTone(station.drive_s / 60, "drive")}`}>{minutes(station.drive_s)}</span> drive</>}
    {" "}to {station.name} station</> });
  for (const d of p.travel.destinations.slice(0, 3)) {
    const drive = d.drive_peak_s ?? d.drive_s;
    if (drive != null) items.push({ icon: <Car />, tab: "location", text: <><span className={`tone-${minutesTone(drive / 60, "drive")}`}>{minutes(drive)}</span> drive to {d.name}{d.drive_peak_s != null && <span className="muted"> in peak hour</span>}</> });
    if (d.transit?.duration_s != null) items.push({ icon: <TramFront />, tab: "location", text: <><span className={`tone-${minutesTone(d.transit.duration_s / 60, "transit")}`}>{minutes(d.transit.duration_s)}</span> public transport to {d.name}</> });
  }
  for (const sch of schools) {
    const way = p.travel.schools?.find((s) => s.name.toLowerCase() === String(sch.label).toLowerCase());
    items.push({ icon: <School />, tab: "location", text: <>{sch.label} <span className="muted">zone</span>
      {way?.walk_s != null && way.walk_s <= 45 * 60 && <> · <span className={`tone-${minutesTone(way.walk_s / 60)}`}>{minutes(way.walk_s)}</span> walk</>}
      {way?.drive_s != null && (way.walk_s == null || way.walk_s > 35 * 60) && <> · {minutes(way.drive_s)} drive</>}</> });
  }
  for (const f of flags) items.push({ icon: <TriangleAlert />, tab: "location", text: <span className={f.effect === "hard_exclude" ? "tone-bad" : "tone-warn"}>{f.label}</span> });
  if (guide && median) {
    const pct = ((guide.low_aud + guide.high_aud) / 2 / median - 1) * 100;
    items.push({ icon: <CircleDollarSign />, tab: "sale", text: <>Guide is {Math.abs(pct).toFixed(0)}% {pct >= 0 ? "above" : "below"} the suburb median ({money(median)})</> });
  }
  if (next) items.push({ icon: <CalendarDays />, tab: "inspections", text: <>Next inspection {when(next.starts_at)}</> });
  const photos = p.attachments.filter(isPhoto).length, docs = p.attachments.length - photos;
  if (p.attachments.length) items.push({ icon: <Paperclip />, tab: "files", text: <>{photos} {photos === 1 ? "photo" : "photos"}, {docs} {docs === 1 ? "document" : "documents"}</> });
  return (
    <div className="card">
      <h2>At a glance</h2>
      {items.length === 0 && <p className="small muted">Travel times, school zones and planning appear here once the house is on the map.</p>}
      <ul className="glance">
        {items.map((it, i) => (
          <li key={i}><span aria-hidden>{it.icon}</span><span className="grow">{it.text}</span>
            <button className="link small" onClick={() => setTab(it.tab)}>More</button></li>
        ))}
      </ul>
    </div>
  );
}

/** Everything that happened to this house, newest first. */
function Timeline({ p }: { p: Detail }) {
  const { byId } = usePeople();
  const [all, setAll] = useState(false);
  const who = (id: string | null | undefined) => (id ? byId.get(id)?.display_name ?? "" : "");
  type Ev = { at: string; icon: React.ReactNode; text: React.ReactNode };
  const ev: Ev[] = [];
  for (const h of p.status_history) ev.push({ at: h.occurred_at, icon: "●", text: <>Status: <strong>{LABEL.status[h.status]}</strong> <span className="muted">· {who(h.created_by)}</span></> });
  for (const o of p.opinions) ev.push({ at: o.recorded_at, icon: o.stance === "yes" ? <ThumbsUp /> : o.stance === "no" ? <ThumbsDown /> : <CircleHelp />,
    text: <>{who(o.person_id)}: <span className={`pill ${o.stance}`}>{LABEL.stance[o.stance]}</span> <span className="muted">{LABEL.stage[o.stage].toLowerCase()}</span>{o.note && <> · “{o.note}”</>}</> });
  for (const c of p.campaigns) {
    if (c.listed_on) ev.push({ at: c.listed_on, icon: <Tag />, text: <>Listed · {LABEL.method[c.sale_method]}</> });
    const guides = oldestFirst(c);
    guides.forEach((g, i) => {
      const prev = guides[i - 1];
      const d = prev ? (g.low_aud + g.high_aud) / 2 - (prev.low_aud + prev.high_aud) / 2 : 0;
      ev.push({ at: g.observed_at, icon: <DollarSign />, text: <>Guide {moneyRange(g.low_aud, g.high_aud)} <span className="muted">({LABEL.guideSource[g.source]})</span>
        {d !== 0 && <span className={`tone-${changeTone(d)}`}> {d > 0 ? "↑" : "↓"} {money(Math.abs(d))}</span>}</> });
    });
    if (c.outcome && c.outcome_on) ev.push({ at: c.outcome_on, icon: <Gavel />, text: <strong>{LABEL.outcome[c.outcome]}{c.sold_price_aud ? ` ${money(c.sold_price_aud)}` : ""}</strong> });
  }
  for (const i of p.inspections) ev.push({ at: i.starts_at, icon: <CalendarDays />, text: <>Inspection{i.attendees.length ? ` · ${i.attendees.map((a) => who(a.person_id)).join(", ")} went` : ""}</> });
  const byDay = new Map<string, number>();
  for (const a of p.attachments) byDay.set(a.created_at.slice(0, 10), (byDay.get(a.created_at.slice(0, 10)) ?? 0) + 1);
  for (const [d, n] of byDay) ev.push({ at: `${d}T12:00:00`, icon: <Paperclip />, text: <>{n} {n === 1 ? "file" : "files"} added</> });
  ev.sort((a, b) => b.at.localeCompare(a.at));
  const shown = all ? ev : ev.slice(0, 10);
  return (
    <div className="card">
      <h2>Timeline</h2>
      {ev.length === 0 && <p className="small muted">Nothing yet.</p>}
      <ol className="timeline">
        {shown.map((e, i) => (
          <li key={i}><span className="tl-icon" aria-hidden>{e.icon}</span><div><div className="small">{e.text}</div><div className="muted tiny">{day(e.at)}</div></div></li>
        ))}
      </ol>
      {ev.length > 10 && <button className="link small" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${ev.length}`}</button>}
    </div>
  );
}

// ─── price tab ────────────────────────────────────────────────────────
/** What the numbers say about the guide, only the ones that are known (no rows of dashes). */
function PriceFacts({ p, c }: { p: Detail; c: Campaign }) {
  const guides = oldestFirst(c);
  const now = guides[guides.length - 1], first = guides[0];
  if (!now) return null;
  const mid = (g: { low_aud: number; high_aud: number }) => (g.low_aud + g.high_aud) / 2;
  const change = guides.length > 1 ? mid(now) - mid(first) : 0;
  const median = [...guides].reverse().find((g) => g.statement_suburb_median_aud)?.statement_suburb_median_aud ?? null;
  const walkAway = [...c.judgements].filter((j) => j.kind === "walk_away").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const facts: { text: React.ReactNode; tone?: string }[] = [];
  if (change) facts.push({ tone: changeTone(change), text: <>Guide {change > 0 ? "up" : "down"} {money(Math.abs(change))} since {day(first.observed_at)} ({moneyRange(first.low_aud, first.high_aud)})</> });
  if (median) facts.push({ text: <>{Math.abs(Math.round((mid(now) / median - 1) * 100))}% {mid(now) >= median ? "above" : "below"} the suburb median ({money(median)})</> });
  if (p.land_m2) facts.push({ text: <>${Math.round(mid(now) / p.land_m2).toLocaleString()} per m² of land</> });
  if (walkAway) facts.push({ tone: walkAway.amount_aud >= now.high_aud ? "good" : "bad",
    text: <>Our max {money(walkAway.amount_aud)} is {money(Math.abs(walkAway.amount_aud - now.high_aud))} {walkAway.amount_aud >= now.high_aud ? "above" : "below"} the top of the guide</> });
  if (!facts.length) return null;
  return <ul className="price-facts">{facts.map((f, i) => <li key={i} className={f.tone ? `tone-${f.tone}` : ""}>{f.text}</li>)}</ul>;
}

const countdown = (at: string | null) => {
  if (!at) return null;
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400_000);
  return days < 0 ? null : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
};

// ─── inspections tab ──────────────────────────────────────────────────
function VerdictHistory({ p }: { p: Detail }) {
  const { byId } = usePeople();
  const list = [...p.opinions].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  return (
    <div className="card">
      <h2>Every verdict</h2>
      {list.length === 0 && <p className="small muted">No verdicts yet. Record one in the panel on the right.</p>}
      <ul className="history small">
        {list.map((o) => (
          <li key={o.id}>
            <span className="dot" style={{ background: byId.get(o.person_id)?.colour }} />{byId.get(o.person_id)?.display_name}{" "}
            <span className={`pill ${o.stance}`}>{LABEL.stance[o.stance]}</span> <span className="muted">{LABEL.stage[o.stage].toLowerCase()} · {when(o.recorded_at)}</span>
            {o.note && <div>“{o.note}”</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── about: notes, tags, details ──────────────────────────────────────
function About({ p }: { p: Detail }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="card stack">
      <div className="row"><h2 className="grow">About</h2><button className="link" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit details"}</button></div>
      {p.notes ? <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{p.notes}</p> : <p className="muted small" style={{ margin: 0 }}>No notes yet. Use Edit details to add some.</p>}
      {p.owners_corp_fees_aud_pa != null && <div className="small">Owners corp {money(p.owners_corp_fees_aud_pa)} a year</div>}
      <TagEditor p={p} />
      {editing && <EditProperty p={p} onDone={() => setEditing(false)} />}
    </div>
  );
}

// ─── header & edit ────────────────────────────────────────────────────
function TagEditor({ p: detail }: { p: Detail }) {
  const p = { ...detail, tags: detail.tags ?? [] };  // pages saved offline before tags existed have none
  const queryClient = useQueryClient();
  const all = useQuery({ queryKey: ["tags"], queryFn: () => api<{ name: string }[]>("/api/tags") });
  const [text, setText] = useState("");
  const colours = useTagColours();
  const save = async (names: string[]) => {
    await api(`/api/properties/${p.id}/tags`, { method: "PUT", body: { names } });
    setText("");
    for (const key of [["property", p.id], ["overview"], ["tags"]]) queryClient.invalidateQueries({ queryKey: key });
  };
  const suggestions = (all.data ?? []).map((t) => t.name).filter((n) => !p.tags.includes(n) && n.toLowerCase().includes(text.toLowerCase()));
  return (
    <div className="row" style={{ marginTop: 6 }}>
      {p.tags.map((t) => (
        <span key={t} className="tag" style={tagStyle(colours, t)}>#{t} <button className="link" aria-label={`Remove ${t}`} onClick={() => save(p.tags.filter((x) => x !== t))}>✕</button></span>
      ))}
      <input className="grow" list={`tags-${p.id}`} placeholder="Add a tag" value={text} style={{ maxWidth: 200, padding: "4px 8px" }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) save([...p.tags, text.trim()]); }} />
      <datalist id={`tags-${p.id}`}>{suggestions.map((n) => <option key={n} value={n} />)}</datalist>
    </div>
  );
}

function EditProperty({ p, onDone }: { p: Detail; onDone: () => void }) {
  const write = useWrite(p.id);
  const [f, setF] = useState({
    unit: p.unit ?? "", street_number: p.street_number ?? "", street: p.street ?? "", suburb: p.suburb ?? "",
    postcode: p.postcode ?? "", plan_number: p.plan_number ?? "", lot_number: p.lot_number ?? "",
    property_type: p.property_type, beds: p.beds?.toString() ?? "", baths: p.baths?.toString() ?? "",
    car_spaces: p.car_spaces?.toString() ?? "", land_m2: p.land_m2?.toString() ?? "",
    owners_corp: p.owners_corp_fees_aud_pa?.toString() ?? "", notes: p.notes ?? "",
  });
  const input = (k: keyof typeof f) => ({
    value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value }),
  });
  const n = (v: string) => (v.trim() === "" ? null : Number(v));
  const s = (v: string) => (v.trim() === "" ? null : v.trim());

  function save() {
    // Only what was changed, with what it was: the server refuses the save if someone changed any of those
    // fields meanwhile, instead of this form quietly putting back its older copy of everything.
    const address = { unit: s(f.unit), street_number: s(f.street_number), street: s(f.street), suburb: s(f.suburb),
                      postcode: s(f.postcode), plan_number: s(f.plan_number), lot_number: s(f.lot_number) };
    const fields = { property_type: f.property_type, beds: n(f.beds), baths: n(f.baths), car_spaces: n(f.car_spaces),
                     land_m2: n(f.land_m2), owners_corp_fees_aud_pa: n(f.owners_corp), notes: s(f.notes) };
    const was = p as unknown as Record<string, unknown>;
    const body: Record<string, unknown> = {}, expected: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== (was[k] ?? null)) { body[k] = v; expected[k] = was[k] ?? null; }
    if (Object.entries(address).some(([k, v]) => v !== (was[k] ?? null))) {
      body.address = address;
      for (const k of Object.keys(address)) expected[k] = was[k] ?? null;
    }
    if (!Object.keys(body).length) { onDone(); return; }
    write.mutate({ path: `/api/properties/${p.id}`, method: "PATCH", body: { ...body, expected } }, { onSuccess: onDone });
  }

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div className="grid3">
        <label>Unit<input {...input("unit")} /></label>
        <label>Number<input {...input("street_number")} /></label>
        <label>Postcode<input {...input("postcode")} /></label>
      </div>
      <label>Street<input {...input("street")} /></label>
      <label>Suburb<input {...input("suburb")} /></label>
      <div className="grid2">
        <label>Plan number<input {...input("plan_number")} /></label>
        <label>Lot<input {...input("lot_number")} /></label>
      </div>
      <label>
        Type
        <select value={f.property_type} onChange={(e) => setF({ ...f, property_type: e.target.value as PropertyType })}>
          {PROPERTY_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </label>
      <div className="grid3">
        <label>Beds<input inputMode="numeric" {...input("beds")} /></label>
        <label>Baths<input inputMode="numeric" {...input("baths")} /></label>
        <label>Cars<input inputMode="numeric" {...input("car_spaces")} /></label>
      </div>
      <div className="grid2">
        <label>Land m²<input inputMode="numeric" {...input("land_m2")} /></label>
        <label>Owners corp $/yr<input inputMode="numeric" {...input("owners_corp")} /></label>
      </div>
      <label>Notes<textarea {...input("notes")} /></label>
      {write.error && <p className="error">{(write.error as Error).message}</p>}
      <button className="primary" onClick={save} disabled={write.isPending}>Save changes</button>
    </div>
  );
}

// ─── shared status ────────────────────────────────────────────────────
function StatusCard({ p, bare = false }: { p: Detail; bare?: boolean }) {
  const write = useWrite(p.id);
  // The most recent campaign that has ended, when there's no live one.
  const ended = p.campaigns.some((c) => !c.outcome) ? null : p.campaigns.find((c) => c.outcome) ?? null;
  const { byId } = usePeople();
  return (
    <div className={bare ? "status-inline" : "card"}>
      <label>
        <span><span className="status-dot" style={{ background: STATUS_COLOUR[p.status], marginRight: 6 }} />Status (shared)</span>
        <select
          value={p.status}
          onChange={(e) => write.mutate({ path: `/api/properties/${p.id}/status`, body: {
            status: e.target.value as Status, check_latest: true, expected_latest_id: p.status_history[0]?.id ?? null } })}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{LABEL.status[s]}</option>)}
        </select>
      </label>
      {write.error && <p className="error small">{(write.error as Error).message}</p>}
      {ended && statusOutOfStep(ended.outcome, ended.bought_by_us, p.status) && (
        <p className="small tone-warn" style={{ margin: 0 }}>
          {LABEL.outcome[ended.outcome!]}, but the status still says {LABEL.status[p.status]}.{" "}
          <button className="link" onClick={() => write.mutate({ path: `/api/properties/${p.id}/status`, body: {
            status: outcomeStatus(ended.outcome, ended.bought_by_us), reason: "Sale outcome recorded",
            check_latest: true, expected_latest_id: p.status_history[0]?.id ?? null } })}>
            Set it to {LABEL.status[outcomeStatus(ended.outcome, ended.bought_by_us)!]}</button>
        </p>
      )}
      {p.status_history.length > 1 && (
        <details>
          <summary>History</summary>
          <ul className="history small">
            {p.status_history.map((h) => (
              <li key={h.id}>{LABEL.status[h.status]} · {byId.get(h.created_by)?.display_name} · {when(h.occurred_at)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ─── location & travel (milestone 2) ──────────────────────────────────
function WhereAndGettingAround({ p }: { p: Detail }) {
  const write = useWrite(p.id);
  const t = p.travel;
  let where: string;
  if (p.lat == null) where = p.geocode_status === "no_match" ? "Couldn't find this address automatically. Set the pin yourself." : "Finding it on the map…";
  else if (p.manual_pin) where = "Pinned by hand.";
  else if (p.geocode_source === "gnaf") where = (p.geocode_confidence ?? 1) < 0.7 ? "Pinned to the street, not the house. Check it." : "Pinned from the national address file.";
  else where = "Pinned from an OpenStreetMap search. Check it's right.";
  return (
    <div className="card stack">
      <h2>Where and getting around</h2>
      <div className="small">{where}</div>
      <div className="row">
        <Link to={`/map?pin=${p.id}`}><button>{p.lat == null ? "Set pin on map" : "Move pin"}</button></Link>
        {p.manual_pin && p.geocode_source && (
          <button onClick={() => write.mutate({ path: `/api/properties/${p.id}/location`, method: "DELETE" })}>Use the address location</button>
        )}
      </div>
      {p.lat != null && (
        <>
          {(t.nearest || t.stations.length > 0 || t.destinations.length > 0 || t.pending > 0) && <Commute travel={t} />}
          {!t.nearest && t.stations.length === 0 && t.destinations.length === 0 && t.pending === 0 && (
            <div className="small muted">No stations or places chosen yet. <Link to="/places">Choose some</Link></div>
          )}
        </>
      )}
    </div>
  );
}

function SchoolsAndPlanning({ p }: { p: Detail }) {
  if (!p.overlays?.length) return null;
  const schools = p.overlays.filter((o) => o.code.includes("school"));
  const planning = p.overlays.filter((o) => !o.code.includes("school"));
  return (
    <div className="card stack">
      <h2>Schools and planning</h2>
      {schools.map((o) => <div key={o.code + o.label} className="small"><span className="muted">{o.title.replace(/ zones.*$/, "")}:</span> {o.label}</div>)}
      {planning.map((o) => (
        <div key={o.code + o.label} className="small">
          {o.effect !== "info" && <span className={`pill ${o.effect === "hard_exclude" ? "no" : "maybe"}`}>{o.effect === "hard_exclude" ? "excluded" : "check"}</span>}{" "}
          {o.label}
        </div>
      ))}
      <div className="small muted">From the region's planning and school zone data, as of the last setup run. Confirm with a planning certificate.</div>
    </div>
  );
}

// ─── per-person opinions ──────────────────────────────────────────────
function Opinions({ p }: { p: Detail }) {
  const { active, byId, me } = usePeople();
  const whose = me?.id ?? "";  // verdicts are always the selected profile's own
  const mine = p.opinions.filter((o) => o.person_id === whose);
  const [stage, setStage] = useState<Stage>(mine.some((o) => o.stage === "pre_inspection") ? "post_inspection" : "pre_inspection");
  const [note, setNote] = useState("");

  const current = (personId: string, s: Stage) => p.opinions.find((o) => o.person_id === personId && o.stage === s);

  const queryClient = useQueryClient();
  const [queuedMsg, setQueuedMsg] = useState<string | null>(null);
  async function record(stance: Stance) {
    // Through the outbox, so a verdict typed with no signal isn't lost (PLAN.md D6).
    const id = newId();
    const seen = p.opinions.find((o) => o.person_id === whose && o.stage === stage)?.id ?? null;
    try {
      const result = await sendOrQueue({
        id, method: "POST", path: `/api/properties/${p.id}/opinions`, propertyId: p.id,
        label: `${active.find((x) => x.id === whose)?.display_name}: ${LABEL.stance[stance]} (${LABEL.stageShort[stage]}) for ${p.address}`,
        body: { id, person_id: whose, stage, stance, note: note.trim() || null, recorded_at: new Date().toISOString(),
                check_latest: true, expected_latest_id: seen },
      });
      setNote("");
      setQueuedMsg(result === "queued" ? "No signal: saved on this phone, sends when you're back online." : null);
      queryClient.invalidateQueries({ queryKey: ["property", p.id] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) {
      setQueuedMsg((e as Error).message);
    }
  }

  return (
    <div className="card stack">
      <h2>Opinions</h2>
      <div className="people">
        {active.map((person) => (
          <div key={person.id}>
            <strong><span className="dot" style={{ background: person.colour }} />{person.display_name}</strong>
            {!current(person.id, "pre_inspection") && !current(person.id, "post_inspection") && <div className="small muted">No verdict yet</div>}
            {(["pre_inspection", "post_inspection"] as const).filter((s) => current(person.id, s)).map((s) => {
              const o = current(person.id, s);
              return (
                <div key={s} className="small">
                  {LABEL.stage[s]}:{" "}
                  {o ? <><span className={`pill ${o.stance}`}>{LABEL.stance[o.stance]}</span> {o.note}</> : <span className="muted">—</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <div className="small"><strong><span className="dot" style={{ background: me?.colour }} />Your verdict</strong>
          <span className="muted"> as {me?.display_name}</span></div>
        <div className="segmented" role="radiogroup" aria-label="When">
          {(["pre_inspection", "post_inspection"] as const).map((s) => (
            <button key={s} role="radio" aria-checked={stage === s} className={stage === s ? "on" : ""} onClick={() => setStage(s)}>
              {s === "pre_inspection" ? "Before inspecting" : "After: pursue to buy?"}</button>
          ))}
        </div>
        <textarea placeholder="Note (optional). Dictate it." value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="stance">
          {(["yes", "maybe", "no"] as const).map((s) => (
            <button key={s} className={`on ${s}`} disabled={!whose} onClick={() => record(s)}>
              {LABEL.stance[s]}
            </button>
          ))}
        </div>
        {queuedMsg && <p className="small muted">{queuedMsg}</p>}
      </div>

      {p.opinions.length > 0 && (
        <details>
          <summary>History ({p.opinions.length})</summary>
          <ul className="history small">
            {p.opinions.map((o) => (
              <li key={o.id}>
                <span className="dot" style={{ background: byId.get(o.person_id)?.colour }} />
                {byId.get(o.person_id)?.display_name} · {LABEL.stageShort[o.stage]}{" "}
                <span className={`pill ${o.stance}`}>{LABEL.stance[o.stance]}</span> · {when(o.recorded_at)}
                {o.created_by !== o.person_id && <span className="muted"> (entered by {byId.get(o.created_by)?.display_name})</span>}
                {o.note && <div>{o.note}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ─── campaigns ────────────────────────────────────────────────────────
function NewCampaign({ p }: { p: Detail }) {
  const write = useWrite(p.id);
  const [method, setMethod] = useState<SaleMethod>("auction");
  const relist = p.campaigns.length > 0;
  return (
    <div className="card stack">
      <h2>{relist ? "Relisted?" : "Not listed yet"}</h2>
      <p className="muted small">
        {relist ? "Start a new campaign. It links to the previous one, so the price history carries over." : "Add the campaign when it goes on the market."}
      </p>
      <div className="row">
        <select className="grow" value={method} onChange={(e) => setMethod(e.target.value as SaleMethod)}>
          {(["auction", "eoi", "private_sale", "other"] as const).map((m) => <option key={m} value={m}>{LABEL.method[m]}</option>)}
        </select>
        <button className="primary" disabled={write.isPending}
          onClick={() => write.mutate({ path: `/api/properties/${p.id}/campaigns`, body: { sale_method: method } })}>
          Start campaign
        </button>
      </div>
      {write.error && <p className="error">{(write.error as Error).message}</p>}
    </div>
  );
}

/** The Price & sale tab for a live campaign: the sale up top, the price story on the left, our side on the right. */
function SaleTab({ p, c, showChart }: { p: Detail; c: Campaign; showChart: boolean }) {
  const write = useWrite(p.id);
  const { byId } = usePeople();
  const at = c.sale_method === "auction" ? c.auction_at : c.sale_method === "eoi" ? c.eoi_closes_at : null;
  const soon = countdown(at);
  const listedDays = c.listed_on ? Math.max(0, Math.round((Date.now() - new Date(c.listed_on).getTime()) / 86400_000)) : null;
  const latest = (k: JudgementKind) => c.judgements.find((j) => j.kind === k);
  return (
    <>
      <div className="card sale-hero">
        <div className="sale-hero-main">
          <div className="section-title" style={{ marginTop: 0 }}>{LABEL.method[c.sale_method]}</div>
          <div className="sale-when-big">{at ? saleWhen(c) : c.sale_method === "private_sale" ? "Private sale" : "No date yet"}</div>
          <div className="row small">
            {soon && <span className={`pill tone-${soonTone(at)}`}>{soon}</span>}
            {listedDays != null && <span className="muted">Listed {listedDays} {listedDays === 1 ? "day" : "days"} ago</span>}
            {c.links.map((l) => (
              <a key={l.id} className="pill link-pill" href={l.url} target="_blank" rel="noreferrer">
                {l.portal === "rea" ? "realestate.com.au" : l.portal === "domain" ? "domain.com.au" : new URL(l.url).hostname} ↗</a>
            ))}
          </div>
          <PriceFacts p={p} c={c} />
        </div>
        {c.sale_method === "auction" && (
          <div className="sale-hero-side"><Link to={`/auction/${c.id}`}><button className="primary"><Gavel /> Auction day mode</button></Link></div>
        )}
        <div className="sale-hero-edit">
          <CampaignDates propertyId={p.id} c={c} />
          <details>
            <summary>Listing links</summary>
            {c.links.map((l) => (
              <div key={l.id} className="row small">
                <a className="grow" href={l.url} target="_blank" rel="noreferrer">{l.url}</a>
                <button className="link" onClick={() => write.mutate({ path: `/api/links/${l.id}`, method: "DELETE" })}>Remove</button>
              </div>
            ))}
            <AddLink propertyId={p.id} campaignId={c.id} />
          </details>
          <RecordOutcome propertyId={p.id} c={c} />
        </div>
      </div>

      <div className="card">
        <h2>Price history</h2>
        {showChart && <PriceHistory campaigns={p.campaigns} />}
        <GuideTable c={c} />
        <AddGuide propertyId={p.id} campaignId={c.id} />
      </div>
          <div className="card">
            <h2>Our numbers</h2>
            <p className="small muted" style={{ marginTop: 0 }}>Shared between you both. Each change is kept.</p>
            <div className="numbers">
              {(["expected_sale", "walk_away"] as const).map((k) => {
                const j = latest(k), all = c.judgements.filter((x) => x.kind === k);
                return (
                  <div key={k} className="number-tile">
                    <div className="muted small">{LABEL.judgement[k]}</div>
                    <SetJudgement propertyId={p.id} campaignId={c.id} kind={k} current={j?.amount_aud ?? null} />
                    {j && <div className="muted tiny">{byId.get(j.created_by)?.display_name}, {day(j.created_at)}</div>}
                    {all.length > 1 && (
                      <details><summary className="tiny">{all.length - 1} earlier</summary>
                        {all.slice(1).map((x) => <div key={x.id} className="tiny">{money(x.amount_aud)} · {byId.get(x.created_by)?.display_name}, {day(x.created_at)}</div>)}
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
            <CostAt campaign={c} />
          </div>
      <div className="tab-grid">
        <div>
          <div className="card">
            <h2>{c.agents.length === 1 ? "Agent" : "Agents"}</h2>
            {c.agents.length === 0 && <p className="small muted" style={{ margin: 0 }}>None recorded yet.</p>}
            {c.agents.map((a) => (
              <div key={a.id} className="agent-row">
                <div><strong>{a.name}</strong>{a.is_lead && c.agents.length > 1 && <span className="pill" style={{ marginLeft: 6 }}>lead</span>}</div>
                {a.agency_name && <div className="muted small">{a.agency_name}{a.office ? ` ${a.office}` : ""}</div>}
                <div className="row small">
                  {a.mobile && <a href={`tel:${a.mobile.replace(/\s/g, "")}`}>{a.mobile}</a>}
                  {a.email && <a href={`mailto:${a.email}`}>{a.email}</a>}
                </div>
              </div>
            ))}
            <AddAgent propertyId={p.id} campaignId={c.id} />
          </div>
        </div>
        <div>
          <div className="card"><Checklist campaignId={c.id} /></div>
          <div className="card"><Comparables campaignId={c.id} /></div>
        </div>
      </div>
      {write.error && <p className="error">{(write.error as Error).message}</p>}
    </>
  );
}

/** Every guide, newest first, with the change from the one before. */
function GuideTable({ c }: { c: Campaign }) {
  const { byId } = usePeople();
  if (!c.price_guides.length) return <p className="small muted">No guide recorded yet.</p>;
  return (
    <table className="history-table small">
      <thead><tr><th>Seen</th><th>Guide</th><th>Change</th><th>Source</th><th>By</th></tr></thead>
      <tbody>
        {c.price_guides.map((g, i) => {
          const prev = c.price_guides[i + 1];
          const mid = (x: { low_aud: number; high_aud: number }) => (x.low_aud + x.high_aud) / 2;
          const delta = prev ? Math.round(mid(g) - mid(prev)) : null;
          return (
            <tr key={g.id}>
              <td>{day(g.observed_at)}</td>
              <td><strong>{moneyRange(g.low_aud, g.high_aud)}</strong>{g.note && <div className="muted">{g.note}</div>}
                {g.statement_suburb_median_aud && <div className="muted">suburb median {money(g.statement_suburb_median_aud)}</div>}</td>
              <td className={delta == null || delta === 0 ? "muted" : `tone-${changeTone(delta)}`}>
                {delta == null ? "first" : delta === 0 ? "same" : `${delta > 0 ? "↑" : "↓"} ${money(Math.abs(delta))}`}</td>
              <td>{LABEL.guideSource[g.source]}</td>
              <td>{byId.get(g.created_by)?.display_name}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** An earlier campaign: how it ended and what the guides were. */
function PastCampaign({ c }: { c: Campaign }) {
  return (
    <div className="past-campaign">
      <div className="row">
        <strong className="grow">{LABEL.method[c.sale_method]}{c.outcome && ` · ${LABEL.outcome[c.outcome]}`}</strong>
        <span className="small muted">{day(c.outcome_on)}</span>
      </div>
      <div className="small">
        {c.sold_price_aud != null && <>Sold {money(c.sold_price_aud)}</>}
        {c.passed_in_bid_aud != null && <>Passed in at {money(c.passed_in_bid_aud)}</>}
        {c.bought_by_us && <> · bought by us <PartyPopper /></>}
      </div>
      <GuideTable c={c} />
    </div>
  );
}

function CampaignDates({ propertyId, c }: { propertyId: string; c: Campaign }) {
  const write = useWrite(propertyId);
  const [method, setMethod] = useState(c.sale_method);
  const [at, setAt] = useState(toLocalInput(c.sale_method === "eoi" ? c.eoi_closes_at : c.auction_at));
  const [listed, setListed] = useState(c.listed_on ?? "");
  return (
    <details>
      <summary>Method and dates</summary>
      <div className="stack">
        <select value={method} onChange={(e) => setMethod(e.target.value as SaleMethod)}>
          {(["auction", "eoi", "private_sale", "other"] as const).map((m) => <option key={m} value={m}>{LABEL.method[m]}</option>)}
        </select>
        {(method === "auction" || method === "eoi") && (
          <label>{method === "auction" ? "Auction" : "EOI closes"}<input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>
        )}
        <label>Listed on<input type="date" value={listed} onChange={(e) => setListed(e.target.value)} /></label>
        <button
          disabled={write.isPending}
          onClick={() =>
            write.mutate({
              path: `/api/campaigns/${c.id}`, method: "PATCH",
              body: {
                sale_method: method, listed_on: listed || null,
                auction_at: method === "auction" ? fromLocalInput(at) : null,
                eoi_closes_at: method === "eoi" ? fromLocalInput(at) : null,
              },
            })
          }
        >
          Save dates
        </button>
      </div>
    </details>
  );
}

function AddLink({ propertyId, campaignId }: { propertyId: string; campaignId: string }) {
  const write = useWrite(propertyId);
  const [url, setUrl] = useState("");
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <input className="grow" type="url" placeholder="Paste a listing link" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button disabled={!url.trim() || write.isPending}
        onClick={() => write.mutate({ path: `/api/campaigns/${campaignId}/links`, body: { url: url.trim() } }, { onSuccess: () => setUrl("") })}>
        Add
      </button>
      {write.error && <p className="error small">{(write.error as Error).message}</p>}
    </div>
  );
}

function AddGuide({ propertyId, campaignId }: { propertyId: string; campaignId: string }) {
  const write = useWrite(propertyId);
  const [source, setSource] = useState<GuideSource>("price_statement");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");
  const [median, setMedian] = useState("");
  const [note, setNote] = useState("");
  const [seen, setSeen] = useState("");
  const lowAud = parseMoney(low);
  return (
    <details>
      <summary>Record a new price or guide</summary>
      <div className="stack">
        <select value={source} onChange={(e) => setSource(e.target.value as GuideSource)}>
          {(Object.keys(LABEL.guideSource) as GuideSource[]).map((s) => <option key={s} value={s}>{LABEL.guideSource[s]}</option>)}
        </select>
        <div className="grid2">
          <label>From<input placeholder="1.2m" value={low} onChange={(e) => setLow(e.target.value)} /></label>
          <label>To<input placeholder="1.3m" value={high} onChange={(e) => setHigh(e.target.value)} /></label>
        </div>
        {source === "price_statement" && <label>Suburb median<input value={median} onChange={(e) => setMedian(e.target.value)} /></label>}
        <label>Date seen (leave blank for today)<input type="date" value={seen} onChange={(e) => setSeen(e.target.value)} /></label>
        <input placeholder="Note, e.g. &quot;vendor wants 1.3+&quot;" value={note} onChange={(e) => setNote(e.target.value)} />
        {write.error && <p className="error small">{(write.error as Error).message}</p>}
        <button
          disabled={lowAud == null || write.isPending}
          onClick={() =>
            write.mutate(
              { path: `/api/campaigns/${campaignId}/price-guides`,
                body: { source, low_aud: lowAud, high_aud: parseMoney(high), statement_suburb_median_aud: parseMoney(median), note: note || null,
                        observed_at: seen ? new Date(`${seen}T12:00`).toISOString() : null } },
              { onSuccess: () => { setLow(""); setHigh(""); setMedian(""); setNote(""); setSeen(""); } },
            )
          }
        >
          Save guide
        </button>
      </div>
    </details>
  );
}

/** One of our figures, shown large and changed in place: click it, type ("1.15m"), Enter. */
function SetJudgement({ propertyId, campaignId, kind, current }: { propertyId: string; campaignId: string; kind: JudgementKind; current: number | null }) {
  const write = useWrite(propertyId);
  const [amount, setAmount] = useState<string | null>(null);
  const aud = amount == null ? null : parseMoney(amount);
  const save = () => {
    if (aud == null || aud === current) { setAmount(null); return; }
    write.mutate({ path: `/api/campaigns/${campaignId}/price-judgements`, body: { kind, amount_aud: aud } }, { onSuccess: () => setAmount(null) });
  };
  if (amount == null) return (
    <button className="stat-value number-set" title="Change it" onClick={() => setAmount(current ? String(current) : "")}>
      {current ? money(current) : <span className="muted small">Set it</span>}</button>
  );
  return (
    <div className="row" style={{ gap: 4 }}>
      <input autoFocus className="grow" style={{ minWidth: 0 }} placeholder="1.15m" value={amount} onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setAmount(null); }} />
      <button className="primary" disabled={aud == null || write.isPending} onClick={save}>Save</button>
    </div>
  );
}

function AddAgent({ propertyId, campaignId }: { propertyId: string; campaignId: string }) {
  const write = useWrite(propertyId);
  const [f, setF] = useState({ name: "", agency_name: "", office: "", mobile: "", email: "" });
  const input = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }) });
  const blank = (v: string) => v.trim() || null;
  return (
    <details>
      <summary>Add agent</summary>
      <div className="stack">
        <input placeholder="Name" {...input("name")} />
        <div className="grid2">
          <input placeholder="Agency" {...input("agency_name")} />
          <input placeholder="Office" {...input("office")} />
        </div>
        <div className="grid2">
          <input placeholder="Mobile" inputMode="tel" {...input("mobile")} />
          <input placeholder="Email" type="email" {...input("email")} />
        </div>
        <button disabled={!f.name.trim() || write.isPending}
          onClick={() => write.mutate(
            { path: `/api/campaigns/${campaignId}/agents`,
              body: { name: f.name.trim(), agency_name: blank(f.agency_name), office: blank(f.office), mobile: blank(f.mobile), email: blank(f.email) } },
            { onSuccess: () => setF({ name: "", agency_name: "", office: "", mobile: "", email: "" }) },
          )}>
          Save agent
        </button>
      </div>
    </details>
  );
}

function RecordOutcome({ propertyId, c }: { propertyId: string; c: Campaign }) {
  const queryClient = useQueryClient();
  const p = queryClient.getQueryData<Detail>(["property", propertyId]);
  const due = !!c.listing_status || (!!(c.auction_at ?? c.eoi_closes_at) && new Date((c.auction_at ?? c.eoi_closes_at)!).getTime() < Date.now());
  return (
    <details open={due}>
      <summary>{due ? <strong>How did it end? Record the outcome</strong> : "Record outcome"}</summary>
      <OutcomeForm propertyId={propertyId} campaignId={c.id} saleMethod={c.sale_method} status={p?.status ?? "watching"}
        latestStatusId={p?.status_history[0]?.id ?? null} listingStatus={c.listing_status} listingPriceText={c.listing_price_text} />
    </details>
  );
}


/** A public transport journey, leg by leg: "Leave 8:26 am · walk 3 min → Lilydale train 20 min → … · arrive 8:51 am". */
