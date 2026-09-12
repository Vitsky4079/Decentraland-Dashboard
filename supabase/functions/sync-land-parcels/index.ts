// Supabase Edge Function: sync-land-parcels
//
// Pulls Decentraland's own official LAND parcel dataset (ownership/type/estate
// grouping) from https://assets-cdn.decentraland.org/tiles/v2/latest.json and
// upserts it into land_parcels (see supabase/migrations/land_parcels.sql).
// This is the data source for our own base map layer (api/map/land-tile.js) —
// it makes the map independent of genesis.city's uptime and reflects live
// on-chain ownership, not a periodic 3D screenshot.
//
// GET, requires header  x-sync-secret: <MAP_SYNC_SECRET>  (same secret already
// used by sync-map-changes). Always does a full refresh — there's no
// incremental/checkpoint concept here: it's one ~92k-row snapshot from
// Decentraland's CDN, and ownership can change for any parcel at any time, so
// each run just upserts the current state of every parcel it received.
//
// Deploy:  supabase functions deploy sync-land-parcels --no-verify-jwt
// (Reuses the MAP_SYNC_SECRET secret already set for sync-map-changes —
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected as usual.)

import { parseTilesV2, chunk, type RawTileV2, type ParcelRow } from './logic.ts';

const TILES_URL = 'https://assets-cdn.decentraland.org/tiles/v2/latest.json';
const UPSERT_BATCH_SIZE = 5000;
const UPSERT_CONCURRENCY = 4;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SYNC_SECRET = Deno.env.get('MAP_SYNC_SECRET') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'x-sync-secret, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function upsertBatch(batch: ParcelRow[]): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/land_parcels?on_conflict=x,y`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error(`upserting land_parcels batch failed: HTTP ${res.status} ${await res.text()}`);
}

async function upsertAll(rows: ParcelRow[], log: string[]): Promise<void> {
  const batches = chunk(rows, UPSERT_BATCH_SIZE);
  for (let i = 0; i < batches.length; i += UPSERT_CONCURRENCY) {
    const slice = batches.slice(i, i + UPSERT_CONCURRENCY);
    await Promise.all(slice.map((b) => upsertBatch(b)));
    log.push(`upserted batch ${Math.min(i + UPSERT_CONCURRENCY, batches.length)}/${batches.length}`);
  }
}

Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (!SYNC_SECRET || req.headers.get('x-sync-secret') !== SYNC_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: 'server misconfigured: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  const log: string[] = [];
  try {
    log.push(`fetching ${TILES_URL}`);
    const res = await fetch(TILES_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`fetching official tile data failed: HTTP ${res.status}`);
    const payload = (await res.json()) as { ok: boolean; data: Record<string, RawTileV2> };
    if (!payload || !payload.data) throw new Error('unexpected response shape from the official tile API');

    const { rows, unknownTypeCount } = parseTilesV2(payload.data);
    log.push(`parsed ${rows.length} parcels (${unknownTypeCount} with an unrecognized type, defaulted to 'owned')`);

    await upsertAll(rows, log);

    return json({
      parcelsWritten: rows.length,
      unknownTypeCount,
      durationMs: Date.now() - startedAt,
      log,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.push(`ERROR: ${message}`);
    console.error('[sync-land-parcels] failed:', message, log);
    return json({ error: message, log, durationMs: Date.now() - startedAt }, 500);
  }
});
