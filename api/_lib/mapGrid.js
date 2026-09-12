// Shared tile-grid math for api/map/land-tile.js — a plain-Node port of the
// same constants assets/map.js uses for genesis.city's tile pyramid (61x61
// tiles of 200px, zoom 6; see the comment block at the top of that file).
// Kept as a separate, dependency-free module so the pure math can be sanity-
// checked in isolation (see scratch verification during development) without
// spinning up a Vercel function.

const SIDE = 200, TILE_COUNT = 61, ZOOM = 6;
const EXTENT = [0, 0, SIDE * TILE_COUNT, SIDE * TILE_COUNT]; // [0,0,12200,12200]
const ORIGIN = [0, SIDE * TILE_COUNT]; // [0, 12200] — top-left, Y grows down in tile-index space
const SCALE = (SIDE * TILE_COUNT) / 305; // 40px per parcel
const OFF = 152.5;
const RESOLUTIONS = [];
for (let i = 0; i <= ZOOM; i++) RESOLUTIONS.push(Math.pow(2, ZOOM - i)); // [64,32,16,8,4,2,1]

const MIN_PARCEL = -152, MAX_PARCEL = 152;

/** Parcel coordinate range a given (z, tx, ty) tile covers, with a 1-parcel
 * safety margin on each side so a parcel whose rect straddles a tile seam
 * still gets queried (and clipped) consistently on both tiles. */
function tileToParcelBounds(z, tx, ty) {
  const zi = Math.max(0, Math.min(RESOLUTIONS.length - 1, Math.round(z)));
  const resolution = RESOLUTIONS[zi];
  const span = SIDE * resolution;
  const minXu = ORIGIN[0] + tx * span;
  const maxXu = minXu + span;
  const maxYu = ORIGIN[1] - ty * span;
  const minYu = maxYu - span;
  return {
    minX: Math.floor(minXu / SCALE - OFF) - 1,
    maxX: Math.ceil(maxXu / SCALE - OFF),
    minY: Math.floor(minYu / SCALE - OFF) - 1,
    maxY: Math.ceil(maxYu / SCALE - OFF),
    minXu, maxXu, minYu, maxYu, span, resolution,
  };
}

/** Local pixel rect (top-left x/y + size, in this tile's own 0..SIDE box) for
 * parcel (x, y), given the tile bounds object returned by tileToParcelBounds. */
function parcelLocalRect(x, y, tile) {
  const westMapUnitX = (x + OFF) * SCALE;
  const southMapUnitY = (y + OFF) * SCALE;
  const size = SCALE / tile.resolution;
  const localX = (westMapUnitX - tile.minXu) / tile.resolution;
  const localYTop = (tile.maxYu - (southMapUnitY + SCALE)) / tile.resolution;
  return { localX, localYTop, size };
}

module.exports = {
  SIDE, TILE_COUNT, ZOOM, EXTENT, ORIGIN, SCALE, OFF, RESOLUTIONS,
  MIN_PARCEL, MAX_PARCEL, tileToParcelBounds, parcelLocalRect,
};
