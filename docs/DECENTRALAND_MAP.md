# Decentraland Map — Daily Scene Changes

This extends the existing `/map` page (`map.html` / `assets/map.js`) — which already
renders the Genesis City tile pyramid and a live "deployed today" layer — with a
persisted history of scene deployments: a changed-parcel overlay over 24h/7d/30d/custom
windows, a "Latest changes" sidebar, a per-parcel deployment-history panel, and an
optional historical-imagery comparison.

**We do NOT render Decentraland scenes ourselves.** [genesis.city](https://genesis.city)
(MIT, [genesis-city/genesis.city](https://github.com/genesis-city/genesis.city)) renders
and hosts all map imagery; we only consume its tiles. The
[Decentraland Catalyst](https://decentraland.github.io/catalyst-api-specs/) content
servers provide scene deployment/change information; we only read from them.

## Architecture

```
Vercel Cron (vercel.json, daily 06:00 UTC)
  -> api/cron/sync-map.js            (thin relay: checks CRON_SECRET, forwards
                                       to the Edge Function with MAP_SYNC_SECRET)
  -> Supabase Edge Function          supabase/functions/sync-map-changes
       - reads map_sync_state.last_successful_sync as its checkpoint
       - pages the Catalyst /content/pointer-changes feed (entityType=scene)
       - resolves each new entity's name/base parcel/full parcel list via
         GET {catalyst}/contents/{entityId}
       - upserts scene_deployments + scene_deployment_parcels (idempotent on
         entity_id), then recomputes map_daily_stats for every UTC day touched
       - only advances the checkpoint once the whole run succeeds
Frontend (map.html / assets/map.js) reads the synced history straight from
Postgres via 3 read-only RPCs (get_map_changes, get_parcel_history,
get_map_daily_stats), called with plain `fetch` + the anon key — the same
pattern assets/dcl.js already uses for get_site_content().
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

Read RPCs (anon key, called from the browser):
- `get_map_changes(p_from, p_to, p_limit, p_offset)` — deployments + parcel lists in a
  window, newest first. Powers both the map overlay and the sidebar.
- `get_parcel_history(p_x, p_y)` — every deployment that ever touched one parcel.
- `get_map_daily_stats(p_from, p_to)` — daily counts, for future "browse by day" UI.

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

## One-time setup

1. **SQL**: Supabase → SQL Editor → paste `supabase/schema.sql` (or just
   `supabase/migrations/map_changes.sql` if the rest of the schema is already applied) → Run.
2. **Deploy the Edge Function**: `supabase functions deploy sync-map-changes --no-verify-jwt`
3. **Secret**: `supabase secrets set MAP_SYNC_SECRET=<a random string>`
4. **Vercel env vars**: add `CRON_SECRET`, `SUPABASE_URL`, `MAP_SYNC_SECRET` (Project →
   Settings → Environment Variables), then redeploy so the cron function picks them up.
5. **Confirm Vercel Cron is enabled** for this project's plan (Project → Settings →
   Cron Jobs) — `vercel.json` already declares the daily 06:00 UTC job.
6. **Backfill** (optional but recommended so the map isn't empty on day one) — call the
   Edge Function directly with an explicit range (chunked internally, doesn't touch the
   incremental checkpoint):
   ```bash
   curl -H "x-sync-secret: $MAP_SYNC_SECRET" \
     "https://<project>.supabase.co/functions/v1/sync-map-changes?from=<ms-epoch>&to=<ms-epoch>"
   ```
   With no `from`/`to`, the first incremental run defaults to the last 30 days.

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

`map/latest/{z}/{x},{y}.jpg` (the base layer) is genesis.city's own continuously-updated
render and is not affected by this limitation; it can also be browser/CDN-cached, so a
just-deployed scene's tile may take a little while to visibly update — this is a
genesis.city-side rendering/caching delay, not something this feature controls.

## Known caps / simplifications

- `get_map_changes` is capped at 500 rows per call; the UI shows a `+` suffix on the
  summary cards when the cap is hit. Fine for 24h/7d/30d windows in practice; a busier
  future could raise the cap or add real pagination.
- The Edge Function backfill mode processes at most 500 Catalyst pages per 7-day chunk
  as a safety valve against an unbounded loop; this has a very large margin over
  realistic deployment volume.
