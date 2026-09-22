// Houses (phone-first). Built on the same rows, filters and shared saved views as Overview (D18),
// with quick filter chips and a sort picker for one-handed use.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { LABEL, money, moneyRange } from "../format";
import { catalogue, display, type Column, type OverviewPlace, type OverviewRow } from "../overview/columns";
import { applyView, builtInDefault, useViews, type Filter, type Sort } from "../overview/views";
import { usePeople } from "../people";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[] };
type Quick = { thisWeek: boolean; method: string; myVerdict: string; hideExcluded: boolean; suburb: string };

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
  const [quick, setQuick] = useState<Quick>({ thisWeek: false, method: "", myVerdict: "", hideExcluded: false, suburb: "" });

  const filters: Filter[] = [...view.filters];
  if (quick.thisWeek) filters.push({ column: "sale_at", op: "thisweek" });
  if (quick.method) filters.push({ column: "sale_method", op: "in", value: [quick.method] });
  if (quick.suburb) filters.push({ column: "suburb", op: "in", value: [quick.suburb] });
  if (quick.hideExcluded) filters.push({ column: "excluded", op: "in", value: ["false"] });
  if (quick.myVerdict && me) {
    filters.push(quick.myVerdict === "unset"
      ? { column: `v:${me.id}:pre`, op: "empty" }
      : { column: `v:${me.id}:post`, op: "in", value: [quick.myVerdict] });
  }
  const sort: Sort[] = sortKey ? [{ column: sortKey, dir: sortKey === "created_at" ? "desc" : "asc" }] : view.sort;
  const filterKey = JSON.stringify(filters), sortJson = JSON.stringify(sort);
  const rows = useMemo(() => applyView(data?.rows ?? [], filters, sort, search, cols),
    [data, filterKey, sortJson, search, cols]); // eslint-disable-line react-hooks/exhaustive-deps
  const suburbs = [...new Set((data?.rows ?? []).map((r) => String(r.suburb)))].sort();
  const toggle = <K extends keyof Quick>(k: K, v: Quick[K]) =>
    setQuick({ ...quick, [k]: quick[k] === v ? (typeof v === "boolean" ? false : "") : v });

  return (
    <>
      <div className="row" style={{ marginTop: 12 }}>
        <input className="grow" type="search" placeholder="Search address, agent, notes" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Link to="/calendar"><button aria-label="Calendar" title="Calendar">📅</button></Link>
        <Link to="/disagree"><button aria-label="Where we disagree" title="Where we disagree">⚖</button></Link>
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
      <div className="chips" aria-label="Quick filters">
        <button className={`chip ${quick.thisWeek ? "on" : ""}`} onClick={() => toggle("thisWeek", true)}>This week</button>
        {(["auction", "eoi", "private_sale"] as const).map((m) => (
          <button key={m} className={`chip ${quick.method === m ? "on" : ""}`} onClick={() => toggle("method", m)}>{LABEL.method[m]}</button>
        ))}
        {(["yes", "maybe", "unset"] as const).map((v) => (
          <button key={v} className={`chip ${quick.myVerdict === v ? "on" : ""}`} onClick={() => toggle("myVerdict", v)}>
            Me: {v === "unset" ? "no verdict" : LABEL.stance[v]}
          </button>
        ))}
        <button className={`chip ${quick.hideExcluded ? "on" : ""}`} onClick={() => toggle("hideExcluded", true)}>Hide my excluded</button>
        <select className="chip" value={quick.suburb} onChange={(e) => setQuick({ ...quick, suburb: e.target.value })} aria-label="Suburb" style={{ width: "auto" }}>
          <option value="">Any suburb</option>
          {suburbs.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="small muted">{rows.length} of {data?.rows.length ?? 0} houses</div>
      {isPending && <p className="muted">Loading…</p>}
      {isError && <p className="error">Couldn't load houses.</p>}
      {data && data.rows.length === 0 && <div className="card"><p>No houses yet.</p><Link to="/add">Add the first one</Link></div>}
      {rows.map((r) => <Card key={r.id} r={r} people={active} favourites={favourites} cols={cols} />)}
    </>
  );
}

/** Four lines: address and status; rooms and travel; sale and price; verdicts. Long-press shows the agent. */
function Card({ r, people, favourites, cols }: {
  r: OverviewRow; people: { id: string; display_name: string; colour: string }[]; favourites: OverviewPlace[]; cols: Column[];
}) {
  const [agent, setAgent] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const col = (k: string) => cols.find((c) => c.key === k)!;
  const n = (k: string) => (r[k] as number | null) ?? null;
  const line2 = [
    [r.beds != null && `${r.beds} bed`, r.baths != null && `${r.baths} bath`, r.car_spaces != null && `${r.car_spaces} car`].filter(Boolean).join(" "),
    r.property_type !== "house" && display(col("property_type"), r.property_type),
    r.nearest_station && `${r.nearest_station_walk} min walk to ${r.nearest_station}`,
    ...favourites.filter((f) => r[`drive:${f.id}`] != null).map((f) => `${r[`drive:${f.id}`]} min drive to ${f.name}`),
    r.days_on_market != null && r.sale_method && `${r.days_on_market} days listed`,
  ].filter(Boolean).join(" · ");
  const change = n("guide_change");
  const sale = r.outcome
    ? `${display(col("outcome"), r.outcome)}${r.sold_price_aud ? ` ${money(n("sold_price_aud"))}` : ""}`
    : r.sale_at ? `${display(col("sale_method"), r.sale_method)} ${display(col("sale_at"), r.sale_at)}`
    : r.sale_method ? display(col("sale_method"), r.sale_method) : "Not listed";
  return (
    <Link to={`/p/${r.id}`} className="card property-card"
      onTouchStart={() => { timer.current = window.setTimeout(() => setAgent(true), 500); }}
      onTouchEnd={() => window.clearTimeout(timer.current)}
      onContextMenu={(e) => { if (r.agent_phone) { e.preventDefault(); setAgent(true); } }}>
      <div className="row">
        <span className="address grow">{String(r.address)}, {String(r.suburb)}</span>
        {Boolean(r.excluded) && <span className="pill no">Excluded</span>}
        <span className="pill">{display(col("status"), r.status)}</span>
      </div>
      <div className="muted small">{line2}</div>
      <div className="row small" style={{ marginTop: 4 }}>
        <span className="grow">{sale}</span>
        <strong>{moneyRange(n("guide_low"), n("guide_high"))}</strong>
        {change != null && change !== 0 && <span className={`pill ${change > 0 ? "no" : "yes"}`}>guide {change > 0 ? "↑" : "↓"} {money(Math.abs(change))}</span>}
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
      {agent && Boolean(r.agent_phone) && (
        <div className="small" onClick={(e) => e.stopPropagation()}>
          {String(r.agent_name ?? "Agent")}: <a href={`tel:${String(r.agent_phone).replace(/\s/g, "")}`}>{String(r.agent_phone)}</a>
        </div>
      )}
    </Link>
  );
}
