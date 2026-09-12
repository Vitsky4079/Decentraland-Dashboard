// Pure, dependency-free helpers for the sync-places Edge Function.
// Kept separate from index.ts (the Deno.serve/network/DB shell) so they can be
// unit-tested with `deno test` without touching the network or Supabase.

export interface RawPlace {
  id: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  base_position?: string | null;
  categories?: string[] | null;
  likes?: number | null;
  favorites?: number | null;
  deployed_at?: string | null;
  disabled?: boolean;
  world?: boolean;
}

export interface PlaceRow {
  id: string;
  title: string | null;
  description: string | null;
  image: string | null;
  base_x: number;
  base_y: number;
  categories: string[];
  likes: number | null;
  favorites: number | null;
  deployed_at: string | null;
}

/** Parses one raw Places-API record into a PlaceRow, or null if it should be
 * skipped: disabled listings, Worlds (no Genesis City x/y), or a malformed/
 * missing base_position. */
export function parsePlace(raw: RawPlace): PlaceRow | null {
  if (raw.disabled || raw.world) return null;
  const m = String(raw.base_position || '').match(/(-?\d+)\s*,\s*(-?\d+)/);
  if (!m) return null;
  return {
    id: raw.id,
    title: raw.title ?? null,
    description: raw.description ?? null,
    image: raw.image ?? null,
    base_x: parseInt(m[1], 10),
    base_y: parseInt(m[2], 10),
    categories: Array.isArray(raw.categories) ? raw.categories : [],
    likes: raw.likes ?? null,
    favorites: raw.favorites ?? null,
    deployed_at: raw.deployed_at ?? null,
  };
}

/** De-duplicates by id, keeping the last occurrence. Needed because paginating
 * by offset over a live, reorderable dataset (the Places API sorts by
 * ranking/favorites, which can shift between page requests) can hand back the
 * same place on two different pages — and Postgres's ON CONFLICT DO UPDATE
 * errors ("cannot affect row a second time") if one upsert batch contains the
 * same id twice, confirmed live. */
export function dedupeById(rows: PlaceRow[]): PlaceRow[] {
  const byId = new Map<string, PlaceRow>();
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()];
}

/** Every page offset needed to cover `total` records at `pageSize` each. */
export function computeOffsets(total: number, pageSize: number): number[] {
  const offsets: number[] = [];
  for (let o = 0; o < total; o += pageSize) offsets.push(o);
  return offsets;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
