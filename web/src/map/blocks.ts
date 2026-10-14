// The map's Blocks mode: every block in the analysed suburbs as an outline coloured by what you choose (whether it fits
// your block preferences, its size, slope, which way it falls, whether it could be split, which way the back faces),
// or the areas view: hexagons shaded by the share of blocks that fit. The preferences are applied here, in the
// layers' paint, so trying different ones on the map is instant; the server's /api/blocks/geojson sends short property
// names to keep a suburb's few thousand blocks small (see api/app/routes/blocks.py).
import type * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";
import { splitLots, type BlockPrefs } from "../blocks";

/** A block as the map has it: a area m², i incline %, d direction, fa fall m, fw frontage m, dp depth, rg regularity,
 *  bx battle-axe, u unit lot, rb back's bearing, z zone, t a tracked house on it; and, added here, sp lots it could split
 *  into, rf the back's aspect (N, EW or S) and sub its suburb. */
export type BlockProps = { pfi: string; a?: number; i?: number; d?: string; fa?: number; fw?: number; dp?: number; rg?: number; bx?: 1; u?: 1;
                           rb?: number; z?: string; t?: string; sp?: number; rf?: "N" | "EW" | "S"; sub?: string };
export type BlockColour = "fit" | "size" | "slope" | "falls" | "split" | "rear";
export const BLOCK_COLOURS: [BlockColour, string][] = [["fit", "Fits your preferences"], ["size", "Size"], ["slope", "Slope"],
  ["falls", "Which way it falls"], ["split", "Could be split"], ["rear", "Which way the back faces"]];

export const BLOCK_LAYERS = ["blocks-fill", "blocks-line", "blocks-tracked", "blocks-selected", "block-hex-fill", "block-hex-line", "block-hex-label"];
const BLOCK_ONLY = ["blocks-fill", "blocks-line", "blocks-tracked", "blocks-selected"];
const HEX_ONLY = ["block-hex-fill", "block-hex-line", "block-hex-label"];

// Colours chosen to read on the light and dark street maps and on the photo; categories differ in lightness as well as
// hue, so they can be told apart without full colour vision.
const C = {
  fit: "#12b886", miss: "#868e96", unknown: "#f59f00", small: "#4dabf7", steep: "#cc5de8",
  size: ["#d3f9d8", "#8ce99a", "#40c057", "#2b8a3e", "#1864ab", "#5f3dc4"],
  slope: { flat: "#37b24d", gentle: "#a9e34b", moderate: "#f59f00", steep: "#e03131" },
  falls: { level: "#adb5bd", down: "#1c7ed6", up: "#e8590c", across: "#ae3ec9" },
  split: { two: "#fab005", more: "#e8590c" },
  rear: { N: "#2f9e44", EW: "#fab005", S: "#4c6ef5" },
};
export const SIZE_STEPS = [400, 600, 800, 1000, 1500];

/** The key for a colouring: [colour, words] each. */
export function blockKey(colour: BlockColour, prefs: BlockPrefs): [string, string][] {
  switch (colour) {
    case "fit": return [[C.fit, "Fits"], [C.small, `Right slope, under ${prefs.min_m2.toLocaleString()} m²`],
      [C.steep, `Right size, steeper than ${prefs.max_incline}% or falls the wrong way`],
      [C.unknown, "Right size, slope unknown"], [C.miss, "Doesn't fit"]];
    case "size": return C.size.map((c, i) => [c, i === 0 ? `Under ${SIZE_STEPS[0]} m²` : i === C.size.length - 1
      ? `${SIZE_STEPS[i - 1].toLocaleString()} m² and over` : `${SIZE_STEPS[i - 1]}–${SIZE_STEPS[i].toLocaleString()} m²`]);
    case "slope": return [[C.slope.flat, "Flat, under 3%"], [C.slope.gentle, "Gentle, 3–8%"], [C.slope.moderate, "Moderate, 8–15%"],
      [C.slope.steep, "Steep, 15% and over"], [C.miss, "Unknown"]];
    case "falls": return [[C.falls.level, "Level"], [C.falls.down, "Slopes down from the street"], [C.falls.up, "Slopes up from the street"],
      [C.falls.across, "Slopes across"]];
    case "split": return [[C.split.two, "Two lots"], [C.split.more, "Three or more"], [C.miss, `Can't, under your rules (${
      Object.entries(prefs.split).filter(([, v]) => v).map(([k, v]) => `${k} ${v} m²`).join(", ")}, ${prefs.split_frontage} m frontage)`]];
    case "rear": return [[C.rear.N, "North (north-west to north-east)"], [C.rear.EW, "East or west"], [C.rear.S, "South"]];
  }
}

/** Whether a block fits: 1 yes, 0 no, -1 the right size but its slope isn't known. As the server's blocks.fits(). */
export function fitOf(b: BlockProps, p: BlockPrefs): 1 | 0 | -1 {
  if (b.u && !p.include_units) return 0;
  if (b.a == null || b.a < p.min_m2 || b.a > p.max_m2) return 0;
  if (b.i == null) return -1;
  return b.i <= p.max_incline && p.directions.includes(b.d as never) ? 1 : 0;
}

const aspect = (bearing: number | undefined): BlockProps["rf"] => {
  if (bearing == null) return undefined;
  const b = ((bearing % 360) + 360) % 360;
  return b >= 292.5 || b <= 67.5 ? "N" : b >= 112.5 && b <= 247.5 ? "S" : "EW";
};

/** A suburb's blocks ready for the map: what the split rules and aspect make of each. */
export function prepare(fc: GeoJSON.FeatureCollection, suburb: string, prefs: BlockPrefs): GeoJSON.Feature[] {
  return fc.features.map((f) => {
    const p = f.properties as BlockProps;
    const sp = splitLots({ area_m2: p.a, frontage_m: p.fw, battleaxe: !!p.bx, is_unit: !!p.u, zone_code: p.z }, prefs);
    return { ...f, properties: { ...p, sp, rf: aspect(p.rb), sub: suburb } };
  });
}

/** 1 fits, 2 the slope suits but it's too small, 3 the right size but the slope doesn't suit (too steep, or falls a way
 *  you don't want), -1 the right size but its slope isn't known, 0 doesn't fit. */
function fitExpression(p: BlockPrefs): ExpressionSpecification {
  const small = ["<", ["coalesce", ["get", "a"], 0], p.min_m2];
  return ["case",
    ...(p.include_units ? [] : [["==", ["coalesce", ["get", "u"], 0], 1], 0]),
    [">", ["coalesce", ["get", "a"], 0], p.max_m2], 0,
    ["!", ["has", "i"]], ["case", small, 0, -1],
    ["all", ["<=", ["get", "i"], p.max_incline], ["in", ["coalesce", ["get", "d"], ""], ["literal", p.directions]]], ["case", small, 2, 1],
    ["case", small, 0, 3]] as unknown as ExpressionSpecification;
}

/** Each colouring's fill colour and how strongly it's filled (the blocks that matter stand out; the rest stay faint). */
function paintFor(colour: BlockColour, p: BlockPrefs, photo: boolean): { color: ExpressionSpecification | string; opacity: ExpressionSpecification | number } {
  const strong = photo ? 0.6 : 0.5, faint = photo ? 0.12 : 0.06;
  switch (colour) {
    case "fit": {
      const fit = fitExpression(p);
      return { color: ["match", fit, 1, C.fit, 2, C.small, 3, C.steep, -1, C.unknown, C.miss] as ExpressionSpecification,
               opacity: ["match", fit, 1, strong, 2, strong * 0.7, 3, strong * 0.7, -1, strong * 0.7, faint] as ExpressionSpecification };
    }
    case "size": return {
      color: ["step", ["coalesce", ["get", "a"], 0], C.size[0], ...SIZE_STEPS.flatMap((s, i) => [s, C.size[i + 1]])] as ExpressionSpecification,
      opacity: ["case", ["==", ["coalesce", ["get", "u"], 0], 1], faint, strong] as ExpressionSpecification };
    case "slope": return {
      color: ["case", ["!", ["has", "i"]], C.miss, ["step", ["get", "i"], C.slope.flat, 3, C.slope.gentle, 8, C.slope.moderate, 15, C.slope.steep]] as ExpressionSpecification,
      opacity: ["case", ["!", ["has", "i"]], faint, strong] as ExpressionSpecification };
    case "falls": return {
      color: ["match", ["coalesce", ["get", "d"], ""], "level", C.falls.level, "down", C.falls.down, "up", C.falls.up, "across", C.falls.across, C.miss] as ExpressionSpecification,
      opacity: ["case", ["!", ["has", "d"]], faint, strong] as ExpressionSpecification };
    case "split": return {
      color: ["step", ["coalesce", ["get", "sp"], 0], C.miss, 2, C.split.two, 3, C.split.more] as ExpressionSpecification,
      opacity: ["step", ["coalesce", ["get", "sp"], 0], faint, 2, strong] as ExpressionSpecification };
    case "rear": return {
      color: ["match", ["coalesce", ["get", "rf"], ""], "N", C.rear.N, "EW", C.rear.EW, "S", C.rear.S, C.miss] as ExpressionSpecification,
      opacity: ["case", ["==", ["coalesce", ["get", "u"], 0], 1], faint, strong] as ExpressionSpecification };
  }
}

/** The layers, hidden until Blocks mode is on: under the basemap's labels (and over contours), like the height layers. */
export function addBlockLayers(map: maplibregl.Map, before: string | undefined) {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  const hidden = { visibility: "none" as const };
  map.addSource("blocks", { type: "geojson", data: empty, promoteId: "pfi" });
  map.addSource("block-hexes", { type: "geojson", data: empty });
  map.addLayer({ id: "blocks-fill", type: "fill", source: "blocks", minzoom: 12, layout: hidden,
    paint: { "fill-color": C.miss, "fill-opacity": 0.1 } }, before);
  map.addLayer({ id: "blocks-line", type: "line", source: "blocks", minzoom: 14, layout: hidden,
    paint: { "line-color": "#495057", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.3, 18, 1], "line-opacity": 0.5 } }, before);
  // Blocks with one of our houses on them: a firmer edge, so tracked and untracked read apart.
  map.addLayer({ id: "blocks-tracked", type: "line", source: "blocks", minzoom: 13, filter: ["has", "t"], layout: hidden,
    paint: { "line-color": "#1f5a70", "line-width": 2 } }, before);
  map.addLayer({ id: "blocks-selected", type: "line", source: "blocks", filter: ["==", ["get", "pfi"], ""], layout: hidden,
    paint: { "line-color": "#1f5a70", "line-width": 3.5 } }, before);
  map.addLayer({ id: "block-hex-fill", type: "fill", source: "block-hexes", layout: hidden,
    paint: { "fill-color": ["interpolate", ["linear"], ["get", "share"], 0, "#f1f3f5", 0.1, "#c3fae8", 0.25, "#63e6be", 0.5, "#12b886", 0.75, "#087f5b"],
             "fill-opacity": ["interpolate", ["linear"], ["get", "share"], 0, 0.15, 0.5, 0.6, 1, 0.75] } }, before);
  map.addLayer({ id: "block-hex-line", type: "line", source: "block-hexes", layout: hidden,
    paint: { "line-color": "#ffffff", "line-width": 0.6, "line-opacity": 0.7 } }, before);
  map.addLayer({ id: "block-hex-label", type: "symbol", source: "block-hexes", minzoom: 13, filter: [">", ["get", "fit"], 0],
    layout: { ...hidden, "text-field": ["concat", ["to-string", ["round", ["*", ["get", "share"], 100]]], "%\n", ["to-string", ["get", "fit"]], " fit"],
              "text-size": 11, "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#1c2326", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.3 } }, before);
}

/** Show the mode chosen (or none), coloured for the preferences being tried. */
export function syncBlockLayers(map: maplibregl.Map, opts: { view: "off" | "blocks" | "areas"; colour: BlockColour; prefs: BlockPrefs;
                                                              photo: boolean; dark: boolean; selected: string | null }) {
  if (!map.getLayer("blocks-fill")) return;
  const show = (ids: string[], on: boolean) => ids.forEach((id) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
  show(BLOCK_ONLY, opts.view === "blocks");
  show(HEX_ONLY, opts.view === "areas");
  const { color, opacity } = paintFor(opts.colour, opts.prefs, opts.photo);
  map.setPaintProperty("blocks-fill", "fill-color", color);
  map.setPaintProperty("blocks-fill", "fill-opacity", opacity);
  map.setPaintProperty("blocks-line", "line-color", opts.photo ? "#ffffff" : opts.dark ? "#ced4da" : "#495057");
  const accent = opts.photo || opts.dark ? "#86c1d3" : "#1f5a70";
  map.setPaintProperty("blocks-tracked", "line-color", accent);
  map.setPaintProperty("blocks-selected", "line-color", opts.photo ? "#ffffff" : accent);
  map.setFilter("blocks-selected", ["==", ["get", "pfi"], opts.selected ?? ""]);
  const ink = opts.photo || opts.dark;
  map.setPaintProperty("block-hex-label", "text-color", ink ? "#ffffff" : "#1c2326");
  map.setPaintProperty("block-hex-label", "text-halo-color", ink ? "rgba(0,0,0,0.8)" : "rgba(255,255,255,0.9)");
  map.setPaintProperty("block-hex-line", "line-color", ink ? "#000000" : "#ffffff");
}

export function setBlockData(map: maplibregl.Map, blocks: GeoJSON.Feature[], hexes: GeoJSON.FeatureCollection | undefined) {
  (map.getSource("blocks") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: blocks });
  if (hexes) (map.getSource("block-hexes") as GeoJSONSource | undefined)?.setData(hexes);
}

/** The corners of some blocks, to zoom the map to them. */
export function boundsOf(features: GeoJSON.Feature[]): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      const [x, y] = c as number[];
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  for (const f of features) walk((f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon).coordinates);
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}
