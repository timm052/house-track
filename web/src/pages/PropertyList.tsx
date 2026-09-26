// Houses (phone-first). Built on the same rows, filters and shared saved views as Overview (D18),
// with quick filter chips and a sort picker for one-handed use.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, whilePending } from "../api";
import { LABEL, landArea, money, moneyRange } from "../format";
import { STATUSES } from "../api";
import { catalogue, display, type Column, type OverviewPlace, type OverviewRow } from "../overview/columns";
import { applyView, builtInDefault, describe, useViews, type Filter, type Sort } from "../overview/views";
import FilterPopover from "../overview/FilterPopover";
import { usePeople } from "../people";
import { CLOSED, STATUS_COLOUR, budgetTone, changeTone, minutesTone, soonTone, suburbClass, suburbSlots, tagStyle, useTagColours } from "../colour";
import { ChevronDown, ChevronRight, Scale } from "lucide-react";
import { useNeeds } from "./ThisWeek";
import { statusOutOfStep } from "../Outcome";
import type { Outcome, Status } from "../api";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[]; pending?: number };
type Quick = { thisWeek: boolean; statuses: string[]; methods: string[]; myVerdicts: string[]; hideExcluded: boolean;
               suburbs: string[]; tags: string[]; affordable: boolean };
const NO_QUICK: Quick = { thisWeek: false, statuses: [], methods: [], myVerdicts: [], hideExcluded: false, suburbs: [], tags: [], affordable: false };

export default function PropertyList() {
  const { all: persons, active, me } = usePeople();
  const { data, isPending, isError } = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview"), refetchInterval: whilePending });
  const views = useViews();
  const cols = useMemo(() => catalogue(persons, data?.places ?? []), [persons, data?.places]);
  const favourites = (data?.places ?? []).filter((p) => p.kind === "destination" && p.is_favourite);

  const [viewId, setViewId] = useState<string | null>(null);
  const view = views.data?.find((v) => v.id === viewId) ?? views.data?.find((v) => v.is_default) ?? builtInDefault(cols);
  const [sortKey, setSortKey] = useState<string>("");
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState<Quick>(NO_QUICK);
  const [extra, setExtra] = useState<Filter[]>([]);
  const [picking, setPicking] = useState<string>("");

  // Several choices within one chip group mean "any of"; different groups must all match.
  const filters: Filter[] = [...(quick.statuses.length ? view.filters.filter((f) => f.column !== "status") : view.filters), ...extra];
  if (quick.statuses.length) filters.push({ column: "status", op: "in", value: quick.statuses });
  if (quick.thisWeek) filters.push({ column: "sale_at", op: "thisweek" });
  if (quick.methods.length) filters.push({ column: "sale_method", op: "in", value: quick.methods });
  if (quick.suburbs.length) filters.push({ column: "suburb", op: "in", value: quick.suburbs });
  if (quick.tags.length) filters.push({ column: "tags", op: "in", value: quick.tags });
  if (quick.hideExcluded) filters.push({ column: "excluded", op: "in", value: ["false"] });
  if (quick.affordable) filters.push({ column: "budget", op: "in", value: ["within", "stretch"] });
  const verdictRows = new Set(me && quick.myVerdicts.length ? (data?.rows ?? []).filter((r) => {
    const v = (r[`v:${me.id}:post`] ?? r[`v:${me.id}:pre`]) as string | undefined;
    return quick.myVerdicts.includes(v ?? "unset");
  }).map((r) => r.id) : []);
  const sort: Sort[] = sortKey ? [{ column: sortKey, dir: ["created_at", "score_avg"].includes(sortKey) ? "desc" : "asc" }] : view.sort;
  const filterKey = JSON.stringify(filters), sortJson = JSON.stringify(sort);
  const rows = useMemo(() => applyView(data?.rows ?? [], filters, sort, search, cols)
    .filter((r) => !quick.myVerdicts.length || verdictRows.has(r.id)),
    [data, filterKey, sortJson, search, cols, quick.myVerdicts]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagNames = [...new Set((data?.rows ?? []).flatMap((r) => (r.tags as string[] | undefined) ?? []))].sort();
  const suburbs = [...new Set((data?.rows ?? []).map((r) => String(r.suburb)))].sort();
  const slots = useMemo(() => suburbSlots(data?.rows ?? []), [data]);
  const tagColours = useTagColours();
  const flip = (k: "statuses" | "methods" | "myVerdicts" | "suburbs" | "tags", v: string) =>
    setQuick({ ...quick, [k]: quick[k].includes(v) ? quick[k].filter((x) => x !== v) : [...quick[k], v] });
  const filtering = Object.values(quick).some((v) => (Array.isArray(v) ? v.length : v)) || extra.length > 0;
  // Everything but status lives under "More filters"; the badge counts what's switched on in there.
  const moreCount = Number(quick.thisWeek) + Number(quick.hideExcluded) + Number(quick.affordable) + quick.methods.length + quick.myVerdicts.length
    + quick.suburbs.length + quick.tags.length + extra.length;
  const [moreOpen, setMoreOpen] = useState(false);
  const needs = useNeeds(data?.rows ?? [], me);
  // Inspected: someone has been to an inspection there, or given a verdict after one.
  const inspected = (r: OverviewRow) => ((r.attended_by as string[] | undefined)?.length ?? 0) > 0
    || persons.some((p) => r[`v:${p.id}:post`] != null);
  const toSee = rows.filter((r) => !inspected(r)), seenRows = rows.filter(inspected);
  const [showInspected, setShowInspected] = useState(() => { try { return localStorage.getItem("housetrack.showInspected") !== "0"; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem("housetrack.showInspected", showInspected ? "1" : "0"); } catch { /* ignore */ } }, [showInspected]);
  const card = (r: OverviewRow) => <Card key={r.id} r={r} people={active} favourites={favourites} cols={cols} slots={slots} tagColours={tagColours}
    picked={comparing ? comparing.includes(r.id) : undefined} onPick={pick} />;
  // Compare: tap "Compare", tap up to four cards, then open them side by side.
  const navigate = useNavigate();
  const [comparing, setComparing] = useState<string[] | null>(null);
  const pick = (id: string) => comparing && setComparing(comparing.includes(id) ? comparing.filter((x) => x !== id)
    : comparing.length < 4 ? [...comparing, id] : comparing);
  const byKey = new Map(cols.map((c) => [c.key, c]));

  return (
    <>
      <SharedLinks />
      {needs.count > 0 && (
        <Link to="/week" className="week-nudge">
          <span className="count-badge">{needs.count}</span>
          {needs.count === 1 ? "thing needs" : "things need"} you: {[needs.needsOutcome.length && `${needs.needsOutcome.length} to record how the sale ended`,
            needs.outOfStep.length && `${needs.outOfStep.length} ${needs.outOfStep.length === 1 ? "status" : "statuses"} to update`,
            needs.needsVerdict.length && `${needs.needsVerdict.length} ${needs.needsVerdict.length === 1 ? "verdict" : "verdicts"} to give`].filter(Boolean).join(", ")}
          <span className="grow" /><span>This week →</span>
        </Link>
      )}
      <div className="toolbar">
        <input className="search" type="search" placeholder="Search address, agent, notes" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className={`icon-btn ${comparing ? "on" : ""}`} aria-pressed={comparing != null} title="Pick houses to compare"
          onClick={() => setComparing(comparing ? null : [])}><Scale /><span className="label">Compare</span></button>
        <Link to="/add"><button className="primary">+ Add house</button></Link>
      </div>
      <div className="filter-bar">
        <select value={view.id ?? ""} onChange={(e) => setViewId(e.target.value || null)} aria-label="View">
          {!views.data?.some((v) => v.is_default) && <option value="">Active houses</option>}
          {views.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} aria-label="Sort">
          <option value="">Sort: view's order</option>
          <option value="sale_at">Sort: auction / EOI date</option>
          <option value="guide_high">Sort: guide price</option>
          <option value="created_at">Sort: newest first</option>
          <option value="score_avg">Sort: best score</option>
          <option value="nearest_station_walk">Sort: walk to station</option>
          <option value="nearest_station_drive">Sort: drive to station</option>
          {favourites.map((f) => <option key={f.id} value={`drive:${f.id}`}>Sort: drive to {f.name}</option>)}
        </select>
        <button className={`chip ${moreOpen || moreCount ? "on" : ""}`} aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
          More filters{moreCount > 0 && <span className="count-badge">{moreCount}</span>}
        </button>
        <span className="small muted grow" style={{ textAlign: "right" }}>
          {rows.length === (data?.rows.length ?? 0) ? `${rows.length} houses` : `${rows.length} of ${data?.rows.length ?? 0} houses`}
          {filtering && <> · <button className="link" onClick={() => { setQuick(NO_QUICK); setExtra([]); }}>Clear filters</button></>}
        </span>
      </div>
      <div className="chips" aria-label="Status">
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${quick.statuses.includes(s) ? "on" : ""}`} onClick={() => flip("statuses", s)}>
            <span className="status-dot" style={{ background: STATUS_COLOUR[s], marginRight: 6 }} />{LABEL.status[s]}</button>
        ))}
      </div>
      {moreOpen && (
        <div className="card stack" style={{ marginTop: 8 }}>
          <div>
            <div className="section-title" style={{ marginTop: 0 }}>Sale</div>
            <div className="chips">
              <button className={`chip ${quick.thisWeek ? "on" : ""}`} onClick={() => setQuick({ ...quick, thisWeek: !quick.thisWeek })}>This week</button>
              {(["auction", "eoi", "private_sale"] as const).map((m) => (
                <button key={m} className={`chip ${quick.methods.includes(m) ? "on" : ""}`} onClick={() => flip("methods", m)}>{LABEL.method[m]}</button>
              ))}
              {(data?.rows ?? []).some((r) => r.budget) && (
                <button className={`chip ${quick.affordable ? "on" : ""}`} onClick={() => setQuick({ ...quick, affordable: !quick.affordable })}>
                  Hide over budget</button>
              )}
            </div>
          </div>
          <div>
            <div className="section-title">My verdict</div>
            <div className="chips">
              {(["yes", "maybe", "no", "unset"] as const).map((v) => (
                <button key={v} className={`chip ${quick.myVerdicts.includes(v) ? "on" : ""}`} onClick={() => flip("myVerdicts", v)}>
                  {v === "unset" ? "No verdict yet" : LABEL.stance[v]}
                </button>
              ))}
              <button className={`chip ${quick.hideExcluded ? "on" : ""}`} onClick={() => setQuick({ ...quick, hideExcluded: !quick.hideExcluded })}>Hide my excluded</button>
            </div>
          </div>
          {suburbs.length > 1 && (
            <div>
              <div className="section-title">Suburb</div>
              <div className="chips">
                {suburbs.map((s) => (
                  <button key={s} className={`chip ${suburbClass(slots, s)} ${quick.suburbs.includes(s) ? "on" : ""}`} onClick={() => flip("suburbs", s)}>
                    <span className="suburb-swatch" />{s}</button>
                ))}
              </div>
            </div>
          )}
          {tagNames.length > 0 && (
            <div>
              <div className="section-title">Tags</div>
              <div className="chips">
                {tagNames.map((t) => (
                  <button key={t} className={`chip ${quick.tags.includes(t) ? "on" : ""}`} style={quick.tags.includes(t) ? undefined : tagStyle(tagColours, t)}
                    onClick={() => flip("tags", t)}>#{t}</button>
                ))}
              </div>
            </div>
          )}
          <div className="row small">
            <select value={picking} onChange={(e) => setPicking(e.target.value)} aria-label="Filter on another field" style={{ width: "auto" }}>
              <option value="">+ Filter on any field…</option>
              {cols.filter((c) => !["address"].includes(c.key)).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            {extra.map((f, i) => (
              <span key={i} className="pill">{describe(f, byKey.get(f.column))}{" "}
                <button className="link" onClick={() => setExtra(extra.filter((_, j) => j !== i))} aria-label="Remove filter">✕</button></span>
            ))}
          </div>
        </div>
      )}
      {picking && byKey.get(picking) && (
        <FilterPopover col={byKey.get(picking)!} rows={data?.rows ?? []} at={{ x: 16, y: 160 }}
          existing={extra.find((f) => f.column === picking)}
          onApply={(fs) => { setExtra([...extra.filter((f) => f.column !== picking), ...fs]); setPicking(""); }}
          onClose={() => setPicking("")} />
      )}
      {isPending && <p className="muted">Loading…</p>}
      {isError && <p className="error">Couldn't load houses.</p>}
      {data && data.rows.length === 0 && <div className="card"><p>No houses yet.</p><Link to="/add">Add the first one</Link></div>}
      {data && data.rows.length > 0 && rows.length === 0 && (
        <div className="card empty">No houses match these filters. <button className="link" onClick={() => { setQuick(NO_QUICK); setExtra([]); setSearch(""); }}>Clear filters</button></div>
      )}
      {/* Houses nobody has inspected yet come first; the ones you've been through sit in their own section. */}
      <div className="card-grid">{toSee.map(card)}</div>
      {seenRows.length > 0 && (
        <section className="inspected-section">
          <button className="section-toggle" aria-expanded={showInspected} onClick={() => setShowInspected(!showInspected)}>
            {showInspected ? <ChevronDown /> : <ChevronRight />} Inspected <span className="muted">({seenRows.length})</span>
          </button>
          {showInspected && <div className="card-grid">{seenRows.map(card)}</div>}
        </section>
      )}
      {comparing && (
        <div className="compare-bar" role="status">
          <span className="grow">{comparing.length ? `${comparing.length} of up to 4 picked` : "Tap the houses to compare (up to 4)"}</span>
          <button onClick={() => setComparing(null)}>Cancel</button>
          <button className="primary" disabled={comparing.length < 2} onClick={() => navigate(`/compare?ids=${comparing.join(",")}`)}>Compare</button>
        </div>
      )}
    </>
  );
}

/** The cover photo, then: address and status; rooms and travel; sale and price; verdicts (once there are any).
 *  Long-press shows the agent. */
function Card({ r, people, favourites, cols, slots, tagColours, picked, onPick }: {
  r: OverviewRow; people: { id: string; display_name: string; colour: string }[]; favourites: OverviewPlace[]; cols: Column[];
  slots: Map<string, number>; tagColours: Map<string, string>;
  picked?: boolean; onPick: (id: string) => void;  // picked is undefined when not choosing houses to compare
}) {
  const [agent, setAgent] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const col = (k: string) => cols.find((c) => c.key === k)!;
  const n = (k: string) => (r[k] as number | null) ?? null;
  const line2 = [
    [r.beds != null && `${r.beds} bed`, r.baths != null && `${r.baths} bath`, r.car_spaces != null && `${r.car_spaces} car`].filter(Boolean).join(" "),
    r.land_m2 != null && `${landArea(Number(r.land_m2))} land`,
    r.property_type !== "house" && display(col("property_type"), r.property_type),
    r.nearest_station && <>{r.nearest_station_walk != null && <><span className={`tone-${minutesTone(r.nearest_station_walk)}`}>{String(r.nearest_station_walk)} min</span> walk</>}
      {r.nearest_station_walk != null && r.nearest_station_drive != null && " · "}
      {r.nearest_station_drive != null && <><span className={`tone-${minutesTone(r.nearest_station_drive, "drive")}`}>{String(r.nearest_station_drive)} min</span> drive</>}
      {" "}to {String(r.nearest_station)}</>,
    ...favourites.filter((f) => r[`drive:${f.id}`] != null || r[`transit:${f.id}`] != null).map((f) => <>
      {r[`drive:${f.id}`] != null && <><span className={`tone-${minutesTone(r[`drive:${f.id}`], "drive")}`}>{String(r[`drive:${f.id}`])} min</span> drive</>}
      {r[`drive:${f.id}`] != null && r[`transit:${f.id}`] != null && " · "}
      {r[`transit:${f.id}`] != null && <><span className={`tone-${minutesTone(r[`transit:${f.id}`], "transit")}`}>{String(r[`transit:${f.id}`])} min</span> public transport</>}
      {" "}to {f.name}</>),
    r.days_on_market != null && r.sale_method && `${r.days_on_market} ${r.days_on_market === 1 ? "day" : "days"} listed`,
  ].filter(Boolean) as ReactNode[];
  const change = n("guide_change");
  // The campaign has an outcome but the house still looks active: nudge whoever looks next.
  const staleStatus = statusOutOfStep(r.outcome as Outcome, Boolean(r.bought_by_us), r.status as Status);
  const sale = r.outcome
    ? `${display(col("outcome"), r.outcome)}${r.sold_price_aud ? ` ${money(n("sold_price_aud"))}` : ""}`
    : r.sale_at ? `${display(col("sale_method"), r.sale_method)} ${display(col("sale_at"), r.sale_at)}`
    : r.sale_method ? display(col("sale_method"), r.sale_method) : "Not listed";
  return (
    <Link to={`/p/${r.id}`} className={`card property-card tint ${suburbClass(slots, r.suburb)} ${r.excluded || CLOSED.includes(r.status as never) ? "dim" : ""} ${picked ? "picked" : ""}`}
      onClick={(e) => { if (picked !== undefined) { e.preventDefault(); onPick(r.id); } }} aria-pressed={picked}
      onTouchStart={() => { timer.current = window.setTimeout(() => setAgent(true), 500); }}
      onTouchEnd={() => window.clearTimeout(timer.current)}
      onContextMenu={(e) => { if (r.agent_phone) { e.preventDefault(); setAgent(true); } }}>
      <div className="card-thumb" aria-hidden>
        {r.cover_id ? <img src={`/api/attachments/${String(r.cover_id)}/thumb`} alt="" loading="lazy" /> : (
          <svg viewBox="0 0 32 32"><path d="M7.5 15.5 16 8.5l8.5 7M10.5 13.5v10h11v-10M14.2 23.5v-5h3.6v5" /></svg>
        )}
      </div>
      <div className="card-body">
      <div className="row">
        <span className="address grow">{String(r.address)}, <span className="suburb-name">{String(r.suburb)}</span></span>
        {Boolean(r.excluded) && <span className="pill no">Excluded</span>}
        <span className="pill status-pill"><span className="status-dot" style={{ background: STATUS_COLOUR[r.status as never] }} />{display(col("status"), r.status)}</span>
      </div>
      <div className="muted small">{line2.map((part, i) => <Fragment key={i}>{i > 0 && " · "}{part}</Fragment>)}</div>
      <div className="row small" style={{ marginTop: 4 }}>
        <span className={`grow ${!r.outcome ? `tone-${soonTone(r.sale_at)}` : ""}`}>{sale}</span>
        <span className={n("guide_low") == null ? "muted" : "price"}>{moneyRange(n("guide_low"), n("guide_high"))}</span>
        {change != null && change !== 0 && <span className={`pill tone-${changeTone(change)}`}>guide {change > 0 ? "↑" : "↓"} {money(Math.abs(change))}</span>}
        {r.walk_away != null && <span className="pill">our max {money(n("walk_away"))}</span>}
        {(r.budget === "over" || r.budget === "stretch") && (
          <span className={`pill tone-${budgetTone(r.budget)}`} title="Guide against the most you can bid. Set it in Settings.">
            {r.budget === "over" ? "Over budget" : "Stretch"}</span>
        )}
      </div>
      {staleStatus && <div className="small tone-warn" style={{ marginTop: 4 }}>Sale's over. Update the status.</div>}
      {Boolean(r.needs_outcome) && <div className="small tone-warn" style={{ marginTop: 4 }}>
        {r.listing_status ? `The listing says ${String(r.listing_status).replace(/_/g, " ")}` : "The sale date has passed"}. Record the outcome.</div>}
      {(r.score_avg != null || people.some((p) => r[`v:${p.id}:post`] ?? r[`v:${p.id}:pre`])) && (
      <div className="row small" style={{ marginTop: 6 }}>
        {r.score_avg != null && <span className="pill score-pill" title="Average score out of 100">Score {String(r.score_avg)}</span>}
        {people.map((p) => {
          const post = r[`v:${p.id}:post`] as string | undefined, pre = r[`v:${p.id}:pre`] as string | undefined;
          const v = post ?? pre;
          return v ? (
            <span key={p.id}>
              <span className="dot" style={{ background: p.colour }} />{p.display_name}{" "}
              <span className={`pill ${v}`} title={post ? "After inspecting" : "Before inspecting"}>{LABEL.stance[v as "yes"]}{!post && <span className="muted"> · pre</span>}</span>
            </span>
          ) : null;
        })}
      </div>
      )}
      {((r.tags as string[] | undefined) ?? []).length > 0 && (
        <div style={{ marginTop: 4 }}>{(r.tags as string[]).map((t) => <span key={t} className="tag" style={tagStyle(tagColours, t)}>#{t}</span>)}</div>
      )}
      {agent && Boolean(r.agent_phone) && (
        <div className="small" onClick={(e) => e.stopPropagation()}>
          {String(r.agent_name ?? "Agent")}: <a href={`tel:${String(r.agent_phone).replace(/\s/g, "")}`}>{String(r.agent_phone)}</a>
        </div>
      )}
      </div>
    </Link>
  );
}


type SharedLink = { id: string; url: string; shared_by: string | null; shared_at: string };

/** Listings shared from a phone that couldn't become a house on their own (the link had no address in it). */
function SharedLinks() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { byId } = usePeople();
  const { data = [] } = useQuery({ queryKey: ["shared-links"], queryFn: () => api<SharedLink[]>("/api/shared-links") });
  if (!data.length) return null;
  const where = (u: string) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + x.pathname; } catch { return u; } };
  async function dismiss(id: string) {
    await api(`/api/shared-links/${id}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: ["shared-links"] });
  }
  return (
    <div className="card stack shared-links">
      <strong>Shared from a phone, still to add</strong>
      {data.map((l) => (
        <div key={l.id} className="row small">
          <span className="grow" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <a href={l.url} target="_blank" rel="noreferrer">{where(l.url)}</a>
            {l.shared_by && <span className="muted"> · {byId.get(l.shared_by)?.display_name}</span>}</span>
          <button className="primary small-btn" onClick={() => navigate(`/add?url=${encodeURIComponent(l.url)}`)}>Add</button>
          <button className="small-btn" onClick={() => dismiss(l.id)}>Dismiss</button>
        </div>
      ))}
    </div>
  );
}
