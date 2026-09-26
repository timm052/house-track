// The map's colours, one set per look: streets in light or dark, and the satellite photo. The basemap stays quiet so
// what's ours stands out, in a fixed order of attention: houses (a magenta price ramp, or their status), then the
// selected house's ring and its walk to the station (both in the accent teal: they belong together), then everything
// around them. Each colour means one thing: stations are neutral white-and-ink dots as on a train map, violet is the
// travel-time area, burnt orange the comparable sales, blue is left for flood.
// Our labels wear ink with a halo of the background, never the colour of what they label.
import type { Status } from "../api";

export type Look = "light" | "dark" | "photo";

/** A planning layer's look: colour, and a line style so each can be told apart without relying on colour alone. */
export type OverlayStyle = { colour: string; line: "solid" | "dashed" | "dotted" | "long"; width: number; fill: number };

export type MapPalette = {
  ink: string; halo: string;                       // our labels
  select: string; route: string;                   // the selected house's ring, and its walk to the station
  station: string; stationFill: string; stationText: string;   // train stations
  routeCasing: string; drive: string;              // the walk's edging; the drive to the station (dashed)
  reach: string; reachFill: number;                // travel-time area
  comp: string; compFill: string; compText: string;   // comparable sales: hollow, burnt orange
  place: string; placeStroke: string;              // your places (work, family, school)
  priceRamp: string[]; noPrice: string;            // cheaper to dearer: always toward more contrast with the map
  pinStroke: string; pinStrokeWidth: number; warn: string; dim: number;
  status: Record<Status, string>;
  overlays: Record<string, OverlayStyle>;
};

// Planning layers: related ones share a colour and differ by line (checked for colour-blind separation between the
// colours themselves; the lines separate the pairs). Red bushfire, blue flood, gold heritage, green vegetation, and
// the zones in quiet neutrals so they sit behind the rest.
const overlays = (c: { red: string; blue: string; gold: string; green: string; grey: string; ink: string }): Record<string, OverlayStyle> => ({
  vic_bushfire_bmo: { colour: c.red, line: "solid", width: 1.6, fill: 0.14 },
  vic_bushfire_prone: { colour: c.red, line: "dashed", width: 1.4, fill: 0.07 },
  vic_flood: { colour: c.blue, line: "solid", width: 1.6, fill: 0.16 },
  vic_heritage: { colour: c.gold, line: "dotted", width: 2, fill: 0.1 },
  vic_vegetation: { colour: c.green, line: "long", width: 1.6, fill: 0.1 },
  vic_residential_zones: { colour: c.grey, line: "solid", width: 1, fill: 0.04 },
  vic_school_primary: { colour: c.ink, line: "solid", width: 2, fill: 0.04 },
  vic_school_secondary: { colour: c.ink, line: "dashed", width: 2, fill: 0.04 },
});

const LIGHT: MapPalette = {
  ink: "#1c2326", halo: "rgba(255, 255, 255, 0.92)",
  select: "#1f5a70", route: "#1f5a70",
  station: "#343a40", stationFill: "#ffffff", stationText: "#343a40",
  routeCasing: "#ffffff", drive: "#495057",
  reach: "#6741d9", reachFill: 0.12,
  comp: "#c2410c", compFill: "#ffffff", compText: "#9a3412",
  place: "#1c2326", placeStroke: "#ffffff",
  // OKLCH hue 340, lightness 0.84 to 0.39 in even steps: the palest has a dark outline to stand off the pale map
  priceRamp: ["#efb7db", "#da83be", "#c253a3", "#9e3081", "#721b5c"], noPrice: "#adb5bd",
  pinStroke: "#4a1140", pinStrokeWidth: 1.5, warn: "#e67700", dim: 0.35,
  status: { watching: "#64748b", interested: "#0284c7", shortlisted: "#16a34a", offering: "#9333ea",
            bought: "#ca8a04", missed_out: "#78716c", ruled_out: "#9ca3af" },
  overlays: overlays({ red: "#e03131", blue: "#1c7ed6", gold: "#b07d00", green: "#2b8a3e", grey: "#868e96", ink: "#343a40" }),
};

const DARK: MapPalette = {
  ink: "#e9ecef", halo: "rgba(12, 12, 12, 0.92)",
  select: "#86c1d3", route: "#86c1d3",
  station: "#ced4da", stationFill: "#101416", stationText: "#dee2e6",
  routeCasing: "#0c0c0c", drive: "#ced4da",
  reach: "#9775fa", reachFill: 0.18,
  comp: "#ff8c5a", compFill: "#101416", compText: "#ffa94d",
  place: "#f1f3f5", placeStroke: "#0c0c0c",
  // The same hue, the other way up: on a dark map the dearest are the brightest (lightness 0.47 to 0.91)
  priceRamp: ["#8b3473", "#b84999", "#da6fba", "#eea2d4", "#fcd4ed"], noPrice: "#6c757d",
  pinStroke: "#0c0c0c", pinStrokeWidth: 1.5, warn: "#ffa94d", dim: 0.4,
  status: { watching: "#94a3b8", interested: "#38bdf8", shortlisted: "#4ade80", offering: "#c084fc",
            bought: "#facc15", missed_out: "#a8a29e", ruled_out: "#6b7280" },
  overlays: overlays({ red: "#ff6b6b", blue: "#4dabf7", gold: "#f0b429", green: "#51cf66", grey: "#adb5bd", ink: "#e9ecef" }),
};

// A photo is busy and mid-dark: the dark set's bright colours, with white edges and dark halos so they hold up.
const PHOTO: MapPalette = {
  ...DARK,
  ink: "#ffffff", halo: "rgba(0, 0, 0, 0.75)",
  station: "#1c2326", stationFill: "#ffffff", stationText: "#ffffff", routeCasing: "rgba(0, 0, 0, 0.6)", drive: "#ffffff",
  reachFill: 0.22, compFill: "#ffffff", compText: "#ffffff",
  place: "#ffffff", placeStroke: "#1c2326",
  noPrice: "#ced4da", pinStroke: "#ffffff", pinStrokeWidth: 2, dim: 0.5,
  overlays: overlays({ red: "#ff6b6b", blue: "#74c0fc", gold: "#ffd43b", green: "#69db7c", grey: "#dee2e6", ink: "#ffffff" }),
};

export const PALETTES: Record<Look, MapPalette> = { light: LIGHT, dark: DARK, photo: PHOTO };

/** A planning layer's style (a neutral one for any layer not listed). */
export const overlayStyle = (pal: MapPalette, code: string): OverlayStyle =>
  pal.overlays[code] ?? { colour: pal.ink, line: "solid", width: 1.2, fill: 0.06 };

/** Line dashes: MapLibre's, in line widths; a map server's, in pixels. */
export const DASH: Record<OverlayStyle["line"], { lines: number[] | null; px: string | null }> = {
  solid: { lines: null, px: null },
  dashed: { lines: [3, 2], px: "6 4" },
  dotted: { lines: [0.6, 1.6], px: "2 4" },
  long: { lines: [6, 2.5], px: "12 5" },
};
