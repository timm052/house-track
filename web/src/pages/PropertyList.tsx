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
  const byKey = new Map(cols.map((c) => [c.key, c]));

  return (
    <>
      <div className="row" style={{ marginTop: 12 }}>
        <input className="grow" type="search" placeholder="Search address, agent, notes" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Link to="/calendar"><button aria-label="Calendar" title="Calendar">📅</button></Link>
        <Link to="/disagree"><button aria-label="Where we disagree" title="Where we disagree">⚖</button></Link>
        <Link to="/trends"><button aria-label="Trends" title="Trends">📈</button></Link>
        <Link to="/add"><button className="primary">+ Add</button></Link>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <select className="grow" value={view.id ?? ""} onChange={(e) => setViewId(e.target.value || null)} aria-label="View">
          {!views.data?.some((v) => v.is_default) && <option value="">Active houses</option>}
          {views.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select className="grow" value={sortKey} onChange={(e) => setSortKey(e.target.value)} aria-label="Sort">
          <option value="">Sort: view's order</option>
          <option value="sale_at">Auction / EOI date</option>
          <option value="guide_high">Guide price</option>
          <option value="created_at">Newest first</option>
          <option value="nearest_station_walk">Walk to station</option>
          {favourites.map((f) => <option key={f.id} value={`drive:${f.id}`}>Drive to {f.name}</option>)}
        </select>
      </div>
      <div className="chips" aria-label="Status">
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${quick.statuses.includes(s) ? "on" : ""}`} onClick={() => flip("statuses", s)}>
            <span className="status-dot" style={{ background: STATUS_COLOUR[s], marginRight: 6 }} />{LABEL.status[s]}</button>
        ))}
      </div>
      <div className="chips" aria-label="Quick filters">
        <button className={`chip ${quick.thisWeek ? "on" : ""}`} onClick={() => setQuick({ ...quick, thisWeek: !quick.thisWeek })}>This week</button>
        {(["auction", "eoi", "private_sale"] as const).map((m) => (
          <button key={m} className={`chip ${quick.methods.includes(m) ? "on" : ""}`} onClick={() => flip("methods", m)}>{LABEL.method[m]}</button>
        ))}
        {(["yes", "maybe", "no", "unset"] as const).map((v) => (
          <button key={v} className={`chip ${quick.myVerdicts.includes(v) ? "on" : ""}`} onClick={() => flip("myVerdicts", v)}>
            Me: {v === "unset" ? "no verdict" : LABEL.stance[v]}
          </button>
        ))}
        <button className={`chip ${quick.hideExcluded ? "on" : ""}`} onClick={() => setQuick({ ...quick, hideExcluded: !quick.hideExcluded })}>Hide my excluded</button>
        {suburbs.length > 1 && suburbs.map((s) => (
          <button key={s} className={`chip ${suburbClass(slots, s)} ${quick.suburbs.includes(s) ? "on" : ""}`} onClick={() => flip("suburbs", s)}>
            <span className="suburb-swatch" />{s}</button>
        ))}
        {tagNames.map((t) => (
          <button key={t} className={`chip ${quick.tags.includes(t) ? "on" : ""}`} style={quick.tags.includes(t) ? undefined : tagStyle(tagColours, t)}
            onClick={() => flip("tags", t)}>#{t}</button>
        ))}
      </div>
      <div className="row small">
        <select value={picking} onChange={(e) => setPicking(e.target.value)} aria-label="Filter on another field" style={{ width: "auto" }}>
          <option value="">+ Filter on…</option>
          {cols.filter((c) => !["address"].includes(c.key)).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        {extra.map((f, i) => (
          <span key={i} className="pill">{describe(f, byKey.get(f.column))}{" "}
            <button className="link" onClick={() => setExtra(extra.filter((_, j) => j !== i))} aria-label="Remove filter">✕</button></span>
        ))}
        {filtering && <button className="link" onClick={() => { setQuick(NO_QUICK); setExtra([]); }}>Clear filters</button>}
      </div>
      {picking && byKey.get(picking) && (
        <FilterPopover col={byKey.get(picking)!} rows={data?.rows ?? []} at={{ x: 16, y: 160 }}
          existing={extra.find((f) => f.column === picking)}
          onApply={(fs) => { setExtra([...extra.filter((f) => f.column !== picking), ...fs]); setPicking(""); }}
          onClose={() => setPicking("")} />
      )}
      <div className="small muted">{rows.length} of {data?.rows.length ?? 0} houses</div>
      {isPending && <p className="muted">Loading…</p>}
      {isError && <p className="error">Couldn't load houses.</p>}
      {data && data.rows.length === 0 && <div className="card"><p>No houses yet.</p><Link to="/add">Add the first one</Link></div>}
      {rows.map((r) => <Card key={r.id} r={r} people={active} favourites={favourites} cols={cols} slots={slots} tagColours={tagColours} />)}
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
    r.days_on_market != null && r.sale_method && `${r.days_on_market} days listed`,
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
        <strong>{moneyRange(n("guide_low"), n("guide_high"))}</strong>
        {change != null && change !== 0 && <span className={`pill tone-${changeTone(change)}`}>guide {change > 0 ? "↑" : "↓"} {money(Math.abs(change))}</span>}
        {r.walk_away != null && <span className="pill">limit {money(n("walk_away"))}</span>}
      </div>
      <div className="row small" style={{ marginTop: 4 }}>
        {people.map((p) => {
          const post = r[`v:${p.id}:post`] as string | undefined, pre = r[`v:${p.id}:pre`] as string | undefined;
          const v = post ?? pre;
          return (
            <span key={p.id}>
              <span className="dot" style={{ background: p.colour }} />{p.display_name}:{" "}
              {v ? <span className={`pill ${v}`}>{post ? "Post" : "Pre"} {LABEL.stance[v as "yes"]}</span> : <span className="muted">—</span>}
            </span>
          );
        })}
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
