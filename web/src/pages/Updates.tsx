// Updates: what's happened to the houses lately and what needs doing. At the top, four numbers (what to rate, what's
// coming up, price changes, sales); then a feed of events (houses added, guides that moved, status changes, sales,
// under offer, new inspection times; not verdicts) grouped by day with the new ones marked; beside it, what
// needs you, what's coming up, the houses you both said yes to, where you disagree, and recent sale results. A card
// with nothing in it isn't shown. Built from the same rows as the house list, so most of it works offline too.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Flag, Gavel, Plus, Route, Tag, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Outcome, type SaleMethod, type Stance, type Status } from "../api";
import { EVENT_LABEL, isSold, LABEL, money, moneyRange, saleEnded } from "../format";
import { CLOSED } from "../colour";
import type { OverviewPlace, OverviewRow } from "../overview/columns";
import { applyOutcomeStatus, OutcomeForm, outcomeStatus, statusOutOfStep } from "../Outcome";
import { usePeople } from "../people";
import { latestVerdict as latestOf, sectionOf, Thumb, type Event } from "./Inspections";
import { findDisagreements } from "./Decide";
import { unrated } from "./Rate";

type Me = { id: string; display_name: string } | null;
type Kind = "added" | "guide" | "status" | "sale" | "sale_price" | "listing" | "inspections";
type Item = { at: string; kind: Kind; property_id: string; person_id: string | null; data: Record<string, unknown> };
type Tone = "good" | "bad" | "warn" | "accent" | "sale";
type Filter = "all" | "prices" | "sales" | "houses";

const FILTERS: [Filter, string, Kind[]][] = [
  ["all", "All", []],
  ["prices", "Prices", ["guide"]],
  ["sales", "Sales", ["sale", "sale_price", "listing"]],
  ["houses", "Houses", ["added", "status", "inspections"]],
];
const PAGE = 40;
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* per-device nicety */ } };
const clockFmt = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long" });
const whenShort = new Intl.DateTimeFormat("en-AU", { weekday: "short", hour: "numeric", minute: "2-digit" });
const whenDay = new Intl.DateTimeFormat("en-AU", { weekday: "long" });
const weekdayShort = new Intl.DateTimeFormat("en-AU", { weekday: "short" });
const monthDay = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY_MS = 86_400_000;

/** What's waiting on this person: also used for the nudge on the Houses page. */
export function useNeeds(rows: OverviewRow[], me: Me) {
  const needsOutcome = rows.filter((r) => r.needs_outcome);
  const outOfStep = rows.filter((r) => statusOutOfStep(r.outcome as Outcome, Boolean(r.bought_by_us), r.status as Status));
  const needsVerdict = me ? rows.filter((r) => (r.attended_by as string[] | undefined)?.includes(me.id) && r[`v:${me.id}:post`] == null) : [];
  return { needsOutcome, outOfStep, needsVerdict, count: needsOutcome.length + outOfStep.length + needsVerdict.length };
}

/** "Today", "Yesterday", or the date. */
function dayLabel(iso: string): string {
  const d = new Date(iso), now = new Date();
  const k = isoLocal(d);
  if (k === isoLocal(now)) return "Today";
  if (k === isoLocal(new Date(now.getTime() - DAY_MS))) return "Yesterday";
  return dayFmt.format(d);
}
/** How long ago, for something today; the time of day otherwise. */
function ago(iso: string): string {
  const t = new Date(iso), mins = Math.round((Date.now() - t.getTime()) / 60_000);
  if (isoLocal(t) !== isoLocal(new Date())) return clockFmt.format(t);
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
}
const mid = (low: number, high: number) => (low + high) / 2;
const pct = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(Math.abs(n) < 10 ? 1 : 0)}%`;

export default function Updates() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { active, me } = usePeople();
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: OverviewRow[]; places: OverviewPlace[] }>("/api/overview") });
  const feed = useQuery({ queryKey: ["updates"], queryFn: () => api<Item[]>("/api/updates?days=30") });
  const upcoming = useQuery({ queryKey: ["inspections", 7], queryFn: () => api<Event[]>("/api/inspections?days=7") });
  const rows = data?.rows ?? [];
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const seenKey = `housetrack.updates.seen.${me?.id ?? "anyone"}`;
  const [seenAt, setSeenAt] = useState(() => stored(seenKey) ?? new Date(Date.now() - 7 * DAY_MS).toISOString());
  const [filter, setFilter] = useState<Filter>("all");
  const [showMine, setShowMine] = useState(() => stored("housetrack.updates.mine") === "1");
  const [shown, setShown] = useState(PAGE);
  const [recording, setRecording] = useState<string | null>(null);
  const [allNeeds, setAllNeeds] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = (e: Item) => me != null && e.person_id === me.id;
  // Something you did yourself isn't news to you; what the listing or the other person did is.
  const isNew = (e: Item) => e.at > seenAt && !(["added", "status"].includes(e.kind) && mine(e));
  // Your own additions and status changes are left out unless you ask: you know about those.
  const items = (feed.data ?? []).filter((e) => rowOf.has(e.property_id) && (showMine || !(["added", "status"].includes(e.kind) && mine(e))));
  const inFilter = (e: Item) => filter === "all" || FILTERS.find(([f]) => f === filter)![2].includes(e.kind);
  const visible = items.filter(inFilter);
  const newCount = items.filter(isNew).length;
  const count = (f: Filter) => items.filter((e) => f === "all" || FILTERS.find(([x]) => x === f)![2].includes(e.kind)).length;

  const { needsOutcome, outOfStep, needsVerdict, count: needs } = useNeeds(rows, me);
  const shownOutOfStep = outOfStep.slice(0, allNeeds ? undefined : Math.max(0, 5 - needsOutcome.length));
  const open = rows.filter((r) => !CLOSED.includes(r.status as Status) && !saleEnded(r.outcome, r.bought_by_us));
  const disagree = findDisagreements(open, active);
  const matches = active.length < 2 ? [] : open.filter((r) => active.every((p) => latestOf(r, p.id) === "yes"));
  const soon = (upcoming.data ?? []).filter((e) => new Date(e.starts_at).getTime() > Date.now() - 3_600_000 && sectionOf(e, rowOf.get(e.property_id), active) === "main");
  const week = Date.now() - 7 * DAY_MS;
  const guideWeek = items.filter((e) => e.kind === "guide" && new Date(e.at).getTime() > week);
  const drops = guideWeek.filter((e) => mid(Number(e.data.low), Number(e.data.high)) < mid(Number(e.data.prev_low), Number(e.data.prev_high))).length;
  const results = rows.filter((r) => isSold(r.outcome) && r.outcome_on && new Date(String(r.outcome_on)).getTime() > Date.now() - 30 * DAY_MS)
    .sort((a, b) => String(b.outcome_on).localeCompare(String(a.outcome_on)));
  const pcts = results.map((r) => r.sold_vs_guide_pct as number | null).filter((x): x is number => x != null);
  const avgPct = pcts.length ? pcts.reduce((s, x) => s + x, 0) / pcts.length : null;
  const toRate = me ? rows.filter((r) => unrated(r, me.id)).length : 0;

  async function addToInspect(r: OverviewRow) {
    setError(null);
    try {
      await api(`/api/properties/${r.id}/inspect-list`, { method: "PUT" });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) { setError((e as Error).message); }
  }
  async function fixStatus(r: OverviewRow) {
    setError(null);
    try {
      await applyOutcomeStatus(r.id, outcomeStatus(r.outcome as Outcome, Boolean(r.bought_by_us), r.status as Status)!, (r._v?.status as string | undefined) ?? null);
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) { setError((e as Error).message); }
  }
  function markSeen() { const now = new Date().toISOString(); setSeenAt(now); store(seenKey, now); }
  const goSold = () => { store("housetrack.houses.stage", "sold"); navigate("/"); };
  const addr = (r: OverviewRow) => <Link to={`/p/${r.id}`}>{String(r.address)}</Link>;
  const soonByDay = soon.length > 1 ? soon.filter((e) => e.type !== "eoi" && isoLocal(new Date(e.starts_at)) === isoLocal(new Date(soon[0].starts_at))) : [];

  // Each event as a sentence, a line of detail, and how it should look.
  function describe(e: Item): { icon: ReactNode; tone: Tone; line: ReactNode; detail?: ReactNode } {
    const r = rowOf.get(e.property_id)!;
    const house = <b>{String(r.address)}</b>;
    const who = (id: string | null) => (id && me && id === me.id ? "You" : active.find((p) => p.id === id)?.display_name ?? "Someone");
    const d = e.data;
    switch (e.kind) {
      case "added":
        return { icon: <Plus />, tone: "accent", line: <><b>{who(e.person_id)}</b> added {house}</>,
          detail: [String(r.suburb), r.guide_low != null ? moneyRange(r.guide_low as number, r.guide_high as number) : null].filter(Boolean).join(" · ") };
      case "guide": {
        const low = Number(d.low), high = Number(d.high), pl = Number(d.prev_low), ph = Number(d.prev_high);
        const change = Math.round(mid(low, high) - mid(pl, ph));
        return { icon: change < 0 ? <TrendingDown /> : <TrendingUp />, tone: change < 0 ? "good" : "bad",
          line: <>Guide {change < 0 ? "down" : "up"} {money(Math.abs(change))} on {house}</>,
          detail: <>{moneyRange(low, high)}, was {moneyRange(pl, ph)}{d.note && d.note !== "From the listing" ? ` · ${String(d.note)}` : ""}</> };
      }
      case "status": {
        const reason = d.reason ? String(d.reason) : null;
        return { icon: <Flag />, tone: "accent", line: <><b>{who(e.person_id)}</b> moved {house} to <b>{LABEL.status[String(d.status) as Status] ?? String(d.status)}</b></>,
          detail: reason && !["Shortlisted in Rate", "Sale outcome recorded"].includes(reason) ? reason : undefined };
      }
      case "sale":
      case "sale_price": {
        const out = String(d.outcome), price = d.price != null ? Number(d.price) : null;
        const against = r.sold_vs_guide_pct as number | null;
        const phrase = d.ours ? "You bought" : out === "passed_in" ? "Passed in:" : out === "withdrawn" ? "Withdrawn:" : out === "disappeared" ? "Off the market:" : e.kind === "sale_price" ? "Sale price known:" : "Sold:";
        return { icon: <Gavel />, tone: "sale", line: <>{phrase} {house}{price ? <> for <b>{money(price)}</b></> : null}</>,
          detail: price == null ? "No price shown yet" : against != null ? `${pct(against)} on the top of the guide` : undefined };
      }
      case "listing": {
        const s = String(d.listing).replace(/[^a-zA-Z]/g, "").toLowerCase();
        return { icon: <Tag />, tone: "warn", line: <>{house} is {s === "underoffer" ? <b>under offer</b> : s === "withdrawn" ? <b>withdrawn</b> : <b>off the market</b>}</>,
          detail: s === "underoffer" ? "Listed as under offer" : undefined };
      }
      default: {
        const n = Number(d.count);
        return { icon: <CalendarPlus />, tone: "accent", line: <>{n} new inspection {n === 1 ? "time" : "times"} for {house}</>,
          detail: d.first ? `First: ${monthDay.format(new Date(String(d.first)))}` : undefined };
      }
    }
  }

  // The feed, a day at a time.
  const groups = useMemo(() => {
    const out: { label: string; items: Item[] }[] = [];
    for (const e of visible.slice(0, shown)) {
      const label = dayLabel(e.at);
      if (out[out.length - 1]?.label === label) out[out.length - 1].items.push(e); else out.push({ label, items: [e] });
    }
    return out;
  }, [visible, shown]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="updates">
      <header className="upd-head">
        <div>
          <h1>Updates</h1>
          <p className="muted">{newCount > 0 ? `${newCount} new since you last looked` : "You're up to date"}</p>
        </div>
        {newCount > 0 && <button className="small-btn" onClick={markSeen}>Mark all seen</button>}
      </header>

      <div className="upd-tiles">
        <Link to="/rate" className="upd-tile accent">
          <span className="n">{toRate}</span><span className="l">To rate</span><span className="s">{toRate === 1 ? "new house" : "new houses"}</span>
        </Link>
        <Link to="/inspections" className="upd-tile">
          <span className="n">{soon.length}</span><span className="l">Coming up</span>
          <span className="s">{soon[0] ? `Next: ${whenShort.format(new Date(soon[0].starts_at))}` : "Nothing in the next week"}</span>
        </Link>
        <button className="upd-tile" onClick={() => { setFilter("prices"); document.querySelector(".upd-c-feed")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
          <span className="n">{guideWeek.length}</span><span className="l">Price changes</span>
          <span className="s">{guideWeek.length ? `${drops} down · ${guideWeek.length - drops} up this week` : "None this week"}</span>
        </button>
        <button className="upd-tile" onClick={goSold}>
          <span className="n">{results.length}</span><span className="l">Sold this month</span>
          <span className="s">{avgPct != null ? `${pct(avgPct)} on guide on average` : results.length ? "No prices yet" : "Nothing sold"}</span>
        </button>
      </div>

      <div className="upd-layout">
        <div className="upd-main">
          {needs > 0 && (
            <section className="card upd-c-needs">
              <h2>Needs you <span className="count-badge">{needs}</span></h2>
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
              {error && <p className="error small">{error}</p>}
            </section>
          )}

          <section className="card upd-c-feed">
            <div className="upd-feedhead">
              <h2>Activity</h2>
              <div className="chips" role="group" aria-label="Show">
                {FILTERS.map(([f, label]) => (
                  <button key={f} className={`chip ${filter === f ? "on" : ""}`} aria-pressed={filter === f} onClick={() => { setFilter(f); setShown(PAGE); }}>
                    {label} <span className="upd-n">{count(f)}</span></button>
                ))}
                <button className={`chip upd-mine ${showMine ? "on" : ""}`} aria-pressed={showMine} title="Include the houses you added and the statuses you changed"
                  onClick={() => { setShowMine(!showMine); store("housetrack.updates.mine", showMine ? "0" : "1"); }}>My changes</button>
              </div>
            </div>
            {feed.isPending ? <p className="muted">Loading…</p> : visible.length === 0 ? (
              <p className="muted upd-none">{items.length === 0 ? "Nothing yet. Updates appear here as houses are added, prices change and sales happen." : "Nothing of that kind in the last 30 days."}</p>
            ) : (
              <>
                {groups.map((g) => (
                  <div key={g.label} className="upd-group">
                    <h3 className="upd-day">{g.label}</h3>
                    <ul className="upd-feed">
                      {g.items.map((e, i) => {
                        const x = describe(e), r = rowOf.get(e.property_id)!;
                        return (
                          <li key={`${e.kind}-${e.property_id}-${e.at}-${i}`} className={`t-${x.tone} ${isNew(e) ? "new" : ""}`}>
                            <Link to={`/p/${e.property_id}`} className="upd-row">
                              <span className="upd-thumb"><Thumb r={r} /><span className={`upd-badge ${x.tone}`}>{x.icon}</span></span>
                              <span className="upd-text">
                                <span className="upd-l1">{x.line}</span>
                                {x.detail && <span className="upd-l2">{x.detail}</span>}
                              </span>
                              <span className="upd-time">{isNew(e) && <i className="upd-dot" aria-label="New" />}{ago(e.at)}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                {visible.length > shown && <button className="small-btn upd-more" onClick={() => setShown(shown + PAGE)}>Show more</button>}
              </>
            )}
          </section>
        </div>

        <div className="upd-side">
          {soon.length > 0 && (
            <section className="card upd-c-coming">
              <div className="row"><h2 className="grow" style={{ margin: 0 }}>Coming up</h2><Link to="/inspections" className="small">All inspections</Link></div>
              <ul className="upd-list">
                {soon.slice(0, 5).map((e) => (
                  <li key={`${e.type}-${e.id}`}>
                    <span className={`upd-when ${e.type === "inspection" ? "" : "sale"}`}>{weekdayShort.format(new Date(e.starts_at))}<b>{new Date(e.starts_at).getDate()}</b></span>
                    <span className="grow"><Link to={`/p/${e.property_id}`}>{e.address.split(",")[0]}</Link>
                      <span className="upd-l2">{clockFmt.format(new Date(e.starts_at))}{e.type === "inspection" ? "" : ` · ${EVENT_LABEL[e.kind]}`}</span></span>
                  </li>
                ))}
                {soon.length > 5 && <li className="small muted">and {soon.length - 5} more</li>}
              </ul>
              {soonByDay.length > 1 && (
                <Link to={`/plan?day=${isoLocal(new Date(soon[0].starts_at))}`} className="plan-link week-plan"><Route /> Plan {whenDay.format(new Date(soon[0].starts_at))}'s route</Link>
              )}
            </section>
          )}

          {matches.length > 0 && (
            <section className="card upd-c-matches">
              <h2>{active.length === 2 ? "You both said yes" : "Everyone said yes"}</h2>
              <ul className="upd-list">
                {matches.map((r) => (
                  <li key={r.id}>
                    <span className="upd-mini"><Thumb r={r} /></span>
                    <span className="grow">{addr(r)}<span className="upd-l2">{String(r.suburb)}{r.guide_low != null ? ` · ${moneyRange(r.guide_low as number, r.guide_high as number)}` : ""}</span></span>
                    {r.to_inspect ? <span className="pill">To inspect</span> : <button className="small-btn" onClick={() => addToInspect(r)}>Add to To inspect</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {disagree.length > 0 && (
            <section className="card upd-c-disagree">
              <h2>Where we disagree</h2>
              <ul className="upd-list">
                {disagree.map(({ r, stage, stances }) => (
                  <li key={r.id}>
                    <span className="upd-mini"><Thumb r={r} /></span>
                    <span className="grow">{addr(r)}<span className="upd-l2">{stage === "post" ? "After inspecting" : "Before inspecting"}</span></span>
                    {active.map((p, i) => stances[i] && (
                      <span key={p.id} className={`pill ${stances[i]}`} title={p.display_name}><span className="dot" style={{ background: p.colour }} />{LABEL.stance[stances[i] as Stance]}</span>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {results.length > 0 && (
            <section className="card upd-c-results">
              <div className="row"><h2 className="grow" style={{ margin: 0 }}>Recent results</h2><button className="link small" onClick={goSold}>All sold</button></div>
              <ul className="upd-list">
                {results.slice(0, 5).map((r) => {
                  const against = r.sold_vs_guide_pct as number | null;
                  return (
                    <li key={r.id}>
                      <span className="upd-mini"><Thumb r={r} /></span>
                      <span className="grow">{addr(r)}<span className="upd-l2">{r.sold_price_aud ? money(r.sold_price_aud as number) : "No price shown"}{r.guide_high != null ? ` · guide ${moneyRange(r.guide_low as number, r.guide_high as number)}` : ""}</span></span>
                      {against != null && <span className={`pill ${against > 0 ? "no" : "yes"}`} title="Against the top of the guide">{pct(against)}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </div>
      {error && needs === 0 && <p className="error small">{error}</p>}
    </div>
  );
}
