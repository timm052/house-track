import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { api, type AreaKind, type MapArea, type MapData, type MapProperty } from "../api";
import { LABEL, minutes } from "../format";
import { basemapStyle } from "../map/basemap";
import { colourFor, syncOverlays, type OverlayLayer } from "../map/overlays";
import { usePeople } from "../people";
import { STATUS_COLOUR, minutesTone } from "../colour";

const MELBOURNE: [number, number] = [145.0, -37.81];
type Filter = "all" | "mine" | "either";
type Selected = { kind: "property"; p: MapProperty } | { kind: "area"; a: MapArea } | null;

const dark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

function addressOf(p: Pick<MapProperty, "unit" | "street_number" | "street" | "suburb" | "plan_number" | "lot_number">) {
  if (p.street_number) return `${p.unit ? `${p.unit}/` : ""}${p.street_number} ${p.street}, ${p.suburb}`;
  return `Lot ${p.lot_number}${p.street ? ` ${p.street}` : ""}, ${p.suburb}`;
}

export default function MapPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { byId, me } = usePeople();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);

  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Selected>(null);
  const [drawKind, setDrawKind] = useState<AreaKind | null>(null);
  const [newShape, setNewShape] = useState<GeoJSON.Polygon | null>(null);
  const [editing, setEditing] = useState<MapArea | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLayers, setShowLayers] = useState(false);
  const [enabled, setEnabled] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("housetrack.map.overlays") ?? "[]"); } catch { return []; }
  });
  const overlayList = useQuery({ queryKey: ["overlays"], queryFn: () => api<OverlayLayer[]>("/api/overlays") });
  useEffect(() => {
    try { localStorage.setItem("housetrack.map.overlays", JSON.stringify(enabled)); } catch { /* per-device nicety */ }
    const map = mapRef.current;
    if (!ready || !map || !overlayList.data) return;
    return syncOverlays(map, enabled, overlayList.data);
  }, [ready, enabled, overlayList.data]);

  const pinFor = params.get("pin");
  const pickPlace = params.get("pick") === "place" ? { name: params.get("name") ?? "", person: params.get("person") } : null;

  const { data } = useQuery({ queryKey: ["map"], queryFn: () => api<MapData>("/api/map") });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["map"] });
    queryClient.invalidateQueries({ queryKey: ["overview"] });
  };

  // ─── map + drawing tool, created once ────────────────────────────────
  useEffect(() => {
    let map: maplibregl.Map | null = null;
    let cancelled = false;
    basemapStyle(dark()).then(({ style }) => {
      if (cancelled || !container.current) return;
      map = new maplibregl.Map({ container: container.current, style, center: MELBOURNE, zoom: 10, attributionControl: { compact: true } });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
      map.on("load", () => {
        addLayers(map!);
        const draw = new TerraDraw({
          adapter: new TerraDrawMapLibreGLAdapter({ map: map! }),
          modes: [
            new TerraDrawPolygonMode(),
            new TerraDrawSelectMode({
              flags: { polygon: { feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } } } },
            }),
          ],
        });
        draw.start();
        draw.on("finish", (id, context) => {
          if (context.action !== "draw") return;
          const f = draw.getSnapshotFeature(id);
          if (f?.geometry.type === "Polygon") setNewShape(f.geometry as GeoJSON.Polygon);
          draw.clear();
          draw.setMode("static");
          setDrawKind(null);
        });
        drawRef.current = draw;
        setReady(true);
      });
    });
    return () => {
      cancelled = true;
      drawRef.current?.stop();
      map?.remove();
    };
  }, []);

  // ─── data → map sources ──────────────────────────────────────────────
  const visibleProperties = useMemo(() => {
    const features = data?.properties.features ?? [];
    return features.filter((f) => {
      if (filter === "mine") return !f.properties.excluded;
      if (filter === "either") return !f.properties.excluded && !f.properties.others_flags.some((x) => x.kind === "hard_exclude");
      return true;
    });
  }, [data, filter]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !data) return;
    (map.getSource("properties") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: visibleProperties.map((f) => ({
        ...f,
        properties: {
          id: f.properties.id,
          colour: STATUS_COLOUR[f.properties.status],
          dim: f.properties.excluded || ["rejected", "lost", "withdrawn"].includes(f.properties.status),
          ring: f.properties.others_flags.length ? byId.get(f.properties.others_flags[0].owner_id)?.colour ?? "#888" : "",
          warned: f.properties.warned,
        },
      })),
    });
    (map.getSource("areas") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: data.areas.features
        .filter((f) => f.properties.id !== editing?.id)
        .map((f) => ({ ...f, properties: { ...f.properties, mine: f.properties.owner_id === me?.id,
                                            colour: byId.get(f.properties.owner_id)?.colour ?? "#888" } })),
    });
    (map.getSource("places") as GeoJSONSource).setData(data.places as GeoJSON.FeatureCollection);

    if (!fitted.current && data.properties.features.length) {
      const bounds = new maplibregl.LngLatBounds();
      data.properties.features.forEach((f) => bounds.extend(f.geometry.coordinates as [number, number]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 0 });
      fitted.current = true;
    }
  }, [ready, data, visibleProperties, editing, byId, me]);

  // ─── clicks ──────────────────────────────────────────────────────────
  const modeRef = useRef({ pinFor, pickPlace, drawing: false });
  modeRef.current = { pinFor, pickPlace, drawing: drawKind !== null || editing !== null };

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const onClick = async (e: maplibregl.MapMouseEvent) => {
      const mode = modeRef.current;
      const point = { lon: e.lngLat.lng, lat: e.lngLat.lat };
      try {
        if (mode.pinFor) {
          await api(`/api/properties/${mode.pinFor}/location`, { method: "PUT", body: point });
          refresh();
          queryClient.invalidateQueries({ queryKey: ["property", mode.pinFor] });
          navigate(`/p/${mode.pinFor}`);
          return;
        }
        if (mode.pickPlace) {
          await api("/api/places", { method: "POST", body: { kind: "destination", name: mode.pickPlace.name, person_id: mode.pickPlace.person || null, location: point } });
          queryClient.invalidateQueries({ queryKey: ["places"] });
          navigate("/places");
          return;
        }
      } catch (err) {
        setError((err as Error).message);
        return;
      }
      if (mode.drawing) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: ["props-circle", "areas-fill"] });
      const prop = hit.find((f) => f.layer.id === "props-circle");
      const area = hit.find((f) => f.layer.id === "areas-fill");
      const current = queryClient.getQueryData<MapData>(["map"]);
      if (prop) {
        const p = current?.properties.features.find((f) => f.properties.id === prop.properties.id)?.properties;
        setSelected(p ? { kind: "property", p } : null);
      } else if (area) {
        const a = current?.areas.features.find((f) => f.properties.id === area.properties.id)?.properties;
        setSelected(a ? { kind: "area", a } : null);
      } else {
        setSelected(null);
      }
    };
    map.on("click", onClick);
    return () => { map.off("click", onClick); };
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── drawing & editing areas ─────────────────────────────────────────
  function startDrawing(kind: AreaKind) {
    setSelected(null);
    setDrawKind(kind);
    drawRef.current?.setMode("polygon");
  }
  function cancelDrawing() {
    drawRef.current?.clear();
    drawRef.current?.setMode("static");
    setDrawKind(null);
    setEditing(null);
  }
  function startEditing(a: MapArea) {
    const draw = drawRef.current;
    const feature = data?.areas.features.find((f) => f.properties.id === a.id);
    if (!draw || !feature) return;
    setSelected(null);
    setEditing(a);
    draw.setMode("select");
    const results = draw.addFeatures(
      feature.geometry.coordinates.map((rings) => ({
        type: "Feature", geometry: { type: "Polygon", coordinates: rings }, properties: { mode: "polygon" },
      })) as Parameters<TerraDraw["addFeatures"]>[0],
    );
    const first = results.find((r) => r.valid);
    if (first) draw.selectFeature(first.id!);
  }
  async function saveEdit() {
    const draw = drawRef.current;
    if (!draw || !editing) return;
    const polygons = draw.getSnapshot().filter((f) => f.geometry.type === "Polygon").map((f) => (f.geometry as GeoJSON.Polygon).coordinates);
    try {
      await api(`/api/areas/${editing.id}`, { method: "PATCH", body: { geometry: { type: "MultiPolygon", coordinates: polygons } } });
      cancelDrawing();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const unpinned = data?.unpinned ?? 0;
  const pinTarget = pinFor ? queryClient.getQueryData<{ address: string }>(["property", pinFor])?.address : null;

  return (
    <div className="map-page">
      <div ref={container} className="map" />

      <div className="map-top">
        {pinFor && <div className="banner">Tap the map where {pinTarget ?? "the house"} is. <Link to={`/p/${pinFor}`}>Cancel</Link></div>}
        {pickPlace && <div className="banner">Tap the map to place “{pickPlace.name}”. <Link to="/places">Cancel</Link></div>}
        {drawKind && <div className="banner">Tap to add corners, and tap the first corner to finish. <button className="link" onClick={cancelDrawing}>Cancel</button></div>}
        {editing && (
          <div className="banner">
            Drag corners to reshape “{editing.name}”. <button className="link" onClick={saveEdit}>Save</button>{" "}
            <button className="link" onClick={cancelDrawing}>Cancel</button>
          </div>
        )}
        {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      </div>

      {!pinFor && !pickPlace && !drawKind && !editing && !newShape && (
        <div className="map-tools">
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter">
            <option value="all">Show all</option>
            <option value="mine">Hide my exclusions</option>
            <option value="either">Hide anyone's exclusions</option>
          </select>
          {(overlayList.data?.length ?? 0) > 0 && <button onClick={() => setShowLayers(!showLayers)}>Layers{enabled.length ? ` (${enabled.length})` : ""}</button>}
          <button onClick={() => startDrawing("hard_exclude")}>Exclude area</button>
          <button onClick={() => startDrawing("soft_warn")}>Warn area</button>
          {unpinned > 0 && <span className="small muted">{unpinned} without a pin</span>}
        </div>
      )}

      {showLayers && overlayList.data && (
        <div className="sheet stack">
          <div className="row"><strong className="grow">Layers</strong><button className="link" onClick={() => setShowLayers(false)}>Done</button></div>
          <p className="small muted">Shown when zoomed in to street level.</p>
          {overlayList.data.map((l) => (
            <label key={l.code} className="check">
              <input type="checkbox" checked={enabled.includes(l.code)}
                onChange={(e) => setEnabled(e.target.checked ? [...enabled, l.code] : enabled.filter((c) => c !== l.code))} />
              <span className="dot" style={{ background: colourFor(l.code, overlayList.data) }} />{l.title}
              {l.effect !== "info" && <span className="pill">{l.effect === "hard_exclude" ? "excludes" : "warns"}</span>}
            </label>
          ))}
        </div>
      )}
      {newShape && <NewAreaSheet shape={newShape} kind={drawKind ?? "hard_exclude"} onDone={() => { setNewShape(null); refresh(); }} />}
      {selected?.kind === "property" && <PropertySheet p={selected.p} onClose={() => setSelected(null)} />}
      {selected?.kind === "area" && (
        <AreaSheet a={selected.a} mine={selected.a.owner_id === me?.id} owner={byId.get(selected.a.owner_id)?.display_name ?? "Someone"}
                   onEdit={() => startEditing(selected.a)} onChanged={() => { setSelected(null); refresh(); }} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function addLayers(map: maplibregl.Map) {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  map.addSource("areas", { type: "geojson", data: empty });
  map.addSource("places", { type: "geojson", data: empty });
  map.addSource("properties", { type: "geojson", data: empty });
  const hard = ["==", ["get", "kind"], "hard_exclude"] as maplibregl.ExpressionSpecification;
  map.addLayer({ id: "areas-fill", type: "fill", source: "areas",
    paint: { "fill-color": ["get", "colour"], "fill-opacity": ["case", ["get", "mine"], ["case", hard, 0.22, 0.1], 0.05] } });
  map.addLayer({ id: "areas-line-mine", type: "line", source: "areas", filter: ["==", ["get", "mine"], true],
    paint: { "line-color": ["get", "colour"], "line-width": ["case", hard, 3, 1.5] } });
  map.addLayer({ id: "areas-line-others", type: "line", source: "areas", filter: ["!=", ["get", "mine"], true],
    paint: { "line-color": ["get", "colour"], "line-width": ["case", hard, 2.5, 1.5], "line-dasharray": [2, 2] } });
  map.addLayer({ id: "areas-label", type: "symbol", source: "areas",
    layout: { "text-field": ["get", "name"], "text-size": 12, "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": ["get", "colour"], "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  map.addLayer({ id: "places-circle", type: "circle", source: "places",
    paint: { "circle-radius": 6, "circle-color": ["case", ["==", ["get", "kind"], "station"], "#ffffff", "#111827"],
             "circle-stroke-color": "#111827", "circle-stroke-width": 2 } });
  map.addLayer({ id: "places-label", type: "symbol", source: "places",
    layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#111827", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  map.addLayer({ id: "props-ring", type: "circle", source: "properties", filter: ["!=", ["get", "ring"], ""],
    paint: { "circle-radius": 12, "circle-color": "transparent", "circle-stroke-color": ["get", "ring"], "circle-stroke-width": 2.5 } });
  map.addLayer({ id: "props-circle", type: "circle", source: "properties",
    paint: { "circle-radius": 8, "circle-color": ["get", "colour"], "circle-opacity": ["case", ["get", "dim"], 0.35, 1],
             "circle-stroke-color": ["case", ["get", "warned"], "#f59e0b", "#ffffff"], "circle-stroke-width": ["case", ["get", "warned"], 3, 1.5] } });
}

// ─── bottom sheets ────────────────────────────────────────────────────
function PropertySheet({ p, onClose }: { p: MapProperty; onClose: () => void }) {
  const { byId } = usePeople();
  return (
    <div className="sheet">
      <div className="row">
        <strong className="grow">{addressOf(p)}</strong>
        <span className="pill status-pill"><span className="status-dot" style={{ background: STATUS_COLOUR[p.status] }} />{LABEL.status[p.status]}</span>
        <button className="link" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {p.nearest_station && <div className="small"><span className={`tone-${minutesTone(p.nearest_station_walk_s == null ? null : p.nearest_station_walk_s / 60)}`}>{minutes(p.nearest_station_walk_s)}</span> walk to {p.nearest_station}</div>}
      {p.excluded && <div className="small error">Excluded by you: {p.reasons.join(", ")}</div>}
      {!p.excluded && p.warned && <div className="small" style={{ color: "var(--maybe)" }}>Warning: {p.reasons.join(", ")}</div>}
      {p.others_flags.map((f, i) => (
        <div key={i} className="small muted">
          <span className="dot" style={{ background: byId.get(f.owner_id)?.colour }} />
          {byId.get(f.owner_id)?.display_name} {f.kind === "hard_exclude" ? "excludes" : "warns about"} this: {f.name}
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <Link to={`/p/${p.id}`}><button className="primary">Open</button></Link>
        <Link to={`/map?pin=${p.id}`}><button>Move pin</button></Link>
      </div>
    </div>
  );
}

function NewAreaSheet({ shape, kind: initialKind, onDone }: { shape: GeoJSON.Polygon; kind: AreaKind; onDone: () => void }) {
  const { active, me } = usePeople();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AreaKind>(initialKind);
  const [owner, setOwner] = useState(me?.id ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try {
      await api("/api/areas", { method: "POST", body: { name: name.trim(), kind, owner_id: owner, reason: reason.trim() || null, geometry: shape } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="sheet stack">
      <strong>New area</strong>
      <input autoFocus placeholder="Name, e.g. Under the flight path" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid2">
        <select value={kind} onChange={(e) => setKind(e.target.value as AreaKind)}>
          <option value="hard_exclude">Exclude</option>
          <option value="soft_warn">Warn only</option>
        </select>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Whose rule">
          {active.map((p) => <option key={p.id} value={p.id}>{p.display_name}'s rule</option>)}
        </select>
      </div>
      <input placeholder="Why (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button className="primary" disabled={!name.trim()} onClick={save}>Save area</button>
        <button onClick={onDone}>Discard</button>
      </div>
    </div>
  );
}

function AreaSheet({ a, mine, owner, onEdit, onChanged, onClose }: {
  a: MapArea; mine: boolean; owner: string; onEdit: () => void; onChanged: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(a.name);
  const patch = (body: object) => api(`/api/areas/${a.id}`, { method: "PATCH", body }).then(onChanged);
  return (
    <div className="sheet stack">
      <div className="row">
        <strong className="grow">{a.name}</strong>
        <span className="pill">{a.kind === "hard_exclude" ? "Exclude" : "Warn"}</span>
        <button className="link" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="small muted">{mine ? "Your area. It only affects your map." : `${owner}'s area. It doesn't hide anything for you.`}</div>
      {a.reason && <div className="small">{a.reason}</div>}
      {mine && (
        <>
          <div className="row">
            <input className="grow" value={name} onChange={(e) => setName(e.target.value)} />
            <button disabled={!name.trim() || name === a.name} onClick={() => patch({ name: name.trim() })}>Rename</button>
          </div>
          <div className="row">
            <button onClick={onEdit}>Edit shape</button>
            <button onClick={() => patch({ kind: a.kind === "hard_exclude" ? "soft_warn" : "hard_exclude" })}>
              {a.kind === "hard_exclude" ? "Make it a warning" : "Make it an exclusion"}
            </button>
            <button onClick={() => api(`/api/areas/${a.id}`, { method: "DELETE" }).then(onChanged)}>Remove</button>
          </div>
        </>
      )}
    </div>
  );
}
