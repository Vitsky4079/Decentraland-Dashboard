# Decentraland Map — Daily Scene Changes

This extends the `/map` page (`map.html` / `assets/map.js`) with: our own independent
base map rendered from Decentraland's official LAND data, a persisted history of scene
deployments (changed-parcel overlay over 24h/7d/30d/custom windows, a "Latest changes"
sidebar, a per-parcel history panel), and an optional genesis.city photo/historical
imagery comparison.

**We do NOT render Decentraland scenes ourselves.** The base map is rendered from
Decentraland's own **official parcel dataset** (ownership/type/estates — see "Base map"
below), not a 3D screenshot. genesis.city (MIT,
[genesis-city/genesis.city](https://github.com/genesis-city/genesis.city)) provides an
**optional** "Photo view" layer of its own periodic 3D-scene renders, off by default. The
[Decentraland Catalyst](https://decentraland.github.io/catalyst-api-specs/) content
servers provide scene deployment/change information; we only read from all of these, we
don't run any of them.

## Base map — official parcel data, not genesis.city

genesis.city's photo tiles depend on a single community member's Netlify hosting, whose
custom-domain TLS certificate broke (confirmed via `openssl s_client -connect
genesis.city:443 -servername genesis.city`, returning Netlify's generic `*.netlify.app`
cert) — outside anyone's control from this repo. Rather than depend on that for the
*primary* map, the base layer is rendered from **Decentraland's own official Atlas/Tile
API** (`https://assets-cdn.decentraland.org/tiles/v2/latest.json`, run by Decentraland
Foundation on its own CDN — the same dataset behind their marketplace map): all 92,598
LAND parcels' `type` (district/road/plaza/owned), `owner`, `name`, and `estateId`. This
is arguably *more* accurate than a photo render, since it reflects live on-chain
ownership rather than a snapshot that can be well over a year stale.

- `supabase/functions/sync-land-parcels` — daily full-refresh sync of that ~13–38MB
  dataset into `land_parcels` (see `supabase/migrations/land_parcels.sql`). No
  checkpoint/incremental logic needed — it's a snapshot, and ownership can change for
  any parcel any day, so every run just upserts current state.
- `api/map/land-tile.js` — a Vercel function that renders one SVG tile per
  `(z, x, y)` OpenLayers request (`/api/map/land-tile?z={z}&x={x}&y={y}`), querying only
  the parcels in that tile's bounding box from `land_parcels` via PostgREST **with the
  anon key** (the table is public-read, so this endpoint needs no secrets at all).
  Same-estate/district parcels are drawn borderless on their shared edge (using the
  `edge_top`/`edge_left` flags from the official data) so they read as one merged shape.
  Cached at Vercel's edge for 6h (`s-maxage=21600`) since the data only changes daily.
  Capped at 8,000 parcels/tile as a safety valve at extreme zoomed-out levels — see
  "Known caps" below.
- `api/_lib/mapGrid.js` — the tile-grid math (bounding box for a given tile, and a
  parcel's position within it), a plain-Node port of the same constants
  `assets/map.js` already uses for genesis.city's grid (61×61 tiles, 200px, zoom 6) —
  same coordinate system, just computed server-side instead of in the browser.
- genesis.city's photo tiles are still available as an **opt-in "Photo view" toggle**
  (unchecked by default) layered on top, for when someone wants to see actual rendered
  scene content and genesis.city happens to be up.

## Architecture

```
Vercel Cron (vercel.json)
  -> api/cron/sync-land.js  (05:00 UTC)  -> supabase/functions/sync-land-parcels
       - fetches Decentraland's official tiles/v2/latest.json (~92,598 parcels)
       - full-refresh upsert into land_parcels (no checkpoint — it's a snapshot)
  -> api/cron/sync-map.js   (06:00 UTC)  -> supabase/functions/sync-map-changes
       - reads map_sync_state.last_successful_sync as its checkpoint
       - pages the Catalyst /content/pointer-changes feed (entityType=scene)
       - resolves each new entity's name/base parcel/full parcel list via
         GET {catalyst}/contents/{entityId}
       - upserts scene_deployments + scene_deployment_parcels (idempotent on
         entity_id), then recomputes map_daily_stats for every UTC day touched
       - only advances the checkpoint once the whole run succeeds
Both relay functions check Vercel's own CRON_SECRET, then forward to their Edge
Function with a shared MAP_SYNC_SECRET header.

Frontend (map.html / assets/map.js):
  - base map: api/map/land-tile.js renders SVG tiles from land_parcels (anon key,
    no secrets — that table is public read)
  - scene-change history: 3 read-only RPCs (get_map_changes, get_parcel_history,
    get_map_daily_stats) + get_parcel_info, called with plain `fetch` + the anon
    key — the same pattern assets/dcl.js already uses for get_site_content().
```

Why this shape: the rest of this repo already keeps anything that needs a secret in a
Supabase Edge Function (see `supabase/functions/github-issues`), and reads anything
public straight from PostgREST/RPC with the anon key. This feature reuses both patterns
instead of introducing a new Vercel API layer for reads, or a Next.js/build step this
repo deliberately doesn't have.

## Catalyst notes (things that weren't obvious from the docs)

- `pointer-changes` pagination is fast and reliable walking **backward** in its default
  order (`sortingOrder=DESC`, newest first). A full ascending walk from an old
  checkpoint was observed to time out (Cloudflare 524) against the live API — the sync
  function always walks DESC and stops itself once it crosses the lower bound it needs,
  rather than trusting an unbounded ascending scan.
- The `pagination.next` string the API returns drops any `sortingField`/`sortingOrder`
  you requested, so blindly re-fetching it can silently flip you back to the default
  order. The sync function reconstructs the next page's `to`+`lastId` itself instead of
  following that string literally.
- `pointer-changes` deltas do **not** carry a "previous entity" field. `previous_entity_id`
  is derived by us: whatever this sync run (or our own DB, at the run's start) knows was
  most recently deployed at the same base parcel.
- A single scene can span many parcels (`metadata.scene.parcels`) — one deployment
  record is stored once, with its full parcel list in `scene_deployment_parcels`, not
  once per parcel.

## Data model (`supabase/migrations/map_changes.sql`, folded into `supabase/schema.sql`)

| Table | Purpose |
|---|---|
| `map_sync_state` | Singleton checkpoint (`last_successful_sync`) for the incremental sync. |
| `scene_deployments` | One row per Catalyst scene deployment: entity id, previous entity id, timestamps, base parcel, name, metadata. |
| `scene_deployment_parcels` | Every parcel a deployment touches (many rows per deployment). |
| `map_daily_stats` | Per-UTC-day rollup: deployment/scene/parcel counts, recomputed (not incremented) whenever that day is touched. |
| `land_parcels` (`supabase/migrations/land_parcels.sql`) | Official ownership/type/estate data for all 92,598 parcels — full-refreshed daily. Read by `api/map/land-tile.js` (the base map) and `get_parcel_info`. |

Read RPCs (anon key, called from the browser):
- `get_map_changes(p_from, p_to, p_limit, p_offset)` — deployments + parcel lists in a
  window, newest first. Powers both the map overlay and the sidebar.
- `get_parcel_history(p_x, p_y)` — every deployment that ever touched one parcel.
- `get_map_daily_stats(p_from, p_to)` — daily counts, for future "browse by day" UI.
- `get_parcel_info(p_x, p_y)` — one parcel's official type/name/owner/estate, shown at
  the top of the parcel click panel alongside its deployment history.

Write path: only the Edge Function, using the Supabase-injected
`SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS). There is deliberately no anon/authenticated
write policy on any of these tables.

## Required environment variables

| Where | Variable | Notes |
|---|---|---|
| Vercel project | `CRON_SECRET` | Any random string. Vercel automatically sends it as `Authorization: Bearer <value>` on cron-triggered requests once set — `api/cron/sync-map.js` checks it. |
| Vercel project | `SUPABASE_URL` | Same project URL already in `assets/config.js`. |
| Vercel project | `MAP_SYNC_SECRET` | Any random string, must match the Supabase secret below. |
| Supabase secret | `MAP_SYNC_SECRET` | `supabase secrets set MAP_SYNC_SECRET=<same value>` |
| Supabase (auto) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Injected into every Edge Function automatically — nothing to set. |

`sync-land-parcels` and `api/cron/sync-land.js` reuse these exact same 3 Vercel vars and
the same Supabase secret — nothing new to configure for the base map on top of what the
scene-change history already needed.

## One-time setup

1. **SQL**: Supabase → SQL Editor → paste `supabase/schema.sql` (or just the two
   `supabase/migrations/*.sql` files if the rest of the schema is already applied) → Run.
2. **Deploy the Edge Functions**:
   ```bash
   supabase functions deploy sync-map-changes --no-verify-jwt
   supabase functions deploy sync-land-parcels --no-verify-jwt
   ```
3. **Secret**: `supabase secrets set MAP_SYNC_SECRET=<a random string>` (shared by both functions)
4. **Vercel env vars**: add `CRON_SECRET`, `SUPABASE_URL`, `MAP_SYNC_SECRET` (Project →
   Settings → Environment Variables), then redeploy so the cron functions pick them up.
5. **Confirm Vercel Cron is enabled** for this project's plan (Project → Settings →
   Cron Jobs) — `vercel.json` already declares both daily jobs (land data at 05:00 UTC,
   scene changes at 06:00 UTC).
6. **Backfill** (optional but recommended so the map isn't empty on day one):
   ```bash
   # Official parcel data — always a full refresh, no from/to needed:
   curl -H "x-sync-secret: $MAP_SYNC_SECRET" "https://<project>.supabase.co/functions/v1/sync-land-parcels"
   # Scene-deployment history — explicit range, chunked internally, doesn't touch
   # the incremental checkpoint:
   curl -H "x-sync-secret: $MAP_SYNC_SECRET" \
     "https://<project>.supabase.co/functions/v1/sync-map-changes?from=<ms-epoch>&to=<ms-epoch>"
   ```
   With no `from`/`to`, the first incremental scene-change sync defaults to the last 30 days.

## Coordinate conversion

Unchanged — see the comments at the top of `assets/map.js` (genesis.city's own tile
grid: 61×61 tiles of 200px, zoom 6, `toPx`/`toCoord` helpers). This feature only adds a
second vector layer (`changesLayer`) drawing one polygon per parcel using those same
helpers; it doesn't touch the tile math.

## Historical imagery — limitations

genesis.city's own "Time Machine" uses a small **hardcoded** list of snapshot dates
(there is no API for arbitrary dates), served from
`https://media.githubusercontent.com/media/genesis-city/parcels/master/maps/<date>/...`.
That list is mirrored in `assets/map.js` (`HISTORICAL_SNAPSHOTS`). As of this writing the
newest snapshot is **2024-08-20** — genesis.city has not published a newer one since, so
"before/after" comparisons are only ever against one of these fixed dates, not an
arbitrary day picked from the change history. If a snapshot ever stops resolving, the UI
shows "Historical rendered imagery unavailable for this date" rather than a broken image.

`map/latest/{z}/{x},{y}.jpg` (genesis.city's "Photo view" toggle, off by default) is
genesis.city's own continuously-updated render and is not affected by the historical-
snapshot limitation above; it can also be browser/CDN-cached, so a just-deployed scene's
tile may take a little while to visibly update there — a genesis.city-side
rendering/caching delay, not something this feature controls. It's no longer the base
layer, so genesis.city's uptime doesn't affect the map's default appearance at all.

## Known caps / simplifications

- `get_map_changes` is capped at 500 rows per call; the UI shows a `+` suffix on the
  summary cards when the cap is hit. Fine for 24h/7d/30d windows in practice; a busier
  future could raise the cap or add real pagination.
- The Edge Function backfill mode processes at most 500 Catalyst pages per 7-day chunk
  as a safety valve against an unbounded loop; this has a very large margin over
  realistic deployment volume.
- `api/map/land-tile.js` caps each tile's parcel query at 8,000 rows. At very zoomed-out
  levels a single tile can geometrically cover more parcels than that (the whole city is
  only ~92,598 total), so the most zoomed-out level(s) may render a partial/sampled
  impression rather than every single parcel. Zooming in — where the feature is actually
  useful for inspecting ownership/type — always renders completely and precisely, since
  each tile then covers only a handful of parcels.
