// Property page sections for milestone 3: inspections (with each person's notes) and photos/documents.
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { FileText, PencilRuler } from "lucide-react";
import { Link } from "react-router-dom";
import { api, type Opinion } from "../api";
import { fromLocalInput, INSPECTION_KINDS } from "../format";
import { newId, sendOrQueue, uploadFiles, uploadMessage } from "../outbox";
import { usePeople } from "../people";
import ConfirmButton from "../ConfirmButton";
import type { ViewerItem } from "../DocViewer";

const DocViewer = lazy(() => import("../DocViewer"));
const PhotoViewer = lazy(() => import("../PhotoViewer"));

export type Inspection = {
  id: string; kind: string; starts_at: string; ends_at: string | null; state: string; inspector: string | null;
  notes: string | null; attendees: { person_id: string; note: string | null }[];
  updated_by_name?: string | null;   // who last changed it: who took it off with Not going
};
export type Attachment = {
  id: string; kind: string; sha256: string | null; mime_type: string | null; original_name: string | null;
  url: string | null; caption: string | null; taken_at: string | null; created_at: string; created_by: string;
  width?: number | null; height?: number | null;  // images: as shown, upright
  markups?: number;  // floor plan markup versions (floorplan/FloorplanEditor.tsx)
};

const KINDS = INSPECTION_KINDS;
// Victorian labels for the generic document kinds (region pack, PLAN.md D9).
export const DOC_KINDS: Record<string, string> = {
  photo: "Photo", floorplan: "Floor plan", price_statement: "Statement of Information", vendor_statement: "Section 32",
  contract: "Contract", building_report: "Building report", pest_report: "Pest report", strata_report: "Strata report",
  strata_certificate: "Owners corporation certificate", plans_specs: "Plans & specs", other: "Other",
};

function useRefresh(propertyId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["property", propertyId] });
    queryClient.invalidateQueries({ queryKey: ["inspections"] });
    queryClient.invalidateQueries({ queryKey: ["overview"] });  // cover photos show on the cards and the map
    queryClient.invalidateQueries({ queryKey: ["map"] });
  };
}

const dayName = new Intl.DateTimeFormat("en-AU", { weekday: "short" });
const dayMonth = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" });
const clockFmt = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });
const clock = (t: string) => clockFmt.format(new Date(t)).toLowerCase();
const STATE_LABEL: Record<string, string> = { attended: "Went", skipped: "Not going", cancelled: "Cancelled", planned: "Did you go?" };

/** Where this house stands on the Inspections page, by that page's rules: on the To inspect list it's in the day's list;
 *  otherwise a house you've been to is under "Already inspected" and one someone said No to is under "Passed on";
 *  anything else is in the list. The words, a short tag, and the button that changes it. */
function standing(toInspect: boolean, inspectedBy: string[], no: string[]) {
  if (toInspect) return { tag: "On To inspect", text: "In the Inspections list.", action: ["Take off the list", "DELETE"] as const };
  if (inspectedBy.length > 0) return { tag: "Already inspected", text: "Kept under Already inspected on the Inspections page.", action: ["Add again", "PUT"] as const };
  if (no.length > 0) return { tag: "Passed on", text: `${no.join(" and ")} said No, so it's under Passed on.`, action: ["Add back", "PUT"] as const };
  return { tag: "In the list", text: "Its times show on the Inspections page.", action: ["Add to To inspect", "PUT"] as const };
}

export function Inspections({ propertyId, inspections, toInspect, inspected, inspectedBy, opinions }: {
  propertyId: string; inspections: Inspection[]; toInspect: boolean; inspected: boolean; inspectedBy: string[]; opinions: Opinion[];
}) {
  const refresh = useRefresh(propertyId);
  const { me, byId, active } = usePeople();
  const [kind, setKind] = useState("open");
  const [at, setAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); refresh(); } catch (e) { setError((e as Error).message); }
  };
  const add = () => run(async () => {
    await api(`/api/properties/${propertyId}/inspections`, { method: "POST", body: { kind, starts_at: fromLocalInput(at) } });
    setAt("");
  });
  const setState = (id: string, state: string) => run(() => api(`/api/inspections/${id}`, { method: "PATCH", body: { state } }));

  const latest = new Map<string, Opinion>();
  for (const o of opinions) if (!latest.has(o.person_id) || o.recorded_at > latest.get(o.person_id)!.recorded_at) latest.set(o.person_id, o);
  const no = active.filter((p) => latest.get(p.id)?.stance === "no").map((p) => p.display_name);
  const st = standing(toInspect, inspectedBy, no);

  // Coming up: planned and not over yet. Earlier: what's happened (or was cancelled), newest first. Not going is kept,
  // folded away, with who took it off, the same as on the Inspections page.
  const now = Date.now();
  const over = (i: Inspection) => new Date(i.ends_at ?? i.starts_at).getTime() < now;
  const upcoming = inspections.filter((i) => i.state === "planned" && !over(i)).sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  const notGoing = inspections.filter((i) => i.state === "skipped");
  const earlier = inspections.filter((i) => !upcoming.includes(i) && i.state !== "skipped");

  const date = (i: Inspection) => (
    <div className="ip-date" aria-hidden><span>{dayName.format(new Date(i.starts_at))}</span><strong>{dayMonth.format(new Date(i.starts_at))}</strong></div>
  );
  const what = (i: Inspection) => <><strong className="ip-time">{clock(i.starts_at)}{i.ends_at ? `–${clock(i.ends_at)}` : ""}</strong>
    <span className="small muted">{KINDS[i.kind] ?? i.kind}</span></>;

  return (
    <div className="card stack insp-panel">
      <div className="ip-head">
        <h2>Inspections</h2>
        <span className={`pill ${toInspect ? "on" : ""}`}>{st.tag}</span>
      </div>
      <div className="ip-standing">
        <span className="small muted grow">{st.text}</span>
        <button className="small-btn" onClick={() => run(() => api(`/api/properties/${propertyId}/inspect-list`, { method: st.action[1] }))}>{st.action[0]}</button>
        <label className="check small"><input type="checkbox" checked={inspected}
          onChange={(e) => run(() => api(`/api/properties/${propertyId}/inspected`, { method: e.target.checked ? "PUT" : "DELETE" }))} />
          We've been to this house</label>
      </div>

      <section>
        <h3 className="ip-sub">Coming up</h3>
        {upcoming.length === 0 && <p className="small muted ip-empty">Nothing booked. Add a time below, or update the house from its listing.</p>}
        <ul className="ip-list">
          {upcoming.map((i) => (
            <li key={i.id}>
              {date(i)}
              <div className="grow ip-what">
                {what(i)}
                {i.inspector && <div className="small muted">Inspector: {i.inspector}</div>}
              </div>
              <div className="ip-acts">
                <a className="small" href={`/api/events/inspection/${i.id}.ics`}>Calendar</a>
                <ConfirmButton className="link small" label="Not going" question="Not going?" yes="Remove" onConfirm={() => setState(i.id, "skipped")} />
              </div>
            </li>
          ))}
        </ul>
      </section>

      {earlier.length > 0 && (
        <section>
          <h3 className="ip-sub">Earlier</h3>
          <ul className="ip-list">
            {earlier.map((i) => {
              const mine = i.attendees.find((x) => x.person_id === me?.id);
              return (
                <li key={i.id}>
                  {date(i)}
                  <div className="grow stack ip-past">
                    <div className="ip-row"><div className="grow ip-what">{what(i)}</div>
                      <span className={`pill ${i.state === "attended" ? "yes" : "quiet"}`}>{STATE_LABEL[i.state] ?? i.state}</span></div>
                    {i.attendees.map((x) => (
                      <div key={x.person_id} className="small">
                        <span className="dot" style={{ background: byId.get(x.person_id)?.colour }} />
                        {byId.get(x.person_id)?.display_name} went{x.note ? `: ${x.note}` : ""}
                      </div>
                    ))}
                    {i.state === "attended" && <AttendeeNote inspectionId={i.id} initial={mine?.note ?? ""} attended={!!mine} onDone={refresh} />}
                    {i.state === "planned" && (
                      <div className="ip-row small">
                        <button className="small-btn" onClick={() => me && run(() => api(`/api/inspections/${i.id}/attendees/${me.id}`, { method: "PUT", body: { note: null } }))}>I went</button>
                        <button className="link" onClick={() => setState(i.id, "skipped")}>Didn't go</button>
                        <button className="link" onClick={() => setState(i.id, "cancelled")}>Cancelled by the agent</button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {notGoing.length > 0 && (
        <details className="ip-fold">
          <summary><strong>Not going</strong> <span className="muted">· {notGoing.length}</span></summary>
          <ul className="ip-list">
            {notGoing.map((i) => (
              <li key={i.id}>
                {date(i)}
                <div className="grow ip-what">{what(i)}<span className="small muted">Removed by {i.updated_by_name ?? "someone"}</span></div>
                <button className="small-btn" onClick={() => setState(i.id, "planned")}>Add back</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <section>
        <h3 className="ip-sub">Add a time</h3>
        <div className="ip-add">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="When" />
          <button className="primary" disabled={!at} onClick={add}>Add</button>
        </div>
      </section>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function AttendeeNote({ inspectionId, initial, attended, onDone }: { inspectionId: string; initial: string; attended: boolean; onDone: () => void }) {
  const { me } = usePeople();
  const [note, setNote] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    if (!me) return;
    const result = await sendOrQueue({
      id: newId(), method: "PUT", path: `/api/inspections/${inspectionId}/attendees/${me.id}`,
      body: { note: note.trim() || null }, label: `Inspection note by ${me.display_name}`,
    });
    setMsg(result === "sent" ? null : "Saved on this phone. It sends when you're back online.");
    onDone();
  }
  return (
    <div className="row">
      <input className="grow" placeholder={attended ? "Your notes" : "Went? Add your notes"} value={note} onChange={(e) => setNote(e.target.value)} />
      <button onClick={save}>{attended ? "Save note" : "I went"}</button>
      {msg && <span className="small muted">{msg}</span>}
    </div>
  );
}

export function Files({ propertyId, attachments, coverId, address }: { propertyId: string; attachments: Attachment[]; coverId?: string | null; address?: string }) {
  const refresh = useRefresh(propertyId);
  const { me } = usePeople();
  const [kind, setKind] = useState("photo");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await uploadFiles(propertyId, address ?? "this house", Array.from(files), kind);
      if (result.queued) setError(uploadMessage(result, kind === "photo" ? "photo" : "file"));
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addLink() {
    const form = new FormData();
    form.append("url", url.trim());
    form.append("kind", kind);
    const res = await fetch(`/api/properties/${propertyId}/attachments`, { method: "POST", body: form, headers: { "X-Person-Id": me?.id ?? "" } });
    if (res.ok) { setUrl(""); refresh(); } else setError((await res.json().catch(() => null))?.detail ?? "Couldn't add the link");
  }

  // The cover first, then the listing's photos in the listing's order, then everyone's own, newest first.
  const fromListing = (a: Attachment) => a.caption === "From the listing";
  // Floor plans are images but belong with the documents (they open in the viewer, never the cover).
  const isPhoto = (a: Attachment) => a.kind === "photo" && !!a.sha256 && !!a.mime_type?.startsWith("image/");
  const photos = attachments.filter(isPhoto).sort((a, b) =>
    Number(b.id === coverId) - Number(a.id === coverId) || Number(fromListing(b)) - Number(fromListing(a))
    || (fromListing(a) ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));
  const docs = attachments.filter((a) => !isPhoto(a)).sort((a, b) => Number(b.kind === "floorplan") - Number(a.kind === "floorplan"));
  // The viewer steps through photos, or through documents kept in House Track (links open on their own site).
  // Photos open in the photo viewer (swipe, pinch to zoom); documents, floor plans among them, in the document viewer.
  const [viewing, setViewing] = useState<{ items: ViewerItem[]; start: number } | null>(null);
  const [photoAt, setPhotoAt] = useState<number | null>(null);
  const fileDocs = docs.filter((d) => !d.url);
  const docItems: ViewerItem[] = fileDocs.map((d) => ({ id: d.id, title: d.caption ?? d.original_name ?? DOC_KINDS[d.kind] ?? "Document", mime: d.mime_type }));
  const [keeping, setKeeping] = useState<string | null>(null);
  async function keepCopy(id: string) {
    setKeeping(id);
    setError(null);
    try { await api(`/api/attachments/${id}/keep-copy`, { method: "POST" }); refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setKeeping(null); }
  }
  return (
    <div className="card stack">
      <h2>Photos and documents</h2>
      {photos.length > 0 && (
        <div className="thumbs">
          {photos.map((p) => (
            <div key={p.id} className={`thumb ${p.id === coverId ? "is-cover" : ""}`}>
              <a href={`/api/attachments/${p.id}/file`} title={p.caption ?? p.original_name ?? ""}
                onClick={(e) => { e.preventDefault(); setPhotoAt(photos.indexOf(p)); }}>
                <img src={`/api/attachments/${p.id}/thumb`} alt={p.caption ?? DOC_KINDS[p.kind]} loading="lazy" />
              </a>
              {p.id === coverId && <span className="thumb-badge">Cover</span>}
              <div className="thumb-actions">
                {p.id !== coverId && (
                  <button title="Use as the cover photo" onClick={() => api(`/api/properties/${propertyId}/cover`, { method: "PUT", body: { attachment_id: p.id } }).then(refresh)}>
                    ★ Cover</button>
                )}
                <ConfirmButton className="" title="Remove this photo" label="✕" question="Remove?" yes="Remove"
                  onConfirm={() => api(`/api/attachments/${p.id}`, { method: "DELETE" }).then(refresh)} />
              </div>
            </div>
          ))}
        </div>
      )}
      {docs.map((d) => (
        <div key={d.id} className="row small doc-row">
          <span className="pill">{DOC_KINDS[d.kind] ?? d.kind}</span>
          {d.url ? (
            <>
              <a className="grow" href={d.url} target="_blank" rel="noreferrer">{d.caption ?? d.url} ↗</a>
              <button className="link" disabled={keeping === d.id} onClick={() => keepCopy(d.id)}
                title="Save a copy (works offline)">{keeping === d.id ? "Saving…" : "Keep a copy"}</button>
            </>
          ) : (
            <button className="link grow doc-open" onClick={() => setViewing({ items: docItems, start: fileDocs.indexOf(d) })}>
              <FileText /> {d.caption ?? d.original_name ?? "Document"}</button>
          )}
          {!d.url && (d.kind === "floorplan" || (d.markups ?? 0) > 0) && (d.mime_type?.startsWith("image/") || d.mime_type === "application/pdf") && (
            <Link className="small-btn-link" to={`/p/${propertyId}/plan/${d.id}?edit=1`} title="Measure rooms and try furniture">
              <PencilRuler /> Mark up{(d.markups ?? 0) > 0 && ` (${d.markups})`}</Link>
          )}
          <ConfirmButton className="link" label="Remove" question="Remove it?" yes="Remove"
            onConfirm={() => api(`/api/attachments/${d.id}`, { method: "DELETE" }).then(refresh)} />
        </div>
      ))}
      {viewing && (
        <Suspense fallback={null}><DocViewer items={viewing.items} start={viewing.start} onClose={() => setViewing(null)} /></Suspense>
      )}
      {photoAt != null && (
        <Suspense fallback={null}><PhotoViewer photos={photos} start={photoAt} onClose={() => setPhotoAt(null)} /></Suspense>
      )}
      <div className="grid2">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          {Object.entries(DOC_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="button-like">
          {busy ? "Uploading…" : "Upload files"}
          <input type="file" multiple hidden accept={kind === "photo" ? "image/*" : undefined} onChange={(e) => upload(e.target.files)} />
        </label>
      </div>
      <div className="row">
        <input className="grow" type="url" placeholder="Or paste a link" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button disabled={!/^https?:\/\//.test(url)} onClick={addLink}>Add link</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
