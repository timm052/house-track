// Milestone 6: weighted scoring, side-by-side comparison and the disagreement queue.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LIVE, Live } from "../live";
import { api, type Stance } from "../api";
import { catalogue, display, type OverviewPlace, type OverviewRow } from "../overview/columns";
import { usePeople } from "../people";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[] };
export type Criterion = { id: string; name: string; weight: number; sort: number };
type Scores = { scores: { criterion_id: string; person_id: string; score: number }[];
                totals: { person_id: string; score: number | null; scored: number; criteria: number }[] };

export function useCriteria(live = false) {
  return useQuery({ queryKey: ["criteria"], queryFn: () => api<Criterion[]>("/api/criteria"), ...(live ? LIVE : {}) });
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
      <div className="card small muted">Add scoring criteria in <Link to="/settings">Settings</Link>.</div>
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
      <div className="small muted">Weighted score out of 100. * Not fully scored.</div>
    </div>
  );
}

/** Settings section: the household's criteria and weights. */
export function CriteriaSettings() {
  const queryClient = useQueryClient();
  const criteria = useCriteria(true);
  const [name, setName] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["criteria"] });
  return (
    <div className="card stack">
      <h2>What matters to us</h2>
      <p className="small muted">Each person scores houses 1–5 on these. The weight sets how much each one counts.</p>
      <Live queries={[criteria]}>
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
      </Live>
    </div>
  );
}

const COMPARE_ROWS = ["suburb", "property_type", "beds", "baths", "car_spaces", "land_m2", "status", "sale_method", "sale_at", "guide_low",
  "guide_high", "expected_sale", "walk_away", "days_on_market", "school_primary", "school_secondary", "planning",
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
      <p className="small muted">Compare up to four houses. Differences are highlighted.</p>
      <div className="row">
        {[0, 1, 2, 3].map((i) => (
          <select key={i} className="grow" value={ids[i] ?? ""} aria-label={`House ${i + 1}`}
            onChange={(e) => { const next = [...ids]; next[i] = e.target.value; setIds(next.filter(Boolean)); }}>
            <option value="">{i < ids.length ? "Remove" : "Add a house…"}</option>
            {data?.rows.map((r) => <option key={r.id} value={r.id}>{String(r.address)}, {String(r.suburb)}</option>)}
          </select>
        ))}
      </div>
      {rows.length === 0 && <div className="card empty">Choose houses to compare.</div>}
      {rows.length > 0 && (
        <div className="compare-wrap card" style={{ padding: 8 }}>
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
          {!criteria.data?.length && <p className="small muted">Add criteria in Settings to compare scores.</p>}
        </div>
      )}
    </div>
  );
}

/** Houses where your current verdicts differ: the ones worth talking about. */
/** Houses where the latest verdicts differ: after inspecting, or before if nobody has inspected yet. */
export function findDisagreements(rows: OverviewRow[], active: { id: string }[]) {
  return rows.flatMap((r) => {
    for (const stage of ["post", "pre"] as const) {
      const stances = active.map((p) => r[`v:${p.id}:${stage}`] as Stance | undefined);
      const given = stances.filter(Boolean);
      if (given.length >= 2 && new Set(given).size > 1) return [{ r, stage, stances }];
      if (given.length >= 1 && stage === "post") break;
    }
    return [];
  });
}

