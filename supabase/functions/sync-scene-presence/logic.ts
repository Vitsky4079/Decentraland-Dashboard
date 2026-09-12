// Pure, dependency-free helpers for the sync-scene-presence Edge Function.
// Kept separate from index.ts (the Deno.serve/network/DB shell) so they can be
// unit-tested with `deno test` without touching the network or Supabase.

export interface ActiveEntity {
  id: string;
  pointers?: string[];
  metadata?: {
    display?: { title?: string };
    scene?: { name?: string; parcels?: string[] };
    name?: string;
  };
}

export interface ParcelPresence {
  x: number;
  y: number;
}

export interface EntityPresence {
  entityId: string;
  name: string | null;
  parcels: ParcelPresence[];
}

/** Every "x,y" pointer string covering [min,max]x[min,max], chunked into
 * batches of at most `batchSize` (the Catalyst entities/active endpoint's own
 * hard cap, confirmed live: 1000 pointers/request). */
export function buildPointerBatches(min: number, max: number, batchSize = 1000): string[][] {
  const all: string[] = [];
  for (let x = min; x <= max; x++) {
    for (let y = min; y <= max; y++) all.push(`${x},${y}`);
  }
  const out: string[][] = [];
  for (let i = 0; i < all.length; i += batchSize) out.push(all.slice(i, i + batchSize));
  return out;
}

function parsePointer(p: string): ParcelPresence | null {
  const m = String(p).match(/(-?\d+)\s*,\s*(-?\d+)/);
  if (!m) return null;
  return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
}

/** Extracts the fields we care about from one Catalyst active-scene entity:
 * every parcel it currently occupies, and its display name if any. Mirrors
 * the same metadata shape sync-map-changes already reads. */
export function extractEntityPresence(entity: ActiveEntity): EntityPresence {
  const md = entity.metadata || {};
  const name = (md.display && md.display.title) || (md.scene && md.scene.name) || md.name || null;
  const rawPointers = (md.scene && md.scene.parcels) || entity.pointers || [];
  const parcels = rawPointers.map(parsePointer).filter((p): p is ParcelPresence => p !== null);
  return { entityId: entity.id, name, parcels };
}

/** Flattens a batch of active entities into one row per parcel (deduping if
 * the same parcel somehow appears in more than one entity in a batch — keeps
 * the last one seen, consistent with "current state wins"). */
export function flattenToParcelRows(entities: EntityPresence[]): Map<string, { x: number; y: number; scene_entity_id: string; scene_name: string | null }> {
  const rows = new Map<string, { x: number; y: number; scene_entity_id: string; scene_name: string | null }>();
  for (const e of entities) {
    for (const p of e.parcels) {
      rows.set(`${p.x},${p.y}`, { x: p.x, y: p.y, scene_entity_id: e.entityId, scene_name: e.name });
    }
  }
  return rows;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
