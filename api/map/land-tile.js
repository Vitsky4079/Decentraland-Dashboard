// Vercel serverless function: our own base-map tile, rendered from Decentraland's
// official LAND parcel data (see supabase/migrations/land_parcels.sql and
// supabase/functions/sync-land-parcels) instead of proxying genesis.city's photo
// renders. assets/map.js requests these exactly like a raster tile source
// (`/api/map/land-tile?z={z}&x={x}&y={y}`), using the same tile-grid math
// ported to api/_lib/mapGrid.js.
//
// No secrets needed: land_parcels is public-read (RLS "public read" policy), so
// this queries PostgREST with the anon key — the same key already public in
// assets/config.js by design (RLS blocks all writes without login).

const { tileToParcelBounds, parcelLocalRect, SIDE, MIN_PARCEL, MAX_PARCEL } = require('../_lib/mapGrid');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bkedlefssfcyashgxxqg.supabase.co';
const ANON_KEY = 'sb_publishable_777eM-cG5uMIqzGOh-LRSg_IKSim8hB';

const MAX_PARCELS_PER_TILE = 8000; // defensive cap at very zoomed-out levels; see docs/DECENTRALAND_MAP.md

// Matches Decentraland's own in-client atlas palette (coral-red ground for
// occupied LAND, green for plazas/parks, tan for roads) rather than this
// project's own dashboard accent colors — this map should look like
// Decentraland's map, not like the rest of the site.
const FILLS = {
  owned: 'url(#dotsOwned)',
  district: 'url(#dotsDistrict)',
  plaza: '#4CA754',
  road: '#C9A876',
};
const BORDER = 'rgba(0,0,0,0.18)'; // subtle grout line between parcels
const LABEL_MIN_SIZE = 26; // px per parcel below which text wouldn't be legible

const DEFS = `<defs>
  <pattern id="dotsOwned" width="8" height="8" patternUnits="userSpaceOnUse">
    <rect width="8" height="8" fill="#C1443A"/>
    <circle cx="2" cy="2" r="1" fill="#A83A31"/>
    <circle cx="6" cy="6" r="1" fill="#A83A31"/>
  </pattern>
  <pattern id="dotsDistrict" width="8" height="8" patternUnits="userSpaceOnUse">
    <rect width="8" height="8" fill="#B23A48"/>
    <circle cx="2" cy="2" r="1" fill="#98303C"/>
    <circle cx="6" cy="6" r="1" fill="#98303C"/>
  </pattern>
</defs>`;

async function fetchParcels(minX, maxX, minY, maxY) {
  const url =
    `${SUPABASE_URL}/rest/v1/land_parcels?select=x,y,type,name,edge_top,edge_left` +
    `&x=gte.${minX}&x=lte.${maxX}&y=gte.${minY}&y=lte.${maxY}&limit=${MAX_PARCELS_PER_TILE}`;
  const res = await fetch(url, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
  if (!res.ok) throw new Error(`land_parcels query failed: HTTP ${res.status}`);
  return res.json();
}

function escXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  const z = Number(req.query.z);
  const x = Number(req.query.x);
  const y = Number(req.query.y);
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    res.status(400).send('invalid tile coordinate');
    return;
  }

  const bounds = tileToParcelBounds(z, x, y);
  const minX = Math.max(MIN_PARCEL, bounds.minX);
  const maxX = Math.min(MAX_PARCEL, bounds.maxX);
  const minY = Math.max(MIN_PARCEL, bounds.minY);
  const maxY = Math.min(MAX_PARCEL, bounds.maxY);

  let rects = '';
  let labels = '';
  if (minX <= maxX && minY <= maxY) {
    try {
      const parcels = await fetchParcels(minX, maxX, minY, maxY);
      for (const p of parcels) {
        const { localX, localYTop, size } = parcelLocalRect(p.x, p.y, bounds);
        if (localX + size < 0 || localX > SIDE || localYTop + size < 0 || localYTop > SIDE) continue;
        const fill = FILLS[p.type] || FILLS.owned;
        // A border on the top/left edge only where it's NOT the same group as
        // that neighbor (edge_top/edge_left false) — merges same-estate/
        // district parcels into one clean outlined shape instead of a grid.
        const strokeTop = p.edge_top ? 'none' : BORDER;
        const strokeLeft = p.edge_left ? 'none' : BORDER;
        rects += `<rect x="${localX.toFixed(2)}" y="${localYTop.toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}" fill="${fill}"/>`;
        if (strokeTop !== 'none') rects += `<line x1="${localX.toFixed(2)}" y1="${localYTop.toFixed(2)}" x2="${(localX + size).toFixed(2)}" y2="${localYTop.toFixed(2)}" stroke="${strokeTop}" stroke-width="1"/>`;
        if (strokeLeft !== 'none') rects += `<line x1="${localX.toFixed(2)}" y1="${localYTop.toFixed(2)}" x2="${localX.toFixed(2)}" y2="${(localYTop + size).toFixed(2)}" stroke="${strokeLeft}" stroke-width="1"/>`;

        // Label the top-left corner parcel of each named group (district,
        // estate, or a single named parcel) once it's large enough to read —
        // avoids repeating the same name across every parcel in the group.
        if (p.name && !p.edge_top && !p.edge_left && size >= LABEL_MIN_SIZE) {
          const fontSize = Math.min(13, Math.max(9, size * 0.22));
          labels += `<text x="${(localX + 4).toFixed(2)}" y="${(localYTop + fontSize + 3).toFixed(2)}" font-family="sans-serif" font-size="${fontSize.toFixed(1)}" font-weight="600" fill="#fff" stroke="#000" stroke-width="2.5" paint-order="stroke" style="pointer-events:none">${escXml(p.name)}</text>`;
        }
      }
    } catch (e) {
      // A failed/slow DB query shouldn't break the tile grid — return an empty
      // (transparent) tile instead of an error image; the map still functions,
      // just blank for this tile until the next request/cache refresh.
      rects = '';
      labels = '';
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE}" height="${SIDE}" viewBox="0 0 ${SIDE} ${SIDE}">${DEFS}${rects}${labels}</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  res.status(200).send(svg);
};
