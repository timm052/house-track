// Height data for the map: free elevation tiles (AWS Open Data's Terrain Tiles, Terrarium encoding, to zoom 15),
// drawn as hill shading and contour lines, and read at a single point for a house's height above sea level. Around
// Melbourne they come from SRTM, about 30 m apart and good to several metres: the lie of the land, not a single lot.
// maplibre-contour turns the tiles into contour lines in a background worker and caches them for the shading too.
import mlcontour from "maplibre-contour";
import * as maplibregl from "maplibre-gl";

const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const MAX_ZOOM = 15;
export const TERRAIN_ATTRIBUTION = "Elevation: Terrain Tiles (AWS Open Data, Mapzen), from NASA SRTM";

export const dem = new mlcontour.DemSource({ url: TERRARIUM, encoding: "terrarium", maxzoom: MAX_ZOOM, worker: true });
dem.setupMaplibre(maplibregl);

/** Contour vector tiles, minor and major lines closer together as you zoom in: coarse (to 5 m apart, the clean
 *  lie of the land) or fine (to 2 m apart, closer to the data, with the small wiggles 30 m data brings). */
const contours = (thresholds: Record<number, number[]>) =>
  dem.contourProtocolUrl({ thresholds, elevationKey: "ele", levelKey: "level", contourLayer: "contours", overzoom: 1 });
export const contourTiles = {
  coarse: contours({ 11: [20, 100], 12: [10, 50], 14: [5, 25] }),
  fine: contours({ 11: [10, 50], 12: [5, 25], 14: [2, 10] }),
};
export type ContourDetail = keyof typeof contourTiles;

/** Metres above sea level at a point, from the finest elevation tile, or null if it can't be read. */
export async function heightAt(lon: number, lat: number): Promise<number | null> {
  const n = 2 ** MAX_ZOOM, rad = (lat * Math.PI) / 180;
  const fx = ((lon + 180) / 360) * n, fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  try {
    const tile = await dem.getDemTile(MAX_ZOOM, x, y);
    const px = Math.min(tile.width - 1, Math.floor((fx - x) * tile.width)), py = Math.min(tile.height - 1, Math.floor((fy - y) * tile.height));
    const h = tile.data[py * tile.width + px];
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}
