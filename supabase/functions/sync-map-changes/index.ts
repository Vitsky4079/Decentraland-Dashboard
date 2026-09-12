// Supabase Edge Function: sync-map-changes
//
// Pulls Decentraland scene deployments from the Catalyst content server's
// /content/pointer-changes feed, resolves each entity's name/parcels, and
// persists deployment + parcel + daily-stats history to our own tables
// (map_sync_state, scene_deployments, scene_deployment_parcels,
// map_daily_stats — see supabase/migrations/map_changes.sql).
//
// Two modes, both GET, both require header  x-sync-secret: <MAP_SYNC_SECRET>:
//   (default)             incremental sync from map_sync_state.last_successful_sync
//                         (or now-30d on first run) up to "now". Only advances
//                         the checkpoint if the whole run succeeds.
//   ?from=<ms>&to=<ms>    manual backfill over an explicit window, chunked into
//                         <=7-day windows; never touches the checkpoint. This
//                         is the "backfill script" — invoke by hand once, e.g.:
//                           curl -H "x-sync-secret: $MAP_SYNC_SECRET" \
//                             "$SUPABASE_URL/functions/v1/sync-map-changes?from=...&to=..."
//
// Deploy:  supabase functions deploy sync-map-changes --no-verify-jwt
// Secret:  supabase secrets set MAP_SYNC_SECRET=<random string>
//          (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected)
//
// Catalyst behavior notes (verified live, 2026-09-12) that shaped this design:
//  - pointer-changes pagination is fast and reliable walking backward in its
//    DEFAULT order (sortingOrder=DESC / newest first). We request pages that
//    way and stop ourselves once a page's items cross below the lower bound
//    we care about, rather than trusting the server's own `from` filter to
//    bound an unbounded walk.
//  - the `pagination.next` string the API returns drops any sortingField/
//    sortingOrder you passed on the request that produced it, so blindly
//    re-fetching that literal URL can silently flip you back to the default
//    order. We sidestep this by reconstructing the next page's `to`+`lastId`
//    ourselves from the last item of the current page (same mechanism the API
//    itself uses for its own `next`), always with entityType=scene explicit.
//  - a full ascending (oldest-first) walk from an old checkpoint was observed
//    to time out (Cloudflare 524) against this API — don't switch to ASC.
//  - pointer-changes deltas do NOT carry a "previous entity" field, so
//    previous_entity_id is derived ourselves (computePreviousEntityIds in
//    logic.ts): whatever this run (or the DB, at the run's start) knows was
//    most recently deployed at the same base parcel.

import {
  type CatalystDelta,
  type CatalystPointerChangesResponse,
  type DeploymentRow,
  dedupeByEntityId,
  extractSceneInfo,
  rollUpDailyStats,
  chunkRange,
  computePreviousEntityIds,
} from './logic.ts';

const CATALYST = 'https://peer.decentraland.org/content';
const PAGE_LIMIT = 1000;
const RESOLVE_CONCURRENCY = 20;
const DEFAULT_BACKFILL_DAYS = 30;
const BACKFILL_CHUNK_DAYS = 7;
const MAX_PAGES_PER_RANGE = 500;

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

function db(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function dbJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await db(path, init);
  if (!res.ok) throw new Error(`Supabase REST ${path} failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/* ---------------- Catalyst: paginate, resolve ---------------- */

// Every scene deployment with cursor timestamp in (fromMs, toMs], newest
// first, walking backward ourselves (see file header notes).
async function fetchDeltasInRange(fromMs: number, toMs: number, log: string[]): Promise<CatalystDelta[]> {
  const all: CatalystDelta[] = [];
  let to = toMs;
  let lastId: string | undefined;
  let pages = 0;
  for (;;) {
    pages++;
    if (pages > MAX_PAGES_PER_RANGE) throw new Error(`too many Catalyst pages for range [${fromMs},${toMs}]`);
    const params = new URLSearchParams({ entityType: 'scene', to: String(to), limit: String(PAGE_LIMIT) });
    if (lastId) params.set('lastId', lastId);
    const res = await fetch(`${CATALYST}/pointer-changes?${params}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Catalyst pointer-changes failed: HTTP ${res.status}`);
    const data = (await res.json()) as CatalystPointerChangesResponse;
    const deltas = data.deltas || [];
    if (!deltas.length) break;

    let crossedLowerBound = false;
    for (const d of deltas) {
      const ts = d.localTimestamp ?? d.entityTimestamp ?? 0;
      if (ts <= fromMs) { crossedLowerBound = true; continue; }
      all.push(d);
    }

    const last = deltas[deltas.length - 1];
    const lastTs = last.localTimestamp ?? last.entityTimestamp ?? 0;
    if (crossedLowerBound || lastTs <= fromMs || !data.pagination?.moreData) break;
    to = lastTs;
    lastId = last.entityId;
  }
  log.push(`fetched ${all.length} new deltas across ${pages} page(s) for [${fromMs}, ${toMs}]`);
  return all;
}

// deno-lint-ignore no-explicit-any
async function resolveEntity(entityId: string): Promise<any | null> {
  try {
    const res = await fetch(`${CATALYST}/contents/${encodeURIComponent(entityId)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null;
  }
}

async function resolveAll(deltas: CatalystDelta[], log: string[]): Promise<DeploymentRow[]> {
  const rows: DeploymentRow[] = [];
  for (let i = 0; i < deltas.length; i += RESOLVE_CONCURRENCY) {
    const batch = deltas.slice(i, i + RESOLVE_CONCURRENCY);
    const entities = await Promise.all(batch.map((d) => resolveEntity(d.entityId)));
    batch.forEach((d, idx) => {
      const entity = entities[idx];
      const info = extractSceneInfo(entity, d.pointers);
      rows.push({
        entityId: d.entityId,
        deployedAt: d.entityTimestamp ?? d.localTimestamp ?? null,
        baseParcel: info.base,
        sceneName: info.name,
        parcels: info.parcels,
      });
    });
  }
  const unresolved = rows.filter((r) => !r.parcels.length).length;
  if (unresolved) log.push(`${unresolved} deployment(s) had no resolvable parcel list (entity fetch failed/empty)`);
  return rows;
}

/* ---------------- Persistence ---------------- */

async function fetchExistingLatestByBaseParcel(basePairs: [number, number][]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(basePairs.map(([x, y]) => `${x},${y}`))].map((s) => s.split(',').map(Number) as [number, number]);
  const BATCH = 50;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const or = batch.map(([x, y]) => `and(base_parcel_x.eq.${x},base_parcel_y.eq.${y})`).join(',');
    if (!or) continue;
    const rows = await dbJson<Array<{ entity_id: string; base_parcel_x: number; base_parcel_y: number }>>(
      `scene_deployments?select=entity_id,base_parcel_x,base_parcel_y&or=(${or})&order=deployed_at.desc`,
    );
    for (const r of rows) {
      const key = `${r.base_parcel_x},${r.base_parcel_y}`;
      if (!result.has(key)) result.set(key, r.entity_id); // first row per key = most recent (desc order)
    }
  }
  return result;
}

async function persistDeployments(rows: DeploymentRow[], log: string[]): Promise<{ deploymentsWritten: number; parcelsWritten: number; daysUpdated: string[] }> {
  if (!rows.length) return { deploymentsWritten: 0, parcelsWritten: 0, daysUpdated: [] };

  const sorted = [...rows].sort((a, b) => (a.deployedAt ?? 0) - (b.deployedAt ?? 0));
  const existingLatest = await fetchExistingLatestByBaseParcel(rows.map((r) => r.baseParcel).filter((p): p is [number, number] => p !== null));
  const previousByEntity = computePreviousEntityIds(sorted, existingLatest);

  const deploymentPayload = sorted.map((r) => ({
    entity_id: r.entityId,
    previous_entity_id: previousByEntity.get(r.entityId) ?? null,
    deployed_at: r.deployedAt ? new Date(r.deployedAt).toISOString() : null,
    base_parcel_x: r.baseParcel ? r.baseParcel[0] : null,
    base_parcel_y: r.baseParcel ? r.baseParcel[1] : null,
    scene_name: r.sceneName,
    pointer_data: r.parcels.map(([x, y]) => `${x},${y}`),
    parcel_count: r.parcels.length,
  }));

  const upserted = await dbJson<Array<{ id: number; entity_id: string }>>(
    'scene_deployments?on_conflict=entity_id&select=id,entity_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(deploymentPayload),
    },
  );
  const idByEntity = new Map(upserted.map((u) => [u.entity_id, u.id]));

  const parcelPayload: Array<{ deployment_id: number; x: number; y: number }> = [];
  for (const r of sorted) {
    const id = idByEntity.get(r.entityId);
    if (!id) continue;
    for (const [x, y] of r.parcels) parcelPayload.push({ deployment_id: id, x, y });
  }
  let parcelsWritten = 0;
  if (parcelPayload.length) {
    const PARCEL_BATCH = 1000;
    for (let i = 0; i < parcelPayload.length; i += PARCEL_BATCH) {
      const batch = parcelPayload.slice(i, i + PARCEL_BATCH);
      const res = await db('scene_deployment_parcels?on_conflict=deployment_id,x,y', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`writing scene_deployment_parcels failed: HTTP ${res.status} ${await res.text()}`);
      parcelsWritten += batch.length;
    }
  }

  const daily = rollUpDailyStats(sorted);
  const daysUpdated = daily.map((d) => d.date);
  if (daysUpdated.length) {
    const res = await db('rpc/recompute_map_daily_stats', {
      method: 'POST',
      body: JSON.stringify({ p_dates: daysUpdated }),
    });
    if (!res.ok) throw new Error(`recompute_map_daily_stats failed: HTTP ${res.status} ${await res.text()}`);
  }

  log.push(`wrote ${upserted.length} deployment row(s), ${parcelsWritten} parcel row(s), refreshed ${daysUpdated.length} daily-stat day(s)`);
  return { deploymentsWritten: upserted.length, parcelsWritten, daysUpdated };
}

/* ---------------- Checkpoint ---------------- */

async function readCheckpoint(): Promise<{ lastSuccessfulSync: number | null; lastEntityId: string | null }> {
  const rows = await dbJson<Array<{ last_successful_sync: string | null; last_entity_id: string | null }>>(
    'map_sync_state?id=eq.1&select=last_successful_sync,last_entity_id',
  );
  const row = rows[0];
  return {
    lastSuccessfulSync: row?.last_successful_sync ? new Date(row.last_successful_sync).getTime() : null,
    lastEntityId: row?.last_entity_id ?? null,
  };
}

async function writeCheckpoint(lastSuccessfulSync: number, lastEntityId: string | null): Promise<void> {
  const res = await db('map_sync_state?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({
      last_successful_sync: new Date(lastSuccessfulSync).toISOString(),
      last_entity_id: lastEntityId,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`writing map_sync_state failed: HTTP ${res.status} ${await res.text()}`);
}

/* ---------------- Run a window (shared by incremental + backfill) ---------------- */

async function runWindow(fromMs: number, toMs: number, log: string[]) {
  const deltas = dedupeByEntityId(await fetchDeltasInRange(fromMs, toMs, log));
  const rows = await resolveAll(deltas, log);
  return await persistDeployments(rows, log);
}

/* ---------------- Handler ---------------- */

Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (!SYNC_SECRET || req.headers.get('x-sync-secret') !== SYNC_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: 'server misconfigured: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  const url = new URL(req.url);
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  const log: string[] = [];

  try {
    if (fromParam) {
      // Manual backfill mode — explicit range, chunked, checkpoint untouched.
      const fromMs = Number(fromParam);
      const toMs = toParam ? Number(toParam) : Date.now();
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
        return json({ error: 'invalid from/to' }, 400);
      }
      log.push(`backfill mode: [${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()}]`);
      const chunks = chunkRange(fromMs, toMs, BACKFILL_CHUNK_DAYS);
      let deploymentsWritten = 0, parcelsWritten = 0;
      const daysUpdated = new Set<string>();
      for (const [chunkFrom, chunkTo] of chunks) {
        const r = await runWindow(chunkFrom, chunkTo, log);
        deploymentsWritten += r.deploymentsWritten;
        parcelsWritten += r.parcelsWritten;
        r.daysUpdated.forEach((d) => daysUpdated.add(d));
      }
      return json({
        mode: 'backfill', from: fromMs, to: toMs, chunks: chunks.length,
        deploymentsWritten, parcelsWritten, daysUpdated: [...daysUpdated],
        durationMs: Date.now() - startedAt, log,
      });
    }

    // Incremental mode.
    const checkpoint = await readCheckpoint();
    const toMs = Date.now();
    const fromMs = checkpoint.lastSuccessfulSync ?? (toMs - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
    log.push(`incremental mode: checkpoint=${checkpoint.lastSuccessfulSync ? new Date(checkpoint.lastSuccessfulSync).toISOString() : 'none (first run, defaulting to ' + DEFAULT_BACKFILL_DAYS + 'd)'}`);

    const result = await runWindow(fromMs, toMs, log);
    // Only advance the checkpoint now that the whole run above succeeded.
    await writeCheckpoint(toMs, null);

    return json({
      mode: 'incremental', from: fromMs, to: toMs,
      ...result, durationMs: Date.now() - startedAt, log,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.push(`ERROR: ${message}`);
    console.error('[sync-map-changes] failed, checkpoint NOT advanced:', message, log);
    return json({ error: message, log, durationMs: Date.now() - startedAt }, 500);
  }
});
