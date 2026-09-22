// A small map of one house: the house page banner (fixed) and its Location tab (pan and zoom).
// Loaded lazily so MapLibre only downloads when a page needs it.
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { useDarkMode } from "../colour";
import { basemapStyle } from "./basemap";

export default function MiniMap({ lon, lat, interactive = false, zoom = 15.5, className = "mini-map" }: {
  lon: number; lat: number; interactive?: boolean; zoom?: number; className?: string;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const dark = useDarkMode();
  useEffect(() => {
    let map: maplibregl.Map | undefined;
    let cancelled = false;
    basemapStyle(dark).then(({ style }) => {
      if (cancelled || !el.current) return;
      map = new maplibregl.Map({ container: el.current, style, center: [lon, lat], zoom, interactive, attributionControl: { compact: true },
                                 cooperativeGestures: interactive });
      if (interactive) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      new maplibregl.Marker({ color: "#e11d48" }).setLngLat([lon, lat]).addTo(map);
    });
    return () => { cancelled = true; map?.remove(); };
  }, [lon, lat, dark, interactive, zoom]);
  return <div ref={el} className={className} aria-label="Map of the house's location" role="img" />;
}
