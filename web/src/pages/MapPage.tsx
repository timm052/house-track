import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { STATUSES, api, whilePending, type AreaKind, type MapArea, type MapData, type MapProperty } from "../api";
import { isSold, LABEL, money, streetLine } from "../format";
import type { OverviewRow } from "../overview/columns";
import { basemapStyle } from "../map/basemap";
import { colourFor, syncOverlays, type OverlayLayer } from "../map/overlays";
import { usePeople } from "../people";
import { STATUS_COLOUR, useDarkMode } from "../colour";
import { isDark as pageIsDark } from "../theme";
import HouseSidePanel, { comparableLabel, type StationRoute, useComparables } from "../map/HouseSidePanel";

const MELBOURNE: [number, number] = [145.0, -37.81];
type Filter = "all" | "mine" | "either";

type Selected = { kind: "property"; p: MapProperty } | { kind: "area"; a: MapArea } | null;


const addressOf = (p: Pick<MapProperty, "unit" | "street_number" | "street" | "suburb" | "lot_number">) => `${streetLine(p)}, ${p.suburb}`;

// ─── colouring houses by price ─────────────────────────────────────────
// One hue, light (cheaper) to dark (dearer), in even OKLCH lightness steps (0.84 to 0.39, hue 340): nothing like the
// stations' white and teal. Houses with no price yet are grey.
const PRICE_RAMP = ["#efb7db", "#da83be", "#c253a3", "#9e3081", "#721b5c"];
const NO_PRICE = "#a8a29e";
/** What a house is going for: its sale price once sold, else the middle of its latest guide. */
function priceOf(r: OverviewRow): number | null {
  if (isSold(r.outcome) && r.sold_price_aud != null) return Number(r.sold_price_aud);
  return r.guide_low != null ? (Number(r.guide_low) + Number(r.guide_high ?? r.guide_low)) / 2 : null;
}
/** Up to five bands holding about as many houses each, split at round $50k figures. Returns where each band starts
 *  (after the first). */
function priceBreaks(prices: number[]): number[] {
  const sorted = [...prices].sort((a, b) => a - b), n = Math.min(5, new Set(sorted).size), breaks: number[] = [];
  for (let i = 1; i < n; i++) {
    const at = Math.round(sorted[Math.floor((i * sorted.length) / n)] / 50_000) * 50_000;
    if (at > sorted[0] && (!breaks.length || at > breaks[breaks.length - 1])) breaks.push(at);
  }
  return breaks;
}
/** The ramp colour for band `i` of `bands`, spread across the ramp so a few bands still differ clearly. */
const bandColour = (i: number, bands: number) => PRICE_RAMP[bands === 1 ? 2 : Math.round((i * (PRICE_RAMP.length - 1)) / (bands - 1))];

export default function MapPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { byId, me } = usePeople();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Layer and source ids that belong to the basemap, so a light/dark switch can swap them and keep ours.
  const baseIds = useRef<{ layers: Set<string>; sources: Set<string> }>({ layers: new Set(), sources: new Set() });
  const isDark = useDarkMode();
  const firstScheme = useRef(isDark);
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
  const [showCommute, setShowCommute] = useState(false);
  // From: "house:<id>" (a house on the map) or "place:<id>" (a saved place or station).
  const [commute, setCommute] = useState<{ from: string; minutes: number; mode: "drive" | "walk" } | null>(null);
  const [commuteMsg, setCommuteMsg] = useState<string | null>(null);
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
  // Opened from a house's page: start zoomed in on it, selected, with its route to the station.
  const houseFor = params.get("house");
  const [colourBy, setColourBy] = useState<"price" | "status">(() => {
    try { return localStorage.getItem("housetrack.map.colour") === "status" ? "status" : "price"; } catch { return "price"; }
  });
  useEffect(() => { try { localStorage.setItem("housetrack.map.colour", colourBy); } catch { /* per-device nicety */ } }, [colourBy]);
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: OverviewRow[] }>("/api/overview") });
  const priceById = useMemo(() => new Map((overview.data?.rows ?? []).map((r) => [r.id, priceOf(r)])), [overview.data]);
  // From the Places tab: tap to add a place (with the ways to get there chosen there), or to move one.
  const pick = params.get("pick");
  const pickPlace = pick === "place" || pick === "move"
    ? { name: params.get("name") ?? "", person: params.get("person"), move: pick === "move" ? params.get("place") : null,
        modes: params.get("modes")?.split(",").filter(Boolean) ?? null }
    : null;

  const { data } = useQuery({ queryKey: ["map"], queryFn: () => api<MapData>("/api/map"), refetchInterval: whilePending });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["map"] });
    queryClient.invalidateQueries({ queryKey: ["overview"] });
  };

  // ─── map + drawing tool, created once ────────────────────────────────
  useEffect(() => {
    let map: maplibregl.Map | null = null;
    let cancelled = false;
    basemapStyle(pageIsDark()).then(({ style }) => {
      if (cancelled || !container.current) return;
      map = new maplibregl.Map({ container: container.current, style, center: MELBOURNE, zoom: 10, attributionControl: { compact: true } });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
      map.on("load", () => {
        const base = map!.getStyle();
        baseIds.current = { layers: new Set(base.layers.map((l) => l.id)), sources: new Set(Object.keys(base.sources)) };
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

  const breaks = useMemo(() => priceBreaks(visibleProperties.map((f) => priceById.get(f.properties.id)).filter((x): x is number => x != null)),
    [visibleProperties, priceById]);
  const priceColour = (id: string) => {
    const price = priceById.get(id);
    return price == null ? NO_PRICE : bandColour(breaks.filter((b) => price >= b).length, breaks.length + 1);
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !data) return;
    (map.getSource("properties") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: visibleProperties.map((f) => ({
        ...f,
        properties: {
          id: f.properties.id,
          label: addressOf(f.properties),
          colour: colourBy === "price" ? priceColour(f.properties.id) : STATUS_COLOUR[f.properties.status],
          // On the light map the palest price shades need an outline to stand out; white is enough on the dark one.
          stroke: colourBy === "price" && !isDark ? "#4a1140" : "#ffffff",
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
      // A house to show (opened from its page, or to move its pin): start on it, street level. Otherwise all of them.
      const focus = data.properties.features.find((f) => f.properties.id === (houseFor ?? pinFor));
      if (focus) {
        const at = focus.geometry.coordinates as [number, number], wide = window.innerWidth >= 800;
        map.fitBounds(new maplibregl.LngLatBounds(at, at), { maxZoom: 16, duration: 0,
          padding: houseFor ? (wide ? { top: 60, left: 60, right: 440, bottom: 90 } : { top: 60, left: 40, right: 40, bottom: window.innerHeight * 0.55 }) : 60 });
        if (houseFor) setSelected({ kind: "property", p: focus.properties });
      } else {
        const bounds = new maplibregl.LngLatBounds();
        data.properties.features.forEach((f) => bounds.extend(f.geometry.coordinates as [number, number]));
        map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 0 });
      }
      fitted.current = true;
    }
  }, [ready, data, visibleProperties, editing, byId, me, colourBy, breaks, priceById, isDark]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── all train stations ──────────────────────────────────────────────
  const stations = useQuery({ queryKey: ["stations"], queryFn: () => api<GeoJSON.FeatureCollection>("/api/stations"), staleTime: 3600_000 });
  useEffect(() => {
    const source = ready ? (mapRef.current?.getSource("stations") as GeoJSONSource | undefined) : undefined;
    if (source && stations.data) source.setData(stations.data);
  }, [ready, stations.data]);

  // ─── the selected house's route to its nearest station ───────────────
  const selectedId = selected?.kind === "property" ? selected.p.id : null;
  // The selected house as the map has it now (its travel times refresh after a pin moves), and its route for
  // where the pin and nearest station are now.
  const selectedNow = data?.properties.features.find((f) => f.properties.id === selectedId);
  const stationRoute = useQuery({
    queryKey: ["station-route", selectedId, selectedNow?.geometry.coordinates.join(","), selectedNow?.properties.nearest_station],
    enabled: !!selectedId && !!selectedNow?.properties.nearest_station, staleTime: 3600_000, retry: false,
    queryFn: () => api<StationRoute>(`/api/properties/${selectedId}/station-route`),
  });
  useEffect(() => {
    const map = mapRef.current;
    const source = ready && map ? (map.getSource("station-route") as GeoJSONSource | undefined) : undefined;
    if (!source) return;
    const r = selectedId ? stationRoute.data : undefined;
    const lines = r ? (["walk", "drive"] as const).flatMap((mode) => r[mode].geometry
      ? [{ type: "Feature" as const, geometry: r[mode].geometry!, properties: { mode } }] : []) : [];
    source.setData({ type: "FeatureCollection", features: lines });
    if (lines.length && map) {
      const bounds = new maplibregl.LngLatBounds();
      lines.forEach((f) => f.geometry.coordinates.forEach((c) => bounds.extend(c as [number, number])));
      const wide = window.innerWidth >= 800;
      map.fitBounds(bounds, { padding: wide ? { top: 60, left: 60, right: 440, bottom: 90 } : { top: 60, left: 40, right: 40, bottom: window.innerHeight * 0.55 },
                              maxZoom: 16, duration: 500 });
    }
  }, [ready, selectedId, stationRoute.data]);

  // ─── the selected house's comparable sales (not houses we track: only shown while it's selected) ───
  const comparables = useComparables(selectedId);
  useEffect(() => {
    const map = mapRef.current;
    const source = ready && map ? (map.getSource("comparables") as GeoJSONSource | undefined) : undefined;
    if (!source) return;
    const placed = selectedId && selectedNow ? (comparables.data ?? []).filter((x) => x.lon != null && x.lat != null) : [];
    const home = selectedNow?.geometry.coordinates as [number, number] | undefined;
    source.setData({ type: "FeatureCollection", features: placed.flatMap((x) => [
      { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [x.lon!, x.lat!] },
        properties: { label: comparableLabel(x), address: x.address } },
      ...(home ? [{ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: [home, [x.lon!, x.lat!]] }, properties: {} }] : []),
    ]) });
    // Bring any that are off screen into view, with the house.
    if (map && home && placed.length) {
      const view = map.getBounds();
      if (placed.some((x) => !view.contains([x.lon!, x.lat!]))) {
        const bounds = new maplibregl.LngLatBounds(home, home);
        placed.forEach((x) => bounds.extend([x.lon!, x.lat!]));
        const wide = window.innerWidth >= 800;
        map.fitBounds(bounds, { padding: wide ? { top: 80, left: 80, right: 460, bottom: 100 } : { top: 60, left: 40, right: 40, bottom: window.innerHeight * 0.55 },
                                maxZoom: 16, duration: 500 });
      }
    }
  }, [ready, selectedId, selectedNow?.geometry.coordinates.join(","), comparables.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── commute area ────────────────────────────────────────────────────
  const commutePlaces = (data?.places.features ?? []) as unknown as { geometry: { coordinates: [number, number] }; properties: { id: string; name: string; kind: string } }[];
  // Where a commute area can start: the selected house first, then saved places.
  const commuteFrom = [
    ...(selected?.kind === "property" ? [{ value: `house:${selected.p.id}`, label: `This house (${addressOf(selected.p)})` }] : []),
    ...(commute?.from.startsWith("house:") && commute.from !== `house:${selected?.kind === "property" ? selected.p.id : ""}`
      ? [{ value: commute.from, label: `House: ${(() => { const f = data?.properties.features.find((x) => `house:${x.properties.id}` === commute.from); return f ? addressOf(f.properties) : "earlier pick"; })()}` }] : []),
    ...commutePlaces.map((f) => ({ value: `place:${f.properties.id}`, label: `${f.properties.name}${f.properties.kind === "station" ? " (station)" : ""}` })),
  ];
  const commuteOrigin: { coords: [number, number]; name: string } | null = (() => {
    if (!commute) return null;
    const [kind, id] = commute.from.split(":");
    if (kind === "house") {
      const f = data?.properties.features.find((x) => x.properties.id === id);
      return f ? { coords: f.geometry.coordinates as [number, number], name: addressOf(f.properties) } : null;
    }
    const f = commutePlaces.find((x) => x.properties.id === id);
    return f ? { coords: f.geometry.coordinates, name: f.properties.name } : null;
  })();
  useEffect(() => {
    const map = mapRef.current;
    const source = ready && map ? (map.getSource("commute") as GeoJSONSource | undefined) : undefined;
    if (!source) return;
    if (!commute || !commuteOrigin) { source.setData({ type: "FeatureCollection", features: [] }); return; }
    let cancelled = false;
    const [lon, lat] = commuteOrigin.coords;
    setCommuteMsg("Working out the area…");
    api<GeoJSON.Feature>(`/api/isochrone?lon=${lon}&lat=${lat}&minutes=${commute.minutes}&mode=${commute.mode}`)
      .then((f) => { if (!cancelled) { source.setData({ type: "FeatureCollection", features: [f] }); setCommuteMsg(null); } })
      .catch((e) => { if (!cancelled) setCommuteMsg((e as Error).message); });
    return () => { cancelled = true; };
  }, [ready, commute, commuteOrigin?.coords.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

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
          if (mode.pickPlace.move) await api(`/api/places/${mode.pickPlace.move}`, { method: "PATCH", body: { location: point } });
          else await api("/api/places", { method: "POST", body: { kind: "destination", name: mode.pickPlace.name, person_id: mode.pickPlace.person || null,
                                                                  location: point, modes: mode.pickPlace.modes ?? undefined } });
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
        setShowLayers(false);
      } else if (area) {
        const a = current?.areas.features.find((f) => f.properties.id === area.properties.id)?.properties;
        setSelected(a ? { kind: "area", a } : null);
      } else {
        setSelected(null);
      }
    };
    map.on("click", onClick);
    // Pins say which house they are on hover, and look clickable.
    const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "pin-hover" });
    const onEnter = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || modeRef.current.drawing) return;
      map.getCanvas().style.cursor = "pointer";
      hover.setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).setText(String(f.properties.label)).addTo(map);
    };
    const onLeave = () => { map.getCanvas().style.cursor = ""; hover.remove(); };
    const onStation = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || modeRef.current.drawing || map.getZoom() >= 12) return;  // named on the map from zoom 12
      map.getCanvas().style.cursor = "default";
      hover.setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).setText(`${String(f.properties.name)} station`).addTo(map);
    };
    map.on("mousemove", "props-circle", onEnter);
    map.on("mouseleave", "props-circle", onLeave);
    map.on("mousemove", "stations-circle", onStation);
    map.on("mouseleave", "stations-circle", onLeave);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", "props-circle", onEnter);
      map.off("mouseleave", "props-circle", onLeave);
      map.off("mousemove", "stations-circle", onStation);
      map.off("mouseleave", "stations-circle", onLeave);
      hover.remove();
    };
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

  const statusesShown = [...new Set((data?.properties.features ?? []).map((f) => f.properties.status))]
    .sort((a, b) => STATUSES.indexOf(a) - STATUSES.indexOf(b));
  // Follow the system's light/dark setting live: swap the basemap, carry over our pins, areas and overlays.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || isDark === firstScheme.current) return;
    firstScheme.current = isDark;
    let cancelled = false;
    basemapStyle(isDark).then(({ style }) => {
      if (cancelled) return;
      map.setStyle(style, {
        transformStyle: (prev, next) => {
          if (!prev) return next;
          const ours = prev.layers.filter((l) => !baseIds.current.layers.has(l.id));
          const oursSources = Object.fromEntries(Object.entries(prev.sources).filter(([id]) => !baseIds.current.sources.has(id)));
          baseIds.current = { layers: new Set(next.layers.map((l) => l.id)), sources: new Set(Object.keys(next.sources)) };
          return { ...next, sources: { ...next.sources, ...oursSources }, layers: [...next.layers, ...ours] };
        },
      });
    });
    return () => { cancelled = true; };
  }, [isDark]);

  return (
    <div className={`map-page ${selected?.kind === "property" ? "side-open" : ""} ${showCommute || showLayers ? "panel-open" : ""}`}>
      <div ref={container} className="map" />

      <div className="map-top">
        {pinFor && <div className="banner">Tap the map where {pinTarget ?? "the house"} is. <Link to={`/p/${pinFor}`}>Cancel</Link></div>}
        {pickPlace && <div className="banner">Tap the map {pickPlace.move ? "where" : "to place"} “{pickPlace.name}”{pickPlace.move ? " really is" : ""}. <Link to="/places">Cancel</Link></div>}
        {drawKind && <div className="banner">Tap each corner. Tap the first one to finish. <button className="link" onClick={cancelDrawing}>Cancel</button></div>}
        {editing && (
          <div className="banner">
            Drag corners to reshape “{editing.name}”. <button className="link" onClick={saveEdit}>Save</button>{" "}
            <button className="link" onClick={cancelDrawing}>Cancel</button>
          </div>
        )}
        {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
        {statusesShown.length > 0 && (
          <details className="banner map-legend">
            <summary>Key</summary>
            <div className="map-colour-by small" role="group" aria-label="Colour houses by">
              <button className={colourBy === "price" ? "on" : ""} aria-pressed={colourBy === "price"} onClick={() => setColourBy("price")}>Price</button>
              <button className={colourBy === "status" ? "on" : ""} aria-pressed={colourBy === "status"} onClick={() => setColourBy("status")}>Status</button>
            </div>
            {colourBy === "price" ? <>
              {priceKey(breaks, visibleProperties.map((f) => priceById.get(f.properties.id)).filter((x): x is number => x != null)).map(([colour, text]) => (
                <div key={colour} className="small"><span className="status-dot price-dot" style={{ background: colour, marginRight: 6 }} />{text}</div>
              ))}
              {visibleProperties.some((f) => priceById.get(f.properties.id) == null) &&
                <div className="small"><span className="status-dot price-dot" style={{ background: NO_PRICE, marginRight: 6 }} />No price yet</div>}
              <div className="small muted">Sale price once sold, otherwise the middle of the latest guide</div>
            </> : statusesShown.map((st) => (
              <div key={st} className="small"><span className="status-dot" style={{ background: STATUS_COLOUR[st], marginRight: 6 }} />{LABEL.status[st]}</div>
            ))}
            <div className="small muted">Faded: rejected, lost, withdrawn or excluded</div>
            <div className="small" style={{ marginTop: 4 }}><span className="key-station" />Train station (named when zoomed in)</div>
          </details>
        )}
      </div>

      {/* The open panel sits above the tools, so neither covers the other. */}
      <div className="map-bottom">
      {showCommute && (
        <div className="sheet stack">
          <div className="row"><strong className="grow">Commute area</strong><button className="link" onClick={() => setShowCommute(false)}>Done</button></div>
          <p className="small muted" style={{ margin: 0 }}>Shades everywhere you can reach in that time from a house or place. Drives assume no traffic.</p>
          {commuteFrom.length === 0 ? <p className="small" style={{ margin: 0 }}>Select a house on the map, or add places on the <Link to="/places">Places</Link> tab.</p> : (
            <>
              <select value={commute?.from ?? ""} aria-label="From"
                onChange={(e) => setCommute(e.target.value ? { minutes: 30, mode: "drive", ...commute, from: e.target.value } : null)}>
                <option value="">Where from?</option>
                {commuteFrom.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {commute && (
                <>
                  <div className="chips">
                    {(commute.mode === "walk" ? [5, 10, 15, 20, 30] : [10, 15, 20, 30, 45, 60]).map((m) => (
                      <button key={m} className={`chip ${commute.minutes === m ? "on" : ""}`} onClick={() => setCommute({ ...commute, minutes: m })}>{m} min</button>
                    ))}
                  </div>
                  <div className="row">
                    {(["drive", "walk"] as const).map((m) => (
                      <button key={m} className={`chip ${commute.mode === m ? "on" : ""}`}
                        onClick={() => setCommute({ ...commute, mode: m, minutes: m === "walk" ? Math.min(commute.minutes, 30) : commute.minutes })}>
                        {m === "drive" ? "Driving" : "Walking"}</button>
                    ))}
                    <span className="grow" />
                    <button className="link" onClick={() => setCommute(null)}>Clear</button>
                  </div>
                </>
              )}
              {commuteMsg && <p className="small muted" style={{ margin: 0 }}>{commuteMsg}</p>}
            </>
          )}
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
      {selected?.kind === "area" && (
        <AreaSheet a={selected.a} mine={selected.a.owner_id === me?.id} owner={byId.get(selected.a.owner_id)?.display_name ?? "Someone"}
                   onEdit={() => startEditing(selected.a)} onChanged={() => { setSelected(null); refresh(); }} onClose={() => setSelected(null)} />
      )}
      {!pinFor && !pickPlace && !drawKind && !editing && !newShape && (
        <div className="map-tools">
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter">
            <option value="all">Show all</option>
            <option value="mine">Hide my exclusions</option>
            <option value="either">Hide anyone's exclusions</option>
          </select>
          {(overlayList.data?.length ?? 0) > 0 && <button onClick={() => { setShowLayers(!showLayers); setShowCommute(false); }}>Layers{enabled.length ? ` (${enabled.length})` : ""}</button>}
          <button className={commute ? "on-accent" : ""} onClick={() => {
            // Opening it with a house selected starts from that house.
            if (!showCommute && !commute && selected?.kind === "property") setCommute({ from: `house:${selected.p.id}`, minutes: 30, mode: "drive" });
            setShowCommute(!showCommute); setShowLayers(false);
          }}>
            {commute && commuteOrigin ? `${commute.minutes} min ${commute.mode} from ${commuteOrigin.name.split(",")[0]}` : "Commute"}</button>
          <button onClick={() => startDrawing("hard_exclude")}>Exclude area</button>
          <button onClick={() => startDrawing("soft_warn")}>Warn area</button>
          {unpinned > 0 && <span className="small muted">{unpinned} without a pin</span>}
        </div>
      )}
      </div>
      {selected?.kind === "property" && (
        <HouseSidePanel p={selectedNow?.properties ?? selected.p} route={stationRoute.data} routeError={stationRoute.error as Error | null}
          onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

/** The key's rows for price: each band's colour and range. */
function priceKey(breaks: number[], prices: number[]): [string, string][] {
  if (!prices.length) return [];
  const bands = breaks.length + 1;
  if (bands === 1) {
    const lo = Math.min(...prices), hi = Math.max(...prices);
    return [[bandColour(0, 1), lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`]];
  }
  return Array.from({ length: bands }, (_, i) => [bandColour(i, bands),
    i === 0 ? `Under ${money(breaks[0])}` : i === bands - 1 ? `${money(breaks[i - 1])} and over` : `${money(breaks[i - 1])}–${money(breaks[i])}`]);
}

function addLayers(map: maplibregl.Map) {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  // Commute area: everywhere within so many minutes of a chosen place (from the routing engine).
  map.addSource("commute", { type: "geojson", data: empty });
  map.addLayer({ id: "commute-fill", type: "fill", source: "commute", paint: { "fill-color": "#b4532f", "fill-opacity": 0.12 } });
  map.addLayer({ id: "commute-line", type: "line", source: "commute", paint: { "line-color": "#b4532f", "line-width": 2, "line-opacity": 0.7 } });
  // The selected house's walk and drive to its nearest station.
  map.addSource("station-route", { type: "geojson", data: empty });
  map.addLayer({ id: "station-route-drive", type: "line", source: "station-route", filter: ["==", ["get", "mode"], "drive"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#b4532f", "line-width": 3, "line-opacity": 0.75, "line-dasharray": [1.5, 1.5] } });
  map.addLayer({ id: "station-route-walk", type: "line", source: "station-route", filter: ["==", ["get", "mode"], "walk"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#1f5a70", "line-width": 4.5, "line-opacity": 0.9 } });
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
  // Every train station in the region (the ones picked on the Places screen are drawn again, larger, below).
  map.addSource("stations", { type: "geojson", data: empty });
  map.addLayer({ id: "stations-circle", type: "circle", source: "stations",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 12, 5, 15, 7], "circle-color": "#ffffff",
             "circle-stroke-color": "#1f5a70", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 13, 2.5] } });
  map.addLayer({ id: "stations-label", type: "symbol", source: "stations", minzoom: 12,
    layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#1f5a70", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  map.addLayer({ id: "places-circle", type: "circle", source: "places",
    paint: { "circle-radius": 6, "circle-color": ["case", ["==", ["get", "kind"], "station"], "#ffffff", "#111827"],
             "circle-stroke-color": "#111827", "circle-stroke-width": 2 } });
  map.addLayer({ id: "places-label", type: "symbol", source: "places",
    layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#111827", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  // The selected house's comparable sales: hollow brick markers with the price, tied to the house by a faint line,
  // so they never read as houses we track.
  map.addSource("comparables", { type: "geojson", data: empty });
  map.addLayer({ id: "comparables-tie", type: "line", source: "comparables", filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": "#d9774f", "line-width": 1.8, "line-opacity": 0.85, "line-dasharray": [2, 2] } });
  map.addLayer({ id: "comparables-circle", type: "circle", source: "comparables", filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-radius": 6, "circle-color": "#ffffff", "circle-stroke-color": "#b4532f", "circle-stroke-width": 2.5 } });
  map.addLayer({ id: "comparables-label", type: "symbol", source: "comparables", filter: ["==", ["geometry-type"], "Point"],
    layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Regular"],
              "text-allow-overlap": true },
    paint: { "text-color": "#8a3a1f", "text-halo-color": "#fff", "text-halo-width": 1.4 } });
  map.addLayer({ id: "props-ring", type: "circle", source: "properties", filter: ["!=", ["get", "ring"], ""],
    paint: { "circle-radius": 12, "circle-color": "transparent", "circle-stroke-color": ["get", "ring"], "circle-stroke-width": 2.5 } });
  map.addLayer({ id: "props-circle", type: "circle", source: "properties",
    paint: { "circle-radius": 8, "circle-color": ["get", "colour"], "circle-opacity": ["case", ["get", "dim"], 0.35, 1],
             "circle-stroke-color": ["case", ["get", "warned"], "#f59e0b", ["get", "stroke"]], "circle-stroke-width": ["case", ["get", "warned"], 3, 1.5] } });
}

// ─── bottom sheets ────────────────────────────────────────────────────

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
      <div className="small muted">{mine ? "Your area. Only your map is affected." : `${owner}'s area. It doesn't hide anything for you.`}</div>
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
