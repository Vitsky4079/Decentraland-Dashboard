-- =============================================================
-- Decentraland Map — official LAND parcel data (ownership/type)
-- Paste into Supabase: SQL Editor → New query → Run.
-- Safe to re-run (idempotent). Also folded into supabase/schema.sql.
--
-- Written by: sync-land-parcels (Edge Function, service-role key, bypasses RLS).
-- Read by:    api/map/land-tile.js (Vercel, anon key — this table is public read,
--             so the tile renderer needs no secrets at all) and
--             map.html / assets/map.js (get_parcel_info RPC, anon key).
--
-- Source of truth: Decentraland's own official Atlas/Tile API
-- (https://assets-cdn.decentraland.org/tiles/v1/latest.json), NOT genesis.city —
-- see docs/DECENTRALAND_MAP.md for why.
-- =============================================================

create table if not exists public.land_parcels (
  x              integer not null,
  y              integer not null,
  type           text not null,       -- 'district' | 'road' | 'plaza' | 'owned'
  name           text,
  owner          text,
  estate_id      text,
  edge_top       boolean not null default false,  -- true = same group as the parcel above (no border needed)
  edge_left      boolean not null default false,  -- true = same group as the parcel to the left
  edge_top_left  boolean not null default false,
  updated_at     timestamptz not null default now(),
  primary key (x, y)
);
create index if not exists land_parcels_type_idx on public.land_parcels (type);

alter table public.land_parcels enable row level security;
drop policy if exists "public read" on public.land_parcels;
create policy "public read" on public.land_parcels for select using (true);

-- Single-parcel lookup for the click panel (ownership/estate/type alongside our
-- own scene-deployment history from get_parcel_history).
create or replace function public.get_parcel_info(p_x integer, p_y integer)
returns jsonb
language sql
stable
as $$
  select to_jsonb(p) - 'x' - 'y'
  from public.land_parcels p
  where p.x = p_x and p.y = p_y;
$$;
grant execute on function public.get_parcel_info(integer, integer) to anon, authenticated;
