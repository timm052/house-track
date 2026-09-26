// Places: where travel times are worked out to, from every house. Your places (work, family, school) with how you'd
// get there (walk, drive, public transport), and train stations (the nearest is found automatically; add others to
// always see). Picking a place on the map comes back here.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Car, Footprints, MapPin, Star, TrainFront, TramFront } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AddressSearch from "../AddressSearch";
import { api, type Place, type Settings as SettingsT, type StationHit, type TravelMode } from "../api";
import ConfirmButton from "../ConfirmButton";
import { LIVE, Live, OfflineNote } from "../live";
import { usePeople } from "../people";

const MODES: { mode: TravelMode; label: string; icon: React.ReactNode }[] = [
  { mode: "walk", label: "Walk", icon: <Footprints /> },
  { mode: "drive", label: "Drive", icon: <Car /> },
  { mode: "transit", label: "Public transport", icon: <TramFront /> },
];

export default function Places() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { active, me } = usePeople();
  const places = useQuery({ queryKey: ["places"], queryFn: () => api<Place[]>("/api/places"), ...LIVE });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsT>("/api/settings"), ...LIVE });
  const [walkText, setWalkText] = useState<string | null>(null);   // the walking limit as typed, until it's saved
  const stationCount = useQuery({ queryKey: ["station-count"], queryFn: () => api<{ n: number }>("/api/stations/count") });
  const [q, setQ] = useState("");
  const hits = useQuery({
    queryKey: ["station-search", q.trim()], enabled: q.trim().length >= 2,
    queryFn: () => api<StationHit[]>(`/api/stations/search?q=${encodeURIComponent(q.trim())}`),
  });
  const [name, setName] = useState("");
  const [person, setPerson] = useState("");
  const [modes, setModes] = useState<TravelMode[]>(["walk", "drive", "transit"]);

  const done = () => ["places", "station-search", "map", "overview", "property"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  const add = useMutation({ mutationFn: (body: object) => api("/api/places", { method: "POST", body }), onSuccess: () => { setName(""); done(); } });
  const patch = useMutation({ mutationFn: ({ id, body }: { id: string; body: object }) => api(`/api/places/${id}`, { method: "PATCH", body }), onSuccess: done });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/places/${id}`, { method: "DELETE" }), onSuccess: done });
  const favourite = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api(`/api/places/${id}/favourite`, { method: "PUT", body: { is_favourite: on } }),
    onSuccess: done,
  });
  const walk = useMutation({
    mutationFn: (v: number) => api("/api/settings/walk_limit_min", { method: "PUT", body: { value: v } }),
    onSuccess: () => { setWalkText(null); queryClient.invalidateQueries({ queryKey: ["settings"] }); done(); },
  });
  const error = add.error || patch.error || remove.error || favourite.error || walk.error;

  const stations = places.data?.filter((p) => p.kind === "station") ?? [];
  const destinations = places.data?.filter((p) => p.kind === "destination") ?? [];
  const toggle = (list: TravelMode[], m: TravelMode) => (list.includes(m) ? list.filter((x) => x !== m) : [...list, m]);

  return (
    <div style={{ marginTop: 12 }}>
      <h1>Places</h1>
      <p className="small muted">Where travel times are worked out to, from every house. They show on the house cards, each house's
        Location tab and as columns in the grid.</p>
      <OfflineNote queries={[places, settings]} />

      <div className="card stack">
        <h2>Your places</h2>
        <Live queries={[places]}>
        {destinations.length === 0 && <p className="small muted" style={{ margin: 0 }}>None yet. Add work, family or school below.</p>}
        {destinations.map((d) => (
          <div key={d.id} className="place-row">
            <button className={`link place-star ${d.is_favourite ? "on" : ""}`} aria-pressed={d.is_favourite}
              title={d.is_favourite ? "Shown on house cards. Click to hide." : "Show on the house cards"}
              onClick={() => favourite.mutate({ id: d.id, on: !d.is_favourite })}><Star /></button>
            <div className="grow">
              <input className="place-name" defaultValue={d.name} key={d.name} aria-label="Name"
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== d.name) patch.mutate({ id: d.id, body: { name: v } }); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              <div className="row small">
                <select value={d.person_id ?? ""} aria-label="Whose place" style={{ width: "auto" }}
                  onChange={(e) => patch.mutate({ id: d.id, body: { person_id: e.target.value || null } })}>
                  <option value="">Shared</option>
                  {active.map((p) => <option key={p.id} value={p.id}>{p.display_name}'s</option>)}
                </select>
                <div className="mode-toggles" role="group" aria-label="How to get there">
                  {MODES.map(({ mode, label, icon }) => (
                    <button key={mode} className={`chip ${d.modes.includes(mode) ? "on" : ""}`} aria-pressed={d.modes.includes(mode)}
                      onClick={() => patch.mutate({ id: d.id, body: { modes: toggle(d.modes, mode) } })}>{icon} {label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="place-actions small">
              <button className="link" onClick={() => navigate(`/map?pick=move&place=${d.id}&name=${encodeURIComponent(d.name)}`)}>Move</button>
              <ConfirmButton label="Remove" question={`Stop showing times to ${d.name}?`} yes="Remove" onConfirm={() => remove.mutate(d.id)} />
            </div>
          </div>
        ))}

        <div className="place-add stack">
          <div className="section-title" style={{ margin: 0 }}>Add a place</div>
          <div className="grid2">
            <input placeholder="Name, e.g. Work" value={name} onChange={(e) => setName(e.target.value)} />
            <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Whose place">
              <option value="">Shared</option>
              {active.map((p) => <option key={p.id} value={p.id}>{p.display_name}'s{p.id === me?.id ? " (you)" : ""}</option>)}
            </select>
          </div>
          <div className="mode-toggles">
            {MODES.map(({ mode, label, icon }) => (
              <button key={mode} className={`chip ${modes.includes(mode) ? "on" : ""}`} aria-pressed={modes.includes(mode)}
                onClick={() => setModes(toggle(modes, mode))}>{icon} {label}</button>
            ))}
          </div>
          {name.trim() ? (
            <>
              <AddressSearch placeholder="Find its address" clearOnPick onPick={(hit) =>
                add.mutate({ kind: "destination", name: name.trim(), person_id: person || null, modes, location: { lon: hit.lon, lat: hit.lat } })} />
              <button onClick={() => navigate(`/map?pick=place&name=${encodeURIComponent(name.trim())}&person=${person}&modes=${modes.join(",")}`)}>
                <MapPin /> Or pick it on the map</button>
            </>
          ) : <p className="small muted" style={{ margin: 0 }}>Name it first, then find its address or pick it on the map.</p>}
        </div>
        </Live>
      </div>

      <div className="card stack">
        <h2>Train stations</h2>
        <p className="small" style={{ margin: 0 }}>Every house gets its <strong>nearest station</strong> automatically, out of all
          {stationCount.data ? ` ${stationCount.data.n}` : ""} stations, with the walk and the drive to it.</p>
        <p className="small muted" style={{ margin: 0 }}>Add stations you'd use anyway (on your line, say) to see the walk to them from every house too.
          They show on a house when they're within the walking limit.</p>
        <Live queries={[places, settings]}>
        {settings.data && (
          <label className="row small" style={{ gap: 8 }}>Walking limit
            {/* Saved only when someone changes it, never from what the page first showed. */}
            <input inputMode="numeric" value={walkText ?? String(settings.data.walk_limit_min)} style={{ width: 70 }}
              onChange={(e) => setWalkText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              onBlur={() => {
                if (walkText == null) return;
                const v = Number(walkText);
                if (Number.isInteger(v) && v >= 1 && v <= 120 && v !== settings.data!.walk_limit_min) walk.mutate(v); else setWalkText(null);
              }} /> minutes
          </label>
        )}
        {stations.map((s) => (
          <div key={s.id} className="row">
            <span className="grow"><TrainFront /> {s.name}</span>
            <ConfirmButton label="Remove" question={`Stop showing ${s.name}?`} yes="Remove" onConfirm={() => remove.mutate(s.id)} />
          </div>
        ))}
        {stationCount.data?.n === 0 ? (
          <p className="small muted">No stations loaded yet. Run setup to load them.</p>
        ) : (
          <div className="address-search">
            <input type="search" placeholder="Add a station" value={q} onChange={(e) => setQ(e.target.value)} />
            {hits.data && hits.data.length > 0 && (
              <ul className="suggestions">
                {hits.data.map((h) => (
                  <li key={h.osm_id}>
                    <button disabled={h.chosen} onClick={() => { add.mutate({ kind: "station", station_osm_id: h.osm_id }); setQ(""); }}>
                      {h.name}{h.chosen && " (added)"}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        </Live>
      </div>
      {error && <p className="error">{(error as Error).message}</p>}
    </div>
  );
}
