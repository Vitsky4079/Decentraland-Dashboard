// Run with: deno test supabase/functions/sync-scene-presence/
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildPointerBatches, extractEntityPresence, flattenToParcelRows, chunk, type ActiveEntity } from './logic.ts';

Deno.test('buildPointerBatches covers every coordinate in range exactly once, chunked to the cap', () => {
  const batches = buildPointerBatches(-1, 1, 4); // 3x3 = 9 pointers, batches of 4
  const all = batches.flat();
  assertEquals(all.length, 9);
  assertEquals(new Set(all).size, 9); // no duplicates
  assertEquals(batches.map((b) => b.length), [4, 4, 1]);
  assertEquals(all.includes('-1,-1'), true);
  assertEquals(all.includes('1,1'), true);
});

Deno.test('buildPointerBatches respects the 1000/request cap by default', () => {
  const batches = buildPointerBatches(-152, 152);
  for (const b of batches) assertEquals(b.length <= 1000, true);
});

Deno.test('extractEntityPresence prefers display.title, falls back through scene.name/pointers', () => {
  const withTitle: ActiveEntity = { id: 'a', pointers: ['0,0'], metadata: { display: { title: 'Cool Place' } } };
  assertEquals(extractEntityPresence(withTitle).name, 'Cool Place');

  const sceneOnly: ActiveEntity = { id: 'b', pointers: ['1,1'], metadata: { scene: { name: 'Scene Name' } } };
  assertEquals(extractEntityPresence(sceneOnly).name, 'Scene Name');

  const noName: ActiveEntity = { id: 'c', pointers: ['2,2'] };
  assertEquals(extractEntityPresence(noName).name, null);
});

Deno.test('extractEntityPresence reads the full multi-parcel footprint, not just one pointer', () => {
  const e: ActiveEntity = {
    id: 'x', pointers: ['0,0'],
    metadata: { scene: { parcels: ['0,0', '0,1', '1,0', '1,1'] } },
  };
  const r = extractEntityPresence(e);
  assertEquals(r.parcels.length, 4);
  assertEquals(r.parcels[2], { x: 1, y: 0 });
});

Deno.test('flattenToParcelRows produces one row per parcel across entities', () => {
  const rows = flattenToParcelRows([
    { entityId: 'a', name: 'A', parcels: [{ x: 0, y: 0 }, { x: 0, y: 1 }] },
    { entityId: 'b', name: 'B', parcels: [{ x: 5, y: 5 }] },
  ]);
  assertEquals(rows.size, 3);
  assertEquals(rows.get('0,0'), { x: 0, y: 0, scene_entity_id: 'a', scene_name: 'A' });
  assertEquals(rows.get('5,5'), { x: 5, y: 5, scene_entity_id: 'b', scene_name: 'B' });
});

Deno.test('flattenToParcelRows lets a later entity win if a parcel somehow appears twice', () => {
  const rows = flattenToParcelRows([
    { entityId: 'old', name: 'Old', parcels: [{ x: 0, y: 0 }] },
    { entityId: 'new', name: 'New', parcels: [{ x: 0, y: 0 }] },
  ]);
  assertEquals(rows.get('0,0')?.scene_entity_id, 'new');
});

Deno.test('chunk splits evenly and carries the remainder', () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
