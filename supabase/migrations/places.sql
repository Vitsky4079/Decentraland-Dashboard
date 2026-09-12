-- =============================================================
-- Decentraland Map — named places (the "scenes" shown as markers on the map)
-- Paste into Supabase: SQL Editor → New query → Run.
-- Safe to re-run (idempotent). Also folded into supabase/schema.sql.
--
-- Written by: sync-places (Edge Function, service-role key, bypasses RLS).
-- Read by:    map.html / assets/map.js (get_places_in_bbox / get_place RPCs, anon key).
--
-- Source of truth: Decentraland's official Places API
-- (https://places.decentraland.org/api/places) — the same curated, named-scene
-- directory (title/description/image/categories) that backs the official
-- Decentraland map's marker pins. Distinct from land_parcels (raw LAND
-- ownership/type) — this is "what's actually here", not just "who owns it".
-- =============================================================

create table if not exists public.places (
  id            text primary key,
  title         text,
  description   text,
  image         text,
  base_x        integer not null,
  base_y        integer not null,
  categories    text[] not null default '{}',
  likes         integer,
  favorites     integer,
  deployed_at   timestamptz,
  updated_at    timestamptz not null default now()
);
create index if not exists places_base_xy_idx on public.places (base_x, base_y);

alter table public.places enable row level security;
drop policy if exists "public read" on public.places;
create policy "public read" on public.places for select using (true);

-- Lightweight marker list for a map viewport.
create or replace function public.get_places_in_bbox(
  p_min_x integer, p_max_x integer, p_min_y integer, p_max_y integer, p_limit integer default 800
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(row_to_json(p)), '[]'::jsonb)
  from (
    select id, title, image, base_x, base_y, categories
    from public.places
    where base_x >= p_min_x and base_x <= p_max_x and base_y >= p_min_y and base_y <= p_max_y
    order by favorites desc nulls last
    limit p_limit
  ) p;
$$;
grant execute on function public.get_places_in_bbox(integer, integer, integer, integer, integer) to anon, authenticated;

-- Full detail for one place, for the marker click panel.
create or replace function public.get_place(p_id text)
returns jsonb
language sql
stable
as $$
  select to_jsonb(p) from public.places p where p.id = p_id;
$$;
grant execute on function public.get_place(text) to anon, authenticated;
