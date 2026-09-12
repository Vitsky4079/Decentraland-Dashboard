// Supabase Edge Function: sync-places
//
// Pulls Decentraland's official Places directory (curated named scenes —
// title/description/image/categories, the same data that backs the star
// markers on Decentraland's own map) from https://places.decentraland.org/api/places
// and upserts it into places (see supabase/migrations/places.sql). This is
// what makes actual named scenes visible on our map, distinct from
// land_parcels (raw LAND ownership/type).
//
// GET, requires header  x-sync-secret: <MAP_SYNC_SECRET>  (same secret already
// used by sync-map-changes / sync-land-parcels). Always a full refresh —
// there's no incremental/checkpoint concept, same reasoning as sync-land-parcels.
//
// Deploy:  supabase functions deploy sync-places --no-verify-jwt

import { parsePlace, dedupeById, computeOffsets, chunk, type RawPlace, type PlaceRow } from './logic.ts';

const PLACES_URL = 'https://places.decentraland.org/api/places';
const PAGE_SIZE = 100; // API's own hard cap, confirmed by testing live
const FETCH_CONCURRENCY = 10;
const UPSERT_BATCH_SIZE = 1000;

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

async function fetchPage(offset: number): Promise<RawPlace[]> {
  const res = await fetch(`${PLACES_URL}?limit=${PAGE_SIZE}&offset=${offset}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Places API page offset=${offset} failed: HTTP ${res.status}`);
  const payload = (await res.json()) as { ok: boolean; data: RawPlace[] };
  return payload.data || [];
}

async function fetchAllPlaces(log: string[]): Promise<RawPlace[]> {
  const first = await fetch(`${PLACES_URL}?limit=${PAGE_SIZE}&offset=0`, { headers: { Accept: 'application/json' } });
  if (!first.ok) throw new Error(`Places API initial page failed: HTTP ${first.status}`);
  const firstPayload = (await first.json()) as { ok: boolean; total: number; data: RawPlace[] };
  const total = firstPayload.total || 0;
  log.push(`Places API reports ${total} total places`);

  const all: RawPlace[] = [...(firstPayload.data || [])];
  const remainingOffsets = computeOffsets(total, PAGE_SIZE).filter((o) => o !== 0);
  const offsetChunks = chunk(remainingOffsets, FETCH_CONCURRENCY);
  for (const offsets of offsetChunks) {
    const pages = await Promise.all(offsets.map((o) => fetchPage(o)));
    for (const page of pages) all.push(...page);
  }
  log.push(`fetched ${all.length} raw place records`);
  return all;
}

async function upsertAll(rows: PlaceRow[], log: string[]): Promise<void> {
  const batches = chunk(rows, UPSERT_BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/places?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(batches[i]),
    });
    if (!res.ok) throw new Error(`upserting places batch ${i + 1}/${batches.length} failed: HTTP ${res.status} ${await res.text()}`);
  }
  log.push(`upserted ${rows.length} place row(s) in ${batches.length} batch(es)`);
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
    const raw = await fetchAllPlaces(log);
    const parsed: PlaceRow[] = [];
    let skipped = 0;
    for (const r of raw) {
      const row = parsePlace(r);
      if (row) parsed.push(row);
      else skipped++;
    }
    // Paginating by offset over a live, reorderable dataset can hand back the
    // same place on two different pages (confirmed live) — dedupe before
    // batching, since a duplicate id within one upsert batch errors.
    const rows = dedupeById(parsed);
    log.push(`parsed ${parsed.length} genesis-city places (${skipped} skipped: disabled/world/malformed), ${rows.length} unique`);

    await upsertAll(rows, log);

    return json({ placesWritten: rows.length, skipped, durationMs: Date.now() - startedAt, log });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.push(`ERROR: ${message}`);
    console.error('[sync-places] failed:', message, log);
    return json({ error: message, log, durationMs: Date.now() - startedAt }, 500);
  }
});
