// Pure, dependency-free helpers for the sync-land-parcels Edge Function.
// Kept separate from index.ts (the Deno.serve/network/DB shell) so they can be
// unit-tested with `deno test` without touching the network or Supabase.

export const PARCEL_TYPES = ['district', 'road', 'plaza', 'owned'] as const;
export type ParcelType = (typeof PARCEL_TYPES)[number];

export interface RawTileV2 {
  x: number;
  y: number;
  type: string;
  name?: string | null;
  owner?: string | null;
  estateId?: string | null;
  top?: boolean;
  left?: boolean;
  topLeft?: boolean;
}

export interface ParcelRow {
  x: number;
  y: number;
  type: ParcelType;
  name: string | null;
  owner: string | null;
  estate_id: string | null;
  edge_top: boolean;
  edge_left: boolean;
  edge_top_left: boolean;
}

/** Whitelists the official API's `type` string, falling back to 'owned' for
 * anything unrecognized (logged by the caller) rather than dropping the row —
 * a parcel with an unexpected type is still real LAND that should render. */
export function normalizeType(raw: string): { type: ParcelType; wasUnknown: boolean } {
  const t = (raw || '').toLowerCase();
  if ((PARCEL_TYPES as readonly string[]).includes(t)) return { type: t as ParcelType, wasUnknown: false };
  return { type: 'owned', wasUnknown: true };
}

/** Maps the official Tile API v2 `data` object into rows ready to upsert into
 * land_parcels. Returns both the rows and a count of unrecognized type values
 * seen (for logging), so a schema change upstream is visible, not silent. */
export function parseTilesV2(data: Record<string, RawTileV2>): { rows: ParcelRow[]; unknownTypeCount: number } {
  const rows: ParcelRow[] = [];
  let unknownTypeCount = 0;
  for (const key of Object.keys(data)) {
    const t = data[key];
    if (typeof t.x !== 'number' || typeof t.y !== 'number') continue;
    const { type, wasUnknown } = normalizeType(t.type);
    if (wasUnknown) unknownTypeCount++;
    rows.push({
      x: t.x,
      y: t.y,
      type,
      name: t.name ?? null,
      owner: t.owner ?? null,
      estate_id: t.estateId ?? null,
      edge_top: Boolean(t.top),
      edge_left: Boolean(t.left),
      edge_top_left: Boolean(t.topLeft),
    });
  }
  return { rows, unknownTypeCount };
}

/** Splits an array into chunks of at most `size` — used to keep each PostgREST
 * upsert request to a manageable payload size across ~92k rows. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
