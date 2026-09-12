# Decentraland Map — Daily Scene Changes

This extends the `/map` page (`map.html` / `assets/map.js`) with: our own independent
base map rendered from Decentraland's official LAND data, a persisted history of scene
deployments (changed-parcel overlay over 24h/7d/30d/custom windows, a "Latest changes"
sidebar, a per-parcel history panel), and an optional genesis.city photo/historical
imagery comparison.

**We do NOT render Decentraland scenes ourselves.** The default base map is real,
current, official Decentraland tile imagery — see "Base map" below for exactly where
that comes from (it is not genesis.city). The [Decentraland
Catalyst](https://decentraland.github.io/catalyst-api-specs/) content servers provide
scene deployment/change information; we only read from all of these, we don't run any
of them.

## Base map — the actual desktop-client satellite tiles, not genesis.city

The default "Current map" view is **the same live tile set the official Decentraland
desktop client renders**, found by reading the client's own source
(`decentraland/unity-explorer`, `SatelliteChunkController.cs`):

```
https://media.githubusercontent.com/media/genesis-city/parcels/new-client-images/maps/lod-0/{z}/{x},{y}.jpg
```

This is **not** `genesis.city` — different host (GitHub's own media CDN, valid
certificate), different branch (`new-client-images`, not `master`), continuously updated
by Decentraland/genesis.city, and it happens to line up almost exactly with the tile
grid `assets/map.js` already uses for genesis.city (`lod-0` level *N* is a `2^N × 2^N`
grid covering the same extent as our own `resolutions[N]` — levels 1–6 map directly onto
our existing zoom levels, tile-index for tile-index, no coordinate conversion needed).
Verified live: fetching all 64 level-3 tiles returns 200, and the level-3 tile at index
(3,3)/(4,4) — the geometric center of the grid — visibly contains Genesis Plaza's
checkered floor, confirming the alignment.

genesis.city's *own* domain has a broken TLS certificate (confirmed via `openssl
s_client -connect genesis.city:443 -servername genesis.city`, returning Netlify's
generic `*.netlify.app` cert instead of one for `genesis.city`) — that's what "Live
photo (genesis.city, legacy)" points at, kept only as a fallback-tested legacy option
since it predates this discovery. The satellite tiles above don't have this problem at
all, which is why they're the default.

The map view switcher (`assets/map.js`, `setMapView`) shows exactly one of these,
never blended:
- **Current map** (default) — the satellite tiles above.
- **Ownership colors (official data)** — our own rendering from Decentraland's official
  Atlas/Tile API (`https://assets-cdn.decentraland.org/tiles/v2/latest.json`): `type`
  (district/road/plaza/owned), `owner`, `name`, `estateId` for all 92,598 parcels, plus
  our own `has_scene`/`scene_name` (see "Scene presence" below). Useful when you want
  ownership/type information rather than photography.
  - `supabase/functions/sync-land-parcels` — daily full-refresh sync into `land_parcels`
    (see `supabase/migrations/land_parcels.sql`). No checkpoint needed — it's a
    snapshot, and ownership can change for any parcel any day.
  - `api/map/land-tile.js` — a Vercel function rendering one SVG tile per `(z,x,y)`
    OpenLayers request, querying only that tile's bbox from `land_parcels` via
    PostgREST with the **anon key** (public-read table, no secrets needed). Same-estate/
    district parcels are drawn borderless on their shared edge (`edge_top`/`edge_left`)
    so they read as one merged shape. Edge-cached 6h. Below 8px/parcel, texture/borders
    are skipped entirely (flat fill only) — a zoomed-out tile was measured carrying
    900+ individually textured+bordered parcels before this, which is what made the map
    feel laggy.
  - `api/_lib/mapGrid.js` — the tile-grid math, a plain-Node port of the same constants
    `assets/map.js` uses (61×61 tiles, 200px, zoom 6).
- **Live photo (genesis.city, legacy)** — auto-falls-back to "Current map" with a note
  if it fails to load (it currently always will, until they fix their cert).
- **Historical dates** — genesis.city's own small hardcoded snapshot list, unaffected
  by the live-domain cert issue since it's served from the same `media.githubusercontent.com`
  host as the satellite tiles, just a different branch/path (see below).

## Named places — the actual "scenes" on the map

`land_parcels` only encodes ownership/type — it can't tell you *what* (if anything) is
built somewhere, since most owned LAND is undeveloped. What actually reads as "a scene"
on Decentraland's own official map is its separate, curated **Places** directory
(`https://places.decentraland.org/api/places`): ~24,400 named entries with a title,
description, thumbnail image, and category (poi/art/game/social/shop/etc. — the same
categories as the filter tabs on Decentraland's own map).

- `supabase/functions/sync-places` — daily full-refresh sync (same reasoning as
  `sync-land-parcels`: it's a snapshot, not a change feed) into `places` (see
  `supabase/migrations/places.sql`). Paginates the API in batches of 100 (its own hard
  cap) with limited concurrency; skips `disabled` and `world` (Worlds have no Genesis
  City x/y) entries.
- Frontend: a clustered marker layer (`ol.source.Cluster`, star icon for a single place,
  a numbered badge for a cluster) loaded per-viewport via `get_places_in_bbox`,
  re-fetched (debounced) on pan/zoom — same "only load what's visible" principle as the
  changed-parcel overlay. Clicking a single marker shows its title/thumbnail/categories
  and a "Jump into Decentraland" link, plus the same deployment-history link the parcel
  popup already has. Clicking a cluster zooms in to split it apart.

## Scene presence — which LAND actually has something built on it

Places (above) is curated and named, but far from every deployed scene is in that
directory. To answer "does *this* parcel have anything built on it at all" comprehensively,
`land_parcels` also carries `has_scene`/`scene_entity_id`/`scene_name`
(`supabase/migrations/scene_presence.sql`), filled in by `supabase/functions/
sync-scene-presence`: a full sweep of the Catalyst content server's
`POST /content/entities/active` (up to 1000 pointers/request, confirmed live — the whole
city takes ~93 requests), which returns the actual currently-active scene at each
pointer. Unlike `scene_deployments` (only what our incremental Catalyst sync has
*observed change* in roughly the last 30+ days), this reflects every scene that is
*currently* live, no matter how long ago it was deployed — found via
[decentraland/deployment-map](https://github.com/decentraland/deployment-map), an old
Decentraland-Foundation repo built for exactly this ("Map showing LAND with deployed
content"), whose own legacy endpoint (`content.decentraland.org/scenes?x1=&y1=...`) is
retired, but the modern equivalent (`entities/active` with an explicit pointer list) still
works.

- Full-refresh sweep, same reasoning as `sync-land-parcels`/`sync-places`: resets
  `has_scene=false` on every previously-flagged parcel first, then re-marks whatever the
  sweep finds — so a scene that's been taken down stops showing as built.
- `api/map/land-tile.js` renders a warm highlight over any parcel with `has_scene=true`,
  and prefers `scene_name` over the district/estate `name` for the on-tile label —
  real content over ownership metadata. The parcel click panel
  (`get_parcel_info`) shows "Has a scene: `<name>`" or "No scene currently deployed here".

## Architecture

```
Vercel Cron (vercel.json)
  -> api/cron/sync-land.js   (05:00 UTC)  -> supabase/functions/sync-land-parcels
       - fetches Decentraland's official tiles/v2/latest.json (~92,598 parcels)
       - full-refresh upsert into land_parcels (no checkpoint — it's a snapshot)
  -> api/cron/sync-scenes.js (05:15 UTC)  -> supabase/functions/sync-scene-presence
       - sweeps Catalyst POST /content/entities/active across the whole city
         (1000 pointers/request, ~93 requests) for every currently-active scene
       - resets has_scene=false, then re-marks land_parcels rows found built
  -> api/cron/sync-places.js (05:30 UTC)  -> supabase/functions/sync-places
       - fetches Decentraland's official Places API (~24,400 named scenes), paginated
       - full-refresh upsert into places (no checkpoint — it's a snapshot)
  -> api/cron/sync-map.js    (06:00 UTC)  -> supabase/functions/sync-map-changes
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
  - named places: get_places_in_bbox (+ get_place for detail) — clustered markers,
    reloaded per-viewport on pan/zoom
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
| `places` (`supabase/migrations/places.sql`) | Official curated named-scene directory (~24,400 rows: title/description/image/categories) — full-refreshed daily. Read by `get_places_in_bbox`/`get_place`. |

Read RPCs (anon key, called from the browser):
- `get_map_changes(p_from, p_to, p_limit, p_offset)` — deployments + parcel lists in a
  window, newest first. Powers both the map overlay and the sidebar.
- `get_parcel_history(p_x, p_y)` — every deployment that ever touched one parcel.
- `get_map_daily_stats(p_from, p_to)` — daily counts, for future "browse by day" UI.
- `get_parcel_info(p_x, p_y)` — one parcel's official type/name/owner/estate, shown at
  the top of the parcel click panel alongside its deployment history.
- `get_places_in_bbox(p_min_x, p_max_x, p_min_y, p_max_y, p_limit)` — named-place markers
  in the current viewport. `get_place(p_id)` — full detail for one place.

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

`sync-land-parcels`/`sync-places` and their `api/cron/*.js` relays reuse these exact same
3 Vercel vars and the same Supabase secret — nothing new to configure on top of what the
scene-change history already needed.

## One-time setup

1. **SQL**: Supabase → SQL Editor → paste `supabase/schema.sql` (or just the
   `supabase/migrations/*.sql` files if the rest of the schema is already applied) → Run.
2. **Deploy the Edge Functions**:
   ```bash
   supabase functions deploy sync-map-changes --no-verify-jwt
   supabase functions deploy sync-land-parcels --no-verify-jwt
   supabase functions deploy sync-scene-presence --no-verify-jwt
   supabase functions deploy sync-places --no-verify-jwt
   ```
3. **Secret**: `supabase secrets set MAP_SYNC_SECRET=<a random string>` (shared by all four functions)
4. **Vercel env vars**: add `CRON_SECRET`, `SUPABASE_URL`, `MAP_SYNC_SECRET` (Project →
   Settings → Environment Variables), then redeploy so the cron functions pick them up.
5. **Confirm Vercel Cron is enabled** for this project's plan (Project → Settings →
   Cron Jobs) — `vercel.json` already declares all four daily jobs (land data 05:00 UTC,
   scene presence 05:15 UTC, places 05:30 UTC, scene changes 06:00 UTC).
6. **Backfill** (optional but recommended so the map isn't empty on day one):
   ```bash
   # Official parcel data, scene presence, and places — always a full refresh, no from/to needed:
   curl -H "x-sync-secret: $MAP_SYNC_SECRET" "https://<project>.supabase.co/functions/v1/sync-land-parcels"
   curl -H "x-sync-secret: $MAP_SYNC_SECRET" "https://<project>.supabase.co/functions/v1/sync-scene-presence"
   curl -H "x-sync-secret: $MAP_SYNC_SECRET" "https://<project>.supabase.co/functions/v1/sync-places"
   # Scene-deployment history — explicit range, chunked internally, doesn't touch
   # the incremental checkpoint:
   curl -H "x-sync-secret: $MAP_SYNC_SECRET" \
     "https://<project>.supabase.co/functions/v1/sync-map-changes?from=<ms-epoch>&to=<ms-epoch>"
   ```
   With no `from`/`to`, the first incremental scene-change sync defaults to the last 30 days.
   Run `sync-land-parcels` before `sync-scene-presence` the first time — the presence sync
   only updates rows that already exist.

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
- `get_places_in_bbox` is capped at 800 rows per call, ordered by favorite count, so a
  very zoomed-out view showing thousands of places surfaces the most-favorited ones
  first rather than an arbitrary subset.
- District/estate name labels on the base map (`api/map/land-tile.js`) can get clipped
  at a tile's edge if the group's labeled corner parcel sits right on the boundary —
  cosmetic only, doesn't affect the coloring/data itself.
