// Property page sections for milestone 4: price history chart, costs at the guide and at our limit,
// due-diligence checklist and comparable sales.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Campaign } from "../api";
import { day, money, parseMoney } from "../format";
import { usePeople } from "../people";

type Costs = { settings: Record<string, unknown>; max_bid: number | null; breakdown?: Breakdown };
type Breakdown = { price: number; duty: number; total: number; budget: number; headroom: number };

/** Guide ranges over time (bars), our figures (dashed lines) and the result (dot), across every campaign. */
export function PriceHistory({ campaigns }: { campaigns: Campaign[] }) {
  const guides = campaigns.flatMap((c) => c.price_guides.map((g) => ({ ...g, t: new Date(g.observed_at).getTime() })));
  const sold = campaigns.filter((c) => c.sold_price_aud && c.outcome_on).map((c) => ({ v: c.sold_price_aud!, t: new Date(c.outcome_on!).getTime() }));
  const passed = campaigns.filter((c) => c.passed_in_bid_aud && c.outcome_on).map((c) => ({ v: c.passed_in_bid_aud!, t: new Date(c.outcome_on!).getTime() }));
  const live = campaigns.find((c) => !c.outcome) ?? campaigns[0];
  const figures = (["estimated_reserve", "walk_away"] as const)
    .map((k) => ({ k, v: live?.judgements.find((j) => j.kind === k)?.amount_aud }))
    .filter((f): f is { k: "estimated_reserve" | "walk_away"; v: number } => f.v != null);
  if (guides.length + sold.length < 1) return null;

  const values = [...guides.flatMap((g) => [g.low_aud, g.high_aud]), ...sold.map((s) => s.v), ...passed.map((p) => p.v), ...figures.map((f) => f.v)];
  const times = [...guides.map((g) => g.t), ...sold.map((s) => s.t), ...passed.map((p) => p.t), Date.now()];
  const [vMin, vMax] = [Math.min(...values) * 0.97, Math.max(...values) * 1.03];
  const [tMin, tMax] = [Math.min(...times), Math.max(...times) + 86400_000];
  const W = 320, H = 120, P = 6;
  const x = (t: number) => P + ((t - tMin) / (tMax - tMin || 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - vMin) / (vMax - vMin || 1)) * (H - 2 * P);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="price-chart" role="img" aria-label="Price guide history">
        {figures.map((f) => (
          <g key={f.k}>
            <line x1={P} x2={W - P} y1={y(f.v)} y2={y(f.v)} className={`fig ${f.k}`} />
            <text x={W - P} y={y(f.v) - 3} textAnchor="end" className="chart-label">{f.k === "walk_away" ? "limit" : "our reserve"} {money(f.v)}</text>
          </g>
        ))}
        {guides.map((g) => (
          <rect key={g.id} x={x(g.t) - 3} width={6} y={y(g.high_aud)} height={Math.max(2, y(g.low_aud) - y(g.high_aud))} className={`guide ${g.source}`}>
            <title>{money(g.low_aud)}–{money(g.high_aud)} · {day(g.observed_at)}</title>
          </rect>
        ))}
        {passed.map((p, i) => <circle key={`p${i}`} cx={x(p.t)} cy={y(p.v)} r={4} className="passed"><title>Passed in {money(p.v)}</title></circle>)}
        {sold.map((s, i) => <circle key={`s${i}`} cx={x(s.t)} cy={y(s.v)} r={5} className="sold"><title>Sold {money(s.v)}</title></circle>)}
      </svg>
      <div className="small muted">Bars: price guides over time · dot: sold (filled) or passed in (hollow) · lines: our figures</div>
    </div>
  );
}

/** What the guide and our limit would actually cost, from the household cost settings. */
export function CostAt({ campaign }: { campaign: Campaign }) {
  const guideHigh = campaign.price_guides[0]?.high_aud;
  const walkAway = campaign.judgements.find((j) => j.kind === "walk_away")?.amount_aud;
  const at = [guideHigh && { label: "top of guide", price: guideHigh }, walkAway && { label: "your limit", price: walkAway }]
    .filter(Boolean) as { label: string; price: number }[];
  const results = useQuery({
    queryKey: ["costs", at.map((a) => a.price).join(",")],
    queryFn: () => Promise.all(at.map((a) => api<Costs>(`/api/costs?price=${a.price}`))),
    enabled: at.length > 0,
  });
  if (!at.length) return null;
  const configured = results.data?.[0] && (results.data[0].breakdown?.budget ?? 0) > 0;
  return (
    <div className="small">
      {results.data?.map((r, i) => r.breakdown && (
        <div key={i}>
          At {at[i].label} {money(r.breakdown.price)}: duty {money(r.breakdown.duty)}, all-in {money(r.breakdown.total)}
          {configured && <> · <span className={r.breakdown.headroom < 0 ? "error" : ""}>{r.breakdown.headroom < 0 ? "over budget by " : "headroom "}{money(Math.abs(r.breakdown.headroom))}</span></>}
        </div>
      ))}
      {results.data && !configured && <div className="muted">Set your budget in <Link to="/settings">Settings</Link> to see headroom.</div>}
      {configured && results.data?.[0].max_bid && <div className="muted">Most you can bid, all costs included: {money(results.data[0].max_bid)}</div>}
    </div>
  );
}

type Item = { id: string; label: string; done_at: string | null; done_by: string | null; note: string | null };

export function Checklist({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient();
  const { byId } = usePeople();
  const key = ["checklist", campaignId];
  const { data = [] } = useQuery({ queryKey: key, queryFn: () => api<Item[]>(`/api/campaigns/${campaignId}/checklist`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const [label, setLabel] = useState("");
  const done = data.filter((i) => i.done_at).length;
  return (
    <details className="section">
      <summary><strong>Due diligence</strong> {data.length > 0 && <>
        <span className="muted">{done} of {data.length} done</span>
        <span className="progress" aria-hidden><span style={{ width: `${(done / data.length) * 100}%` }} /></span></>}</summary>
      {data.length === 0 && (
        <button onClick={() => api(`/api/campaigns/${campaignId}/checklist/defaults`, { method: "POST" }).then(refresh)}>Start the standard checklist</button>
      )}
      {data.map((i) => (
        <label key={i.id} className="check checklist">
          <input type="checkbox" checked={!!i.done_at}
            onChange={(e) => api(`/api/checklist/${i.id}`, { method: "PATCH", body: { done: e.target.checked } }).then(refresh)} />
          <span className="grow" style={{ textDecoration: i.done_at ? "line-through" : undefined }}>{i.label}</span>
          {i.done_at && <span className="small muted">{byId.get(i.done_by ?? "")?.display_name}, {day(i.done_at)}</span>}
        </label>
      ))}
      {data.length > 0 && (
        <div className="row">
          <input className="grow" placeholder="Add an item" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button disabled={!label.trim()} onClick={() => api(`/api/campaigns/${campaignId}/checklist`, { method: "POST", body: { label } }).then(() => { setLabel(""); refresh(); })}>Add</button>
        </div>
      )}
    </details>
  );
}

type Comp = { id?: string; property_id?: string; address: string; sold_price_aud: number | null; sold_on: string | null;
              beds: number | null; baths: number | null; car_spaces: number | null; land_m2: number | null; distance_m?: number; source?: string };

export function Comparables({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient();
  const key = ["comparables", campaignId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<{ entered: Comp[]; tracked: Comp[] }>(`/api/campaigns/${campaignId}/comparables`) });
  const [f, setF] = useState({ address: "", price: "", date: "", beds: "" });
  const add = useMutation({
    mutationFn: () => api(`/api/campaigns/${campaignId}/comparables`, { method: "POST", body: {
      address: f.address, sold_price_aud: parseMoney(f.price), sold_on: f.date || null, beds: f.beds ? Number(f.beds) : null } }),
    onSuccess: () => { setF({ address: "", price: "", date: "", beds: "" }); queryClient.invalidateQueries({ queryKey: key }); },
  });
  const all = [...(data?.entered ?? []), ...(data?.tracked ?? [])];
  const line = (c: Comp) => [c.beds != null && `${c.beds} bed`, c.land_m2 && `${c.land_m2} m²`, c.sold_on && day(c.sold_on),
                              c.distance_m != null && `${(c.distance_m / 1000).toFixed(1)} km away`].filter(Boolean).join(" · ");
  return (
    <details className="section">
      <summary><strong>Comparable sales</strong> <span className="muted">{all.length || ""}</span></summary>
      {all.map((c, i) => (
        <div key={c.id ?? c.property_id ?? i} className="row small">
          <span className="grow">
            {c.property_id ? <Link to={`/p/${c.property_id}`}>{c.address}</Link> : c.address}
            {c.property_id && <span className="pill">tracked</span>}
            <br /><span className="muted">{line(c)}</span>
          </span>
          <strong>{money(c.sold_price_aud)}</strong>
          {c.id && <button className="link" onClick={() => api(`/api/comparables/${c.id}`, { method: "DELETE" }).then(() => queryClient.invalidateQueries({ queryKey: key }))}>✕</button>}
        </div>
      ))}
      <div className="stack">
        <input placeholder="Address (from the Statement of Information)" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        <div className="grid3">
          <input placeholder="Sold 1.2m" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} aria-label="Sold on" />
          <input placeholder="Beds" inputMode="numeric" value={f.beds} onChange={(e) => setF({ ...f, beds: e.target.value })} />
        </div>
        <button disabled={f.address.trim().length < 3 || (!!f.price && parseMoney(f.price) == null)} onClick={() => add.mutate()}>Add comparable</button>
      </div>
    </details>
  );
}
