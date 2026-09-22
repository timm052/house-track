import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api, OUTCOMES, PROPERTY_TYPES, STATUSES,
  type Campaign, type GuideSource, type JudgementKind, type Outcome, type PropertyDetail as Detail,
  type PropertyType, type SaleMethod, type Stage, type Stance, type Status,
} from "../api";
import { day, fromLocalInput, km, LABEL, minutes, money, moneyRange, parseMoney, rooms, saleWhen, toLocalInput, when } from "../format";
import { newId, sendOrQueue } from "../outbox";
import { usePeople } from "../people";
import { STATUS_COLOUR, suburbClass, tagStyle, useSuburbSlots, useTagColours } from "../colour";
import { Checklist, Comparables, CostAt, PriceHistory } from "./MoneyExtras";
import { Files, Inspections } from "./PropertyExtras";
import { ScoresCard } from "./Decide";

/** Run a write, then refresh this property and the list. */
function useWrite(propertyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }: { path: string; method?: string; body?: unknown }) =>
      api(path, { method, body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["property", propertyId] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export default function PropertyDetail() {
  const { id = "" } = useParams();
  const { data: p, isPending, isError } = useQuery({
    queryKey: ["property", id],
    queryFn: () => api<Detail>(`/api/properties/${id}`),
    // Keep checking while the worker is still geocoding or routing this property.
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && ((d.lat == null && d.geocode_status === "pending") || d.travel.pending > 0) ? 3000 : false;
    },
  });
  if (isPending) return <p className="muted">Loading…</p>;
  if (isError || !p) return <p className="error">Couldn't load this property. <Link to="/">Back to the list</Link></p>;

  const live = p.campaigns.find((c) => !c.outcome) ?? null;
  const past = p.campaigns.filter((c) => c.outcome);
  return (
    <div style={{ marginTop: 12 }}>
      <Header p={p} />
      <StatusCard p={p} />
      <WhereAndGettingAround p={p} />
      <SchoolsAndPlanning p={p} />
      <Opinions p={p} />
      <ScoresCard propertyId={p.id} />
      <Inspections propertyId={p.id} inspections={p.inspections} />
      <Files propertyId={p.id} attachments={p.attachments} />
      {live ? <CampaignCard propertyId={p.id} c={live} /> : <NewCampaign p={p} />}
      {p.campaigns.some((c) => c.price_guides.length || c.sold_price_aud) && (
        <div className="card"><h2>Price history</h2><PriceHistory campaigns={p.campaigns} /></div>
      )}
      {past.length > 0 && (
        <details className="card">
          <summary>Earlier campaigns ({past.length})</summary>
          {past.map((c) => <CampaignCard key={c.id} propertyId={p.id} c={c} />)}
        </details>
      )}
    </div>
  );
}

// ─── header & edit ────────────────────────────────────────────────────
function Header({ p }: { p: Detail }) {
  const [editing, setEditing] = useState(false);
  const slots = useSuburbSlots();
  return (
    <div className={`card tint ${suburbClass(slots, p.suburb)}`} style={{ borderLeft: "5px solid var(--sub-ink, var(--border))" }}>
      <div className="row">
        <h1 className="grow">{p.address}</h1>
        <Link to={`/compare?ids=${p.id}`} className="small">Compare</Link>
        <button className="link" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>
      </div>
      <div className="row small" style={{ marginBottom: 4 }}>
        {p.suburb && <span><span className="suburb-swatch" /><span className="suburb-name">{p.suburb}</span></span>}
        <span className="pill status-pill"><span className="status-dot" style={{ background: STATUS_COLOUR[p.status] }} />{LABEL.status[p.status]}</span>
      </div>
      <div className="muted">
        {[rooms(p), p.property_type, p.build_status !== "established" && p.build_status.replace(/_/g, " "),
          p.land_m2 && `${p.land_m2} m² land`].filter(Boolean).join(" · ")}
      </div>
      {p.owners_corp_fees_aud_pa != null && <div className="small">Owners corp {money(p.owners_corp_fees_aud_pa)}/yr</div>}
      {p.notes && <p style={{ whiteSpace: "pre-wrap" }}>{p.notes}</p>}
      <TagEditor p={p} />
      {editing && <EditProperty p={p} onDone={() => setEditing(false)} />}
    </div>
  );
}

function TagEditor({ p: detail }: { p: Detail }) {
  const p = { ...detail, tags: detail.tags ?? [] };  // pages saved offline before tags existed have none
  const queryClient = useQueryClient();
  const all = useQuery({ queryKey: ["tags"], queryFn: () => api<{ name: string }[]>("/api/tags") });
  const [text, setText] = useState("");
  const colours = useTagColours();
  const save = async (names: string[]) => {
    await api(`/api/properties/${p.id}/tags`, { method: "PUT", body: { names } });
    setText("");
    for (const key of [["property", p.id], ["overview"], ["tags"]]) queryClient.invalidateQueries({ queryKey: key });
  };
  const suggestions = (all.data ?? []).map((t) => t.name).filter((n) => !p.tags.includes(n) && n.toLowerCase().includes(text.toLowerCase()));
  return (
    <div className="row" style={{ marginTop: 6 }}>
      {p.tags.map((t) => (
        <span key={t} className="tag" style={tagStyle(colours, t)}>#{t} <button className="link" aria-label={`Remove ${t}`} onClick={() => save(p.tags.filter((x) => x !== t))}>✕</button></span>
      ))}
      <input className="grow" list={`tags-${p.id}`} placeholder="Add a tag" value={text} style={{ maxWidth: 200, padding: "4px 8px" }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) save([...p.tags, text.trim()]); }} />
      <datalist id={`tags-${p.id}`}>{suggestions.map((n) => <option key={n} value={n} />)}</datalist>
    </div>
  );
}

function EditProperty({ p, onDone }: { p: Detail; onDone: () => void }) {
  const write = useWrite(p.id);
  const [f, setF] = useState({
    unit: p.unit ?? "", street_number: p.street_number ?? "", street: p.street ?? "", suburb: p.suburb ?? "",
    postcode: p.postcode ?? "", plan_number: p.plan_number ?? "", lot_number: p.lot_number ?? "",
    property_type: p.property_type, beds: p.beds?.toString() ?? "", baths: p.baths?.toString() ?? "",
    car_spaces: p.car_spaces?.toString() ?? "", land_m2: p.land_m2?.toString() ?? "",
    owners_corp: p.owners_corp_fees_aud_pa?.toString() ?? "", notes: p.notes ?? "",
  });
  const input = (k: keyof typeof f) => ({
    value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value }),
  });
  const n = (v: string) => (v.trim() === "" ? null : Number(v));
  const s = (v: string) => (v.trim() === "" ? null : v.trim());

  function save() {
    write.mutate(
      {
        path: `/api/properties/${p.id}`, method: "PATCH",
        body: {
          address: { unit: s(f.unit), street_number: s(f.street_number), street: s(f.street), suburb: s(f.suburb),
                     postcode: s(f.postcode), plan_number: s(f.plan_number), lot_number: s(f.lot_number) },
          property_type: f.property_type, beds: n(f.beds), baths: n(f.baths), car_spaces: n(f.car_spaces),
          land_m2: n(f.land_m2), owners_corp_fees_aud_pa: n(f.owners_corp), notes: s(f.notes),
        },
      },
      { onSuccess: onDone },
    );
  }

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div className="grid3">
        <label>Unit<input {...input("unit")} /></label>
        <label>Number<input {...input("street_number")} /></label>
        <label>Postcode<input {...input("postcode")} /></label>
      </div>
      <label>Street<input {...input("street")} /></label>
      <label>Suburb<input {...input("suburb")} /></label>
      <div className="grid2">
        <label>Plan number<input {...input("plan_number")} /></label>
        <label>Lot<input {...input("lot_number")} /></label>
      </div>
      <label>
        Type
        <select value={f.property_type} onChange={(e) => setF({ ...f, property_type: e.target.value as PropertyType })}>
          {PROPERTY_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </label>
      <div className="grid3">
        <label>Beds<input inputMode="numeric" {...input("beds")} /></label>
        <label>Baths<input inputMode="numeric" {...input("baths")} /></label>
        <label>Cars<input inputMode="numeric" {...input("car_spaces")} /></label>
      </div>
      <div className="grid2">
        <label>Land m²<input inputMode="numeric" {...input("land_m2")} /></label>
        <label>Owners corp $/yr<input inputMode="numeric" {...input("owners_corp")} /></label>
      </div>
      <label>Notes<textarea {...input("notes")} /></label>
      {write.error && <p className="error">{(write.error as Error).message}</p>}
      <button className="primary" onClick={save} disabled={write.isPending}>Save changes</button>
    </div>
  );
}

// ─── shared status ────────────────────────────────────────────────────
function StatusCard({ p }: { p: Detail }) {
  const write = useWrite(p.id);
  const { byId } = usePeople();
  return (
    <div className="card">
      <label>
        <span><span className="status-dot" style={{ background: STATUS_COLOUR[p.status], marginRight: 6 }} />Status (shared)</span>
        <select
          value={p.status}
          onChange={(e) => write.mutate({ path: `/api/properties/${p.id}/status`, body: { status: e.target.value as Status } })}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{LABEL.status[s]}</option>)}
        </select>
      </label>
      {p.status_history.length > 1 && (
        <details>
          <summary>History</summary>
          <ul className="history small">
            {p.status_history.map((h) => (
              <li key={h.id}>{LABEL.status[h.status]} · {byId.get(h.created_by)?.display_name} · {when(h.occurred_at)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ─── location & travel (milestone 2) ──────────────────────────────────
function WhereAndGettingAround({ p }: { p: Detail }) {
  const write = useWrite(p.id);
  const { byId } = usePeople();
  const t = p.travel;
  let where: string;
  if (p.lat == null) where = p.geocode_status === "no_match" ? "Couldn't find this address automatically. Set the pin yourself." : "Finding it on the map…";
  else if (p.manual_pin) where = "Pinned by hand.";
  else if (p.geocode_source === "gnaf") where = (p.geocode_confidence ?? 1) < 0.7 ? "Pinned to the street, not the house. Check it." : "Pinned from the national address file.";
  else where = "Pinned from an OpenStreetMap search. Check it's right.";
  return (
    <div className="card stack">
      <h2>Where and getting around</h2>
      <div className="small">{where}</div>
      <div className="row">
        <Link to={`/map?pin=${p.id}`}><button>{p.lat == null ? "Set pin on map" : "Move pin"}</button></Link>
        {p.manual_pin && p.geocode_source && (
          <button onClick={() => write.mutate({ path: `/api/properties/${p.id}/location`, method: "DELETE" })}>Use the address location</button>
        )}
      </div>
      {p.lat != null && (
        <>
          {t.stations.map((s) => (
            <div key={s.place_id} className="small">
              🚉 {s.is_nearest ? <strong>{s.name}</strong> : s.name}: {minutes(s.duration_s)} walk ({km(s.distance_m)})
            </div>
          ))}
          {t.destinations.map((d) => (
            <div key={d.place_id} className="small">
              📍 {d.name}{d.person_id && <span className="muted"> ({byId.get(d.person_id)?.display_name}'s)</span>}:{" "}
              {d.walk_s == null && d.drive_s == null ? <span className="muted">no route</span> : (
                <>walk {minutes(d.walk_s)} · drive {minutes(d.drive_s)} <span className="muted">({km(d.drive_m)}, no traffic)</span></>
              )}
            </div>
          ))}
          {t.pending > 0 && <div className="small muted">Working out travel times…</div>}
          {t.stations.length === 0 && t.destinations.length === 0 && t.pending === 0 && (
            <div className="small muted">No stations or places chosen yet. <Link to="/places">Choose some</Link></div>
          )}
        </>
      )}
    </div>
  );
}

function SchoolsAndPlanning({ p }: { p: Detail }) {
  if (!p.overlays?.length) return null;
  const schools = p.overlays.filter((o) => o.code.includes("school"));
  const planning = p.overlays.filter((o) => !o.code.includes("school"));
  return (
    <div className="card stack">
      <h2>Schools and planning</h2>
      {schools.map((o) => <div key={o.code + o.label} className="small"><span className="muted">{o.title.replace(/ zones.*$/, "")}:</span> {o.label}</div>)}
      {planning.map((o) => (
        <div key={o.code + o.label} className="small">
          {o.effect !== "info" && <span className={`pill ${o.effect === "hard_exclude" ? "no" : "maybe"}`}>{o.effect === "hard_exclude" ? "excluded" : "check"}</span>}{" "}
          {o.label}
        </div>
      ))}
      <div className="small muted">From the region's planning and school zone data, as of the last setup run. Confirm with a planning certificate.</div>
    </div>
  );
}

// ─── per-person opinions ──────────────────────────────────────────────
function Opinions({ p }: { p: Detail }) {
  const { active, byId, me } = usePeople();
  const [whose, setWhose] = useState(me?.id ?? "");
  const mine = p.opinions.filter((o) => o.person_id === whose);
  const [stage, setStage] = useState<Stage>(mine.some((o) => o.stage === "pre_inspection") ? "post_inspection" : "pre_inspection");
  const [note, setNote] = useState("");

  const current = (personId: string, s: Stage) => p.opinions.find((o) => o.person_id === personId && o.stage === s);

  const queryClient = useQueryClient();
  const [queuedMsg, setQueuedMsg] = useState<string | null>(null);
  async function record(stance: Stance) {
    // Through the outbox, so a verdict typed with no signal isn't lost (PLAN.md D6).
    const id = newId();
    const seen = p.opinions.find((o) => o.person_id === whose && o.stage === stage)?.id ?? null;
    try {
      const result = await sendOrQueue({
        id, method: "POST", path: `/api/properties/${p.id}/opinions`, propertyId: p.id,
        label: `${active.find((x) => x.id === whose)?.display_name}: ${LABEL.stance[stance]} (${LABEL.stageShort[stage]}) for ${p.address}`,
        body: { id, person_id: whose, stage, stance, note: note.trim() || null, recorded_at: new Date().toISOString(),
                check_latest: true, expected_latest_id: seen },
      });
      setNote("");
      setQueuedMsg(result === "queued" ? "No signal: saved on this phone, sends when you're back online." : null);
      queryClient.invalidateQueries({ queryKey: ["property", p.id] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) {
      setQueuedMsg((e as Error).message);
    }
  }

  return (
    <div className="card stack">
      <h2>Opinions</h2>
      <div className="people">
        {active.map((person) => (
          <div key={person.id}>
            <strong><span className="dot" style={{ background: person.colour }} />{person.display_name}</strong>
            {(["pre_inspection", "post_inspection"] as const).map((s) => {
              const o = current(person.id, s);
              return (
                <div key={s} className="small">
                  {LABEL.stage[s]}:{" "}
                  {o ? <><span className={`pill ${o.stance}`}>{LABEL.stance[o.stance]}</span> {o.note}</> : <span className="muted">—</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <div className="grid2">
          <label>
            Whose opinion
            <select value={whose} onChange={(e) => setWhose(e.target.value)}>
              {active.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
            </select>
          </label>
          <label>
            When
            <select value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
              <option value="pre_inspection">{LABEL.stage.pre_inspection}</option>
              <option value="post_inspection">{LABEL.stage.post_inspection} (pursue to buy?)</option>
            </select>
          </label>
        </div>
        <textarea placeholder="Note (optional). Dictate it." value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="stance">
          {(["yes", "maybe", "no"] as const).map((s) => (
            <button key={s} className={`on ${s}`} disabled={!whose} onClick={() => record(s)}>
              {LABEL.stance[s]}
            </button>
          ))}
        </div>
        {queuedMsg && <p className="small muted">{queuedMsg}</p>}
      </div>

      {p.opinions.length > 0 && (
        <details>
          <summary>History ({p.opinions.length})</summary>
          <ul className="history small">
            {p.opinions.map((o) => (
              <li key={o.id}>
                <span className="dot" style={{ background: byId.get(o.person_id)?.colour }} />
                {byId.get(o.person_id)?.display_name} · {LABEL.stageShort[o.stage]}{" "}
                <span className={`pill ${o.stance}`}>{LABEL.stance[o.stance]}</span> · {when(o.recorded_at)}
                {o.created_by !== o.person_id && <span className="muted"> (entered by {byId.get(o.created_by)?.display_name})</span>}
                {o.note && <div>{o.note}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ─── campaigns ────────────────────────────────────────────────────────
function NewCampaign({ p }: { p: Detail }) {
  const write = useWrite(p.id);
  const [method, setMethod] = useState<SaleMethod>("auction");
  const relist = p.campaigns.length > 0;
  return (
    <div className="card stack">
      <h2>{relist ? "Relisted?" : "Not listed yet"}</h2>
      <p className="muted small">
        {relist ? "Start a new campaign. It links to the previous one, so the price history carries over." : "Add the campaign when it goes on the market."}
      </p>
      <div className="row">
        <select className="grow" value={method} onChange={(e) => setMethod(e.target.value as SaleMethod)}>
          {(["auction", "eoi", "private_sale", "other"] as const).map((m) => <option key={m} value={m}>{LABEL.method[m]}</option>)}
        </select>
        <button className="primary" disabled={write.isPending}
          onClick={() => write.mutate({ path: `/api/properties/${p.id}/campaigns`, body: { sale_method: method } })}>
          Start campaign
        </button>
      </div>
      {write.error && <p className="error">{(write.error as Error).message}</p>}
    </div>
  );
}

function CampaignCard({ propertyId, c }: { propertyId: string; c: Campaign }) {
  const write = useWrite(propertyId);
  const { byId } = usePeople();
  const guide = c.price_guides[0];
  const latest = (k: JudgementKind) => c.judgements.find((j) => j.kind === k);
  return (
    <div className="card stack">
      <div className="row">
        <h2 className="grow">{c.outcome ? `${LABEL.method[c.sale_method]} · ${LABEL.outcome[c.outcome]}` : saleWhen(c)}</h2>
        {guide && <strong>{moneyRange(guide.low_aud, guide.high_aud)}</strong>}
      </div>
      {c.outcome && (
        <div className="small">
          {day(c.outcome_on)}
          {c.sold_price_aud != null && ` · sold ${money(c.sold_price_aud)}`}
          {c.passed_in_bid_aud != null && ` · passed in at ${money(c.passed_in_bid_aud)}`}
          {c.bought_by_us && " · bought by us 🎉"}
        </div>
      )}
      {!c.outcome && <CampaignDates propertyId={propertyId} c={c} />}

      <section>
        <h3>Links</h3>
        {c.links.map((l) => (
          <div key={l.id} className="row small">
            <a className="grow" href={l.url} target="_blank" rel="noreferrer">{l.portal === "rea" ? "realestate.com.au" : l.portal === "domain" ? "domain.com.au" : l.url}</a>
            <button className="link" onClick={() => write.mutate({ path: `/api/links/${l.id}`, method: "DELETE" })}>Remove</button>
          </div>
        ))}
        <AddLink propertyId={propertyId} campaignId={c.id} />
      </section>

      <section>
        <h3>Price and guide history</h3>
        <table className="history-table small">
          <thead><tr><th>Seen</th><th>Price / guide</th><th>Change</th><th>Source</th><th>By</th></tr></thead>
          <tbody>
            {c.price_guides.map((g, i) => {
              const prev = c.price_guides[i + 1];
              const mid = (x: { low_aud: number; high_aud: number }) => (x.low_aud + x.high_aud) / 2;
              const delta = prev ? Math.round(mid(g) - mid(prev)) : null;
              return (
                <tr key={g.id}>
                  <td>{day(g.observed_at)}</td>
                  <td><strong>{moneyRange(g.low_aud, g.high_aud)}</strong>{g.note && <div className="muted">{g.note}</div>}
                    {g.statement_suburb_median_aud && <div className="muted">suburb median {money(g.statement_suburb_median_aud)}</div>}</td>
                  <td className={delta == null ? "muted" : delta > 0 ? "error" : delta < 0 ? "good" : "muted"}>
                    {delta == null ? "first" : delta === 0 ? "same" : `${delta > 0 ? "↑" : "↓"} ${money(Math.abs(delta))}`}</td>
                  <td>{LABEL.guideSource[g.source]}</td>
                  <td>{byId.get(g.created_by)?.display_name}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <AddGuide propertyId={propertyId} campaignId={c.id} />
      </section>

      <section>
        <h3>Our numbers (joint)</h3>
        <div className="grid3 small">
          {(["estimated_reserve", "expected_sale", "walk_away"] as const).map((k) => (
            <div key={k}>
              <div className="muted">{LABEL.judgement[k]}</div>
              <strong>{money(latest(k)?.amount_aud)}</strong>
              {c.judgements.filter((j) => j.kind === k).length > 1 && (
                <details><summary className="small">history</summary>
                  {c.judgements.filter((j) => j.kind === k).map((j) => (
                    <div key={j.id} className="small">{money(j.amount_aud)} · {byId.get(j.created_by)?.display_name}, {day(j.created_at)}</div>
                  ))}
                </details>
              )}
              {latest(k) && <div className="muted">{byId.get(latest(k)!.created_by)?.display_name}, {day(latest(k)!.created_at)}</div>}
            </div>
          ))}
        </div>
        <AddJudgement propertyId={propertyId} campaignId={c.id} />
        <CostAt campaign={c} />
      </section>

      <section>
        <h3>Agent</h3>
        {c.agents.map((a) => (
          <div key={a.id} className="small">
            <strong>{a.name}</strong>{a.agency_name && ` · ${a.agency_name}${a.office ? ` ${a.office}` : ""}`}
            {a.mobile && <> · <a href={`tel:${a.mobile.replace(/\s/g, "")}`}>{a.mobile}</a></>}
            {a.email && <> · <a href={`mailto:${a.email}`}>{a.email}</a></>}
          </div>
        ))}
        <AddAgent propertyId={propertyId} campaignId={c.id} />
      </section>

      {!c.outcome && c.sale_method === "auction" && (
        <Link to={`/auction/${c.id}`}><button className="primary">Auction day mode</button></Link>
      )}
      <Checklist campaignId={c.id} />
      <Comparables campaignId={c.id} />
      {!c.outcome && <RecordOutcome propertyId={propertyId} c={c} />}
      {write.error && <p className="error">{(write.error as Error).message}</p>}
    </div>
  );
}

function CampaignDates({ propertyId, c }: { propertyId: string; c: Campaign }) {
  const write = useWrite(propertyId);
  const [method, setMethod] = useState(c.sale_method);
  const [at, setAt] = useState(toLocalInput(c.sale_method === "eoi" ? c.eoi_closes_at : c.auction_at));
  const [listed, setListed] = useState(c.listed_on ?? "");
  return (
    <details>
      <summary>Method and dates</summary>
      <div className="stack">
        <select value={method} onChange={(e) => setMethod(e.target.value as SaleMethod)}>
          {(["auction", "eoi", "private_sale", "other"] as const).map((m) => <option key={m} value={m}>{LABEL.method[m]}</option>)}
        </select>
        {(method === "auction" || method === "eoi") && (
          <label>{method === "auction" ? "Auction" : "EOI closes"}<input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>
        )}
        <label>Listed on<input type="date" value={listed} onChange={(e) => setListed(e.target.value)} /></label>
        <button
          disabled={write.isPending}
          onClick={() =>
            write.mutate({
              path: `/api/campaigns/${c.id}`, method: "PATCH",
              body: {
                sale_method: method, listed_on: listed || null,
                auction_at: method === "auction" ? fromLocalInput(at) : null,
                eoi_closes_at: method === "eoi" ? fromLocalInput(at) : null,
              },
            })
          }
        >
          Save dates
        </button>
      </div>
    </details>
  );
}

function AddLink({ propertyId, campaignId }: { propertyId: string; campaignId: string }) {
  const write = useWrite(propertyId);
  const [url, setUrl] = useState("");
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <input className="grow" type="url" placeholder="Paste a listing link" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button disabled={!url.trim() || write.isPending}
        onClick={() => write.mutate({ path: `/api/campaigns/${campaignId}/links`, body: { url: url.trim() } }, { onSuccess: () => setUrl("") })}>
        Add
      </button>
      {write.error && <p className="error small">{(write.error as Error).message}</p>}
    </div>
  );
}

function AddGuide({ propertyId, campaignId }: { propertyId: string; campaignId: string }) {
  const write = useWrite(propertyId);
  const [source, setSource] = useState<GuideSource>("price_statement");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");
  const [median, setMedian] = useState("");
  const [note, setNote] = useState("");
  const [seen, setSeen] = useState("");
  const lowAud = parseMoney(low);
  return (
    <details>
      <summary>Record a new price or guide</summary>
      <div className="stack">
        <select value={source} onChange={(e) => setSource(e.target.value as GuideSource)}>
          {(Object.keys(LABEL.guideSource) as GuideSource[]).map((s) => <option key={s} value={s}>{LABEL.guideSource[s]}</option>)}
        </select>
        <div className="grid2">
          <label>From<input placeholder="1.2m" value={low} onChange={(e) => setLow(e.target.value)} /></label>
          <label>To<input placeholder="1.3m" value={high} onChange={(e) => setHigh(e.target.value)} /></label>
        </div>
        {source === "price_statement" && <label>Suburb median<input value={median} onChange={(e) => setMedian(e.target.value)} /></label>}
        <label>Date seen (leave blank for today)<input type="date" value={seen} onChange={(e) => setSeen(e.target.value)} /></label>
        <input placeholder="Note, e.g. &quot;vendor wants 1.3+&quot;" value={note} onChange={(e) => setNote(e.target.value)} />
        {write.error && <p className="error small">{(write.error as Error).message}</p>}
        <button
          disabled={lowAud == null || write.isPending}
          onClick={() =>
            write.mutate(
              { path: `/api/campaigns/${campaignId}/price-guides`,
                body: { source, low_aud: lowAud, high_aud: parseMoney(high), statement_suburb_median_aud: parseMoney(median), note: note || null,
                        observed_at: seen ? new Date(`${seen}T12:00`).toISOString() : null } },
              { onSuccess: () => { setLow(""); setHigh(""); setMedian(""); setNote(""); setSeen(""); } },
            )
          }
        >
          Save guide
        </button>
      </div>
    </details>
  );
}

function AddJudgement({ propertyId, campaignId }: { propertyId: string; campaignId: string }) {
  const write = useWrite(propertyId);
  const [kind, setKind] = useState<JudgementKind>("estimated_reserve");
  const [amount, setAmount] = useState("");
  const aud = parseMoney(amount);
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <select className="grow" value={kind} onChange={(e) => setKind(e.target.value as JudgementKind)}>
        {(Object.keys(LABEL.judgement) as JudgementKind[]).map((k) => <option key={k} value={k}>{LABEL.judgement[k]}</option>)}
      </select>
      <input style={{ width: 120 }} placeholder="1.15m" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <button disabled={aud == null || write.isPending}
        onClick={() => write.mutate({ path: `/api/campaigns/${campaignId}/price-judgements`, body: { kind, amount_aud: aud } }, { onSuccess: () => setAmount("") })}>
        Set
      </button>
    </div>
  );
}

function AddAgent({ propertyId, campaignId }: { propertyId: string; campaignId: string }) {
  const write = useWrite(propertyId);
  const [f, setF] = useState({ name: "", agency_name: "", office: "", mobile: "", email: "" });
  const input = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }) });
  const blank = (v: string) => v.trim() || null;
  return (
    <details>
      <summary>Add agent</summary>
      <div className="stack">
        <input placeholder="Name" {...input("name")} />
        <div className="grid2">
          <input placeholder="Agency" {...input("agency_name")} />
          <input placeholder="Office" {...input("office")} />
        </div>
        <div className="grid2">
          <input placeholder="Mobile" inputMode="tel" {...input("mobile")} />
          <input placeholder="Email" type="email" {...input("email")} />
        </div>
        <button disabled={!f.name.trim() || write.isPending}
          onClick={() => write.mutate(
            { path: `/api/campaigns/${campaignId}/agents`,
              body: { name: f.name.trim(), agency_name: blank(f.agency_name), office: blank(f.office), mobile: blank(f.mobile), email: blank(f.email) } },
            { onSuccess: () => setF({ name: "", agency_name: "", office: "", mobile: "", email: "" }) },
          )}>
          Save agent
        </button>
      </div>
    </details>
  );
}

function RecordOutcome({ propertyId, c }: { propertyId: string; c: Campaign }) {
  const write = useWrite(propertyId);
  const [outcome, setOutcome] = useState<Outcome>(c.sale_method === "auction" ? "sold_at_auction" : "sold");
  const [price, setPrice] = useState("");
  const [ours, setOurs] = useState(false);
  const sold = outcome.startsWith("sold");
  const aud = parseMoney(price);
  return (
    <details>
      <summary>Record outcome</summary>
      <div className="stack">
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
          {OUTCOMES.map((o) => <option key={o} value={o}>{LABEL.outcome[o]}</option>)}
        </select>
        {(sold || (outcome === "passed_in" && c.sale_method === "auction")) && (
          <label>{sold ? "Sold price (blank if undisclosed)" : "Passed in at"}<input value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        )}
        {sold && <label className="check"><input type="checkbox" checked={ours} onChange={(e) => setOurs(e.target.checked)} /> We bought it</label>}
        {write.error && <p className="error small">{(write.error as Error).message}</p>}
        <button
          disabled={write.isPending || (price !== "" && aud == null)}
          onClick={() =>
            write.mutate({
              path: `/api/campaigns/${c.id}`, method: "PATCH",
              body: {
                outcome,
                sold_price_aud: sold ? aud : null,
                passed_in_bid_aud: outcome === "passed_in" ? aud : null,
                bought_by_us: sold && ours,
              },
            })
          }
        >
          Save outcome
        </button>
      </div>
    </details>
  );
}
