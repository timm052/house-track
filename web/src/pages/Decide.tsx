// Milestone 6: weighted scoring, side-by-side comparison and the disagreement queue.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Stance } from "../api";
import { LABEL } from "../format";
import { catalogue, display, type OverviewPlace, type OverviewRow } from "../overview/columns";
import { usePeople } from "../people";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[] };
export type Criterion = { id: string; name: string; weight: number; sort: number };
type Scores = { scores: { criterion_id: string; person_id: string; score: number }[];
                totals: { person_id: string; score: number | null; scored: number; criteria: number }[] };

export function useCriteria() {
  return useQuery({ queryKey: ["criteria"], queryFn: () => api<Criterion[]>("/api/criteria") });
}

/** Property page section: each person scores each criterion 1-5; weighted totals out of 100. */
export function ScoresCard({ propertyId }: { propertyId: string }) {
  const queryClient = useQueryClient();
  const { active, me } = usePeople();
  const criteria = useCriteria();
  const key = ["scores", propertyId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<Scores>(`/api/properties/${propertyId}/scores`) });
  const [whose, setWhose] = useState(me?.id ?? "");
  if (!criteria.data?.length) {
    return (
      <div className="card small muted">Score houses against your own criteria (garden, light, street…): set them up in <Link to="/settings">Settings</Link>.</div>
    );
  }
  const current = (c: string, p: string) => data?.scores.find((s) => s.criterion_id === c && s.person_id === p)?.score;
  async function score(criterionId: string, value: number) {
    await api(`/api/properties/${propertyId}/scores`, { method: "POST", body: { criterion_id: criterionId, score: value, person_id: whose } });
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["overview"] });
  }
  return (
    <div className="card stack">
      <div className="row">
        <h2 className="grow">Scores</h2>
        {active.map((p) => {
          const t = data?.totals.find((x) => x.person_id === p.id);
          return <span key={p.id} className="pill"><span className="dot" style={{ background: p.colour }} />{p.display_name} {t?.score ?? "—"}{t && t.scored < t.criteria ? "*" : ""}</span>;
        })}
      </div>
      <select value={whose} onChange={(e) => setWhose(e.target.value)} aria-label="Whose scores" style={{ width: "auto" }}>
        {active.map((p) => <option key={p.id} value={p.id}>{p.display_name}'s scores</option>)}
      </select>
      {criteria.data.map((c) => (
        <div key={c.id} className="row">
          <span className="grow small">{c.name} <span className="muted">×{c.weight}</span></span>
          <div className="score-buttons">
            {[1, 2, 3, 4, 5].map((v) => (
              <button key={v} className={current(c.id, whose) === v ? "on" : ""} onClick={() => score(c.id, v)} aria-label={`${c.name} ${v}`}>{v}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="small muted">Out of 100, weighted. * = not every criterion scored yet.</div>
    </div>
  );
}

/** Settings section: the household's criteria and weights. */
export function CriteriaSettings() {
  const queryClient = useQueryClient();
  const criteria = useCriteria();
  const [name, setName] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["criteria"] });
  return (
    <div className="card stack">
      <h2>What matters to us</h2>
      <p className="small muted">Criteria you each score houses against, 1 to 5. Weight 5 counts five times as much as weight 1.</p>
      {criteria.data?.map((c) => (
        <div key={c.id} className="row">
          <span className="grow">{c.name}</span>
          <select value={c.weight} style={{ width: "auto" }} aria-label={`Weight of ${c.name}`}
            onChange={(e) => api(`/api/criteria/${c.id}`, { method: "PATCH", body: { weight: Number(e.target.value) } }).then(refresh)}>
            {[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>weight {w}</option>)}
          </select>
          <button className="link" onClick={() => api(`/api/criteria/${c.id}`, { method: "DELETE" }).then(refresh)}>Remove</button>
        </div>
      ))}
      <div className="row">
        <input className="grow" placeholder="e.g. North-facing garden" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim()} onClick={() => api("/api/criteria", { method: "POST", body: { name } }).then(() => { setName(""); refresh(); })}>Add</button>
      </div>
    </div>
  );
}

const COMPARE_ROWS = ["suburb", "property_type", "beds", "baths", "car_spaces", "land_m2", "status", "sale_method", "sale_at", "guide_low",
  "guide_high", "estimated_reserve", "walk_away", "days_on_market", "school_primary", "school_secondary", "planning",
  "nearest_station", "nearest_station_walk", "owners_corp_fees_aud_pa", "agent_name", "notes"];

export function Compare() {
  const [params, setParams] = useSearchParams();
  const { all: persons, active } = usePeople();
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview") });
  const criteria = useCriteria();
  const cols = useMemo(() => catalogue(persons, data?.places ?? []), [persons, data?.places]);
  const ids = (params.get("ids") ?? "").split(",").filter(Boolean).slice(0, 4);
  const rows = ids.map((id) => data?.rows.find((r) => r.id === id)).filter((r): r is OverviewRow => !!r);
  const setIds = (next: string[]) => setParams({ ids: next.join(",") });
  const favourites = (data?.places ?? []).filter((p) => p.is_favourite && p.kind === "destination");
  const keys = [...COMPARE_ROWS, ...favourites.map((f) => `drive:${f.id}`),
                ...active.flatMap((p) => [`v:${p.id}:pre`, `v:${p.id}:post`, `score:${p.id}`]), "score_avg"];
  const label = (k: string) => k.startsWith("score:") ? `${persons.find((p) => `score:${p.id}` === k)?.display_name} score`
    : k === "score_avg" ? "Average score" : cols.find((c) => c.key === k)?.label ?? k;
  const show = (k: string, r: OverviewRow) => {
    const col = cols.find((c) => c.key === k);
    return col ? display(col, r[k]) : r[k] == null ? "" : String(r[k]);
  };
  return (
    <div style={{ marginTop: 12 }}>
      <h1>Compare</h1>
      <div className="row">
        {[0, 1, 2, 3].map((i) => (
          <select key={i} className="grow" value={ids[i] ?? ""} aria-label={`House ${i + 1}`}
            onChange={(e) => { const next = [...ids]; next[i] = e.target.value; setIds(next.filter(Boolean)); }}>
            <option value="">{i < ids.length ? "Remove" : "Add a house…"}</option>
            {data?.rows.map((r) => <option key={r.id} value={r.id}>{String(r.address)}, {String(r.suburb)}</option>)}
          </select>
        ))}
      </div>
      {rows.length > 0 && (
        <div className="compare-wrap">
          <table className="compare">
            <thead><tr><th />{rows.map((r) => <th key={r.id}><Link to={`/p/${r.id}`}>{String(r.address)}</Link></th>)}</tr></thead>
            <tbody>
              {keys.filter((k) => rows.some((r) => r[k] != null && r[k] !== "")).map((k) => {
                const values = rows.map((r) => show(k, r));
                const differ = new Set(values).size > 1;
                return (
                  <tr key={k} className={differ ? "differ" : ""}>
                    <th>{label(k)}</th>
                    {rows.map((r, i) => <td key={r.id}>{values[i] || <span className="muted">—</span>}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!criteria.data?.length && <p className="small muted">Add scoring criteria in Settings to compare scores too.</p>}
        </div>
      )}
    </div>
  );
}

/** Houses where your current verdicts differ: the ones worth talking about. */
export function Disagreements() {
  const { active } = usePeople();
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview") });
  const rows = (data?.rows ?? []).flatMap((r) => {
    for (const stage of ["post", "pre"] as const) {
      const stances = active.map((p) => r[`v:${p.id}:${stage}`] as Stance | undefined);
      const given = stances.filter(Boolean);
      if (given.length >= 2 && new Set(given).size > 1) return [{ r, stage, stances }];
      if (given.length >= 1 && stage === "post") break;
    }
    return [];
  });
  return (
    <div style={{ marginTop: 12 }}>
      <h1>We disagree</h1>
      <p className="small muted">Houses where your latest verdicts differ (after inspecting, or before if neither has inspected).</p>
      {rows.length === 0 && <p className="muted">Nothing to argue about right now.</p>}
      {rows.map(({ r, stage, stances }) => (
        <Link key={r.id} to={`/p/${r.id}`} className="card property-card">
          <div className="address">{String(r.address)}, {String(r.suburb)}</div>
          <div className="row small">
            <span className="muted">{stage === "post" ? "After inspecting" : "Before inspecting"}:</span>
            {active.map((p, i) => (
              <span key={p.id}><span className="dot" style={{ background: p.colour }} />{p.display_name}{" "}
                {stances[i] ? <span className={`pill ${stances[i]}`}>{LABEL.stance[stances[i]!]}</span> : <span className="muted">—</span>}</span>
            ))}
          </div>
        </Link>
      ))}
    </div>
  );
}
