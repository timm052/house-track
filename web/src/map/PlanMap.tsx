// The inspection plan's stops, numbered in visiting order and joined up (straight lines: the times come from
// the routing engine, the map just shows the order). Loaded lazily with MapLibre.
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { useDarkMode } from "../colour";
import { basemapStyle } from "./basemap";

export type PlanStop = { lon: number; lat: number; label: string; clash?: boolean; start?: boolean };

export default function PlanMap({ stops }: { stops: PlanStop[] }) {
  const el = useRef<HTMLDivElement | null>(null);
  const dark = useDarkMode();
  const key = JSON.stringify(stops);
  useEffect(() => {
    if (!stops.length) return;
    let map: maplibregl.Map | undefined;
    let cancelled = false;
    basemapStyle(dark).then(({ style }) => {
      if (cancelled || !el.current) return;
      map = new maplibregl.Map({ container: el.current, style, center: [stops[0].lon, stops[0].lat], zoom: 12,
                                 attributionControl: { compact: true }, cooperativeGestures: true });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        map!.addSource("plan-line", { type: "geojson", data: { type: "Feature", properties: {},
          geometry: { type: "LineString", coordinates: stops.map((s) => [s.lon, s.lat]) } } });
        map!.addLayer({ id: "plan-line", type: "line", source: "plan-line",
          paint: { "line-color": "#1f5a70", "line-width": 3, "line-dasharray": [2, 1.5], "line-opacity": 0.8 } });
      });
      let n = 0;
      for (const s of stops) {
        const pin = document.createElement("div");
        pin.className = `plan-pin ${s.clash ? "clash" : ""} ${s.start ? "start" : ""}`;
        pin.textContent = s.start ? "●" : String(++n);
        pin.title = s.label;
        new maplibregl.Marker({ element: pin }).setLngLat([s.lon, s.lat]).addTo(map);
      }
      const bounds = new maplibregl.LngLatBounds();
      stops.forEach((s) => bounds.extend([s.lon, s.lat]));
      map.fitBounds(bounds, { padding: 50, maxZoom: 15, duration: 0 });
    });
    return () => { cancelled = true; map?.remove(); };
  }, [key, dark]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el} className="plan-map" role="img" aria-label="Map of the inspection plan" />;
}
