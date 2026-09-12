-- =============================================================
-- Decentraland Map — actual scene presence per parcel
-- Paste into Supabase: SQL Editor → New query → Run.
-- Safe to re-run (idempotent). Also folded into supabase/schema.sql.
--
-- Written by: sync-scene-presence (Edge Function, service-role key, bypasses RLS).
-- Read by:    api/map/land-tile.js (Vercel, anon key) and get_parcel_info.
--
-- land_parcels (official Atlas API) only encodes OWNERSHIP — most owned LAND
-- has nothing built on it. This adds whether a parcel currently has an active
-- deployed scene, from the Catalyst content server's /content/entities/active
-- endpoint (POST, up to 1000 pointers/request — the whole city takes ~93
-- requests), which is comprehensive (any scene ever deployed and still live),
-- unlike scene_deployments (only what our incremental sync has observed
-- change in roughly the last 30+ days).
-- =============================================================

alter table public.land_parcels add column if not exists has_scene boolean not null default false;
alter table public.land_parcels add column if not exists scene_entity_id text;
alter table public.land_parcels add column if not exists scene_name text;
create index if not exists land_parcels_has_scene_idx on public.land_parcels (has_scene) where has_scene;

-- A real UPDATE (not an upsert) so parcels the sweep finds that AREN'T in
-- land_parcels (Decentraland's real grid has ~427 gaps inside the nominal
-- -152..152 square) simply don't match, instead of failing on land_parcels'
-- NOT NULL `type` column the way a bulk upsert would (Postgres validates
-- NOT NULL for the attempted INSERT row before it even checks for a
-- conflict, so omitting `type` from an upsert payload breaks even for rows
-- that will end up just updating).
create or replace function public.apply_scene_presence(p_rows jsonb)
returns void
language sql
as $$
  update public.land_parcels lp
  set has_scene = true,
      scene_entity_id = r.scene_entity_id,
      scene_name = r.scene_name,
      updated_at = now()
  from jsonb_to_recordset(p_rows) as r(x integer, y integer, scene_entity_id text, scene_name text)
  where lp.x = r.x and lp.y = r.y;
$$;
grant execute on function public.apply_scene_presence(jsonb) to service_role;
