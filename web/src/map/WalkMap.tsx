// The walk to the station on a street map: the chosen way coloured by its climbs and drops (going to the station),
// the other ways as dashed lines, and a dot that follows the pointer on the height profile (and the other way round).
// Loaded lazily with MapLibre.
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { useDarkMode } from "../colour";
import { basemapStyle } from "./basemap";
import { gradeColour } from "../walks";

export type MapWay = { points: number[][]; heights: number[] };

const CHUNK = 5;   // colour by 50 m stretches (heights are every 10 m)

function segments(way: MapWay): GeoJSON.FeatureCollection {
  const { points: p, heights: h } = way;
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < p.length - 1; i += CHUNK) {
    const j = Math.min(i + CHUNK, p.length - 1);
    const pct = ((h[j] - h[i]) / ((j - i) * 10)) * 100;
    features.push({ type: "Feature", properties: { c: gradeColour(pct) }, geometry: { type: "LineString", coordinates: p.slice(i, j + 1) } });
  }
  return { type: "FeatureCollection", features };
}

export default function WalkMap({ ways, chosen, hover, onHover }: {
  ways: MapWay[]; chosen: number; hover: number | null; onHover: (i: number | null) => void;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const dot = useRef<maplibregl.Marker | null>(null);
  const hoverCb = useRef(onHover);
  hoverCb.current = onHover;
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const dark = useDarkMode();
  const key = JSON.stringify(ways.map((w) => [w.points.length, w.points[0], w.points[w.points.length - 1]]));

  useEffect(() => {
    if (!ways.length) return;
    let map: maplibregl.Map | undefined;
    let cancelled = false;
    basemapStyle(dark).then(({ style }) => {
      if (cancelled || !el.current) return;
      const first = ways[0].points;
      map = new maplibregl.Map({ container: el.current, style, center: first[0] as [number, number], zoom: 14,
                                 attributionControl: { compact: true }, cooperativeGestures: true });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        const others: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: ways.map((w, i) => ({
          type: "Feature", properties: { i }, geometry: { type: "LineString", coordinates: w.points } })) };
        map!.addSource("walk-others", { type: "geojson", data: others });
        map!.addLayer({ id: "walk-others", type: "line", source: "walk-others", layout: { "line-cap": "round" },
          paint: { "line-color": dark ? "#c8ced1" : "#5f676b", "line-width": 3, "line-dasharray": [1.5, 1.5], "line-opacity": 0.75 } });
        map!.addSource("walk-chosen", { type: "geojson", data: segments(ways[chosen] ?? ways[0]) });
        map!.addLayer({ id: "walk-casing", type: "line", source: "walk-chosen", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": 9 } });
        map!.addLayer({ id: "walk-chosen", type: "line", source: "walk-chosen", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "c"], "line-width": 6 } });
        map!.setFilter("walk-others", ["!=", ["get", "i"], chosen]);
        // The pointer on the chosen way: the nearest height point, for the profile's marker.
        map!.on("mousemove", "walk-chosen", (e) => {
          const way = ways[chosenRef.current] ?? ways[0];
          let best = 0, bestD = Infinity;
          way.points.forEach((pt, i) => {
            const d = (pt[0] - e.lngLat.lng) ** 2 + (pt[1] - e.lngLat.lat) ** 2;
            if (d < bestD) { bestD = d; best = i; }
          });
          hoverCb.current(best);
        });
        map!.on("mouseleave", "walk-chosen", () => hoverCb.current(null));
      });
      const start = document.createElement("div");
      start.className = "walk-pin";
      start.textContent = "H";
      start.title = "The house";
      new maplibregl.Marker({ element: start }).setLngLat(first[0] as [number, number]).addTo(map);
      const end = document.createElement("div");
      end.className = "walk-pin station";
      end.textContent = "S";
      end.title = "The station";
      new maplibregl.Marker({ element: end }).setLngLat(first[first.length - 1] as [number, number]).addTo(map);
      const pointer = document.createElement("div");
      pointer.className = "walk-dot";
      dot.current = new maplibregl.Marker({ element: pointer });
      const bounds = new maplibregl.LngLatBounds();
      ways.forEach((w) => w.points.forEach((pt) => bounds.extend(pt as [number, number])));
      map.fitBounds(bounds, { padding: 36, maxZoom: 16, duration: 0 });
    });
    return () => { cancelled = true; dot.current?.remove(); map?.remove(); mapRef.current = null; };
  }, [key, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  // The chosen way, recoloured in place.
  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource("walk-chosen") as maplibregl.GeoJSONSource | undefined;
    if (!map || !source) return;
    source.setData(segments(ways[chosen] ?? ways[0]));
    map.setFilter("walk-others", ["!=", ["get", "i"], chosen]);
  }, [chosen, key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current, marker = dot.current;
    if (!map || !marker) return;
    const pt = hover != null ? (ways[chosen] ?? ways[0]).points[hover] : null;
    if (pt) marker.setLngLat(pt as [number, number]).addTo(map);
    else marker.remove();
  }, [hover, chosen, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="walk-map" role="img" aria-label="Map of the walk to the station, coloured by its climbs and drops" />;
}
