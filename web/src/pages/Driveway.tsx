// Driveway mode (PLAN.md Must, milestone 3): stand outside, one hand, possibly no signal. GPS finds the
// nearest house from the cached list; three big buttons record a verdict through the outbox.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Stage, type Stance } from "../api";
import { LABEL } from "../format";
import type { OverviewPlace, OverviewRow } from "../overview/columns";
import { newId, sendOrQueue } from "../outbox";
import { usePeople } from "../people";

type Overview = { rows: OverviewRow[]; places: OverviewPlace[] };
type Event = { type: string; id: string; kind: string; state: string; starts_at: string; property_id: string; address: string };

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

export default function Driveway() {
  const queryClient = useQueryClient();
  const { active, me } = usePeople();
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview") });
  const events = useQuery({ queryKey: ["inspections"], queryFn: () => api<Event[]>("/api/inspections?days=2") });
  const [pos, setPos] = useState<{ lat: number; lon: number; accuracy: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [whose, setWhose] = useState(me?.id ?? "");
  const [note, setNote] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) { setGpsError("This browser can't share your location."); return; }
    const watch = navigator.geolocation.watchPosition(
      (p) => setPos({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => setGpsError(e.code === e.PERMISSION_DENIED ? "Location permission is off; pick the house below." : "No GPS fix yet."),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, []);

  const rows = overview.data?.rows ?? [];
  const nearby = useMemo(() => {
    const pinned = rows.filter((r) => r.lat != null && r.lon != null) as (OverviewRow & { lat: number; lon: number })[];
    if (!pos) return [];
    return pinned.map((r) => ({ r, d: metres(pos, r) })).sort((a, b) => a.d - b.d).slice(0, 4);
  }, [rows, pos]);
  const todays = new Set((events.data ?? []).filter((e) => e.type === "inspection").map((e) => e.property_id));
  const current = rows.find((r) => r.id === chosen) ?? nearby[0]?.r ?? rows[0] ?? null;
  const personId = whose || me?.id || "";
  const hasPre = current ? current[`v:${personId}:pre`] != null : false;
  const [stage, setStage] = useState<Stage | null>(null);
  const activeStage: Stage = stage ?? (hasPre || (current && todays.has(current.id)) ? "post_inspection" : "pre_inspection");
  const shortStage = activeStage === "pre_inspection" ? "pre" : "post";

  async function record(stance: Stance) {
    if (!current) return;
    const id = newId();
    const seen = current._v?.[`v:${personId}:${shortStage}`] ?? null;
    const result = await sendOrQueue({
      id, method: "POST", path: `/api/properties/${current.id}/opinions`, propertyId: current.id,
      label: `${active.find((p) => p.id === personId)?.display_name}: ${LABEL.stance[stance]} (${LABEL.stageShort[activeStage]}) for ${current.address}`,
      body: { id, person_id: personId, stage: activeStage, stance, note: note.trim() || null, recorded_at: new Date().toISOString(),
              check_latest: true, expected_latest_id: seen },
    });
    // Show it straight away, whether it was sent or queued.
    queryClient.setQueryData<Overview>(["overview"], (old) => old && {
      ...old, rows: old.rows.map((r) => (r.id === current.id ? { ...r, [`v:${personId}:${shortStage}`]: stance } : r)),
    });
    setNote("");
    setFlash(result === "sent" ? "Saved" : "Saved on this phone. It sends when you're back online.");
    setTimeout(() => setFlash(null), 3500);
    if (result === "sent") queryClient.invalidateQueries({ queryKey: ["overview"] });
  }

  async function imHere() {
    if (!current || !me) return;
    const inspection = (events.data ?? []).find((e) => e.type === "inspection" && e.property_id === current.id);
    if (inspection) {
      const result = await sendOrQueue({ id: newId(), method: "PUT", path: `/api/inspections/${inspection.id}/attendees/${me.id}`,
        body: { note: null }, label: `Attended ${current.address}`, propertyId: current.id });
      setFlash(result === "sent" ? "Marked as attended" : "Attendance saved on this phone");
    } else {
      try {
        const now = new Date();
        await api(`/api/properties/${current.id}/inspections`, { method: "POST", body: { kind: "private", starts_at: now.toISOString(), state: "attended" } });
        setFlash("Inspection logged");
      } catch {
        setFlash("No signal: log the inspection later from the house page.");
      }
    }
    setTimeout(() => setFlash(null), 3500);
    queryClient.invalidateQueries({ queryKey: ["inspections"] });
  }

  async function photo(files: FileList | null) {
    if (!current || !files?.length) return;
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        form.append("kind", "photo");
        const res = await fetch(`/api/properties/${current.id}/attachments`, { method: "POST", body: form, headers: { "X-Person-Id": me?.id ?? "" } });
        if (!res.ok) throw new Error();
      }
      setFlash(`${files.length} photo${files.length > 1 ? "s" : ""} uploaded`);
    } catch {
      setFlash("No signal: the photos are in your camera roll; upload them from the house page later.");
    }
    setTimeout(() => setFlash(null), 4000);
  }

  return (
    <div className="driveway stack" style={{ marginTop: 12 }}>
      <div className="small muted">
        {pos ? `Located to ±${Math.round(pos.accuracy)} m` : gpsError ?? "Finding your location…"}
      </div>
      <div className="chips">
        {(nearby.length ? nearby.map(({ r, d }) => ({ r, d })) : rows.slice(0, 8).map((r) => ({ r, d: null as number | null }))).map(({ r, d }) => (
          <button key={r.id} className={`chip ${current?.id === r.id ? "on" : ""}`} onClick={() => { setChosen(r.id); setStage(null); }}>
            {String(r.address)}{d != null && ` · ${d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`}`}
          </button>
        ))}
      </div>
      {!current ? (
        <p className="muted">No houses yet. Add one first.</p>
      ) : (
        <div className="card stack">
          <div className="row">
            <h1 className="grow" style={{ margin: 0 }}>{String(current.address)}</h1>
            <Link to={`/p/${current.id}`}>Open</Link>
          </div>
          <div className="grid2">
            <select value={personId} onChange={(e) => setWhose(e.target.value)} aria-label="Whose verdict">
              {active.map((p) => <option key={p.id} value={p.id}>{p.display_name}'s verdict</option>)}
            </select>
            <select value={activeStage} onChange={(e) => setStage(e.target.value as Stage)} aria-label="Stage">
              <option value="pre_inspection">Before inspecting</option>
              <option value="post_inspection">After: pursue to buy?</option>
            </select>
          </div>
          <textarea placeholder="Note: tap the microphone on your keyboard to dictate" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="stance big">
            {(["yes", "maybe", "no"] as const).map((s) => (
              <button key={s} className={`on ${s}`} onClick={() => record(s)}>{LABEL.stance[s]}</button>
            ))}
          </div>
          {current[`v:${personId}:${shortStage}`] != null && (
            <div className="small muted">Current: {LABEL.stance[current[`v:${personId}:${shortStage}`] as Stance]}</div>
          )}
          <div className="grid2">
            <button onClick={imHere}>{todays.has(current.id) ? "I'm here (attended)" : "Log an inspection now"}</button>
            <label className="button-like">
              📷 Photos
              <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => photo(e.target.files)} />
            </label>
          </div>
        </div>
      )}
      {flash && <div className="toast">{flash}</div>}
    </div>
  );
}
