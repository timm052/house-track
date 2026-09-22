import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AddressSearch from "../AddressSearch";
import { api, type Place, type StationHit } from "../api";
import { usePeople } from "../people";

/** Stations picked from the region's list, and destinations like work (PLAN.md D10). */
export default function Places() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { active, byId, me } = usePeople();
  const places = useQuery({ queryKey: ["places"], queryFn: () => api<Place[]>("/api/places") });
  const stationCount = useQuery({ queryKey: ["station-count"], queryFn: () => api<{ n: number }>("/api/stations/count") });
  const [q, setQ] = useState("");
  const hits = useQuery({
    queryKey: ["station-search", q.trim()],
    queryFn: () => api<StationHit[]>(`/api/stations/search?q=${encodeURIComponent(q.trim())}`),
    enabled: q.trim().length >= 2,
  });
  const [name, setName] = useState("");
  const [person, setPerson] = useState(me?.id ?? "");

  const done = () => {
    queryClient.invalidateQueries({ queryKey: ["places"] });
    queryClient.invalidateQueries({ queryKey: ["station-search"] });
    queryClient.invalidateQueries({ queryKey: ["map"] });
  };
  const add = useMutation({ mutationFn: (body: object) => api("/api/places", { method: "POST", body }), onSuccess: done });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/places/${id}`, { method: "DELETE" }), onSuccess: done });
  const favourite = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api(`/api/places/${id}/favourite`, { method: "PUT", body: { is_favourite: on } }),
    onSuccess: () => { done(); queryClient.invalidateQueries({ queryKey: ["overview"] }); },
  });

  const stations = places.data?.filter((p) => p.kind === "station") ?? [];
  const destinations = places.data?.filter((p) => p.kind === "destination") ?? [];

  return (
    <div style={{ marginTop: 12 }}>
      <div className="card stack">
        <h2>Stations</h2>
        <p className="muted small">Each house shows walking time to its nearest chosen station, plus any others within your walking limit (Settings).</p>
        {stations.map((s) => (
          <div key={s.id} className="row">
            <span className="grow">🚉 {s.name}</span>
            <button className="link" onClick={() => remove.mutate(s.id)}>Remove</button>
          </div>
        ))}
        {stationCount.data?.n === 0 ? (
          <p className="small muted">The station list is empty. Run the setup job to load it.</p>
        ) : (
          <>
            <input type="search" placeholder="Find a station" value={q} onChange={(e) => setQ(e.target.value)} />
            {hits.data && hits.data.length > 0 && (
              <ul className="suggestions">
                {hits.data.map((h) => (
                  <li key={h.osm_id}>
                    <button disabled={h.chosen} onClick={() => { add.mutate({ kind: "station", station_osm_id: h.osm_id }); setQ(""); }}>
                      {h.name}{h.chosen && " (chosen)"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="card stack">
        <h2>Places you travel to</h2>
        <p className="muted small">Work, family, childcare. Each house shows walking and driving time to every place (driving assumes no traffic). Star up to five favourites: they get their own columns in Overview and appear on the house cards.</p>
        {destinations.map((d) => (
          <div key={d.id} className="row">
            <button className="link" title={d.is_favourite ? "Unfavourite" : "Favourite"} aria-label="Favourite"
              onClick={() => favourite.mutate({ id: d.id, on: !d.is_favourite })}>{d.is_favourite ? "★" : "☆"}</button>
            <span className="grow">
              {d.name}
              {d.person_id && <span className="muted small"> · {byId.get(d.person_id)?.display_name}</span>}
            </span>
            <button className="link" onClick={() => remove.mutate(d.id)}>Remove</button>
          </div>
        ))}
        <div className="grid2">
          <input placeholder="Name, e.g. Work" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Whose place">
            <option value="">Shared</option>
            {active.map((p) => <option key={p.id} value={p.id}>{p.display_name}'s</option>)}
          </select>
        </div>
        {name.trim() && (
          <>
            <AddressSearch placeholder="Find its address" onPick={(hit) => {
              add.mutate({ kind: "destination", name: name.trim(), person_id: person || null, location: { lon: hit.lon, lat: hit.lat } });
              setName("");
            }} />
            <button onClick={() => navigate(`/map?pick=place&name=${encodeURIComponent(name.trim())}&person=${person}`)}>
              Or pick it on the map
            </button>
          </>
        )}
        {(add.error || remove.error || favourite.error) && <p className="error">{((add.error || remove.error || favourite.error) as Error).message}</p>}
      </div>
      <p className="small"><Link to="/settings">Back to settings</Link></p>
    </div>
  );
}
