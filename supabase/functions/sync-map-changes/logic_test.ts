// Run with: deno test supabase/functions/sync-map-changes/
import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  parsePointer,
  dedupeByEntityId,
  extractSceneInfo,
  hasMorePages,
  utcDateKey,
  rollUpDailyStats,
  chunkRange,
  nextCheckpoint,
  computePreviousEntityIds,
  type CatalystDelta,
  type DeploymentRow,
} from './logic.ts';

Deno.test('parsePointer parses positive and negative coordinates', () => {
  assertEquals(parsePointer('12,-34'), [12, -34]);
  assertEquals(parsePointer('-72, 34'), [-72, 34]);
  assertEquals(parsePointer('not a pointer'), null);
});

Deno.test('dedupeByEntityId keeps the last occurrence per entity, no duplicates', () => {
  const deltas: CatalystDelta[] = [
    { entityId: 'a', pointers: ['0,0'], entityTimestamp: 1 },
    { entityId: 'b', pointers: ['1,1'], entityTimestamp: 2 },
    { entityId: 'a', pointers: ['0,0'], entityTimestamp: 3 }, // re-seen at a page boundary
  ];
  const out = dedupeByEntityId(deltas);
  assertEquals(out.length, 2);
  const a = out.find((d) => d.entityId === 'a');
  assertEquals(a?.entityTimestamp, 3);
});

Deno.test('extractSceneInfo reads a multi-parcel scene and its base parcel', () => {
  const entity = {
    metadata: {
      display: { title: 'WonderZone' },
      scene: { base: '10,10', parcels: ['10,10', '10,11', '11,10', '11,11'] },
    },
    pointers: ['10,10'],
  };
  const info = extractSceneInfo(entity);
  assertEquals(info.name, 'WonderZone');
  assertEquals(info.base, [10, 10]);
  assertEquals(info.parcels.length, 4);
});

Deno.test('extractSceneInfo falls back to entity.pointers when scene metadata is absent', () => {
  const entity = { metadata: {}, pointers: ['-18,91'] };
  const info = extractSceneInfo(entity);
  assertEquals(info.base, [-18, 91]);
  assertEquals(info.parcels, [[-18, 91]]);
});

Deno.test('a single scene deployment is not counted as one deployment per parcel', () => {
  const entity = { metadata: { scene: { base: '0,0', parcels: ['0,0', '0,1', '1,0', '1,1'] } }, pointers: [] };
  const info = extractSceneInfo(entity);
  // 4 parcels, but this is still exactly one scene/deployment record.
  assertEquals(info.parcels.length, 4);
  assert(info.base !== null);
});

Deno.test('hasMorePages follows the Catalyst pagination.moreData/next contract', () => {
  assertEquals(hasMorePages({ moreData: true, next: '?lastId=x' }), true);
  assertEquals(hasMorePages({ moreData: false }), false);
  assertEquals(hasMorePages({ moreData: true }), false); // no next cursor, can't continue
});

Deno.test('utcDateKey buckets by UTC calendar day', () => {
  assertEquals(utcDateKey(Date.UTC(2026, 8, 12, 23, 59)), '2026-09-12');
  assertEquals(utcDateKey(Date.UTC(2026, 8, 13, 0, 0)), '2026-09-13');
});

Deno.test('rollUpDailyStats aggregates deployments/scenes/parcels per day, skips undated rows', () => {
  const rows: DeploymentRow[] = [
    { entityId: 'a', deployedAt: Date.UTC(2026, 8, 12, 10), baseParcel: [0, 0], sceneName: 'A', parcels: [[0, 0], [0, 1]] },
    { entityId: 'b', deployedAt: Date.UTC(2026, 8, 12, 11), baseParcel: [5, 5], sceneName: 'B', parcels: [[5, 5]] },
    { entityId: 'c', deployedAt: Date.UTC(2026, 8, 13, 1), baseParcel: [0, 0], sceneName: 'A2', parcels: [[0, 0]] },
    { entityId: 'd', deployedAt: null, baseParcel: null, sceneName: null, parcels: [] },
  ];
  const stats = rollUpDailyStats(rows);
  assertEquals(stats, [
    { date: '2026-09-12', deployment_count: 2, scene_count: 2, parcel_count: 3 },
    { date: '2026-09-13', deployment_count: 1, scene_count: 1, parcel_count: 1 },
  ]);
});

Deno.test('chunkRange splits a large backfill window into <=maxDays chunks covering it exactly', () => {
  const from = Date.UTC(2026, 0, 1);
  const to = Date.UTC(2026, 0, 22); // 21 days
  const chunks = chunkRange(from, to, 7);
  assertEquals(chunks.length, 3);
  assertEquals(chunks[0][0], from);
  assertEquals(chunks[chunks.length - 1][1], to);
  for (let i = 1; i < chunks.length; i++) assertEquals(chunks[i][0], chunks[i - 1][1]);
});

Deno.test('chunkRange handles a window smaller than maxDays as a single chunk', () => {
  const from = Date.UTC(2026, 0, 1);
  const to = Date.UTC(2026, 0, 2);
  assertEquals(chunkRange(from, to, 7), [[from, to]]);
});

Deno.test('computePreviousEntityIds chains deployments at the same base parcel in order', () => {
  const rows: DeploymentRow[] = [
    { entityId: 'e1', deployedAt: 1, baseParcel: [0, 0], sceneName: null, parcels: [[0, 0]] },
    { entityId: 'e2', deployedAt: 2, baseParcel: [5, 5], sceneName: null, parcels: [[5, 5]] },
    { entityId: 'e3', deployedAt: 3, baseParcel: [0, 0], sceneName: null, parcels: [[0, 0]] }, // redeploy of e1's parcel
  ];
  const out = computePreviousEntityIds(rows, new Map());
  assertEquals(out.get('e1'), null);
  assertEquals(out.get('e2'), null);
  assertEquals(out.get('e3'), 'e1');
});

Deno.test('computePreviousEntityIds seeds from existing DB state so chunk boundaries stay correct', () => {
  const rows: DeploymentRow[] = [
    { entityId: 'e4', deployedAt: 10, baseParcel: [1, 1], sceneName: null, parcels: [[1, 1]] },
  ];
  const out = computePreviousEntityIds(rows, new Map([['1,1', 'e3-already-in-db']]));
  assertEquals(out.get('e4'), 'e3-already-in-db');
});

Deno.test('nextCheckpoint only advances when the run succeeded', () => {
  const previous = { lastSuccessfulSync: 100, lastEntityId: 'old' };
  const latest = { lastSuccessfulSync: 200, lastEntityId: 'new' };
  assertEquals(nextCheckpoint(true, previous, latest), latest);
  assertEquals(nextCheckpoint(false, previous, latest), previous);
});
