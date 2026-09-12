// Run with: deno test supabase/functions/sync-places/
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parsePlace, dedupeById, computeOffsets, chunk, type RawPlace, type PlaceRow } from './logic.ts';

Deno.test('parsePlace parses a normal genesis-city place', () => {
  const raw: RawPlace = {
    id: 'abc', title: 'Genesis Plaza', description: 'Spawn point', image: 'https://x/y.png',
    base_position: '-3,-2', categories: ['poi', 'social'], likes: 254, favorites: 281, deployed_at: '2026-09-10T23:59:10.049Z',
  };
  assertEquals(parsePlace(raw), {
    id: 'abc', title: 'Genesis Plaza', description: 'Spawn point', image: 'https://x/y.png',
    base_x: -3, base_y: -2, categories: ['poi', 'social'], likes: 254, favorites: 281,
    deployed_at: '2026-09-10T23:59:10.049Z',
  });
});

Deno.test('parsePlace skips disabled listings', () => {
  const raw: RawPlace = { id: 'a', base_position: '0,0', disabled: true };
  assertEquals(parsePlace(raw), null);
});

Deno.test('parsePlace skips Worlds (no Genesis City coordinates)', () => {
  const raw: RawPlace = { id: 'a', base_position: '0,0', world: true };
  assertEquals(parsePlace(raw), null);
});

Deno.test('parsePlace skips a missing/malformed base_position rather than guessing 0,0', () => {
  assertEquals(parsePlace({ id: 'a', base_position: null }), null);
  assertEquals(parsePlace({ id: 'a', base_position: 'not-a-coord' }), null);
  assertEquals(parsePlace({ id: 'a' }), null);
});

Deno.test('parsePlace defaults optional fields to null/empty rather than throwing', () => {
  const row = parsePlace({ id: 'a', base_position: '5,5' });
  assertEquals(row, {
    id: 'a', title: null, description: null, image: null, base_x: 5, base_y: 5,
    categories: [], likes: null, favorites: null, deployed_at: null,
  });
});

Deno.test('dedupeById collapses a place that appeared on two paginated pages, keeping the later copy', () => {
  const base: PlaceRow = {
    id: 'p1', title: 'A', description: null, image: null, base_x: 0, base_y: 0,
    categories: [], likes: 1, favorites: 1, deployed_at: null,
  };
  const rows: PlaceRow[] = [
    base,
    { id: 'p2', title: 'B', description: null, image: null, base_x: 1, base_y: 1, categories: [], likes: null, favorites: null, deployed_at: null },
    { ...base, likes: 5 }, // same id, reappeared on a later page with a shifted value
  ];
  const out = dedupeById(rows);
  assertEquals(out.length, 2);
  assertEquals(out.find((r) => r.id === 'p1')?.likes, 5);
});

Deno.test('computeOffsets covers the full total in pageSize steps', () => {
  assertEquals(computeOffsets(250, 100), [0, 100, 200]);
  assertEquals(computeOffsets(100, 100), [0]);
  assertEquals(computeOffsets(0, 100), []);
});

Deno.test('chunk splits evenly and carries the remainder', () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
