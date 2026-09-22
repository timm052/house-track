import { layers, namedFlavor } from "@protomaps/basemaps";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";

// MapLibre 6 runs its tile parsing in a module worker that the bundler has to emit separately.
maplibregl.setWorkerUrl(workerUrl);

// The setup job writes these under DATA_DIR/tiles, which the web container serves at /tiles.
const LOCAL_TILES = "/tiles/basemap.pmtiles";
const LOCAL_ASSETS = "/tiles/assets";
const HOSTED_ASSETS = "https://protomaps.github.io/basemaps-assets";

let registered = false;

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

export type Basemap = { style: StyleSpecification; hasTiles: boolean };

/** Protomaps light or dark style over the local PMTiles extract (PLAN.md decision 5). Fonts and sprites
 *  come from the local copy when setup installed it, otherwise from Protomaps' hosted copy (online only).
 *  Without tiles the map still works on a plain background, so pins and areas remain usable. */
export async function basemapStyle(dark: boolean): Promise<Basemap> {
  if (!registered) {
    maplibregl.addProtocol("pmtiles", new Protocol().tile);
    registered = true;
  }
  const [hasTiles, hasAssets] = await Promise.all([
    exists(LOCAL_TILES),
    exists(`${LOCAL_ASSETS}/sprites/v4/light.json`),
  ]);
  const flavor = dark ? "dark" : "light";
  const assets = hasAssets ? `${location.origin}${LOCAL_ASSETS}` : HOSTED_ASSETS;
  // Only the light sprite is installed locally; the dark style reuses it.
  const spriteFlavor = hasAssets ? "light" : flavor;

  const background = dark ? "#1b1d23" : "#eef0f2";
  if (!hasTiles) {
    return {
      hasTiles,
      style: { version: 8, glyphs: `${assets}/fonts/{fontstack}/{range}.pbf`, sources: {},
               layers: [{ id: "background", type: "background", paint: { "background-color": background } }] },
    };
  }
  return {
    hasTiles,
    style: {
      version: 8,
      glyphs: `${assets}/fonts/{fontstack}/{range}.pbf`,
      sprite: `${assets}/sprites/v4/${spriteFlavor}`,
      sources: {
        protomaps: {
          type: "vector",
          url: `pmtiles://${location.origin}${LOCAL_TILES}`,
          attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
        },
      },
      layers: layers("protomaps", namedFlavor(flavor), { lang: "en" }),
    },
  };
}
