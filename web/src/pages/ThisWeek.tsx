// The This week tab: what's waiting on you (outcomes to record, statuses out of step, verdicts after an
// inspection), what changed since you last looked, the houses you all said yes to, where you disagree, and the calendar. Built from the
// same rows as the house list, so it works offline too.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Outcome, type SaleMethod, type Stance, type Status } from "../api";
import { LABEL, money, saleEnded } from "../format";
import { CLOSED } from "../colour";
import type { OverviewPlace, OverviewRow } from "../overview/columns";
import { applyOutcomeStatus, OutcomeForm, outcomeStatus, statusOutOfStep } from "../Outcome";
import { usePeople } from "../people";
import CalendarSection from "./Calendar";
import { findDisagreements } from "./Decide";

type Me = { id: string; display_name: string } | null;

function stored(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window: forget it */ }
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** What's waiting on this person: also used for the nudge on the Houses page. */
export function useNeeds(rows: OverviewRow[], me: Me) {
  const needsOutcome = rows.filter((r) => r.needs_outcome);
  const outOfStep = rows.filter((r) => statusOutOfStep(r.outcome as Outcome, Boolean(r.bought_by_us), r.status as Status));
  const needsVerdict = me ? rows.filter((r) => (r.attended_by as string[] | undefined)?.includes(me.id) && r[`v:${me.id}:post`] == null) : [];
  return { needsOutcome, outOfStep, needsVerdict, count: needsOutcome.length + outOfStep.length + needsVerdict.length };
}

export default function ThisWeek() {
  const queryClient = useQueryClient();
  const { active, me } = usePeople();
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: OverviewRow[]; places: OverviewPlace[] }>("/api/overview") });
  const rows = data?.rows ?? [];
  const seenKey = `housetrack.seen.${me?.id ?? "anyone"}`;
  const [seen, setSeen] = useState(() => stored(seenKey, isoDay(new Date(Date.now() - 7 * 86400_000))));
  const [recording, setRecording] = useState<string | null>(null);
  const [allNeeds, setAllNeeds] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const s = (r: OverviewRow, k: string) => (r[k] == null ? null : String(r[k]));
  // One line per house, with everything that changed on it.
  const changes = rows.flatMap((r) => {
    const out: string[] = [];
    if ((s(r, "created_at") ?? "") > seen) out.push("Added");
    const change = r.guide_change as number | null;
    if ((s(r, "last_guide_change") ?? "") > seen && change) out.push(`Guide ${change < 0 ? "down" : "up"} ${money(Math.abs(change))}`);
    if ((s(r, "status_since") ?? "") > seen && (s(r, "created_at") ?? "") <= seen) out.push(`Now ${LABEL.status[r.status as Status]}`);
    return out.length ? [{ r, text: out.join(" · ") }] : [];
  });
  const { needsOutcome, outOfStep, needsVerdict, count } = useNeeds(rows, me);
  // Nothing to argue about on a house we're done with, or one whose sale is over.
  const disagree = findDisagreements(rows.filter((r) => !CLOSED.includes(r.status as Status) && !saleEnded(r.outcome, r.bought_by_us)), active);
  const shownOutOfStep = outOfStep.slice(0, allNeeds ? undefined : Math.max(0, 5 - needsOutcome.length));
  // Matches: everyone's latest verdict (after inspecting, else before) is yes. Needs two or more people.
  const latestVerdict = (r: OverviewRow, id: string) => r[`v:${id}:post`] ?? r[`v:${id}:pre`];
  const matches = active.length < 2 ? [] : rows.filter((r) => !CLOSED.includes(r.status as Status) && !saleEnded(r.outcome, r.bought_by_us)
    && active.every((p) => latestVerdict(r, p.id) === "yes"));
  async function addToInspect(r: OverviewRow) {
    setError(null);
    try {
      await api(`/api/properties/${r.id}/inspect-list`, { method: "PUT" });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function markSeen() { const today = isoDay(new Date()); setSeen(today); store(seenKey, today); }
  async function fixStatus(r: OverviewRow) {
    setError(null);
    try {
      await applyOutcomeStatus(r.id, outcomeStatus(r.outcome as Outcome, Boolean(r.bought_by_us), r.status as Status)!, (r._v?.status as string | undefined) ?? null);
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) { setError((e as Error).message); }
  }
  const addr = (r: OverviewRow) => <Link to={`/p/${r.id}`}>{String(r.address)}</Link>;

  return (
    <div style={{ marginTop: 12 }}>
      <h1>This week</h1>
      <div className="week-grid">
        <div className="card">
          <h2>Needs you {count > 0 && <span className="count-badge">{count}</span>}</h2>
          {count === 0 ? <p className="small muted">All caught up.</p> : (
            <ul className="week-list">
              {needsOutcome.map((r) => (
                <li key={`o-${r.id}`} className="week-stack">
                  <div className="row">
                    <span className="grow">{addr(r)}: {r.listing_status ? `the listing says ${String(r.listing_status).replace(/_/g, " ")}` : "the sale date has passed"}</span>
                    <button className="link" onClick={() => setRecording(recording === r.id ? null : r.id)}>Record outcome</button>
                  </div>
                  {recording === r.id && (
                    <OutcomeForm propertyId={r.id} campaignId={String(r.campaign_id)} saleMethod={r.sale_method as SaleMethod} status={r.status as Status}
                      latestStatusId={(r._v?.status as string | undefined) ?? null} listingStatus={r.listing_status as string | null}
                      listingPriceText={r.listing_price_text as string | null} onDone={() => setRecording(null)} />
                  )}
                </li>
              ))}
              {shownOutOfStep.map((r) => (
                <li key={`s-${r.id}`}>
                  <span className="grow">{addr(r)}: {LABEL.outcome[r.outcome as Outcome]}, still {LABEL.status[r.status as Status]}</span>
                  <button className="link" onClick={() => fixStatus(r)}>Set to {LABEL.status[outcomeStatus(r.outcome as Outcome, Boolean(r.bought_by_us), r.status as Status)!]}</button>
                </li>
              ))}
              {needsVerdict.map((r) => (
                <li key={`v-${r.id}`}><span className="grow">{addr(r)}: you've inspected it</span><Link to={`/p/${r.id}`}>Give your verdict</Link></li>
              ))}
              {shownOutOfStep.length < outOfStep.length && (
                <li><button className="link small" onClick={() => setAllNeeds(true)}>Show all {needsOutcome.length + outOfStep.length}</button></li>
              )}
            </ul>
          )}
          {error && <p className="error small">{error}</p>}
        </div>

        <div className="card">
          <div className="row"><h2 className="grow" style={{ margin: 0 }}>Since you last looked</h2>
            {changes.length > 0 && <button className="link small" onClick={markSeen}>Mark all seen</button>}</div>
          {changes.length === 0 ? <p className="small muted">Nothing new.</p> : (
            <ul className="week-list">
              {changes.slice(0, 10).map((c, i) => <li key={i}><span className="grow">{addr(c.r)}</span><span className="small">{c.text}</span></li>)}
              {changes.length > 10 && <li className="small muted">and {changes.length - 10} more</li>}
            </ul>
          )}
        </div>

        {matches.length > 0 && (
          <div className="card">
            <h2>{active.length === 2 ? "You both said yes" : "Everyone said yes"}</h2>
            <ul className="week-list">
              {matches.map((r) => (
                <li key={r.id}>
                  <span className="grow">{addr(r)}</span>
                  {r.to_inspect ? <span className="pill">To inspect</span>
                    : <button className="small-btn" onClick={() => addToInspect(r)}>Add to To inspect</button>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="card">
          <h2>Where we disagree</h2>
          {disagree.length === 0 ? <p className="small muted">No disagreements.</p> : (
            <ul className="week-list">
              {disagree.map(({ r, stage, stances }) => (
                <li key={r.id}>
                  <span className="grow">{addr(r)} <span className="muted small">{stage === "post" ? "after inspecting" : "before inspecting"}</span></span>
                  {active.map((p, i) => stances[i] && (
                    <span key={p.id} className={`pill ${stances[i]}`} title={p.display_name}>
                      <span className="dot" style={{ background: p.colour }} />{LABEL.stance[stances[i] as Stance]}</span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <CalendarSection />
    </div>
  );
}
