import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Ban, Landmark, LandPlot, Layers, PenLine, Search, Timer, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { STATUSES, api, whilePending, type AreaKind, type MapArea, type MapData, type MapProperty } from "../api";
import { isSold, LABEL, money, saleEnded, streetLine } from "../format";
import type { OverviewRow } from "../overview/columns";
import { basemapStyle } from "../map/basemap";
import { syncOverlays, type OverlayLayer } from "../map/overlays";
import { overlayStyle, PALETTES, type Look, type MapPalette } from "../map/palette";
import { contourTiles, dem, TERRAIN_ATTRIBUTION, type ContourDetail } from "../map/terrain";
import { usePeople } from "../people";
import { CLOSED, STATUS_COLOUR, useDarkMode } from "../colour";
import { isDark as pageIsDark } from "../theme";
import HouseSidePanel, { comparableLabel, type StationRoute, useComparables } from "../map/HouseSidePanel";
import { useBlockPrefs, useBlockSuburbs, type BlockPrefs } from "../blocks";
import { addBlockLayers, BLOCK_COLOURS, BLOCK_LAYERS, boundsOf, prepare, setBlockData, syncBlockLayers, type BlockColour } from "../map/blocks";
import { BlockSheet, BlocksPanel, type BlockView, type Street } from "../map/BlocksPanel";

const MELBOURNE: [number, number] = [145.0, -37.81];
// Free satellite imagery (Esri World Imagery, street-level detail across Melbourne).
const SATELLITE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
// With the household's free ArcGIS key (ARCGIS_API_KEY on the server), the same imagery through Esri's keyed service.
const satelliteTiles: Promise<string> = fetch("/api/map-config").then((r) => r.json())
  .then((c: { satellite?: string | null }) => c.satellite || SATELLITE).catch(() => SATELLITE);
// Our layers that go under the basemap's labels, so street and place names stay readable over them.
const UNDER_LABELS = new Set(["hillshade", "contour-lines", "contour-labels", ...BLOCK_LAYERS]);
/** A basemap layer the satellite photo replaces: its land, water, buildings and roads (not its labels, which stay on
 *  top). The styles mix labels in among these, so they're hidden rather than left to draw over the photo. */
const underPhoto = (l: { type: string }) => l.type !== "symbol" && l.type !== "background";
/** The basemap's labels over a photo: white with a soft dark outline (its own styles put grey text on solid black, or
 *  on white, which on a photo read as bars), and no one-way arrows. */
const PHOTO_LABELS: Record<string, unknown> = { "text-color": "#ffffff", "text-halo-color": "rgba(0, 0, 0, 0.85)", "text-halo-width": 2,
  "text-halo-blur": 0.5, "icon-opacity": 0 };
/** On the dark street map its own labels are dim grey on near-black: lifted to a readable grey, still quieter than ours. */
const DARK_LABELS: Record<string, unknown> = { "text-color": "#a3acb0", "text-halo-color": "rgba(12, 12, 12, 0.9)", "text-halo-width": 1.2 };
/** The basemap label colours for a look: the photo's, the dark map's lift, or (null) the style's own. */
const labelsFor = (photo: boolean, dark: boolean) => (photo ? PHOTO_LABELS : dark ? DARK_LABELS : null);
const LABEL_KEYS = [...new Set([...Object.keys(PHOTO_LABELS), ...Object.keys(DARK_LABELS)])];
const labelPaints = (layers: { id: string; type: string; paint?: unknown }[]) =>
  new Map(layers.filter((l) => l.type === "symbol").map((l) => [l.id, { ...(l.paint as Record<string, unknown> | undefined) }]));
/** The basemap layers a style hides itself, so switching the photo off doesn't show them. */
const hiddenIn = (layers: { id: string; layout?: unknown }[]) =>
  new Set(layers.filter((l) => (l.layout as { visibility?: string } | undefined)?.visibility === "none").map((l) => l.id));
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* per-device nicety */ } };
type Filter = "all" | "mine" | "either";

type Selected = { kind: "property"; p: MapProperty } | { kind: "area"; a: MapArea } | null;
type Panel = "key" | "layers" | "planning" | "travel" | "draw" | "blocks" | null;
const PANEL_TITLE: Record<Exclude<Panel, null>, string> = { key: "Key", layers: "Layers", planning: "Schools and planning", travel: "Travel time",
  draw: "Mark an area", blocks: "Blocks" };
const storedJson = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; } };
const REDUCED_MOTION = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;


const addressOf = (p: Pick<MapProperty, "unit" | "street_number" | "street" | "suburb" | "lot_number">) => `${streetLine(p)}, ${p.suburb}`;

// ─── colouring houses by price ─────────────────────────────────────────
// One hue (the palette's price ramp, map/palette.ts), cheaper to dearer; houses with no price yet are grey.
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
const bandColour = (ramp: string[], i: number, bands: number) => ramp[bands === 1 ? 2 : Math.round((i * (ramp.length - 1)) / (bands - 1))];

export default function MapPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { byId, me } = usePeople();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Layer and source ids that belong to the basemap, so a light/dark switch can swap them and keep ours.
  const baseIds = useRef<{ layers: Set<string>; sources: Set<string>; hidden: Set<string> }>({ layers: new Set(), sources: new Set(), hidden: new Set() });
  const labelPaint = useRef(new Map<string, Record<string, unknown>>());   // the basemap's own label colours, to put back
  const isDark = useDarkMode();
  const firstScheme = useRef(isDark);
  const drawRef = useRef<TerraDraw | null>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);

  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Selected>(null);
  const selectedId = selected?.kind === "property" ? selected.p.id : null;
  const [drawKind, setDrawKind] = useState<AreaKind | null>(null);
  const [newShape, setNewShape] = useState<GeoJSON.Polygon | null>(null);
  const [editing, setEditing] = useState<MapArea | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One panel at a time over the map: the key, layers, travel time or marking an area.
  const [panel, setPanel] = useState<Panel>(null);
  // The base under the houses (map or satellite) and whether height shows: per device.
  const [base, setBase] = useState<"map" | "satellite">(() => (stored("housetrack.map.base") === "satellite" ? "satellite" : "map"));
  const [height, setHeight] = useState(() => stored("housetrack.map.height") === "1");
  // Every colour on the map comes from the palette for the look: streets light or dark, or the satellite photo.
  const look: Look = base === "satellite" ? "photo" : isDark ? "dark" : "light";
  const pal = PALETTES[look];
  const baseRef = useRef(base);   // for the light/dark swap, which rebuilds the basemap
  baseRef.current = base;
  const [contourDetail, setContourDetail] = useState<ContourDetail>(() => (stored("housetrack.map.contours") === "fine" ? "fine" : "coarse"));
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
    return syncOverlays(map, enabled, overlayList.data, pal);
  }, [ready, enabled, overlayList.data, look]); // eslint-disable-line react-hooks/exhaustive-deps

  // How much of the map a phone's house sheet covers (0 on a computer), so a house and its route are framed above it.
  const sheetH = useRef(0);
  const page = useRef<HTMLDivElement>(null);
  const framing = (): maplibregl.PaddingOptions => (window.innerWidth >= 800
    ? { top: 80, left: 60, right: 440, bottom: 90 }
    : { top: 76, left: 30, right: 30, bottom: (sheetH.current || 200) + 70 });   // (the tools sit just above the sheet)

  const pinFor = params.get("pin");
  // Opened from a house's page: start zoomed in on it, selected, with its route to the station.
  const houseFor = params.get("house");
  const [colourBy, setColourBy] = useState<"price" | "status">(() => {
    try { return localStorage.getItem("housetrack.map.colour") === "status" ? "status" : "price"; } catch { return "price"; }
  });
  useEffect(() => { try { localStorage.setItem("housetrack.map.colour", colourBy); } catch { /* per-device nicety */ } }, [colourBy]);
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<{ rows: OverviewRow[] }>("/api/overview") });
  const priceById = useMemo(() => new Map((overview.data?.rows ?? []).map((r) => [r.id, priceOf(r)])), [overview.data]);
  const endedById = useMemo(() => new Map((overview.data?.rows ?? []).map((r) => [r.id, saleEnded(r.outcome, r.bought_by_us)])), [overview.data]);
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
        baseIds.current = { layers: new Set(base.layers.map((l) => l.id)), sources: new Set(Object.keys(base.sources)), hidden: hiddenIn(base.layers) };
        labelPaint.current = labelPaints(base.layers);
        addBaseLayers(map!, baseIds.current.layers);
        addBlockLayers(map!, map!.getStyle().layers.find((l) => baseIds.current.layers.has(l.id) && l.type === "symbol")?.id);
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
    return price == null ? pal.noPrice : bandColour(pal.priceRamp, breaks.filter((b) => price >= b).length, breaks.length + 1);
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
          colour: colourBy === "price" ? priceColour(f.properties.id) : pal.status[f.properties.status],
          // The palette's edge: dark plum round the pale price shades on the light map; status colours there get white.
          stroke: colourBy === "status" && look === "light" ? "#ffffff" : pal.pinStroke,
          sel: f.properties.id === selectedId,
          dim: f.properties.excluded || CLOSED.includes(f.properties.status) || !!endedById.get(f.properties.id),
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
        const at = focus.geometry.coordinates as [number, number];
        map.fitBounds(new maplibregl.LngLatBounds(at, at), { maxZoom: 16, duration: 0, padding: houseFor ? framing() : 60 });
        if (houseFor) setSelected({ kind: "property", p: focus.properties });
      } else {
        const bounds = new maplibregl.LngLatBounds();
        data.properties.features.forEach((f) => bounds.extend(f.geometry.coordinates as [number, number]));
        map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 0 });
      }
      fitted.current = true;
    }
  }, [ready, data, visibleProperties, editing, byId, me, colourBy, breaks, priceById, endedById, look, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── all train stations ──────────────────────────────────────────────
  const stations = useQuery({ queryKey: ["stations"], queryFn: () => api<GeoJSON.FeatureCollection>("/api/stations"), staleTime: 3600_000 });
  useEffect(() => {
    const source = ready ? (mapRef.current?.getSource("stations") as GeoJSONSource | undefined) : undefined;
    if (source && stations.data) source.setData(stations.data);
  }, [ready, stations.data]);

  // ─── the selected house's route to its nearest station ───────────────
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
      map.fitBounds(bounds, { padding: framing(),
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
        map.fitBounds(bounds, { padding: framing(),
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
    setCommuteMsg("Calculating the area…");
    api<GeoJSON.Feature>(`/api/isochrone?lon=${lon}&lat=${lat}&minutes=${commute.minutes}&mode=${commute.mode}`)
      .then((f) => { if (!cancelled) { source.setData({ type: "FeatureCollection", features: [f] }); setCommuteMsg(null); } })
      .catch((e) => { if (!cancelled) setCommuteMsg((e as Error).message); });
    return () => { cancelled = true; };
  }, [ready, commute, commuteOrigin?.coords.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── blocks: every block in the analysed suburbs, or areas where many fit ───
  const [blockView, setBlockView] = useState<BlockView>(() => { const v = stored("housetrack.map.blocks"); return v === "blocks" || v === "areas" ? v : "off"; });
  const [blockColour, setBlockColour] = useState<BlockColour>(() => {
    const v = stored("housetrack.map.blockColour"); return BLOCK_COLOURS.some(([c]) => c === v) ? v as BlockColour : "fit"; });
  const [hiddenSuburbs, setHiddenSuburbs] = useState<string[]>(() => storedJson("housetrack.map.blockSuburbsHidden", []));
  const [hexSize, setHexSize] = useState(() => Number(stored("housetrack.map.hexSize")) || 250);
  // Preferences being tried on the map (this device) until saved for the household; null: the household's.
  const [trial, setTrial] = useState<BlockPrefs | null>(() => storedJson("housetrack.map.blockPrefs", null));
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  useEffect(() => {
    store("housetrack.map.blocks", blockView); store("housetrack.map.blockColour", blockColour); store("housetrack.map.hexSize", String(hexSize));
    store("housetrack.map.blockSuburbsHidden", JSON.stringify(hiddenSuburbs)); store("housetrack.map.blockPrefs", JSON.stringify(trial));
  }, [blockView, blockColour, hexSize, hiddenSuburbs, trial]);
  const householdPrefs = useBlockPrefs();
  const blockPrefs = trial ?? householdPrefs.data ?? null;
  const blockSuburbs = useBlockSuburbs(blockView !== "off" || panel === "blocks");
  const shownSuburbs = (blockSuburbs.data ?? []).filter((x) => x.status === "done" && !hiddenSuburbs.includes(x.suburb));
  const blockGeo = useQueries({ queries: shownSuburbs.map((x) => ({
    queryKey: ["block-geojson", x.suburb, x.analysed_at], staleTime: Infinity, enabled: blockView !== "off",
    queryFn: () => api<GeoJSON.FeatureCollection>(`/api/blocks/geojson?suburb=${encodeURIComponent(x.suburb)}`) })) });
  const geoStamp = blockGeo.map((q) => q.dataUpdatedAt).join(",");
  const splitRule = JSON.stringify([blockPrefs?.split, blockPrefs?.split_frontage]);
  const blockFeatures = useMemo(() => !blockPrefs ? [] : shownSuburbs.flatMap((x, i) => {
    const fc = blockGeo[i]?.data;
    return fc ? prepare(fc, x.suburb, blockPrefs) : [];
  }), [geoStamp, splitRule, shownSuburbs.map((x) => x.suburb).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const areas = useQuery({
    queryKey: ["block-areas", blockPrefs && [blockPrefs.min_m2, blockPrefs.max_m2, blockPrefs.max_incline, blockPrefs.directions, blockPrefs.include_units], hexSize,
               (blockSuburbs.data ?? []).map((x) => x.analysed_at).join(",")],
    enabled: blockView === "areas" && !!blockPrefs, staleTime: 300_000, placeholderData: (prev) => prev,
    queryFn: () => api<{ hexes: GeoJSON.FeatureCollection; streets: Street[] }>("/api/blocks/areas", { method: "POST", body: {
      min_m2: blockPrefs!.min_m2, max_m2: blockPrefs!.max_m2, max_incline: blockPrefs!.max_incline, directions: blockPrefs!.directions,
      include_units: blockPrefs!.include_units, size: hexSize } }),
  });
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) setBlockData(map, blockFeatures, areas.data?.hexes);
  }, [ready, blockFeatures, areas.data]);
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map && blockPrefs) syncBlockLayers(map, { view: blockView, colour: blockColour, prefs: blockPrefs, photo: look === "photo",
                                                           dark: look === "dark", selected: selectedBlock });
  }, [ready, blockView, blockColour, blockPrefs, look, selectedBlock]);
  async function saveBlockPrefs() {
    if (!trial) return;
    setSavingPrefs(true);
    try {
      await api("/api/blocks/prefs", { method: "PUT", body: trial });
      setTrial(null);
      for (const key of [["block-prefs"], ["overview"], ["block"], ["property-block"]]) queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingPrefs(false);
    }
  }
  function goToSuburb(suburb: string) {
    const b = boundsOf(blockFeatures.filter((f) => (f.properties as { sub?: string }).sub === suburb));
    if (b) mapRef.current?.fitBounds(b, { padding: framing(), duration: REDUCED_MOTION ? 0 : 600 });
  }
  const houseSuburbs = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of overview.data?.rows ?? []) if (r.suburb) n.set(String(r.suburb), (n.get(String(r.suburb)) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x);
  }, [overview.data]);

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
      const hit = map.queryRenderedFeatures(e.point, { layers: ["props-circle", "areas-fill", "blocks-fill"] });
      const prop = hit.find((f) => f.layer.id === "props-circle");
      const area = hit.find((f) => f.layer.id === "areas-fill");
      const block = hit.find((f) => f.layer.id === "blocks-fill");
      const current = queryClient.getQueryData<MapData>(["map"]);
      setSelectedBlock(null);
      if (prop) {
        const p = current?.properties.features.find((f) => f.properties.id === prop.properties.id)?.properties;
        setSelected(p ? { kind: "property", p } : null);
        setPanel(null);
      } else if (block) {
        // A block: its card (on a phone it takes the panel's place; on a computer the Blocks panel stays open beside it).
        setSelected(null);
        setSelectedBlock(String(block.properties.pfi));
        if (window.innerWidth < 800) setPanel(null);
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
    // Blocks can be tapped for their card.
    const onBlock = () => { if (!modeRef.current.drawing) map.getCanvas().style.cursor = "pointer"; };
    const offBlock = () => { map.getCanvas().style.cursor = ""; };
    map.on("mousemove", "blocks-fill", onBlock);
    map.on("mouseleave", "blocks-fill", offBlock);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", "props-circle", onEnter);
      map.off("mouseleave", "props-circle", onLeave);
      map.off("mousemove", "stations-circle", onStation);
      map.off("mouseleave", "stations-circle", onLeave);
      map.off("mousemove", "blocks-fill", onBlock);
      map.off("mouseleave", "blocks-fill", offBlock);
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
  // The palette on every layer of ours. (Declared before the light/dark swap below, so the swap carries these colours over.)
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) applyPalette(map, pal);
  }, [ready, look]); // eslint-disable-line react-hooks/exhaustive-deps

  // Satellite and height on or off, with contours coloured to read on whichever is underneath.
  useEffect(() => {
    store("housetrack.map.base", base);
    store("housetrack.map.height", height ? "1" : "0");
    store("housetrack.map.contours", contourDetail);
    const map = mapRef.current;
    if (!ready || !map) return;
    const source = map.getSource("contours") as maplibregl.VectorTileSource | undefined;
    if (source && source.tiles?.[0] !== contourTiles[contourDetail]) source.setTiles([contourTiles[contourDetail]]);
    const show = (id: string, on: boolean) => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };
    show("satellite", base === "satellite");
    for (const l of map.getStyle().layers) {
      if (!baseIds.current.layers.has(l.id)) continue;
      if (underPhoto(l)) show(l.id, base !== "satellite" && !baseIds.current.hidden.has(l.id));
      if (l.type === "symbol") {
        const own = labelPaint.current.get(l.id) ?? {}, over = labelsFor(base === "satellite", isDark);
        for (const k of LABEL_KEYS) map.setPaintProperty(l.id, k as "text-color", (over && k in over ? over[k] : own[k]) as string | undefined);
      }
    }
    for (const id of ["hillshade", "contour-lines", "contour-labels"]) show(id, height);
    if (!map.getLayer("contour-lines")) return;
    const photo = base === "satellite";
    map.setPaintProperty("contour-lines", "line-color", photo ? "#ffffff" : isDark ? "#c9a878" : "#8a5a2b");
    map.setPaintProperty("contour-labels", "text-color", photo ? "#ffffff" : isDark ? "#e2c9a4" : "#6b4420");
    map.setPaintProperty("contour-labels", "text-halo-color", photo ? "rgba(0,0,0,0.85)" : isDark ? "#1c2326" : "#ffffff");
    map.setPaintProperty("contour-labels", "text-halo-width", photo ? 2 : 1.2);
    // Hill shading: on the dark map, faint highlights and black shadows (full white reads as streaks, not relief).
    map.setPaintProperty("hillshade", "hillshade-highlight-color", isDark && !photo ? "rgba(255, 255, 255, 0.14)" : "#ffffff");
    map.setPaintProperty("hillshade", "hillshade-shadow-color", isDark && !photo ? "#000000" : "#3d3222");
    // Over a photo, stronger and a touch wider, so they hold up against busy ground even zoomed well out.
    map.setPaintProperty("contour-lines", "line-opacity", ["match", ["get", "level"], 1, photo ? 0.95 : 0.75, photo ? 0.7 : 0.4]);
    map.setPaintProperty("contour-lines", "line-width", ["match", ["get", "level"], 1, photo ? 1.7 : 1.3, photo ? 0.9 : 0.6]);
  }, [ready, base, height, contourDetail, isDark]);

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
          baseIds.current = { layers: new Set(next.layers.map((l) => l.id)), sources: new Set(Object.keys(next.sources)), hidden: hiddenIn(next.layers) };
          const photo = ours.filter((l) => l.id === "satellite");
          const under = ours.filter((l) => UNDER_LABELS.has(l.id)), over = ours.filter((l) => !UNDER_LABELS.has(l.id) && l.id !== "satellite");
          labelPaint.current = labelPaints(next.layers);
          const onPhoto = baseRef.current === "satellite";
          const basemap = next.layers.map((l) => (onPhoto && underPhoto(l) ? { ...l, layout: { ...l.layout, visibility: "none" as const } }
            : l.type === "symbol" && labelsFor(onPhoto, isDark) ? { ...l, paint: { ...l.paint, ...labelsFor(onPhoto, isDark) } } as typeof l : l));
          const ground = basemap.filter((l) => l.type === "background").length;
          const labels = basemap.findIndex((l) => l.type === "symbol");
          const layers = labels < 0
            ? [...basemap.slice(0, ground), ...photo, ...basemap.slice(ground), ...under, ...over]
            : [...basemap.slice(0, ground), ...photo, ...basemap.slice(ground, labels), ...under, ...basemap.slice(labels), ...over];
          return { ...next, sources: { ...next.sources, ...oursSources }, layers };
        },
      });
    });
    return () => { cancelled = true; };
  }, [isDark]);

  const houses = data?.properties.features ?? [];
  // A task that takes the map over (placing a pin or a place, drawing or reshaping an area): its banner, nothing else.
  const busy = Boolean(pinFor || pickPlace || drawKind || editing || newShape);
  const houseOpen = selected?.kind === "property";
  const layersOn = (base === "satellite" ? 1 : 0) + (height ? 1 : 0) + (filter !== "all" ? 1 : 0);
  const toggle = (next: Panel) => setPanel(panel === next ? null : next);
  const swatches = colourBy === "price" ? pal.priceRamp : statusesShown.slice(0, 5).map((st) => pal.status[st]);
  function selectHouse(f: (typeof houses)[number]) {
    setSelected({ kind: "property", p: f.properties });
    setSelectedBlock(null);
    setPanel(null);
    const at = f.geometry.coordinates as [number, number];
    mapRef.current?.fitBounds(new maplibregl.LngLatBounds(at, at), { padding: framing(), maxZoom: 16, duration: REDUCED_MOTION ? 0 : 600 });
  }
  function travelFromHouse() {
    if (selected?.kind === "property") setCommute({ minutes: commute?.minutes ?? 30, mode: commute?.mode ?? "drive", from: `house:${selected.p.id}` });
    setPanel("travel");
  }

  return (
    <div ref={page} className={`map-page ${houseOpen ? "house-open" : ""} ${panel || newShape || selected?.kind === "area" ? "panel-open" : ""}`}>
      <div ref={container} className="map" />

      <div className="map-top">
        {!busy && <HouseSearch houses={houses} onPick={selectHouse} />}
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
      </div>

      {/* The open panel sits above the tools, so neither covers the other. */}
      <div className="map-dock">
        {panel && !busy && (
          <MapPanel title={PANEL_TITLE[panel]} onClose={() => setPanel(null)}>
            {panel === "key" && <>
              <Seg label="Colour houses by" value={colourBy} onChange={setColourBy} options={[["price", "Price"], ["status", "Status"]]} />
              <div className="map-key">
                {colourBy === "price" ? <>
                  {priceKey(pal.priceRamp, breaks, visibleProperties.map((f) => priceById.get(f.properties.id)).filter((x): x is number => x != null)).map(([colour, text]) => (
                    <div key={colour}><span className="key-pin" style={{ background: colour, borderColor: pal.pinStroke }} />{text}</div>
                  ))}
                  {visibleProperties.some((f) => priceById.get(f.properties.id) == null) &&
                    <div><span className="key-pin" style={{ background: pal.noPrice, borderColor: pal.pinStroke }} />No price yet</div>}
                </> : statusesShown.map((st) => (
                  <div key={st}><span className="key-pin" style={{ background: pal.status[st], borderColor: look === "light" ? "#ffffff" : pal.pinStroke }} />
                    {LABEL.status[st]}</div>
                ))}
                <div><span className="key-pin key-ring" style={{ borderColor: pal.select }} />Selected house</div>
                <div><span className="key-station" style={{ borderColor: pal.station, background: pal.stationFill }} />Train station</div>
                <div><span className="key-line" style={{ borderTopColor: pal.route }} />Walk to nearest station
                  <span className="key-line dashed" style={{ borderTopColor: pal.drive, marginLeft: 6 }} />drive</div>
                <div><span className="comp-key" style={{ borderColor: pal.comp, background: pal.compFill }} />Comparable sale</div>
                <div><span className="key-area" style={{ borderColor: pal.reach, background: pal.reach }} />Travel time area</div>
              </div>
              <p className="small muted">{colourBy === "price" ? "Price is the sold price, or the middle of the latest guide. " : ""}
                Faded: ruled out, sold or excluded.</p>
            </>}
            {panel === "layers" && <>
              <section>
                <div className="section-title">Map</div>
                <Seg label="Map" value={base} onChange={setBase} options={[["map", "Streets"], ["satellite", "Satellite"]]} />
              </section>
              <section>
                <div className="section-title">Contour lines</div>
                <Seg label="Contour lines" value={height ? contourDetail : "off"} options={[["off", "Off"], ["coarse", "Coarse"], ["fine", "Fine"]]}
                  onChange={(v) => { setHeight(v !== "off"); if (v !== "off") setContourDetail(v); }} />
                {height && <p className="small muted">{contourDetail === "coarse" ? "Every 5 m, labelled every 25 m" : "Every 2 m, labelled every 10 m"},
                  with hill shading. Approximate.</p>}
              </section>
              <section>
                <div className="section-title">Hide excluded houses</div>
                <Seg label="Hide excluded houses" value={filter} onChange={setFilter}
                  options={[["all", "No"], ["mine", "Mine"], ["either", "Everyone's"]]} />
                {unpinned > 0 && <p className="small muted">{unpinned} {unpinned === 1 ? "house has" : "houses have"} no pin yet.</p>}
              </section>
            </>}
            {panel === "planning" && <>
              <p className="small muted">Shown when zoomed in. Set what each layer does in <Link to="/settings">Settings</Link>.</p>
              <div className="map-overlay-list">
                {(overlayList.data ?? []).map((l) => (
                  <label key={l.code} className="map-toggle">
                    <OverlaySwatch pal={pal} code={l.code} />
                    <span className="grow">{l.title}{l.effect !== "info" && <span className="pill">{l.effect === "hard_exclude" ? "excludes" : "warns"}</span>}</span>
                    <input type="checkbox" role="switch" checked={enabled.includes(l.code)}
                      onChange={(e) => setEnabled(e.target.checked ? [...enabled, l.code] : enabled.filter((c) => c !== l.code))} />
                  </label>
                ))}
              </div>
              {enabled.length > 0 && <button className="link" style={{ justifySelf: "start" }} onClick={() => setEnabled([])}>Turn them all off</button>}
            </>}
            {panel === "travel" && <>
              <p className="small muted">Shows where you can reach in the time chosen. Drives assume no traffic.</p>
              {commuteFrom.length === 0 ? <p className="small">Select a house, or add places in <Link to="/places">Places</Link>.</p> : (
                <>
                  <select value={commute?.from ?? ""} aria-label="From"
                    onChange={(e) => setCommute(e.target.value ? { minutes: 30, mode: "drive", ...commute, from: e.target.value } : null)}>
                    <option value="">Where from?</option>
                    {commuteFrom.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {commute && (
                    <>
                      <Seg label="How" value={commute.mode} options={[["drive", "Driving"], ["walk", "Walking"]]}
                        onChange={(m) => setCommute({ ...commute, mode: m, minutes: m === "walk" ? Math.min(commute.minutes, 30) : commute.minutes })} />
                      <div className="chips">
                        {(commute.mode === "walk" ? [5, 10, 15, 20, 30] : [10, 15, 20, 30, 45, 60]).map((m) => (
                          <button key={m} className={`chip ${commute.minutes === m ? "on" : ""}`} onClick={() => setCommute({ ...commute, minutes: m })}>{m} min</button>
                        ))}
                      </div>
                      <button className="link" style={{ justifySelf: "start" }} onClick={() => setCommute(null)}>Clear</button>
                    </>
                  )}
                  {commuteMsg && <p className="small muted">{commuteMsg}</p>}
                </>
              )}
            </>}
            {panel === "blocks" && (blockPrefs ? (
              <BlocksPanel view={blockView} setView={setBlockView} colour={blockColour} setColour={setBlockColour} prefs={blockPrefs}
                household={householdPrefs.data} setTrial={setTrial} onSave={saveBlockPrefs} saving={savingPrefs}
                suburbs={blockSuburbs.data ?? []} hidden={hiddenSuburbs} setHidden={setHiddenSuburbs} features={blockFeatures}
                streets={areas.data?.streets} areasLoading={areas.isFetching} onGoTo={goToSuburb} hexSize={hexSize} setHexSize={setHexSize}
                houseSuburbs={houseSuburbs} />
            ) : <p className="small muted">Loading…</p>)}
            {panel === "draw" && <>
              <p className="small muted">Draw an area on the map. Only you see its effect.</p>
              <button className="map-choice" onClick={() => { setPanel(null); startDrawing("hard_exclude"); }}>
                <Ban /><span><strong>Exclude the houses inside</strong><span className="small muted">Marked excluded for you.</span></span></button>
              <button className="map-choice" onClick={() => { setPanel(null); startDrawing("soft_warn"); }}>
                <TriangleAlert /><span><strong>Warn about the houses inside</strong><span className="small muted">Flagged with a warning, e.g. a flight path.</span></span></button>
            </>}
          </MapPanel>
        )}
        {newShape && <NewAreaSheet shape={newShape} kind={drawKind ?? "hard_exclude"} onDone={() => { setNewShape(null); refresh(); }} />}
        {selected?.kind === "area" && (
          <AreaSheet a={selected.a} mine={selected.a.owner_id === me?.id} owner={byId.get(selected.a.owner_id)?.display_name ?? "Someone"}
                     onEdit={() => startEditing(selected.a)} onChanged={() => { setSelected(null); refresh(); }} onClose={() => setSelected(null)} />
        )}
        {!busy && (
          <div className="map-tools" role="toolbar" aria-label="Map tools">
            <button className={panel === "key" ? "on" : ""} aria-pressed={panel === "key"} onClick={() => toggle("key")}>
              <span className="key-swatches" aria-hidden>{swatches.map((c, i) => <i key={i} style={{ background: c }} />)}</span>Key</button>
            <button className={panel === "layers" ? "on" : ""} aria-pressed={panel === "layers"} onClick={() => toggle("layers")}>
              <Layers />Layers{layersOn > 0 && <span className="count-badge">{layersOn}</span>}</button>
            {(overlayList.data?.length ?? 0) > 0 && (
              <button className={panel === "planning" ? "on" : ""} aria-pressed={panel === "planning"} onClick={() => toggle("planning")}>
                <Landmark />Planning{enabled.length > 0 && <span className="count-badge">{enabled.length}</span>}</button>
            )}
            <button className={panel === "travel" || commute ? "on" : ""} aria-pressed={panel === "travel"} onClick={() => toggle("travel")}>
              <Timer />{commute && commuteOrigin ? `${commute.minutes} min ${commute.mode === "drive" ? "drive" : "walk"}` : "Travel time"}</button>
            <button className={panel === "blocks" || blockView !== "off" ? "on" : ""} aria-pressed={panel === "blocks"}
              onClick={() => { toggle("blocks"); if (panel !== "blocks" && blockView === "off") setBlockView("blocks"); }}>
              <LandPlot />Blocks</button>
            <button className={panel === "draw" ? "on" : ""} aria-pressed={panel === "draw"} onClick={() => toggle("draw")}>
              <PenLine />Mark an area</button>
          </div>
        )}
      </div>

      {/* A tapped block: beside the map on a computer (the Blocks panel stays open to try preferences), a sheet on a phone. */}
      {selectedBlock && blockPrefs && !busy && (
        <div className="block-side"><BlockSheet pfi={selectedBlock} prefs={blockPrefs} onClose={() => setSelectedBlock(null)} /></div>
      )}

      {houseOpen && (
        <HouseSidePanel p={selectedNow?.properties ?? selected.p} route={stationRoute.data} routeError={stationRoute.error as Error | null}
          onClose={() => setSelected(null)} onTravel={travelFromHouse}
          onSheetHeight={(h, stop) => {
            sheetH.current = h;
            page.current?.style.setProperty("--sheet-h", `${h}px`);
            if (page.current) page.current.dataset.sheet = stop;
          }} />
      )}
    </div>
  );
}

/** One choice of a few, as a row of buttons: the map's panels use it for every either/or. */
function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="map-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

/** A panel over the map: floating by the tools on a computer, a sheet from the bottom on a phone. */
function MapPanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <section className="map-panel" role="dialog" aria-label={title}>
      <header><strong className="grow">{title}</strong><button className="map-panel-close" onClick={onClose} aria-label="Close"><X /></button></header>
      <div className="map-panel-body">{children}</div>
    </section>
  );
}

/** Find a house by its address and go to it. */
function HouseSearch<F extends { geometry: GeoJSON.Point; properties: MapProperty }>({ houses, onPick }: { houses: F[]; onPick: (f: F) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const words = q.trim().toLowerCase();
  const hits = words.length < 2 ? [] : houses.filter((f) => addressOf(f.properties).toLowerCase().includes(words)).slice(0, 6);
  const pick = (f: F) => { onPick(f); setQ(""); setOpen(false); (document.activeElement as HTMLElement | null)?.blur(); };
  return (
    <div className="map-search">
      <Search aria-hidden />
      <input type="search" placeholder="Find a house" aria-label="Find a house" value={q} onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) pick(hits[0]); if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); } }} />
      {open && words.length >= 2 && (
        <ul className="map-search-hits">
          {hits.map((f) => (
            <li key={f.properties.id}>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => pick(f)}>
                <span className="status-dot" style={{ background: STATUS_COLOUR[f.properties.status] }} />{addressOf(f.properties)}</button>
            </li>
          ))}
          {hits.length === 0 && <li className="small muted" style={{ padding: "8px 12px" }}>No house on the map matches.</li>}
        </ul>
      )}
    </div>
  );
}

/** A planning layer's swatch: its colour as a fill and its outline in its line style, as on the map. */
function OverlaySwatch({ pal, code }: { pal: MapPalette; code: string }) {
  const st = overlayStyle(pal, code);
  const border = st.line === "dotted" ? "dotted" : st.line === "solid" ? "solid" : "dashed";
  return <span className="ov-swatch" style={{ borderColor: st.colour, borderStyle: border,
    background: `color-mix(in srgb, ${st.colour} ${Math.round(Math.max(st.fill, 0.12) * 100 * 1.6)}%, transparent)` }} />;
}

/** The palette on our own layers (the houses' colours travel with their data; see the properties source). */
function applyPalette(map: maplibregl.Map, pal: MapPalette) {
  const set = (layer: string, prop: string, value: unknown) => { if (map.getLayer(layer)) map.setPaintProperty(layer, prop as "line-color", value as string); };
  set("commute-fill", "fill-color", pal.reach); set("commute-fill", "fill-opacity", pal.reachFill);
  set("commute-line", "line-color", pal.reach);
  set("station-route-casing", "line-color", pal.routeCasing);
  set("station-route-walk", "line-color", pal.route);
  set("station-route-drive", "line-color", pal.drive);
  set("areas-label", "text-color", pal.ink); set("areas-label", "text-halo-color", pal.halo);
  set("stations-circle", "circle-color", pal.stationFill); set("stations-circle", "circle-stroke-color", pal.station);
  set("stations-label", "text-color", pal.stationText); set("stations-label", "text-halo-color", pal.halo);
  set("places-circle", "circle-color", pal.place); set("places-circle", "circle-stroke-color", pal.placeStroke);
  set("places-label", "text-color", pal.ink); set("places-label", "text-halo-color", pal.halo);
  set("comparables-tie", "line-color", pal.comp);
  set("comparables-circle", "circle-color", pal.compFill); set("comparables-circle", "circle-stroke-color", pal.comp);
  set("comparables-label", "text-color", pal.compText); set("comparables-label", "text-halo-color", pal.halo);
  set("props-selected", "circle-stroke-color", pal.select);
  set("props-circle", "circle-opacity", ["case", ["get", "dim"], pal.dim, 1]);
  set("props-circle", "circle-stroke-opacity", ["case", ["get", "dim"], pal.dim, 1]);
  set("props-circle", "circle-stroke-width", ["case", ["get", "warned"], 3, pal.pinStrokeWidth]);
  set("props-circle", "circle-stroke-color", ["case", ["get", "warned"], pal.warn, ["get", "stroke"]]);
}

/** The key's rows for price: each band's colour and range. */
function priceKey(ramp: string[], breaks: number[], prices: number[]): [string, string][] {
  if (!prices.length) return [];
  const bands = breaks.length + 1;
  if (bands === 1) {
    const lo = Math.min(...prices), hi = Math.max(...prices);
    return [[bandColour(ramp, 0, 1), lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`]];
  }
  return Array.from({ length: bands }, (_, i) => [bandColour(ramp, i, bands),
    i === 0 ? `Under ${money(breaks[0])}` : i === bands - 1 ? `${money(breaks[i - 1])} and over` : `${money(breaks[i - 1])}–${money(breaks[i])}`]);
}

/** Satellite imagery and height (hill shading, contour lines), hidden until chosen. The photo sits just above the
 *  basemap's background (its other shapes are hidden while it shows); height goes under the basemap's labels. */
function addBaseLayers(map: maplibregl.Map, basemapLayers: Set<string>) {
  map.addSource("satellite", { type: "raster", tiles: [SATELLITE], tileSize: 256, maxzoom: 19,
    attribution: "Imagery: Esri, Vantor, Earthstar Geographics" });
  satelliteTiles.then((url) => {
    if (url !== SATELLITE) (map.getSource("satellite") as maplibregl.RasterTileSource | undefined)?.setTiles([url]);
  });
  map.addSource("dem", { type: "raster-dem", encoding: "terrarium", tiles: [dem.sharedDemProtocolUrl], tileSize: 256, maxzoom: 15,
    attribution: TERRAIN_ATTRIBUTION });
  map.addSource("contours", { type: "vector", tiles: [contourTiles.coarse], maxzoom: 15 });
  const style = map.getStyle().layers;
  const labels = style.find((l) => basemapLayers.has(l.id) && l.type === "symbol")?.id;
  const ground = style.find((l) => basemapLayers.has(l.id) && l.type !== "background")?.id;
  const hidden = { visibility: "none" as const };
  // Toned down a little (brightest at 80%, slightly less saturated) so white labels and lines read over it.
  map.addLayer({ id: "satellite", type: "raster", source: "satellite", layout: hidden,
    paint: { "raster-brightness-max": 0.8, "raster-saturation": -0.15 } }, ground);
  map.addLayer({ id: "hillshade", type: "hillshade", source: "dem", layout: hidden,
    paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#3d3222", "hillshade-highlight-color": "#ffffff" } }, labels);
  map.addLayer({ id: "contour-lines", type: "line", source: "contours", "source-layer": "contours", minzoom: 9, layout: hidden,
    paint: { "line-color": "#8a5a2b", "line-opacity": ["match", ["get", "level"], 1, 0.75, 0.4], "line-width": ["match", ["get", "level"], 1, 1.3, 0.6] } }, labels);
  map.addLayer({ id: "contour-labels", type: "symbol", source: "contours", "source-layer": "contours", minzoom: 10,
    filter: [">", ["get", "level"], 0],
    layout: { ...hidden, "symbol-placement": "line", "text-field": ["concat", ["number-format", ["get", "ele"], {}], " m"],
              "text-size": 10, "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#6b4420", "text-halo-color": "#ffffff", "text-halo-width": 1.2 } }, labels);
}

function addLayers(map: maplibregl.Map) {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  // Commute area: everywhere within so many minutes of a chosen place (from the routing engine).
  map.addSource("commute", { type: "geojson", data: empty });
  map.addLayer({ id: "commute-fill", type: "fill", source: "commute", paint: { "fill-color": "#b4532f", "fill-opacity": 0.12 } });
  map.addLayer({ id: "commute-line", type: "line", source: "commute", paint: { "line-color": "#b4532f", "line-width": 2, "line-opacity": 0.7 } });
  // The selected house's walk and drive to its nearest station.
  map.addSource("station-route", { type: "geojson", data: empty });
  // (An edge of the map's own colour under the walk keeps it readable over busy streets and photos.)
  map.addLayer({ id: "station-route-casing", type: "line", source: "station-route", filter: ["==", ["get", "mode"], "walk"],
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.85 } });
  map.addLayer({ id: "station-route-drive", type: "line", source: "station-route", filter: ["==", ["get", "mode"], "drive"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#495057", "line-width": 2.5, "line-opacity": 0.85, "line-dasharray": [2, 2] } });
  map.addLayer({ id: "station-route-walk", type: "line", source: "station-route", filter: ["==", ["get", "mode"], "walk"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#1f5a70", "line-width": 4.5 } });
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
    paint: { "text-color": "#1c2326", "text-halo-color": "#fff", "text-halo-width": 1.3 } });
  // Every train station in the region (the ones picked on the Places screen are drawn again, larger, below).
  map.addSource("stations", { type: "geojson", data: empty });
  map.addLayer({ id: "stations-circle", type: "circle", source: "stations", minzoom: 11,   // from suburb level: city-wide, they're clutter
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
  // The picked house: a ring round its pin, so it's easy to find again after panning away.
  map.addLayer({ id: "props-selected", type: "circle", source: "properties", filter: ["==", ["get", "sel"], true],
    paint: { "circle-radius": 14, "circle-color": "transparent", "circle-stroke-color": "#1f5a70", "circle-stroke-width": 3 } });
  map.addLayer({ id: "props-circle", type: "circle", source: "properties",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 6, 13, 8, 16, 10], "circle-color": ["get", "colour"],
             "circle-opacity": ["case", ["get", "dim"], 0.35, 1],
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
