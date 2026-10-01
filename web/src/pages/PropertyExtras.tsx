// Property page sections for milestone 3: inspections (with each person's notes) and photos/documents.
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { FileText, PencilRuler } from "lucide-react";
import { Link } from "react-router-dom";
import { api, type Opinion } from "../api";
import { fromLocalInput, INSPECTION_KINDS, when } from "../format";
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

/** Where this house stands on the Inspections page, by the same rules as that page: on the To inspect list it's in
 *  the day's list; otherwise a house someone has been to is under "Already inspected", and one someone said No to is
 *  under "Passed on". Anything else is in the list. The button puts it in the list, or takes it out. */
function ListStanding({ propertyId, toInspect, inspectedBy, opinions, onDone }: {
  propertyId: string; toInspect: boolean; inspectedBy: string[]; opinions: Opinion[]; onDone: () => void;
}) {
  const { active } = usePeople();
  const latest = new Map<string, Opinion>();
  for (const o of opinions) if (!latest.has(o.person_id) || o.recorded_at > latest.get(o.person_id)!.recorded_at) latest.set(o.person_id, o);
  const no = active.filter((p) => latest.get(p.id)?.stance === "no").map((p) => p.display_name);
  const call = (method: "PUT" | "DELETE") => api(`/api/properties/${propertyId}/inspect-list`, { method }).then(onDone);
  let text: string, button: [string, "PUT" | "DELETE"] | null;
  if (toInspect) { text = "On your To inspect list. It shows on the Inspections page."; button = ["Remove from list", "DELETE"]; }
  else if (inspectedBy.length > 0) { text = "Already inspected, so it's kept out of the Inspections list."; button = ["Add again", "PUT"]; }
  else if (no.length > 0) { text = `${no.join(" and ")} said No, so it's kept out of the Inspections list.`; button = ["Add back", "PUT"]; }
  else { text = "Shows on the Inspections page."; button = ["Add to To inspect", "PUT"]; }
  return (
    <div className="row small">
      <span className="grow">{text}</span>
      {button && <button className="small-btn" onClick={() => call(button![1])}>{button[0]}</button>}
    </div>
  );
}

export function Inspections({ propertyId, inspections, toInspect, inspectedBy, opinions }: {
  propertyId: string; inspections: Inspection[]; toInspect: boolean; inspectedBy: string[]; opinions: Opinion[];
}) {
  const refresh = useRefresh(propertyId);
  const { me, byId } = usePeople();
  const [kind, setKind] = useState("open");
  const [at, setAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    try {
      await api(`/api/properties/${propertyId}/inspections`, { method: "POST", body: { kind, starts_at: fromLocalInput(at) } });
      setAt("");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const setState = (id: string, state: string) =>
    api(`/api/inspections/${id}`, { method: "PATCH", body: { state } }).then(refresh);
  // Not going is kept (and shown on the Inspections page under Not going), with who took it off. Add back restores it.
  const notGoing = inspections.filter((i) => i.state === "skipped");
  const shown = inspections.filter((i) => i.state !== "skipped");

  return (
    <div className="card stack">
      <h2>Inspections</h2>
      <ListStanding propertyId={propertyId} toInspect={toInspect} inspectedBy={inspectedBy} opinions={opinions} onDone={refresh} />
      {shown.length === 0 && <p className="small muted">None yet.</p>}
      {shown.map((i) => {
        const mine = i.attendees.find((a) => a.person_id === me?.id);
        return (
          <div key={i.id} className="inspection">
            <div className="row">
              <strong className="grow">{when(i.starts_at)} · {KINDS[i.kind] ?? i.kind}</strong>
              <span className="pill">{i.state}</span>
              <a className="small" href={`/api/events/inspection/${i.id}.ics`}>Add to calendar</a>
            </div>
            {i.inspector && <div className="small">Inspector: {i.inspector}</div>}
            {i.attendees.map((a) => (
              <div key={a.person_id} className="small">
                <span className="dot" style={{ background: byId.get(a.person_id)?.colour }} />
                {byId.get(a.person_id)?.display_name} went{a.note ? `: ${a.note}` : ""}
              </div>
            ))}
            <AttendeeNote inspectionId={i.id} initial={mine?.note ?? ""} attended={!!mine} onDone={refresh} />
            {i.state === "planned" && (
              <div className="row">
                <ConfirmButton className="link" label="Not going" question="Not going?" yes="Remove" onConfirm={() => setState(i.id, "skipped")} />
                <button className="link" onClick={() => setState(i.id, "cancelled")}>Cancelled by the agent</button>
              </div>
            )}
          </div>
        );
      })}
      {notGoing.length > 0 && (
        <details>
          <summary className="small"><strong>Not going</strong> <span className="muted">· {notGoing.length}</span></summary>
          {notGoing.map((i) => (
            <div key={i.id} className="row small" style={{ marginTop: 6 }}>
              <span className="grow">{when(i.starts_at)} · {KINDS[i.kind] ?? i.kind}
                <span className="muted"> · Removed by {i.updated_by_name ?? "someone"}</span></span>
              <button className="small-btn" onClick={() => setState(i.id, "planned")}>Add back</button>
            </div>
          ))}
        </details>
      )}
      <div className="grid2">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="When" />
      </div>
      {error && <p className="error small">{error}</p>}
      <button disabled={!at} onClick={add}>Add inspection</button>
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
