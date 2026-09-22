// Context layers on the map (milestone 5): school zones and planning overlays, fetched for the visible
// area only and redrawn as the map moves.
import type * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { api } from "../api";

export type OverlayLayer = { code: string; title: string; effect: "info" | "soft_warn" | "hard_exclude"; pieces: number;
                             tiles: string | null };

const COLOURS = ["#7c3aed", "#0891b2", "#2563eb", "#db2777", "#65a30d", "#ea580c", "#0d9488", "#9333ea"];
export const colourFor = (code: string, all: OverlayLayer[]) =>
  code.includes("flood") ? "#2563eb" : code.includes("bushfire") ? "#dc2626" : COLOURS[all.findIndex((l) => l.code === code) % COLOURS.length];

// Local vector layers (school zones) load per viewport, so they only draw from this zoom in; zoomed further
// out, stale zones from the last viewport would look like the data stops there.
const MIN_ZOOM = 12;

export function syncOverlays(map: maplibregl.Map, enabled: string[], all: OverlayLayer[]): () => void {
  const ids = (code: string) => ({ src: `ov-${code}`, fill: `ov-${code}-fill`, line: `ov-${code}-line`, label: `ov-${code}-label` });
  // Remove layers that were switched off.
  for (const l of all) {
    if (enabled.includes(l.code)) continue;
    const i = ids(l.code);
    for (const id of [i.label, i.line, i.fill]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(i.src)) map.removeSource(i.src);
  }
  const before = map.getLayer("areas-fill") ? "areas-fill" : undefined;
  for (const code of enabled) {
    const i = ids(code), colour = colourFor(code, all);
    if (map.getSource(i.src)) continue;
    const layer = all.find((l) => l.code === code);
    if (layer?.tiles) {
      // Streamed straight from the state's map service as image tiles, for whatever area is on screen.
      map.addSource(i.src, { type: "raster", tiles: [layer.tiles], tileSize: 256, minzoom: 10,
                             attribution: "Vicmap Planning © State of Victoria" });
      map.addLayer({ id: i.fill, type: "raster", source: i.src, paint: { "raster-opacity": 0.6 } }, before);
      continue;
    }
    map.addSource(i.src, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: i.fill, type: "fill", source: i.src, minzoom: MIN_ZOOM, paint: { "fill-color": colour, "fill-opacity": 0.12 } }, before);
    map.addLayer({ id: i.line, type: "line", source: i.src, minzoom: MIN_ZOOM, paint: { "line-color": colour, "line-width": 1.2 } }, before);
    map.addLayer({ id: i.label, type: "symbol", source: i.src, minzoom: 14,
      layout: { "text-field": ["get", "label"], "text-size": 10, "text-font": ["Noto Sans Regular"] },
      paint: { "text-color": colour, "text-halo-color": "#fff", "text-halo-width": 1 } }, before);
  }

  let timer: number | undefined;
  const refresh = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (map.getZoom() < MIN_ZOOM) return;
      const b = map.getBounds();
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(",");
      for (const code of enabled.filter((c) => !all.find((l) => l.code === c)?.tiles)) {
        try {
          const fc = await api<GeoJSON.FeatureCollection>(`/api/overlays/${code}/features?bbox=${bbox}&zoom=${map.getZoom().toFixed(1)}`);
          (map.getSource(ids(code).src) as GeoJSONSource | undefined)?.setData(fc);
        } catch { /* offline: keep what's drawn */ }
      }
    }, 250);
  };
  map.on("moveend", refresh);
  refresh();
  return () => { map.off("moveend", refresh); window.clearTimeout(timer); };
}
