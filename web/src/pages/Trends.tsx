// Trends: what the houses you've tracked (and the comparable sales you've entered) say about prices,
// for any mix of suburbs, house types, sizes and time.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, PROPERTY_TYPES } from "../api";
import { money } from "../format";
import type { OverviewPlace, OverviewRow } from "../overview/columns";
import { Histogram, LineChart, Scatter } from "../trends/charts";
import { suburbClass, suburbSlots } from "../colour";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[] };
type Comp = { id: string; address: string; suburb: string | null; sold_price_aud: number; sold_on: string | null; beds: number | null; land_m2: number | null };

type Rec = {
  id: string; label: string; suburb: string; type: string | null; beds: number | null; land: number | null;
  guideLow: number | null; guideHigh: number | null; guideMid: number | null; sold: number | null;
  when: string | null;            // month bucket date: sale date, else listing/added date
  soldOn: string | null; days: number | null; method: string | null; outcome: string | null; source: "tracked" | "comparable";
};

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const nums = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
const monthKey = (d: string) => d.slice(0, 7);
const monthLabel = (k: string) => new Date(`${k}-01T00:00`).toLocaleDateString("en-AU", { month: "short", year: "2-digit" });
const dollars = (v: number | null) => (v == null ? "—" : `$${Math.round(v).toLocaleString("en-AU")}`);
const pct = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

function toRecords(rows: OverviewRow[], comps: Comp[]): Rec[] {
  const out: Rec[] = rows.map((r) => {
    const lo = r.guide_low as number | null, hi = r.guide_high as number | null;
    return {
      id: r.id, label: `${r.address}, ${r.suburb}`, suburb: String(r.suburb), type: r.property_type as string, beds: r.beds as number | null,
      land: r.land_m2 as number | null, guideLow: lo, guideHigh: hi, guideMid: lo != null ? (lo + (hi ?? lo)) / 2 : null,
      sold: (r.sold_price_aud as number | null) ?? null, soldOn: (r.outcome_on as string | null) ?? null,
      when: ((r.outcome_on ?? r.listed_on ?? r.created_at) as string | null) ?? null,
      days: r.outcome && r.days_on_market != null ? (r.days_on_market as number) : null,
      method: r.sale_method as string | null, outcome: r.outcome as string | null, source: "tracked",
    };
  });
  for (const c of comps) {
    out.push({ id: c.id, label: c.address, suburb: c.suburb ?? "Unknown", type: null, beds: c.beds, land: c.land_m2, guideLow: null,
               guideHigh: null, guideMid: null, sold: c.sold_price_aud, soldOn: c.sold_on, when: c.sold_on, days: null,
               method: null, outcome: "sold", source: "comparable" });
  }
  return out;
}

export default function Trends() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview") });
  const comps = useQuery({ queryKey: ["comparables-all"], queryFn: () => api<Comp[]>("/api/comparables") });
  const all = useMemo(() => toRecords(overview.data?.rows ?? [], comps.data ?? []), [overview.data, comps.data]);
  const slots = useMemo(() => suburbSlots(overview.data?.rows ?? []), [overview.data]);

  const [suburbs, setSuburbs] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [bedsMin, setBedsMin] = useState(0);
  const [landMin, setLandMin] = useState("");
  const [landMax, setLandMax] = useState("");
  const [months, setMonths] = useState(24);
  const [withComps, setWithComps] = useState(true);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const suburbList = [...new Set(all.map((r) => r.suburb))].sort();
  const since = months ? new Date(Date.now() - months * 30.4 * 86400_000).toISOString().slice(0, 10) : "";
  const recs = all.filter((r) =>
    (withComps || r.source === "tracked") &&
    (!suburbs.length || suburbs.includes(r.suburb)) &&
    (!types.length || (r.type != null && types.includes(r.type))) &&
    (!bedsMin || (r.beds ?? 0) >= bedsMin) &&
    (!landMin || (r.land ?? 0) >= Number(landMin)) && (!landMax || (r.land != null && r.land <= Number(landMax))) &&
    (!since || !r.when || r.when >= since));

  const sold = recs.filter((r) => r.sold != null);
  const auctions = recs.filter((r) => r.source === "tracked" && r.method === "auction" && r.outcome);
  const cleared = auctions.filter((r) => r.outcome!.startsWith("sold")).length;
  const vsGuide = nums(sold.filter((r) => r.guideHigh).map((r) => (r.sold! / r.guideHigh! - 1) * 100));
  const stats = [
    { label: "Houses", value: String(recs.length), sub: `${sold.length} with a sale price` },
    { label: "Median guide", value: money(median(nums(recs.map((r) => r.guideMid)))), sub: "middle of the range" },
    { label: "Median sold", value: money(median(nums(sold.map((r) => r.sold)))), sub: withComps ? "incl. comparables" : "tracked houses" },
    { label: "Sold vs guide top", value: pct(median(vsGuide)), sub: `median of ${vsGuide.length}` },
    { label: "Auction clearance", value: auctions.length ? `${Math.round((cleared / auctions.length) * 100)}%` : "—", sub: `${cleared} of ${auctions.length} auctions` },
    { label: "Median days to sell", value: String(median(nums(recs.map((r) => r.days))) ?? "—"), sub: "tracked houses" },
    { label: "Median land", value: median(nums(recs.map((r) => r.land))) != null ? `${Math.round(median(nums(recs.map((r) => r.land)))!)} m²` : "—", sub: "" },
    { label: "Median sold per m² land", value: dollars(median(nums(sold.filter((r) => r.land).map((r) => r.sold! / r.land!)))), sub: "" },
  ];

  // Monthly medians: guides by the month listed/added, sales by the month sold.
  const monthKeys = [...new Set(recs.map((r) => r.when && monthKey(r.when)).filter(Boolean) as string[])].sort();
  const series = [
    { key: "guide", label: "Median guide", slot: 1 as const,
      points: monthKeys.map((m) => ({ x: monthLabel(m), v: median(nums(recs.filter((r) => r.guideMid != null && r.when && monthKey(r.when) === m && r.source === "tracked").map((r) => r.guideMid))) })) },
    { key: "sold", label: "Median sold", slot: 2 as const,
      points: monthKeys.map((m) => ({ x: monthLabel(m), v: median(nums(sold.filter((r) => r.soldOn && monthKey(r.soldOn) === m).map((r) => r.sold))) })) },
  ];
  const bySuburb = [...new Set(recs.map((r) => r.suburb))].sort().map((s) => {
    const rs = recs.filter((r) => r.suburb === s), ss = rs.filter((r) => r.sold != null);
    return { suburb: s, n: rs.length, guide: median(nums(rs.map((r) => r.guideMid))), sold: median(nums(ss.map((r) => r.sold))),
             land: median(nums(rs.map((r) => r.land))), perM2: median(nums(ss.filter((r) => r.land).map((r) => r.sold! / r.land!))) };
  });
  const priceValues = sold.length >= 4 ? nums(sold.map((r) => r.sold)) : nums(recs.map((r) => r.sold ?? r.guideMid));

  return (
    <div className="trends" style={{ marginTop: 12 }}>
      <h1>Trends</h1>
      <p className="small muted">From the houses you've tracked{withComps ? " and the comparable sales you've entered" : ""}. Small numbers: treat as a guide, not a market report.</p>

      <div className="card stack">
        <div className="chips">
          {suburbList.map((s) => <button key={s} className={`chip ${suburbClass(slots, s)} ${suburbs.includes(s) ? "on" : ""}`} onClick={() => toggle(suburbs, setSuburbs, s)}>
            {suburbClass(slots, s) && <span className="suburb-swatch" />}{s}</button>)}
        </div>
        <div className="chips">
          {PROPERTY_TYPES.map((t) => <button key={t} className={`chip ${types.includes(t) ? "on" : ""}`} onClick={() => toggle(types, setTypes, t)}>{t}</button>)}
        </div>
        <div className="row small">
          <label className="check">Beds at least
            <select value={bedsMin} onChange={(e) => setBedsMin(Number(e.target.value))} style={{ width: "auto" }}>
              {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n || "any"}</option>)}
            </select></label>
          <label className="check">Land m²
            <input style={{ width: 80 }} inputMode="numeric" placeholder="min" value={landMin} onChange={(e) => setLandMin(e.target.value.replace(/\D/g, ""))} />–
            <input style={{ width: 80 }} inputMode="numeric" placeholder="max" value={landMax} onChange={(e) => setLandMax(e.target.value.replace(/\D/g, ""))} /></label>
          <label className="check">Period
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ width: "auto" }}>
              <option value={3}>3 months</option><option value={6}>6 months</option><option value={12}>12 months</option>
              <option value={24}>2 years</option><option value={0}>All time</option>
            </select></label>
          <label className="check"><input type="checkbox" checked={withComps} onChange={(e) => setWithComps(e.target.checked)} /> Include comparable sales</label>
          {(suburbs.length > 0 || types.length > 0 || bedsMin > 0 || landMin || landMax) &&
            <button className="link" onClick={() => { setSuburbs([]); setTypes([]); setBedsMin(0); setLandMin(""); setLandMax(""); }}>Clear</button>}
        </div>
      </div>

      <div className="stat-grid">
        {stats.map((s) => (
          <div key={s.label} className="stat"><div className="muted small">{s.label}</div><div className="stat-value">{s.value}</div>
            {s.sub && <div className="muted small">{s.sub}</div>}</div>
        ))}
      </div>

      <div className="card viz-root"><h2>Median prices by month</h2>
        <LineChart series={series} fmt={money} label="Median guide and median sold price by month" /></div>
      <div className="card viz-root"><h2>Sold price against the top of the guide</h2>
        <p className="small muted">Dots above the line sold for more than the top of their guide.</p>
        <Scatter dots={sold.filter((r) => r.guideHigh).map((r) => ({ id: r.id, x: r.guideHigh!, y: r.sold!, label: r.label }))}
          fmt={money} xLabel="guide top" yLabel="sold" label="Sold price against guide top" /></div>
      <div className="card viz-root"><h2>How prices are spread</h2>
        <p className="small muted">{sold.length >= 4 ? "Sale prices" : "Sale prices, or the middle of the guide where unsold"}, in $100k bands.</p>
        <Histogram values={priceValues} step={100_000} fmt={money} label="Number of houses per $100k price band" /></div>

      <div className="card"><h2>By suburb</h2>
        <div className="compare-wrap">
          <table className="compare">
            <thead><tr><th>Suburb</th><th>Houses</th><th>Median guide</th><th>Median sold</th><th>Median land</th><th>Sold per m²</th></tr></thead>
            <tbody>
              {bySuburb.map((b) => (
                <tr key={b.suburb}><th className={suburbClass(slots, b.suburb)}>{suburbClass(slots, b.suburb) && <span className="suburb-swatch" />}{b.suburb}</th><td>{b.n}</td><td>{money(b.guide)}</td><td>{money(b.sold)}</td>
                  <td>{b.land != null ? `${Math.round(b.land)} m²` : "—"}</td><td>{dollars(b.perM2)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Add sold prices from each campaign's outcome and comparable sales from Statements of Information to fill this in. <Link to="/overview">Overview</Link></p>
      </div>
    </div>
  );
}
