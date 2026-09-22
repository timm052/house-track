// What the bookmarklet read from a listing page, and the choices about what to keep (PLAN.md D12).
// Used by Add: a review panel for a new house, and an update panel when the listing is already tracked.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type PropertyDetail, type PropertyType, type SaleMethod } from "../api";
import { LABEL, money, moneyRange, when } from "../format";

export type Capture = {
  url: string | null; address: string | null;
  address_parts?: { unit: string | null; street_number: string | null; street: string | null; suburb: string | null; postcode: string | null } | null;
  property_type?: PropertyType | null; beds: number | null; baths: number | null; car_spaces: number | null;
  land_m2: number | null; building_m2?: number | null;
  sale_method: SaleMethod | null; auction_at?: string | null; eoi_closes_at?: string | null; listed_on?: string | null;
  guide_low_aud: number | null; guide_high_aud: number | null; price_text?: string | null;
  headline?: string | null; description?: string | null; features?: string[]; suggested_tags?: string[];
  lat?: number | null; lon?: number | null;
  agents?: { name: string; mobile: string | null; email: string | null; agency_name: string | null }[];
  inspections?: { starts_at: string; ends_at: string }[];
  soi_url?: string | null; photos?: string[]; image_url?: string | null;
  existing_property_id?: string | null; existing_address?: string | null;
};

export type Choices = { photos: "main" | "all" | "none"; agents: boolean; inspections: boolean; soi: boolean; pin: boolean; tags: string[]; notes: boolean };

export const photosOf = (c: Capture) => (c.photos?.length ? c.photos : c.image_url ? [c.image_url] : []);

export function defaultChoices(c: Capture): Choices {
  return { photos: photosOf(c).length ? "main" : "none", agents: true, inspections: true, soi: true, pin: true,
           tags: c.suggested_tags ?? [], notes: false };
}

/** The `listing` part of a save or update request. */
export function extrasFor(c: Capture, ch: Choices) {
  const photos = photosOf(c);
  return {
    lat: ch.pin ? c.lat ?? null : null, lon: ch.pin ? c.lon ?? null : null,
    agents: ch.agents ? (c.agents ?? []).map((a) => ({ name: a.name, mobile: a.mobile, email: a.email, agency_name: a.agency_name })) : [],
    inspections: ch.inspections ? c.inspections ?? [] : [],
    soi_url: ch.soi ? c.soi_url ?? null : null,
    tags: ch.tags,
    photos: ch.photos === "all" ? photos : ch.photos === "main" ? photos.slice(0, 1) : [],
  };
}

/** Notes from the listing's own words, if the person wants them. */
export const listingNotes = (c: Capture) =>
  [c.headline, c.description, c.features?.length ? `Features: ${c.features.join(", ")}` : null].filter(Boolean).join("\n\n") || null;

// ─── new house: pick what to keep ─────────────────────────────────────
export function CaptureReview({ c, ch, set }: { c: Capture; ch: Choices; set: (ch: Choices) => void }) {
  const photos = photosOf(c);
  const tick = (k: "agents" | "inspections" | "soi" | "pin" | "notes") => (
    <input type="checkbox" checked={ch[k]} onChange={(e) => set({ ...ch, [k]: e.target.checked })} />
  );
  const tags = [...new Set([...(c.suggested_tags ?? []), ...ch.tags])];
  return (
    <div className="card stack capture">
      <h2>Also from the listing</h2>
      <p className="small muted" style={{ margin: 0 }}>The form below is filled in. Choose what else to save with the house.</p>
      {c.price_text && <div className="small"><span className="muted">Listing says:</span> <strong>{c.price_text}</strong></div>}

      {photos.length > 0 && (
        <div className="stack">
          <div className="section-title" style={{ margin: 0 }}>Photos</div>
          <div className="capture-photos">
            {photos.slice(0, 8).map((u, i) => <img key={u} src={u} alt={`Listing photo ${i + 1}`} referrerPolicy="no-referrer" loading="lazy" />)}
            {photos.length > 8 && <span className="muted small">+{photos.length - 8} more</span>}
          </div>
          <div className="row small">
            {(["main", "all", "none"] as const).map((v) => (
              <label key={v} className="check"><input type="radio" name="photos" checked={ch.photos === v} onChange={() => set({ ...ch, photos: v })} />
                {v === "main" ? "Main photo" : v === "all" ? `All ${photos.length} photos` : "No photos"}</label>
            ))}
          </div>
        </div>
      )}

      {(c.agents?.length ?? 0) > 0 && (
        <label className="check">{tick("agents")}
          <span>Agents: {c.agents!.map((a) => `${a.name}${a.mobile ? ` (${a.mobile})` : ""}`).join(", ")}{c.agents![0].agency_name && <span className="muted"> · {c.agents![0].agency_name}</span>}</span>
        </label>
      )}
      {(c.inspections?.length ?? 0) > 0 && (
        <label className="check">{tick("inspections")}
          <span>Open for inspection: {c.inspections!.map((i) => when(i.starts_at)).join(" · ")}</span>
        </label>
      )}
      {c.soi_url && <label className="check">{tick("soi")}<span>Statement of Information <a href={c.soi_url} target="_blank" rel="noreferrer">(open)</a></span></label>}
      {c.lat != null && <label className="check">{tick("pin")}<span>Map position from the listing <span className="muted">(used only if the address isn't found)</span></span></label>}
      {(c.headline || c.description) && (
        <label className="check">{tick("notes")}<span>Copy the listing description into notes{c.headline && <span className="muted"> · “{c.headline}”</span>}</span></label>
      )}
      {tags.length > 0 && (
        <div>
          <div className="section-title" style={{ marginTop: 4 }}>Tags</div>
          <div className="chips">
            {tags.map((t) => {
              const on = ch.tags.includes(t);
              return <button key={t} type="button" className={`chip ${on ? "on" : ""}`}
                onClick={() => set({ ...ch, tags: on ? ch.tags.filter((x) => x !== t) : [...ch.tags, t] })}>#{t}</button>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── already tracked: refresh the house from its listing ───────────────
export function ExistingUpdate({ c }: { c: Capture }) {
  const id = c.existing_property_id!;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: p } = useQuery({ queryKey: ["property", id], queryFn: () => api<PropertyDetail>(`/api/properties/${id}`) });
  const [ch, setCh] = useState<Choices>(() => ({ ...defaultChoices(c), photos: "all", tags: [] }));
  const [msg, setMsg] = useState<string | null>(null);
  const live = p?.campaigns.find((x) => !x.outcome);
  const latest = live?.price_guides[0];  // newest first
  const guideChanged = !!c.guide_low_aud && (!latest || latest.low_aud !== c.guide_low_aud || latest.high_aud !== (c.guide_high_aud ?? c.guide_low_aud));
  const newInspections = (c.inspections ?? []).filter((i) => !p?.inspections.some((x) => new Date(x.starts_at).getTime() === new Date(i.starts_at).getTime()));
  const newAgents = (c.agents ?? []).filter((a) => !live?.agents.some((x) => x.name.toLowerCase() === a.name.toLowerCase()));
  const dateAt = c.sale_method === "auction" ? c.auction_at : c.eoi_closes_at;
  const liveAt = live && (c.sale_method === "auction" ? live.auction_at : live.eoi_closes_at);
  const dateChanged = !!dateAt && (!liveAt || new Date(liveAt).getTime() !== new Date(dateAt).getTime());
  const methodChanged = !!c.sale_method && !!live && live.sale_method !== c.sale_method;
  const photos = photosOf(c);

  async function update() {
    setMsg("Updating…");
    try {
      const body = { ...extrasFor(c, { ...ch, inspections: true, agents: true }),
                     inspections: newInspections, agents: extrasFor(c, ch).agents.filter((a) => newAgents.some((n) => n.name === a.name)),
                     guide_low_aud: guideChanged ? c.guide_low_aud : null, guide_high_aud: guideChanged ? c.guide_high_aud : null,
                     sale_method: methodChanged ? c.sale_method : null,
                     auction_at: c.sale_method === "auction" && dateChanged ? c.auction_at : null,
                     eoi_closes_at: c.sale_method === "eoi" && dateChanged ? c.eoi_closes_at : null };
      await api(`/api/properties/${id}/listing-update`, { method: "POST", body });
      for (const key of [["property", id], ["overview"], ["tags"]]) queryClient.invalidateQueries({ queryKey: key });
      navigate(`/p/${id}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const changes = [
    guideChanged && <li key="g"><strong>New price guide {moneyRange(c.guide_low_aud, c.guide_high_aud)}</strong>
      {latest && <span className="muted"> (was {moneyRange(latest.low_aud, latest.high_aud)})</span>}</li>,
    methodChanged && <li key="m"><strong>Sale method: {LABEL.method[c.sale_method!]}</strong> <span className="muted">(was {LABEL.method[live!.sale_method]})</span></li>,
    dateChanged && <li key="d">{c.sale_method === "auction" ? "Auction" : "EOI closes"} {when(dateAt!)}{liveAt && <span className="muted"> (was {when(liveAt)})</span>}</li>,
    newInspections.length > 0 && <li key="i">{newInspections.length} new inspection {newInspections.length === 1 ? "time" : "times"}: {newInspections.map((i) => when(i.starts_at)).join(" · ")}</li>,
    newAgents.length > 0 && <li key="a">Agents: {newAgents.map((a) => a.name).join(", ")}</li>,
    c.soi_url && !p?.attachments.some((x) => x.url === c.soi_url) && <li key="s">Statement of Information</li>,
  ].filter(Boolean);

  return (
    <div className="card stack capture" style={{ borderColor: "var(--accent)" }}>
      <h2>Already in House Track</h2>
      <p className="small" style={{ margin: 0 }}>This listing is <Link to={`/p/${id}`}>{c.existing_address ?? "a house you track"}</Link>.
        {c.price_text && <> The listing now says <strong>{c.price_text}</strong>.</>}</p>
      {!p ? <p className="small muted">Checking what's new…</p> : changes.length === 0 && photos.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>Nothing new on the listing since you last captured it.</p>
      ) : (
        <>
          {changes.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{changes}</ul>}
          {photos.length > 0 && (
            <div className="row small">
              <span className="muted">Photos:</span>
              {(["all", "main", "none"] as const).map((v) => (
                <label key={v} className="check"><input type="radio" name="uphotos" checked={ch.photos === v} onChange={() => setCh({ ...ch, photos: v })} />
                  {v === "main" ? "Main photo" : v === "all" ? `All ${photos.length}` : "None"}</label>
              ))}
              <span className="muted">(ones you already have are skipped)</span>
            </div>
          )}
        </>
      )}
      <div className="row">
        <button className="primary" onClick={update} disabled={!p}>Update the house</button>
        <Link to={`/p/${id}`}><button>Open it</button></Link>
      </div>
      {msg && <p className="small muted" style={{ margin: 0 }}>{msg}</p>}
      {latest && !guideChanged && c.guide_low_aud && <p className="small muted" style={{ margin: 0 }}>Guide unchanged at {money(latest.low_aud)}–{money(latest.high_aud)}.</p>}
    </div>
  );
}
