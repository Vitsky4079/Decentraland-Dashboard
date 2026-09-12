// Supabase Edge Function: sync-scene-presence
//
// land_parcels (from Decentraland's official Atlas API) only encodes
// ownership/type — most owned LAND has nothing built on it. This fills in
// has_scene/scene_entity_id/scene_name on land_parcels by sweeping the
// Catalyst content server's POST /content/entities/active endpoint across
// the whole city (1000 pointers/request, its own hard cap, confirmed live —
// see docs/DECENTRALAND_MAP.md). Unlike scene_deployments (only what our
// incremental Catalyst sync has observed change recently), this reflects
// *every* currently-active scene regardless of when it was deployed.
//
// GET, requires header  x-sync-secret: <MAP_SYNC_SECRET>  (same secret as the
// other map sync functions). Always a full sweep — there's no incremental
// mode; "does this parcel have a scene right now" has no meaningful diff feed.
//
// Deploy:  supabase functions deploy sync-scene-presence --no-verify-jwt

import { buildPointerBatches, extractEntityPresence, flattenToParcelRows, chunk, type ActiveEntity } from './logic.ts';

const CATALYST = 'https://peer.decentraland.org/content';
const MIN_PARCEL = -152, MAX_PARCEL = 152;
const FETCH_CONCURRENCY = 8;
const UPSERT_BATCH_SIZE = 2000;

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

async function fetchActiveBatch(pointers: string[]): Promise<ActiveEntity[]> {
  const res = await fetch(`${CATALYST}/entities/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointers }),
  });
  if (!res.ok) throw new Error(`entities/active failed: HTTP ${res.status}`);
  return (await res.json()) as ActiveEntity[];
}

async function resetStalePresence(log: string[]): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/land_parcels?has_scene=eq.true`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ has_scene: false, scene_entity_id: null, scene_name: null }),
  });
  if (!res.ok) throw new Error(`resetting stale scene presence failed: HTTP ${res.status} ${await res.text()}`);
  log.push('reset has_scene=false on previously-flagged parcels');
}

// Calls apply_scene_presence — a real UPDATE ... FROM, not an upsert (see
// supabase/migrations/scene_presence.sql for why: rows the sweep finds that
// aren't in land_parcels at all — Decentraland's real grid has gaps inside
// the nominal -152..152 square — must simply not match, not error out).
async function applyPresence(rows: Array<{ x: number; y: number; scene_entity_id: string; scene_name: string | null }>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/apply_scene_presence`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_rows: rows }),
  });
  if (!res.ok) throw new Error(`applying scene presence failed: HTTP ${res.status} ${await res.text()}`);
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
    await resetStalePresence(log);

    const pointerBatches = buildPointerBatches(MIN_PARCEL, MAX_PARCEL, 1000);
    log.push(`sweeping ${pointerBatches.length} Catalyst batches (${(MAX_PARCEL - MIN_PARCEL + 1) ** 2} coordinates)`);

    let entitiesSeen = 0;
    let pendingRows: Array<{ x: number; y: number; scene_entity_id: string; scene_name: string | null }> = [];
    let parcelsWritten = 0;

    const fetchChunks = chunk(pointerBatches, FETCH_CONCURRENCY);
    for (const fc of fetchChunks) {
      const results = await Promise.all(fc.map((pointers) => fetchActiveBatch(pointers)));
      const entities = results.flat().map(extractEntityPresence);
      entitiesSeen += entities.length;
      const rows = flattenToParcelRows(entities);
      for (const r of rows.values()) pendingRows.push(r);

      if (pendingRows.length >= UPSERT_BATCH_SIZE) {
        for (const batch of chunk(pendingRows, UPSERT_BATCH_SIZE)) {
          if (!batch.length) continue;
          await applyPresence(batch);
          parcelsWritten += batch.length;
        }
        pendingRows = [];
      }
    }
    if (pendingRows.length) {
      for (const batch of chunk(pendingRows, UPSERT_BATCH_SIZE)) {
        await applyPresence(batch);
        parcelsWritten += batch.length;
      }
    }

    log.push(`${entitiesSeen} active scene entities seen, ${parcelsWritten} parcel row(s) marked has_scene=true`);
    return json({ entitiesSeen, parcelsWritten, durationMs: Date.now() - startedAt, log });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.push(`ERROR: ${message}`);
    console.error('[sync-scene-presence] failed:', message, log);
    return json({ error: message, log, durationMs: Date.now() - startedAt }, 500);
  }
});
