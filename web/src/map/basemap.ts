import { layers, namedFlavor } from "@protomaps/basemaps";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { PMTiles, Protocol } from "pmtiles";

// MapLibre 6 runs its tile parsing in a module worker that the bundler has to emit separately.
maplibregl.setWorkerUrl(workerUrl);

// The setup job writes these under DATA_DIR/tiles, which the web container serves at /tiles.
const LOCAL_TILES = "/tiles/basemap.pmtiles";
const LOCAL_ASSETS = "/tiles/assets";
const HOSTED_ASSETS = "https://protomaps.github.io/basemaps-assets";

let registered = false;

// Victoria's extent: a local extract smaller than this (e.g. a test area) would leave most of the map
// blank, so when online the streamed basemap wins over it.
const REGION = { minLon: 141.0, minLat: -39.1, maxLon: 149.9, maxLat: -34.0 };

async function coversRegion(url: string): Promise<boolean> {
  try {
    const h = await new PMTiles(url).getHeader();
    return h.minLon <= REGION.minLon && h.minLat <= REGION.minLat && h.maxLon >= REGION.maxLon && h.maxLat >= REGION.maxLat;
  } catch {
    return false;
  }
}

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

export type Basemap = { style: StyleSpecification | string; hasTiles: boolean; streamed: boolean };
const STREAMED = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };

/** A local PMTiles extract when `setup tiles` has installed one (works offline, PLAN.md decision 5);
 *  otherwise the free OpenFreeMap vector tiles for anywhere in Australia, streamed (needs internet;
 *  offline, pins and areas still draw on a blank background). */
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

  const useLocal = hasTiles && (!navigator.onLine || (await coversRegion(`${location.origin}${LOCAL_TILES}`)));
  if (!useLocal) return { hasTiles, streamed: true, style: dark ? STREAMED.dark : STREAMED.light };
  return {
    hasTiles,
    streamed: false,
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
