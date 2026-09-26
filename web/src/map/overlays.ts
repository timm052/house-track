// Context layers on the map (milestone 5): school zones and planning overlays, fetched for the visible
// area only and redrawn as the map moves.
import type * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { api } from "../api";
import { DASH, overlayStyle, type MapPalette, type OverlayStyle } from "./palette";

export type OverlayLayer = { code: string; title: string; effect: "info" | "soft_warn" | "hard_exclude"; pieces: number;
                             tiles: string | null };

/** The state's map server draws its layers in its own colours (heritage in the house pins' pink, say). Sending a style
 *  with each request (an SLD) draws them in ours instead: the palette's colour, fill and line style. */
function styled(url: string, s: OverlayStyle): string {
  const layer = new URL(url).searchParams.get("layers") ?? "";
  const dash = DASH[s.line].px;
  const sld = '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">'
    + `<NamedLayer><Name>${layer}</Name><UserStyle><FeatureTypeStyle><Rule><PolygonSymbolizer>`
    + `<Fill><CssParameter name="fill">${s.colour}</CssParameter><CssParameter name="fill-opacity">${s.fill}</CssParameter></Fill>`
    + `<Stroke><CssParameter name="stroke">${s.colour}</CssParameter><CssParameter name="stroke-width">${s.width}</CssParameter>`
    + (dash ? `<CssParameter name="stroke-dasharray">${dash}</CssParameter>` : "")
    + "</Stroke></PolygonSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>";
  return `${url}&SLD_BODY=${encodeURIComponent(sld)}`;
}

// The style each layer was last drawn with, so a change of look (light, dark, satellite) redraws it.
const drawnWith = new Map<string, string>();

// Local vector layers (school zones) load per viewport, so they only draw from this zoom in; zoomed further
// out, stale zones from the last viewport would look like the data stops there.
const MIN_ZOOM = 12;

export function syncOverlays(map: maplibregl.Map, enabled: string[], all: OverlayLayer[], pal: MapPalette): () => void {
  const ids = (code: string) => ({ src: `ov-${code}`, fill: `ov-${code}-fill`, line: `ov-${code}-line`, label: `ov-${code}-label` });
  // Remove layers that were switched off, or drawn in another look.
  for (const l of all) {
    const key = JSON.stringify(overlayStyle(pal, l.code));
    if (enabled.includes(l.code) && drawnWith.get(l.code) === key) continue;
    drawnWith.delete(l.code);
    const i = ids(l.code);
    for (const id of [i.label, i.line, i.fill]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(i.src)) map.removeSource(i.src);
  }
  const before = map.getLayer("areas-fill") ? "areas-fill" : undefined;
  for (const code of enabled) {
    const i = ids(code), style = overlayStyle(pal, code);
    if (map.getSource(i.src)) continue;
    drawnWith.set(code, JSON.stringify(style));
    const layer = all.find((l) => l.code === code);
    if (layer?.tiles) {
      // Streamed straight from the state's map service as image tiles, for whatever area is on screen, in our style.
      map.addSource(i.src, { type: "raster", tiles: [styled(layer.tiles, style)], tileSize: 256, minzoom: 10,
                             attribution: "Vicmap Planning © State of Victoria" });
      map.addLayer({ id: i.fill, type: "raster", source: i.src }, before);
      continue;
    }
    const dash = DASH[style.line].lines;
    map.addSource(i.src, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: i.fill, type: "fill", source: i.src, minzoom: MIN_ZOOM, paint: { "fill-color": style.colour, "fill-opacity": style.fill } }, before);
    map.addLayer({ id: i.line, type: "line", source: i.src, minzoom: MIN_ZOOM,
      paint: { "line-color": style.colour, "line-width": style.width, ...(dash ? { "line-dasharray": dash } : {}) } }, before);
    map.addLayer({ id: i.label, type: "symbol", source: i.src, minzoom: 14,
      layout: { "text-field": ["get", "label"], "text-size": 10.5, "text-font": ["Noto Sans Regular"] },
      paint: { "text-color": pal.ink, "text-halo-color": pal.halo, "text-halo-width": 1.3 } }, before);
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
