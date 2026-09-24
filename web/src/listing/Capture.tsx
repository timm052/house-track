// What the bookmarklet read from a listing page, and the choices about what to keep (PLAN.md D12).
// Used by Add: a review panel for a new house, and an update panel when the listing is already tracked.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type PropertyType, type SaleMethod } from "../api";
import { when } from "../format";

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
  soi_url?: string | null; photos?: string[]; floorplans?: string[]; image_url?: string | null;
  existing_property_id?: string | null; existing_address?: string | null;
};

export type Choices = { photos: "main" | "all" | "none"; floorplans: boolean; agents: boolean; inspections: boolean; soi: boolean; pin: boolean; tags: string[]; notes: boolean };

export const photosOf = (c: Capture) => (c.photos?.length ? c.photos : c.image_url ? [c.image_url] : []);

export function defaultChoices(c: Capture): Choices {
  return { photos: photosOf(c).length ? "all" : "none", floorplans: true, agents: true, inspections: true, soi: true, pin: true,
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
    floorplans: ch.floorplans ? c.floorplans ?? [] : [],
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
      {(c.floorplans?.length ?? 0) > 0 && (
        <label className="check"><input type="checkbox" checked={ch.floorplans} onChange={(e) => set({ ...ch, floorplans: e.target.checked })} />
          The floor plan</label>
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
/** A tracked house's update request: everything the listing says. The server skips what's already saved and
 *  works out what's new (see listing_apply.refresh), for the preview and the update alike. */
function updateBody(c: Capture, ch: Choices) {
  return {
    ...extrasFor(c, { ...ch, inspections: true, agents: true, soi: true }),
    guide_low_aud: c.guide_low_aud, guide_high_aud: c.guide_high_aud, sale_method: c.sale_method,
    auction_at: c.sale_method === "auction" ? c.auction_at ?? null : null,
    eoi_closes_at: c.sale_method === "eoi" ? c.eoi_closes_at ?? null : null,
    beds: c.beds, baths: c.baths, car_spaces: c.car_spaces, land_m2: c.land_m2, building_m2: c.building_m2 ?? null,
  };
}

export function ExistingUpdate({ c }: { c: Capture }) {
  const id = c.existing_property_id!;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [ch, setCh] = useState<Choices>(() => ({ ...defaultChoices(c), photos: "all", tags: [] }));
  const [msg, setMsg] = useState<string | null>(null);
  // What Update would do, from the server doing it and rolling it back (photos aside: they download later).
  const preview = useQuery({
    queryKey: ["listing-preview", id, c.url],
    queryFn: () => api<{ changes: string[] }>(`/api/properties/${id}/listing-update?preview=true`, { method: "POST", body: updateBody(c, { ...ch, photos: "none", floorplans: false }) }),
    staleTime: Infinity,
  });
  const changes = preview.data?.changes ?? [];
  const photos = photosOf(c);

  async function update() {
    setMsg("Updating…");
    try {
      await api(`/api/properties/${id}/listing-update`, { method: "POST", body: updateBody(c, ch) });
      for (const key of [["property", id], ["overview"], ["tags"]]) queryClient.invalidateQueries({ queryKey: key });
      navigate(`/p/${id}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="card stack capture" style={{ borderColor: "var(--accent)" }}>
      <h2>Already in House Track</h2>
      <p className="small" style={{ margin: 0 }}>This listing is <Link to={`/p/${id}`}>{c.existing_address ?? "a house you track"}</Link>.
        {c.price_text && <> The listing now says <strong>{c.price_text}</strong>.</>}</p>
      {preview.isPending ? <p className="small muted">Checking what's new…</p>
        : preview.isError ? <p className="error small">{(preview.error as Error).message}</p>
        : changes.length === 0 && photos.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>Nothing new on the listing since you last captured it.</p>
        ) : (
          <>
            {changes.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{changes.map((t) => <li key={t}>{t}</li>)}</ul>}
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
            {(c.floorplans?.length ?? 0) > 0 && (
              <label className="check small"><input type="checkbox" checked={ch.floorplans} onChange={(e) => setCh({ ...ch, floorplans: e.target.checked })} />
                The floor plan</label>
            )}
          </>
        )}
      <div className="row">
        <button className="primary" onClick={update} disabled={preview.isPending}>Update the house</button>
        <Link to={`/p/${id}`}><button>Open it</button></Link>
      </div>
      {msg && <p className="small muted" style={{ margin: 0 }}>{msg}</p>}
    </div>
  );
}
