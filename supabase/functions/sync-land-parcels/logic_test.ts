// Run with: deno test supabase/functions/sync-land-parcels/
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { normalizeType, parseTilesV2, chunk, type RawTileV2 } from './logic.ts';

Deno.test('normalizeType passes through the 4 known official types', () => {
  for (const t of ['district', 'road', 'plaza', 'owned']) {
    assertEquals(normalizeType(t), { type: t, wasUnknown: false });
  }
});

Deno.test('normalizeType is case-insensitive', () => {
  assertEquals(normalizeType('District'), { type: 'district', wasUnknown: false });
});

Deno.test('normalizeType falls back to owned for an unrecognized type rather than dropping the row', () => {
  assertEquals(normalizeType('some-new-type'), { type: 'owned', wasUnknown: true });
});

Deno.test('parseTilesV2 maps fields and edge flags, defaulting missing optionals to null/false', () => {
  const data: Record<string, RawTileV2> = {
    '-150,150': {
      x: -150, y: 150, type: 'district', name: 'Ocean Corner', owner: '0xabc', estateId: '5784',
      top: true, left: false, topLeft: false,
    },
    '10,10': { x: 10, y: 10, type: 'road' }, // no name/owner/estate/edges at all
  };
  const { rows, unknownTypeCount } = parseTilesV2(data);
  assertEquals(unknownTypeCount, 0);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], {
    x: -150, y: 150, type: 'district', name: 'Ocean Corner', owner: '0xabc', estate_id: '5784',
    edge_top: true, edge_left: false, edge_top_left: false,
  });
  assertEquals(rows[1], {
    x: 10, y: 10, type: 'road', name: null, owner: null, estate_id: null,
    edge_top: false, edge_left: false, edge_top_left: false,
  });
});

Deno.test('parseTilesV2 skips entries missing x/y and counts unknown types', () => {
  const data: Record<string, RawTileV2> = {
    'bad': { x: undefined as unknown as number, y: 1, type: 'road' },
    'ok': { x: 1, y: 1, type: 'mystery-type' },
  };
  const { rows, unknownTypeCount } = parseTilesV2(data);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].type, 'owned');
  assertEquals(unknownTypeCount, 1);
});

Deno.test('chunk splits evenly and carries the remainder in a final short chunk', () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  assertEquals(chunk([], 2), []);
});
