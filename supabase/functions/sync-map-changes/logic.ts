// Pure, dependency-free helpers for the sync-map-changes Edge Function.
// Kept separate from index.ts (the Deno.serve/network/DB shell) so they can be
// unit-tested with `deno test` without touching the network or Supabase.

export interface CatalystDelta {
  entityId: string;
  pointers: string[];
  entityTimestamp?: number;
  localTimestamp?: number;
}

export interface CatalystPagination {
  moreData: boolean;
  next?: string;
}

export interface CatalystPointerChangesResponse {
  deltas: CatalystDelta[];
  pagination: CatalystPagination;
}

export interface SceneInfo {
  name: string | null;
  base: [number, number] | null;
  parcels: [number, number][];
}

export interface DeploymentRow {
  entityId: string;
  deployedAt: number | null;   // ms epoch
  baseParcel: [number, number] | null;
  sceneName: string | null;
  parcels: [number, number][];
}

export interface DailyStatsRow {
  date: string;               // 'YYYY-MM-DD' (UTC)
  deployment_count: number;
  scene_count: number;
  parcel_count: number;
}

/** Parse a Catalyst pointer string like "12,-34" into [12, -34]. Returns null if malformed. */
export function parsePointer(pointer: string): [number, number] | null {
  const m = String(pointer).match(/(-?\d+)\s*,\s*(-?\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

/**
 * Dedupe a page (or several concatenated pages) of Catalyst deltas by entityId,
 * keeping the last-seen occurrence (Catalyst can repeat an entity across pages
 * at the pagination boundary). Order of the input is preserved for first-seen
 * insertion order, values may be overwritten in place.
 */
export function dedupeByEntityId(deltas: CatalystDelta[]): CatalystDelta[] {
  const byId = new Map<string, CatalystDelta>();
  for (const d of deltas) byId.set(d.entityId, d);
  return [...byId.values()];
}

/**
 * Extract the fields we persist from a Catalyst scene entity (the response of
 * GET {catalyst}/contents/{entityId}), mirroring sceneFromEntity() in the
 * github-issues function. A scene can list several parcels; `base` is the
 * canonical one to key the "one marker per scene" views on.
 */
// deno-lint-ignore no-explicit-any
export function extractSceneInfo(entity: any, fallbackPointers: string[] = []): SceneInfo {
  const md = (entity && entity.metadata) || {};
  const name: string | null =
    (md.display && md.display.title) || (md.scene && md.scene.name) || md.name || null;

  const rawParcels: string[] =
    (md.scene && Array.isArray(md.scene.parcels) && md.scene.parcels.length ? md.scene.parcels : null) ||
    (Array.isArray(entity?.pointers) && entity.pointers.length ? entity.pointers : null) ||
    fallbackPointers;

  const parcels = rawParcels.map(parsePointer).filter((p): p is [number, number] => p !== null);

  const rawBase: string | null = (md.scene && md.scene.base) || rawParcels[0] || null;
  const base = rawBase ? parsePointer(rawBase) : (parcels[0] ?? null);

  return { name, base, parcels };
}

/** True if a Catalyst pointer-changes page indicates more pages follow. */
export function hasMorePages(pagination: CatalystPagination): boolean {
  return Boolean(pagination && pagination.moreData && pagination.next);
}

/** UTC 'YYYY-MM-DD' for a ms-epoch timestamp. */
export function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Roll a batch of deployment rows up into per-UTC-day stats. Rows without a
 * resolvable deployedAt are skipped (can't be attributed to a day).
 */
export function rollUpDailyStats(rows: DeploymentRow[]): DailyStatsRow[] {
  const byDate = new Map<string, { deployments: number; scenes: Set<string>; parcels: Set<string> }>();
  for (const r of rows) {
    if (!r.deployedAt) continue;
    const key = utcDateKey(r.deployedAt);
    let bucket = byDate.get(key);
    if (!bucket) { bucket = { deployments: 0, scenes: new Set(), parcels: new Set() }; byDate.set(key, bucket); }
    bucket.deployments += 1;
    if (r.baseParcel) bucket.scenes.add(r.baseParcel[0] + ',' + r.baseParcel[1]);
    for (const p of r.parcels) bucket.parcels.add(p[0] + ',' + p[1]);
  }
  return [...byDate.entries()]
    .map(([date, b]) => ({
      date,
      deployment_count: b.deployments,
      scene_count: b.scenes.size,
      parcel_count: b.parcels.size,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Split [fromMs, toMs] into ascending, non-overlapping windows of at most
 * maxDays each, so a large manual backfill makes several smaller Catalyst
 * pagination runs instead of one unbounded one.
 */
export function chunkRange(fromMs: number, toMs: number, maxDays = 7): Array<[number, number]> {
  const chunks: Array<[number, number]> = [];
  const step = maxDays * 24 * 60 * 60 * 1000;
  let start = fromMs;
  while (start < toMs) {
    const end = Math.min(start + step, toMs);
    chunks.push([start, end]);
    start = end;
  }
  return chunks;
}

/**
 * Assigns each deployment's previous_entity_id: the entity_id of whatever
 * deployment previously occupied its base parcel, chronologically. `rows` must
 * be sorted ascending by deployedAt (a single sync run/chunk, small enough to
 * hold in memory) and `existingLatest` should be seeded from the DB with the
 * entity_id of the most recent deployment already stored per base parcel
 * (key: "x,y") before this run started — so a deployment at the very start of
 * a chunk still correctly points back at something from *before* the chunk.
 * Returns a map of entityId -> previousEntityId (or null if it's the first
 * deployment ever seen at that base parcel).
 */
export function computePreviousEntityIds(
  rows: DeploymentRow[],
  existingLatest: Map<string, string>,
): Map<string, string | null> {
  const latest = new Map(existingLatest);
  const result = new Map<string, string | null>();
  for (const r of rows) {
    if (!r.baseParcel) { result.set(r.entityId, null); continue; }
    const key = r.baseParcel[0] + ',' + r.baseParcel[1];
    result.set(r.entityId, latest.get(key) ?? null);
    latest.set(key, r.entityId);
  }
  return result;
}

/**
 * The sync loop must only advance the stored checkpoint after a run's entire
 * fetch+write sequence has completed without throwing. This is a documentation
 * function (used by the real loop's try/catch) so the "no partial checkpoint
 * advance" rule has one obvious place to unit-test against.
 */
export function nextCheckpoint(
  runSucceeded: boolean,
  previous: { lastSuccessfulSync: number | null; lastEntityId: string | null },
  latest: { lastSuccessfulSync: number; lastEntityId: string | null },
): { lastSuccessfulSync: number | null; lastEntityId: string | null } {
  return runSucceeded ? latest : previous;
}
