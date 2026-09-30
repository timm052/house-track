// Driveway mode (PLAN.md Must, milestone 3): stand outside, one hand, possibly no signal. GPS finds the
// nearest house from the cached list; three big buttons record a verdict through the outbox.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Stage, type Stance } from "../api";
import { LABEL } from "../format";
import type { OverviewPlace, OverviewRow } from "../overview/columns";
import { newId, sendOrQueue, uploadFiles, uploadMessage } from "../outbox";
import { usePeople } from "../people";
import { CalendarDays, Camera } from "lucide-react";

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
  const [note, setNote] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) { setGpsError("This browser can't share your location."); return; }
    const watch = navigator.geolocation.watchPosition(
      (p) => setPos({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => setGpsError(e.code === e.PERMISSION_DENIED ? "Location is off. Pick the house below." : "No GPS fix yet."),
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
  const inspecting = (events.data ?? []).filter((e) => e.type === "inspection");
  // "At an inspection now": from an hour before it starts to three hours after. Tomorrow's doesn't count.
  const nowMs = Date.now();
  const onNow = inspecting.filter((e) => { const t = new Date(e.starts_at).getTime(); return t - 3_600_000 <= nowMs && nowMs <= t + 3 * 3_600_000; });
  const todays = new Set(onNow.map((e) => e.property_id));
  const upcoming = new Set(inspecting.map((e) => e.property_id));
  // Without GPS: houses with an inspection soon first (in time order), then the rest.
  const byTime = [...new Set(inspecting.map((e) => e.property_id))];
  const fallback = [...rows].sort((a, b) => (byTime.indexOf(a.id) + 1 || 1e9) - (byTime.indexOf(b.id) + 1 || 1e9));
  const current = rows.find((r) => r.id === chosen) ?? nearby[0]?.r ?? fallback[0] ?? null;
  const personId = me?.id ?? "";  // your own verdict, as the selected profile
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
    const inspection = onNow.find((e) => e.property_id === current.id);
    if (inspection) {
      const result = await sendOrQueue({ id: newId(), method: "PUT", path: `/api/inspections/${inspection.id}/attendees/${me.id}`,
        body: { note: null }, label: `Attended ${current.address}`, propertyId: current.id });
      setFlash(result === "sent" ? "Marked as attended" : "Attendance saved on this phone");
    } else {
      // The id is made here so the attendance can follow it through the outbox, and a resend is harmless.
      const id = newId();
      const result = await sendOrQueue({ id, method: "POST", path: `/api/properties/${current.id}/inspections`, propertyId: current.id,
        body: { id, kind: "private", starts_at: new Date().toISOString(), state: "attended" }, label: `Inspection at ${current.address}` });
      await sendOrQueue({ id: newId(), method: "PUT", path: `/api/inspections/${id}/attendees/${me.id}`, propertyId: current.id,
        body: { note: null }, label: `Attended ${current.address}` });
      setFlash(result === "sent" ? "Inspection logged" : "Inspection saved on this phone. It sends when you're back online.");
    }
    setTimeout(() => setFlash(null), 3500);
    queryClient.invalidateQueries({ queryKey: ["inspections"] });
  }

  async function photo(files: FileList | null) {
    if (!current || !files?.length) return;
    try {
      setFlash(uploadMessage(await uploadFiles(current.id, String(current.address), Array.from(files))));
    } catch (e) {
      setFlash((e as Error).message);
    }
    setTimeout(() => setFlash(null), 4000);
  }

  return (
    <div className="driveway stack" style={{ marginTop: 12 }}>
      <div className="small muted">
        {pos ? `Located to ±${Math.round(pos.accuracy)} m` : gpsError ?? "Finding your location…"}
      </div>
      <div className="chips">
        {(nearby.length ? nearby.map(({ r, d }) => ({ r, d })) : fallback.slice(0, 8).map((r) => ({ r, d: null as number | null }))).map(({ r, d }) => (
          <button key={r.id} className={`chip ${current?.id === r.id ? "on" : ""}`} onClick={() => { setChosen(r.id); setStage(null); }}>
            {!d && upcoming.has(r.id) && <><CalendarDays />{" "}</>}{String(r.address)}{d != null && ` · ${d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`}`}
          </button>
        ))}
      </div>
      {!current ? (
        <p className="muted">No houses yet. Add one first.</p>
      ) : (
        <div className="card stack">
          <div className="row" style={{ alignItems: "center" }}>
            {Boolean(current.cover_id) && <img className="drive-photo" src={`/api/attachments/${String(current.cover_id)}/thumb`} alt="" />}
            <div className="grow">
              <h1 style={{ margin: 0 }}>{String(current.address)}</h1>
              <div className="muted small">{String(current.suburb)}</div>
            </div>
            <Link to={`/p/${current.id}`}>Open</Link>
          </div>
          <div className="segmented" role="radiogroup" aria-label="When">
            {(["pre_inspection", "post_inspection"] as const).map((s) => (
              <button key={s} role="radio" aria-checked={activeStage === s} className={activeStage === s ? "on" : ""} onClick={() => setStage(s)}>
                {s === "pre_inspection" ? "Before inspecting" : "After inspecting"}</button>
            ))}
          </div>
          <textarea placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
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
              <Camera /> Photos
              <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => photo(e.target.files)} />
            </label>
          </div>
        </div>
      )}
      {flash && <div className="toast">{flash}</div>}
    </div>
  );
}
