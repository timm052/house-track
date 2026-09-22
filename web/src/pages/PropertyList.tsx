// Houses (phone-first). Built on the same rows, filters and shared saved views as Overview (D18),
// with quick filter chips and a sort picker for one-handed use.
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { LABEL, money, moneyRange } from "../format";
import { STATUSES } from "../api";
import { catalogue, display, type Column, type OverviewPlace, type OverviewRow } from "../overview/columns";
import { applyView, builtInDefault, describe, useViews, type Filter, type Sort } from "../overview/views";
import FilterPopover from "../overview/FilterPopover";
import { usePeople } from "../people";
import { CLOSED, STATUS_COLOUR, changeTone, minutesTone, soonTone, suburbClass, suburbSlots, tagStyle, useTagColours } from "../colour";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[] };
type Quick = { thisWeek: boolean; statuses: string[]; methods: string[]; myVerdicts: string[]; hideExcluded: boolean;
               suburbs: string[]; tags: string[] };
const NO_QUICK: Quick = { thisWeek: false, statuses: [], methods: [], myVerdicts: [], hideExcluded: false, suburbs: [], tags: [] };

export default function PropertyList() {
  const { all: persons, active, me } = usePeople();
  const { data, isPending, isError } = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview") });
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
  const verdictRows = new Set(me && quick.myVerdicts.length ? (data?.rows ?? []).filter((r) => {
    const v = (r[`v:${me.id}:post`] ?? r[`v:${me.id}:pre`]) as string | undefined;
    return quick.myVerdicts.includes(v ?? "unset");
  }).map((r) => r.id) : []);
  const sort: Sort[] = sortKey ? [{ column: sortKey, dir: sortKey === "created_at" ? "desc" : "asc" }] : view.sort;
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
  const moreCount = Number(quick.thisWeek) + Number(quick.hideExcluded) + quick.methods.length + quick.myVerdicts.length
    + quick.suburbs.length + quick.tags.length + extra.length;
  const [moreOpen, setMoreOpen] = useState(false);
  const byKey = new Map(cols.map((c) => [c.key, c]));

  return (
    <>
      <div className="toolbar">
        <input className="search" type="search" placeholder="Search address, agent, notes" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Link to="/calendar"><button className="icon-btn" aria-label="Calendar" title="Calendar">📅<span className="label">Calendar</span></button></Link>
        <Link to="/disagree"><button className="icon-btn" aria-label="Where we disagree" title="Where we disagree">⚖<span className="label">Disagreements</span></button></Link>
        <Link to="/trends"><button className="icon-btn" aria-label="Trends" title="Trends">📈<span className="label">Trends</span></button></Link>
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
          <option value="nearest_station_walk">Sort: walk to station</option>
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
      <div className="card-grid">
        {rows.map((r) => <Card key={r.id} r={r} people={active} favourites={favourites} cols={cols} slots={slots} tagColours={tagColours} />)}
      </div>
    </>
  );
}

/** Four lines: address and status; rooms and travel; sale and price; verdicts. Long-press shows the agent. */
function Card({ r, people, favourites, cols, slots, tagColours }: {
  r: OverviewRow; people: { id: string; display_name: string; colour: string }[]; favourites: OverviewPlace[]; cols: Column[];
  slots: Map<string, number>; tagColours: Map<string, string>;
}) {
  const [agent, setAgent] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const col = (k: string) => cols.find((c) => c.key === k)!;
  const n = (k: string) => (r[k] as number | null) ?? null;
  const line2 = [
    [r.beds != null && `${r.beds} bed`, r.baths != null && `${r.baths} bath`, r.car_spaces != null && `${r.car_spaces} car`].filter(Boolean).join(" "),
    r.land_m2 != null && `${Number(r.land_m2).toLocaleString()} m² land`,
    r.property_type !== "house" && display(col("property_type"), r.property_type),
    r.nearest_station && <><span className={`tone-${minutesTone(r.nearest_station_walk)}`}>{String(r.nearest_station_walk)} min</span> walk to {String(r.nearest_station)}</>,
    ...favourites.filter((f) => r[`drive:${f.id}`] != null).map((f) =>
      <><span className={`tone-${minutesTone(r[`drive:${f.id}`], "drive")}`}>{String(r[`drive:${f.id}`])} min</span> drive to {f.name}</>),
    r.days_on_market != null && r.sale_method && `${r.days_on_market} ${r.days_on_market === 1 ? "day" : "days"} listed`,
  ].filter(Boolean) as ReactNode[];
  const change = n("guide_change");
  const sale = r.outcome
    ? `${display(col("outcome"), r.outcome)}${r.sold_price_aud ? ` ${money(n("sold_price_aud"))}` : ""}`
    : r.sale_at ? `${display(col("sale_method"), r.sale_method)} ${display(col("sale_at"), r.sale_at)}`
    : r.sale_method ? display(col("sale_method"), r.sale_method) : "Not listed";
  return (
    <Link to={`/p/${r.id}`} className={`card property-card tint ${suburbClass(slots, r.suburb)} ${r.excluded || CLOSED.includes(r.status as never) ? "dim" : ""}`}
      onTouchStart={() => { timer.current = window.setTimeout(() => setAgent(true), 500); }}
      onTouchEnd={() => window.clearTimeout(timer.current)}
      onContextMenu={(e) => { if (r.agent_phone) { e.preventDefault(); setAgent(true); } }}>
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
        {r.walk_away != null && <span className="pill">limit {money(n("walk_away"))}</span>}
      </div>
      <div className="row small" style={{ marginTop: 6 }}>
        {people.some((p) => r[`v:${p.id}:post`] ?? r[`v:${p.id}:pre`]) ? people.map((p) => {
          const post = r[`v:${p.id}:post`] as string | undefined, pre = r[`v:${p.id}:pre`] as string | undefined;
          const v = post ?? pre;
          return v ? (
            <span key={p.id}>
              <span className="dot" style={{ background: p.colour }} />{p.display_name}{" "}
              <span className={`pill ${v}`} title={post ? "After inspecting" : "Before inspecting"}>{LABEL.stance[v as "yes"]}{!post && <span className="muted"> · pre</span>}</span>
            </span>
          ) : null;
        }) : <span className="muted">No verdicts yet</span>}
      </div>
      {((r.tags as string[] | undefined) ?? []).length > 0 && (
        <div style={{ marginTop: 4 }}>{(r.tags as string[]).map((t) => <span key={t} className="tag" style={tagStyle(tagColours, t)}>#{t}</span>)}</div>
      )}
      {agent && Boolean(r.agent_phone) && (
        <div className="small" onClick={(e) => e.stopPropagation()}>
          {String(r.agent_name ?? "Agent")}: <a href={`tel:${String(r.agent_phone).replace(/\s/g, "")}`}>{String(r.agent_phone)}</a>
        </div>
      )}
    </Link>
  );
}
