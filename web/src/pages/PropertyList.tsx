// Houses (phone-first). Built on the same rows, filters and shared saved views as Overview (D18). One search box that
// also offers filters as you type (a suburb, a tag, "auction", "this week"…); where each house is up to (in play,
// shortlisted, under offer, sold, ruled out); a sort either way round, or grouped by suburb and street as a compact
// list; and every filter that's on shown once, as a chip to remove.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, whilePending } from "../api";
import { isSold, LABEL, landArea, listingState, money, moneyRange, saleEnded } from "../format";
import SoldAgainst from "../SoldAgainst";
import { describeLink } from "../listingLink";
import { STATUSES } from "../api";
import { catalogue, display, type Column, type OverviewPlace, type OverviewRow } from "../overview/columns";
import { applyView, builtInDefault, describe, useViews, type Filter, type Sort } from "../overview/views";
import FieldFilter, { fieldOffers } from "../overview/FieldFilter";
import { usePeople } from "../people";
import { CLOSED, STATUS_COLOUR, budgetTone, changeTone, minutesTone, soonTone, suburbClass, suburbSlots, tagStyle, useTagColours } from "../colour";
import { ArrowDown, ArrowUp, Bath, BedDouble, CalendarDays, Camera, Car, ChevronDown, DoorOpen, ChevronRight, Footprints, GraduationCap, LandPlot, MapPin,
  PencilRuler, Plus, Scale, Search, SlidersHorizontal, TrainFront, TramFront, TriangleAlert } from "lucide-react";
import { useNeeds } from "./Updates";
import { statusOutOfStep } from "../Outcome";
import type { Outcome, Status } from "../api";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[]; pending?: number };
// verdicts: person id → the verdicts to show (theirs after inspecting, else before; "unset" for none yet)
type Quick = { thisWeek: boolean; statuses: string[]; methods: string[]; verdicts: Record<string, string[]>; hideExcluded: boolean;
               suburbs: string[]; tags: string[]; affordable: boolean };
const NO_QUICK: Quick = { thisWeek: false, statuses: [], methods: [], verdicts: {}, hideExcluded: false, suburbs: [], tags: [], affordable: false };
/** Which houses: you buy one, and watch the rest to learn what things sell for. Every house is in exactly one of
 *  looking, shortlist, under offer (the listing says so), sold (or otherwise off the market) and ruled out; "In
 *  play" is the first three together. Under offer and sold follow the listing, so nobody has to move them. */
type Stage = "inplay" | "inspect" | "shortlist" | "offer" | "sold" | "out" | "all";
type Phase = "looking" | "shortlist" | "offer" | "sold" | "out";
const phaseOf = (r: OverviewRow): Phase => {
  if (r.status === "ruled_out") return "out";
  if (r.status === "bought") return "shortlist";
  const listing = r.outcome ? "" : listingState(r.listing_status);
  if (r.status === "missed_out" || saleEnded(r.outcome, r.bought_by_us) || listing === "sold") return "sold";
  if (listing === "underoffer") return "offer";
  return ["shortlisted", "offering"].includes(String(r.status)) ? "shortlist" : "looking";
};
// To inspect is a list rather than a stage: houses shortlisted in Rate (or added on the house page) that nobody has
// been to see yet, whatever else is going on with them.
const STAGES = ["inplay", "inspect", "shortlist", "offer", "sold", "out", "all"] as const;
const STAGE_PHASES: Record<Stage, Phase[]> = { inplay: ["looking", "shortlist", "offer"], inspect: [], shortlist: ["shortlist"], offer: ["offer"],
  sold: ["sold"], out: ["out"], all: ["looking", "shortlist", "offer", "sold", "out"] };
const inStage = (r: OverviewRow, st: Stage) => (st === "inspect" ? Boolean(r.to_inspect) : STAGE_PHASES[st].includes(phaseOf(r)));
const STAGE_LABEL: Record<Stage, string> = { inplay: "In play", inspect: "To inspect", shortlist: "Shortlist", offer: "Under offer", sold: "Sold",
  out: "Ruled out", all: "All" };
const STAGE_TITLE: Record<Stage, string> = {
  inplay: "Houses still in the running", inspect: "Houses to go and see",
  shortlist: "Shortlisted, offering or bought",
  offer: "Listed as under offer", sold: "Sold or off the market", out: "Ruled out", all: "Every house" };
/** The sorts, each with the way round it starts and what each way means. */
const SORTS: { key: string; label: string; desc?: boolean; asc: string; dsc: string }[] = [
  { key: "", label: "Sale date", asc: "Soonest first", dsc: "Latest first" },
  { key: "street", label: "Suburb, then street", asc: "A to Z", dsc: "Z to A" },
  { key: "created_at", label: "Date added", desc: true, asc: "Oldest first", dsc: "Newest first" },
  { key: "guide_high", label: "Guide price", asc: "Cheapest first", dsc: "Dearest first" },
  { key: "score_avg", label: "Score", desc: true, asc: "Lowest first", dsc: "Best first" },
  { key: "nearest_station_walk", label: "Walk to station", asc: "Closest first", dsc: "Furthest first" },
  { key: "nearest_station_drive", label: "Drive to station", asc: "Closest first", dsc: "Furthest first" },
];
const DRIVE_SORT = { asc: "Closest first", dsc: "Furthest first" };
const METHODS = ["auction", "eoi", "private_sale"] as const;
const VERDICTS = ["yes", "maybe", "no", "unset"] as const;
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* per-device nicety */ } };

export default function PropertyList() {
  const { all: persons, active, me } = usePeople();
  const { data, isPending, isError } = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview"), refetchInterval: whilePending });
  const views = useViews();
  const cols = useMemo(() => catalogue(persons, data?.places ?? []), [persons, data?.places]);
  const favourites = (data?.places ?? []).filter((p) => p.kind === "destination" && p.is_favourite);

  const [viewId, setViewId] = useState<string | null>(null);
  const view = views.data?.find((v) => v.id === viewId) ?? views.data?.find((v) => v.is_default) ?? builtInDefault(cols);
  // Remembered on this device: where you're up to and the sort (grouping by suburb, say) stay as chosen.
  const [stage, setStage] = useState<Stage>(() => {
    const v = stored("housetrack.houses.stage");
    return v === "results" ? "sold" : v && v in STAGE_LABEL ? v as Stage : "inplay";
  });
  useEffect(() => store("housetrack.houses.stage", stage), [stage]);
  const [sortKey, setSortKey] = useState<string>(() => stored("housetrack.houses.sort") ?? "");
  useEffect(() => store("housetrack.houses.sort", sortKey), [sortKey]);
  const [reversed, setReversed] = useState(() => stored("housetrack.houses.reversed") === "1");
  useEffect(() => store("housetrack.houses.reversed", reversed ? "1" : "0"), [reversed]);
  const grouped = sortKey === "street";
  const sortInfo = SORTS.find((s) => s.key === sortKey) ?? { key: sortKey, label: "", desc: false, ...DRIVE_SORT };
  const descending = Boolean(sortInfo.desc) !== reversed;
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState<Quick>(NO_QUICK);
  const [extra, setExtra] = useState<Filter[]>([]);
  const [fieldStart, setFieldStart] = useState<string | null>(null);   // a field the search box asked to filter on
  const [panelOpen, setPanelOpen] = useState(false);

  // Several choices within one kind mean "any of"; different kinds must all match. Particular statuses picked (in
  // the search) stand in for the stage; a saved view's own status filter gives way to either.
  const filters: Filter[] = [...view.filters.filter((f) => f.column !== "status"), ...extra];
  if (quick.statuses.length) filters.push({ column: "status", op: "in", value: quick.statuses });
  if (quick.thisWeek) filters.push({ column: "sale_at", op: "thisweek" });
  if (quick.methods.length) filters.push({ column: "sale_method", op: "in", value: quick.methods });
  if (quick.suburbs.length) filters.push({ column: "suburb", op: "in", value: quick.suburbs });
  if (quick.tags.length) filters.push({ column: "tags", op: "in", value: quick.tags });
  if (quick.hideExcluded) filters.push({ column: "excluded", op: "in", value: ["false"] });
  if (quick.affordable) filters.push({ column: "budget", op: "in", value: ["within", "stretch"] });
  const verdictOf = (r: OverviewRow, personId: string) => ((r[`v:${personId}:post`] ?? r[`v:${personId}:pre`]) as string | undefined) ?? "unset";
  const verdictPicks = Object.entries(quick.verdicts).filter(([, vs]) => vs.length);
  const keep = (r: OverviewRow) => (quick.statuses.length > 0 || inStage(r, stage))
    && verdictPicks.every(([pid, vs]) => vs.includes(verdictOf(r, pid)));
  // Date added sorts to the second (several houses are often added on one day). Reversed turns every key round.
  const baseSort: Sort[] = grouped ? [] : sortKey ? [{ column: sortKey === "created_at" ? "added_at" : sortKey, dir: sortInfo.desc ? "desc" : "asc" }] : view.sort;
  const sort: Sort[] = reversed ? baseSort.map((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" })) : baseSort;
  const filterKey = JSON.stringify(filters), sortJson = JSON.stringify(sort);
  // Houses whose sale is over (to someone else) go to the bottom, in the same order among themselves.
  const rows = useMemo(() => {
    const shown = applyView(data?.rows ?? [], filters, sort, search, cols).filter(keep);
    const over = (r: OverviewRow) => saleEnded(r.outcome, r.bought_by_us);
    return [...shown.filter((r) => !over(r)), ...shown.filter(over)];
  },
    [data, filterKey, sortJson, search, cols, quick.verdicts, quick.statuses, stage]); // eslint-disable-line react-hooks/exhaustive-deps
  const stageCount = (st: Stage) => (data?.rows ?? []).filter((r) => inStage(r, st)).length;
  const tagNames = [...new Set((data?.rows ?? []).flatMap((r) => (r.tags as string[] | undefined) ?? []))].sort();
  const suburbs = [...new Set((data?.rows ?? []).map((r) => String(r.suburb)))].sort();
  const slots = useMemo(() => suburbSlots(data?.rows ?? []), [data]);
  const tagColours = useTagColours();
  const flip = (k: "statuses" | "methods" | "suburbs" | "tags", v: string) =>
    setQuick({ ...quick, [k]: quick[k].includes(v) ? quick[k].filter((x) => x !== v) : [...quick[k], v] });
  const flipVerdict = (pid: string, v: string) => {
    const now = quick.verdicts[pid] ?? [];
    setQuick({ ...quick, verdicts: { ...quick.verdicts, [pid]: now.includes(v) ? now.filter((x) => x !== v) : [...now, v] } });
  };
  const nameOf = (pid: string) => (pid === me?.id ? "My" : `${persons.find((x) => x.id === pid)?.display_name ?? "Someone"}'s`);
  const verdictLabel = (pid: string, v: string) => (v === "unset" ? `No verdict from ${pid === me?.id ? "me" : persons.find((x) => x.id === pid)?.display_name}`
    : `${nameOf(pid)} verdict: ${LABEL.stance[v as "yes"]}`);
  const byKey = new Map(cols.map((c) => [c.key, c]));
  // Every filter that's on, once: a chip each, removed with its ✕.
  const onChips: { key: string; label: ReactNode; off: () => void; edit?: () => void }[] = [
    ...(viewId && view.name ? [{ key: "view", label: <>View: {view.name}</>, off: () => setViewId(null) }] : []),
    ...quick.statuses.map((st) => ({ key: `s:${st}`, label: LABEL.status[st as Status], off: () => flip("statuses", st) })),
    ...quick.suburbs.map((x) => ({ key: `u:${x}`, label: x, off: () => flip("suburbs", x) })),
    ...quick.tags.map((t) => ({ key: `t:${t}`, label: `#${t}`, off: () => flip("tags", t) })),
    ...quick.methods.map((m) => ({ key: `m:${m}`, label: LABEL.method[m as "auction"], off: () => flip("methods", m) })),
    ...verdictPicks.flatMap(([pid, vs]) => vs.map((v) => ({ key: `v:${pid}:${v}`, label: verdictLabel(pid, v), off: () => flipVerdict(pid, v) }))),
    ...(quick.thisWeek ? [{ key: "week", label: "Selling this week", off: () => setQuick({ ...quick, thisWeek: false }) }] : []),
    ...(quick.affordable ? [{ key: "budget", label: "Within budget", off: () => setQuick({ ...quick, affordable: false }) }] : []),
    ...(quick.hideExcluded ? [{ key: "excl", label: "Hiding my excluded", off: () => setQuick({ ...quick, hideExcluded: false }) }] : []),
    ...extra.map((f, i) => ({ key: `x:${i}`, label: describe(f, byKey.get(f.column)), off: () => setExtra(extra.filter((_, j) => j !== i)),
      edit: () => { setFieldStart(f.column); setPanelOpen(true); } })),
  ];
  const clearAll = () => { setQuick(NO_QUICK); setExtra([]); setViewId(null); setSearch(""); };
  // What the search box offers for what's typed: filters to add, beside searching the words themselves.
  const offers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    const has = (label: string) => label.toLowerCase().includes(q);
    const out: { key: string; kind: string; label: string; add: () => void }[] = [];
    for (const x of suburbs) if (has(x) && !quick.suburbs.includes(x)) out.push({ key: `u:${x}`, kind: "Suburb", label: x, add: () => flip("suburbs", x) });
    for (const t of tagNames) if (has(t) && !quick.tags.includes(t)) out.push({ key: `t:${t}`, kind: "Tag", label: `#${t}`, add: () => flip("tags", t) });
    for (const st of STATUSES) if (has(LABEL.status[st]) && !quick.statuses.includes(st)) out.push({ key: `s:${st}`, kind: "Status", label: LABEL.status[st], add: () => flip("statuses", st) });
    for (const m of METHODS) if (has(LABEL.method[m]) && !quick.methods.includes(m)) out.push({ key: `m:${m}`, kind: "Sale", label: LABEL.method[m], add: () => flip("methods", m) });
    // Verdicts: typing a name offers theirs; typing yes, maybe or no offers everyone's.
    for (const person of active) {
      const named = person.display_name.toLowerCase().includes(q) || (person.id === me?.id && ["me", "my", "mine"].includes(q));
      for (const v of VERDICTS) {
        if (quick.verdicts[person.id]?.includes(v)) continue;
        if (named || (v !== "unset" && LABEL.stance[v].toLowerCase().startsWith(q)))
          out.push({ key: `v:${person.id}:${v}`, kind: "Verdict", label: verdictLabel(person.id, v), add: () => flipVerdict(person.id, v) });
      }
    }
    if (!quick.thisWeek && ("selling this week".includes(q) || q.includes("week"))) out.push({ key: "week", kind: "Sale", label: "Selling this week", add: () => setQuick({ ...quick, thisWeek: true }) });
    if (!quick.affordable && ["budget", "afford", "within"].some((w) => w.includes(q) || q.includes(w))) out.push({ key: "budget", kind: "Price", label: "Within budget", add: () => setQuick({ ...quick, affordable: true }) });
    if (!quick.hideExcluded && "excluded".includes(q)) out.push({ key: "excl", kind: "Excluded", label: "Hide my excluded", add: () => setQuick({ ...quick, hideExcluded: true }) });
    // From the fields: a phrase ("3 bed", "land over 600"), a value ("townhouse"), or a field to filter on.
    for (const o of fieldOffers(search, cols)) {
      out.push({ key: o.key, kind: o.kind, label: o.label, add: o.filters
        ? () => { const col = o.filters![0].column; setExtra((x) => [...x.filter((f) => f.column !== col), ...o.filters!]); }
        : () => { setFieldStart(o.column!); setPanelOpen(true); } });
    }
    return out.slice(0, 9);
  }, [search, suburbs, tagNames, quick, active, cols]); // eslint-disable-line react-hooks/exhaustive-deps
  const [searchOpen, setSearchOpen] = useState(false);
  const takeOffer = (o: { add: () => void }) => { o.add(); setSearch(""); setSearchOpen(false); };
  const needs = useNeeds(data?.rows ?? [], me);
  // Inspected: someone has been to an inspection there, or given a verdict after one.
  const inspected = (r: OverviewRow) => ((r.attended_by as string[] | undefined)?.length ?? 0) > 0
    || persons.some((p) => r[`v:${p.id}:post`] != null);
  const toSee = rows.filter((r) => !inspected(r)), seenRows = rows.filter(inspected);
  const [showInspected, setShowInspected] = useState(() => { try { return localStorage.getItem("housetrack.showInspected") !== "0"; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem("housetrack.showInspected", showInspected ? "1" : "0"); } catch { /* ignore */ } }, [showInspected]);
  const card = (r: OverviewRow) => <Card key={r.id} r={r} people={active} favourites={favourites} cols={cols} slots={slots} tagColours={tagColours}
    picked={comparing ? comparing.includes(r.id) : undefined} onPick={pick} />;
  // Grouped by suburb, then street (headings for each, A to Z, houses by number), or one grid in the chosen order.
  // Grouped: a suburb's streets sit side by side, several to a line, each with its heading and a divider between
  // them; a street takes room for its houses, so a street of one doesn't leave a line to itself.
  const cards = (list: OverviewRow[]) => !grouped ? <div className="card-grid">{list.map(card)}</div> : suburbGroups(list, reversed).map((sg) => (
    <section key={sg.suburb} className="suburb-group">
      <h2 className={`suburb-heading ${suburbClass(slots, sg.suburb)}`}><span className="suburb-swatch" />{sg.suburb}
        <span className="muted"> · {sg.count}</span></h2>
      <div className="street-flow">
        {sg.streets.map((g) => (
          <div key={g.street} className="street-block" style={{ "--n": g.rows.length } as React.CSSProperties}>
            <div className="street-heading">{g.street}{g.rows.length > 1 && <span className="muted"> · {g.rows.length}</span>}</div>
            <div className="street-cards">{g.rows.map(card)}</div>
          </div>
        ))}
      </div>
    </section>
  ));
  // Compare: tap "Compare", tap up to four cards, then open them side by side.
  const navigate = useNavigate();
  const [comparing, setComparing] = useState<string[] | null>(null);
  const pick = (id: string) => comparing && setComparing(comparing.includes(id) ? comparing.filter((x) => x !== id)
    : comparing.length < 4 ? [...comparing, id] : comparing);

  return (
    <>
      <SharedLinks />
      {needs.count > 0 && (
        <Link to="/updates" className="week-nudge">
          <span className="count-badge">{needs.count}</span>
          {needs.count === 1 ? "thing needs" : "things need"} you: {[needs.needsOutcome.length && `${needs.needsOutcome.length} to record how the sale ended`,
            needs.outOfStep.length && `${needs.outOfStep.length} ${needs.outOfStep.length === 1 ? "status" : "statuses"} to update`,
            needs.needsVerdict.length && `${needs.needsVerdict.length} ${needs.needsVerdict.length === 1 ? "verdict" : "verdicts"} to give`].filter(Boolean).join(", ")}
          <span className="grow" /><span>Updates →</span>
        </Link>
      )}
      <div className="houses-head">
        <div className="houses-search">
          <Search aria-hidden />
          <input type="search" placeholder="Search, or filter by suburb, tag, auction…" aria-label="Search or filter houses" value={search}
            onFocus={() => setSearchOpen(true)} onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)}
            onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
            onKeyDown={(e) => { if (e.key === "Enter" && offers[0]) { e.preventDefault(); takeOffer(offers[0]); } if (e.key === "Escape") setSearchOpen(false); }} />
          {searchOpen && offers.length > 0 && (
            <ul className="houses-offers" role="listbox">
              {offers.map((o) => (
                <li key={o.key}><button onMouseDown={(e) => e.preventDefault()} onClick={() => takeOffer(o)}>
                  <span className="houses-offer-kind">{o.kind}</span>{o.label}</button></li>
              ))}
              <li className="small muted houses-offer-note">Or keep typing to search addresses, agents and notes</li>
            </ul>
          )}
        </div>
        <button className={`icon-btn ${comparing ? "on" : ""}`} aria-pressed={comparing != null} title="Pick houses to compare"
          onClick={() => setComparing(comparing ? null : [])}><Scale /><span className="label">Compare</span></button>
        <Link to="/add"><button className="primary"><Plus /> <span className="label">Add house</span></button></Link>
      </div>

      <div className="houses-controls">
        <div className="houses-stage" role="radiogroup" aria-label="Which houses">
          {STAGES.map((st) => (
            <button key={st} role="radio" aria-checked={stage === st} className={stage === st ? "on" : ""} title={STAGE_TITLE[st]} onClick={() => setStage(st)}>
              {STAGE_LABEL[st]} <span className="houses-stage-n">{stageCount(st)}</span></button>
          ))}
        </div>
        <div className="houses-sort">
          <select value={sortKey} onChange={(e) => { setSortKey(e.target.value); setReversed(false); }} aria-label="Sort by">
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            {favourites.map((f) => <option key={f.id} value={`drive:${f.id}`}>Drive to {f.name}</option>)}
          </select>
          <button className="houses-dir" onClick={() => setReversed(!reversed)} title="Reverse order"
            aria-label={`${descending ? sortInfo.dsc : sortInfo.asc}. Reverse order`}>
            {descending ? <ArrowDown /> : <ArrowUp />}<span className="label">{descending ? sortInfo.dsc : sortInfo.asc}</span></button>
        </div>
        <button className={`houses-filters-btn ${panelOpen ? "on" : ""}`} aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}>
          <SlidersHorizontal /> Filters{onChips.length > 0 && <span className="count-badge">{onChips.length}</span>}</button>
      </div>

      {(onChips.length > 0 || search.trim()) && (
        <div className="houses-on">
          <span className="small muted">{rows.length} of {stageCount(stage)}</span>
          {search.trim() && <span className="houses-on-chip">“{search.trim()}” <button onClick={() => setSearch("")} aria-label="Stop searching">✕</button></span>}
          {onChips.map((c) => (
            <span key={c.key} className="houses-on-chip">
              {c.edit ? <button className="houses-on-edit" onClick={c.edit} title="Change this filter">{c.label}</button> : c.label}
              <button onClick={c.off} aria-label="Remove this filter">✕</button></span>
          ))}
          <button className="link small" onClick={clearAll}>Clear all</button>
        </div>
      )}

      {panelOpen && (
        <div className="card houses-panel">
          <section>
            <div className="section-title">Selling</div>
            <div className="chips">
              <button className={`chip ${quick.thisWeek ? "on" : ""}`} onClick={() => setQuick({ ...quick, thisWeek: !quick.thisWeek })}>This week</button>
              {METHODS.map((m) => (
                <button key={m} className={`chip ${quick.methods.includes(m) ? "on" : ""}`} onClick={() => flip("methods", m)}>{LABEL.method[m]}</button>
              ))}
              {(data?.rows ?? []).some((r) => r.budget) && (
                <button className={`chip ${quick.affordable ? "on" : ""}`} onClick={() => setQuick({ ...quick, affordable: !quick.affordable })}>Within budget</button>
              )}
            </div>
          </section>
          <section>
            <div className="section-title">Verdicts <span className="muted small">most recent</span></div>
            <div className="houses-verdicts">
              {[...active].sort((a, b) => Number(b.id === me?.id) - Number(a.id === me?.id)).map((person) => (
                <div key={person.id} className="houses-verdict-row">
                  <span className="houses-verdict-who"><span className="dot" style={{ background: person.colour }} />{person.id === me?.id ? "Me" : person.display_name}</span>
                  <div className="chips">
                    {VERDICTS.map((v) => (
                      <button key={v} className={`chip ${quick.verdicts[person.id]?.includes(v) ? "on" : ""}`} onClick={() => flipVerdict(person.id, v)}>
                        {v === "unset" ? "None yet" : LABEL.stance[v]}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="chips">
              <button className={`chip ${quick.hideExcluded ? "on" : ""}`} onClick={() => setQuick({ ...quick, hideExcluded: !quick.hideExcluded })}>Hide my excluded</button>
            </div>
          </section>
          {suburbs.length > 1 && (
            <section>
              <div className="section-title">Suburb</div>
              <div className="chips">
                {suburbs.map((x) => (
                  <button key={x} className={`chip ${suburbClass(slots, x)} ${quick.suburbs.includes(x) ? "on" : ""}`} onClick={() => flip("suburbs", x)}>
                    <span className="suburb-swatch" />{x}</button>
                ))}
              </div>
            </section>
          )}
          {tagNames.length > 0 && (
            <section>
              <div className="section-title">Tags</div>
              <div className="chips">
                {tagNames.map((t) => (
                  <button key={t} className={`chip ${quick.tags.includes(t) ? "on" : ""}`} style={quick.tags.includes(t) ? undefined : tagStyle(tagColours, t)}
                    onClick={() => flip("tags", t)}>#{t}</button>
                ))}
              </div>
            </section>
          )}
          {(views.data?.length ?? 0) > 0 && (
            <section>
              <div className="section-title">Saved views <span className="muted small">from the Grid</span></div>
              <div className="chips">
                {views.data!.map((v) => (
                  <button key={v.id} className={`chip ${view.id === v.id ? "on" : ""}`} onClick={() => setViewId(view.id === v.id ? null : v.id ?? null)}>{v.name}</button>
                ))}
              </div>
            </section>
          )}
          <section>
            <div className="section-title">Any other field</div>
            <FieldFilter key={fieldStart ?? "pick"} cols={cols} rows={data?.rows ?? []} current={extra} start={fieldStart}
              onApply={(column, fs) => { setExtra((x) => [...x.filter((f) => f.column !== column), ...fs]); setFieldStart(null); }} />
          </section>
          <div className="row">
            <span className="grow" />
            <button className="primary" onClick={() => setPanelOpen(false)}>Show {rows.length} {rows.length === 1 ? "house" : "houses"}</button>
          </div>
        </div>
      )}
      {isPending && <p className="muted">Loading…</p>}
      {isError && <p className="error">Couldn't load houses.</p>}
      {data && data.rows.length === 0 && <div className="card"><p>No houses yet.</p><Link to="/add">Add the first one</Link></div>}
      {data && data.rows.length > 0 && rows.length === 0 && (
        <div className="card empty">No houses match{stage === "all" ? "" : ` in ${STAGE_LABEL[stage]}`}.{" "}
          {onChips.length > 0 || search.trim() ? <button className="link" onClick={clearAll}>Clear the filters</button>
            : stage !== "all" && <button className="link" onClick={() => setStage("all")}>Show all houses</button>}</div>
      )}
      {/* Houses nobody has inspected yet come first; the ones you've been through sit in their own section (not when
          grouped by suburb and street, where the grouping is the order). */}
      {grouped ? cards(rows) : cards(toSee)}
      {!grouped && seenRows.length > 0 && (
        <section className="inspected-section">
          <button className="section-toggle" aria-expanded={showInspected} onClick={() => setShowInspected(!showInspected)}>
            {showInspected ? <ChevronDown /> : <ChevronRight />} Inspected <span className="muted">({seenRows.length})</span>
          </button>
          {showInspected && cards(seenRows)}
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

/** A house's place along its street: number, then any letter (12, 12A, 12B), then unit (1/12 before 2/12). */
function streetOrder(r: OverviewRow): [number, string, number] {
  const m = String(r.street_number ?? "").match(/^(\d+)\s*([A-Za-z]?)/);
  return [m ? Number(m[1]) : Number.MAX_SAFE_INTEGER, (m?.[2] ?? "").toUpperCase(), Number(String(r.unit ?? "").match(/\d+/)?.[0] ?? 0)];
}

/** Houses by suburb, then street, both A to Z (or Z to A), and each street's houses by number. */
function suburbGroups(rows: OverviewRow[], reversed = false) {
  const cmp = (a: [number, string, number], b: [number, string, number]) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2];
  const bySuburb = new Map<string, Map<string, OverviewRow[]>>();
  for (const r of rows) {
    const suburb = String(r.suburb ?? ""), street = String(r.street || r.address);
    if (!bySuburb.has(suburb)) bySuburb.set(suburb, new Map());
    const streets = bySuburb.get(suburb)!;
    streets.set(street, [...(streets.get(street) ?? []), r]);
  }
  const way = reversed ? -1 : 1;
  return [...bySuburb.entries()].sort(([a], [b]) => way * a.localeCompare(b, "en-AU")).map(([suburb, streets]) => ({
    suburb, count: [...streets.values()].reduce((n, l) => n + l.length, 0),
    streets: [...streets.entries()].sort(([a], [b]) => way * a.localeCompare(b, "en-AU", { numeric: true }))
      .map(([street, list]) => ({ street, rows: list.sort((a, b) => way * cmp(streetOrder(a), streetOrder(b))) })),
  }));
}

/** Days until a sale date, in words ("today", "tomorrow", "in 5 days"), or null once it's passed or too far off. */
function countdown(iso: unknown): string | null {
  if (typeof iso !== "string" || !iso) return null;
  const days = Math.round((new Date(iso).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400_000);
  return days < 0 || days > 21 ? null : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

/** A house at a glance: photo, where it is, the price and how the sale's going; its rooms; how far things are; its
 *  school zones; what the price is doing; and what you each think. Each on its own line, in that order, with
 *  anything missing simply left out. Long-press shows the agent. */
function Card({ r, people, favourites, cols, slots, tagColours, picked, onPick }: {
  r: OverviewRow; people: { id: string; display_name: string; colour: string }[]; favourites: OverviewPlace[]; cols: Column[];
  slots: Map<string, number>; tagColours: Map<string, string>;
  picked?: boolean; onPick: (id: string) => void;  // picked is undefined when not choosing houses to compare
}) {
  const navigate = useNavigate();
  const [agent, setAgent] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const col = (k: string) => cols.find((c) => c.key === k)!;
  const n = (k: string) => (r[k] as number | null) ?? null;
  const mins = (v: unknown, mode?: "drive" | "transit") => v == null ? null
    : <b className={`tone-${minutesTone(v, mode)}`}>{String(v)}</b>;
  const change = n("guide_change");
  // The campaign has an outcome but the house still looks active: nudge whoever looks next.
  const staleStatus = statusOutOfStep(r.outcome as Outcome, Boolean(r.bought_by_us), r.status as Status);
  const sold = isSold(r.outcome) ? n("sold_price_aud") : null;
  const soon = !r.outcome ? countdown(r.sale_at) : null;
  const sale = r.outcome ? display(col("outcome"), r.outcome)
    : r.sale_at ? `${display(col("sale_method"), r.sale_method)} ${display(col("sale_at"), r.sale_at)}`
    : r.sale_method ? display(col("sale_method"), r.sale_method) : "Not listed";
  const places = favourites.filter((f) => r[`drive:${f.id}`] != null || r[`transit:${f.id}`] != null).slice(0, 3);
  const schools = [...new Set([r.school_primary, r.school_secondary].filter(Boolean).map(String))];   // a P-12 school is both
  const verdicts = people.map((p) => ({ p, post: r[`v:${p.id}:post`] as string | undefined, pre: r[`v:${p.id}:pre`] as string | undefined }))
    .filter((x) => x.post ?? x.pre);
  const tags = (r.tags as string[] | undefined) ?? [];
  const photos = n("photo_count") ?? 0;
  const facts = [
    r.beds != null && <span key="b"><BedDouble /> {String(r.beds)}</span>,
    r.baths != null && <span key="ba"><Bath /> {String(r.baths)}</span>,
    r.car_spaces != null && <span key="c"><Car /> {String(r.car_spaces)}</span>,
    r.land_m2 != null && <span key="l"><LandPlot /> {landArea(Number(r.land_m2))}</span>,
    r.property_type !== "house" && r.property_type != null && <span key="t" className="muted">{display(col("property_type"), r.property_type)}</span>,
  ].filter(Boolean) as ReactNode[];
  const notes = [
    change != null && change !== 0 && <span key="g" className={`pill tone-${changeTone(change)}`}>guide {change > 0 ? "↑" : "↓"} {money(Math.abs(change))}</span>,
    (r.budget === "over" || r.budget === "stretch") && <span key="bu" className={`pill tone-${budgetTone(r.budget)}`} title="Guide compared with your maximum bid (Settings)">
      {r.budget === "over" ? "Over budget" : "Stretch"}</span>,
    r.walk_away != null && <span key="w" className="pill">our max {money(n("walk_away"))}</span>,
    Boolean(r.days_on_market != null && r.sale_method && !r.outcome) && <span key="d" className="pill quiet">{String(r.days_on_market)} {r.days_on_market === 1 ? "day" : "days"} listed</span>,
  ].filter(Boolean) as ReactNode[];
  const go = (e: React.MouseEvent, to: string) => { e.preventDefault(); e.stopPropagation(); navigate(to); };
  // On the To inspect list or not, from the card. A finished sale or a ruled-out house has nothing left to inspect.
  const queryClient = useQueryClient();
  const finished = r.excluded || CLOSED.includes(r.status as never) || saleEnded(r.outcome, r.bought_by_us);
  const toggleInspect = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    await api(`/api/properties/${r.id}/inspect-list`, { method: r.to_inspect ? "DELETE" : "PUT" });
    for (const key of [["overview"], ["inspections"], ["property", r.id]]) queryClient.invalidateQueries({ queryKey: key });
  };

  return (
    <Link to={`/p/${r.id}`} className={`card property-card tint ${suburbClass(slots, r.suburb)} ${r.excluded || CLOSED.includes(r.status as never) || saleEnded(r.outcome, r.bought_by_us) ? "dim" : ""} ${picked ? "picked" : ""}`}
      onClick={(e) => { if (picked !== undefined) { e.preventDefault(); onPick(r.id); } }} aria-pressed={picked}
      onTouchStart={() => { timer.current = window.setTimeout(() => setAgent(true), 500); }}
      onTouchEnd={() => window.clearTimeout(timer.current)}
      onContextMenu={(e) => { if (r.agent_phone) { e.preventDefault(); setAgent(true); } }}>
      <div className="card-thumb pc-photo" aria-hidden>
        {r.cover_id ? <img src={`/api/attachments/${String(r.cover_id)}/thumb`} alt="" loading="lazy" /> : (
          <svg viewBox="0 0 32 32"><path d="M7.5 15.5 16 8.5l8.5 7M10.5 13.5v10h11v-10M14.2 23.5v-5h3.6v5" /></svg>
        )}
        {photos > 1 && <span className="pc-count"><Camera /> {photos}</span>}
      </div>
      <div className="pc-body">
        <div className="pc-top">
          <div className="pc-where">
            <span className="address">{String(r.address)}</span>
            <span className="suburb-name small">{String(r.suburb)}</span>
          </div>
          <div className="pc-price">
            <strong className={sold == null && n("guide_low") == null ? "muted" : ""}>
              {sold != null ? money(sold) : n("guide_low") == null ? "No guide" : moneyRange(n("guide_low"), n("guide_high"))}</strong>
            <span className={`small ${soon ? `tone-${soonTone(r.sale_at)}` : "muted"}`}>{sale}</span>
          </div>
        </div>

        <div className="pc-badges">
          <span className="pill status-pill"><span className="status-dot" style={{ background: STATUS_COLOUR[r.status as never] }} />{display(col("status"), r.status)}</span>
          {!r.outcome && listingState(r.listing_status) === "underoffer" && <span className="pill maybe">Under offer</span>}
          {((r.attended_by as string[] | undefined)?.length ?? 0) > 0 && <span className="pill" title="Someone has been to see it">Inspected</span>}
          {!finished && (
            <button className={`pc-link ${r.to_inspect ? "on" : ""}`} onClick={toggleInspect} aria-pressed={Boolean(r.to_inspect)}
              title={r.to_inspect ? "Take it off the To inspect list" : "Put it on the To inspect list"}>
              {r.to_inspect ? <><DoorOpen /> To inspect ✕</> : <><DoorOpen /> To inspect</>}</button>
          )}
          {soon && <span className={`pill tone-${soonTone(r.sale_at)}`}><CalendarDays /> {r.sale_method === "eoi" ? "Closes" : "Auction"} {soon}</span>}
          {Boolean(r.excluded) && <span className="pill no">Excluded</span>}
          {Boolean(r.floorplan_id) && (
            <button className="pc-link" onClick={(e) => go(e, `/p/${r.id}/plan/${String(r.floorplan_id)}`)} title="Open the floor plan"><PencilRuler /> Floor plan</button>
          )}
        </div>

        {facts.length > 0 && <div className="pc-facts">{facts}</div>}

        {(Boolean(r.nearest_station) || places.length > 0) && (
          <div className="pc-travel">
            {Boolean(r.nearest_station) && (
              <span className="pc-chip" title={`Nearest station: ${String(r.nearest_station)}`}>
                <TrainFront /><span className="pc-chip-name">{String(r.nearest_station)}</span>
                {r.nearest_station_walk != null && <> <Footprints />{mins(r.nearest_station_walk)}</>}
                {r.nearest_station_drive != null && <> <Car />{mins(r.nearest_station_drive, "drive")}</>}
              </span>
            )}
            {places.map((f) => (
              <span key={f.id} className="pc-chip" title={`Minutes to ${f.name} by car and public transport`}>
                <MapPin /><span className="pc-chip-name">{f.name}</span>
                {r[`drive:${f.id}`] != null && <> <Car />{mins(r[`drive:${f.id}`], "drive")}</>}
                {r[`transit:${f.id}`] != null && <> <TramFront />{mins(r[`transit:${f.id}`], "transit")}</>}
              </span>
            ))}
          </div>
        )}

        {schools.length > 0 && <div className="pc-schools small"><GraduationCap /> {schools.join(" · ")}</div>}

        {sold != null
          ? <SoldAgainst sold={sold} firstLow={n("first_guide_low")} firstHigh={n("first_guide_high")} ours={n("expected_sale")} />
          : notes.length > 0 && <div className="pc-notes">{notes}</div>}

        {(staleStatus || Boolean(r.needs_outcome)) && (
          <div className="pc-alert small"><TriangleAlert />
            {staleStatus ? "Sale's over. Update the status."
              : `${r.listing_status ? `The listing says ${String(r.listing_status).replace(/_/g, " ")}` : "The sale date has passed"}. Record the outcome.`}</div>
        )}

        {(verdicts.length > 0 || r.score_avg != null || tags.length > 0) && (
          <div className="pc-people">
            {verdicts.map(({ p, post, pre }) => (
              <span key={p.id} className="pc-verdict" title={`${p.display_name}, ${post ? "after inspecting" : "before inspecting"}`}>
                <span className="dot" style={{ background: p.colour }} />{p.display_name}
                <span className={`pill ${post ?? pre}`}>{LABEL.stance[(post ?? pre) as "yes"]}{!post && <span className="muted"> · pre</span>}</span>
              </span>
            ))}
            {r.score_avg != null && <span className="pill score-pill" title="Average score out of 100">Score {String(r.score_avg)}</span>}
            {tags.map((t) => <span key={t} className="tag" style={tagStyle(tagColours, t)}>#{t}</span>)}
          </div>
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
  async function dismiss(id: string) {
    await api(`/api/shared-links/${id}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: ["shared-links"] });
  }
  return (
    <div className="card stack shared-links">
      <strong>Shared links to add</strong>
      {data.map((l) => (
        <div key={l.id} className="row small">
          <span className="grow" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <a href={l.url} target="_blank" rel="noreferrer">{describeLink(l.url).main}</a>
            {describeLink(l.url).site && <span className="muted"> · {describeLink(l.url).site}</span>}
            {l.shared_by && <span className="muted"> · {byId.get(l.shared_by)?.display_name}</span>}</span>
          <button className="primary small-btn" onClick={() => navigate(`/add?url=${encodeURIComponent(l.url)}`)}>Add</button>
          <button className="small-btn" onClick={() => dismiss(l.id)}>Dismiss</button>
        </div>
      ))}
    </div>
  );
}
