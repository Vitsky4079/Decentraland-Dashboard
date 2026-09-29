-- =============================================================
-- Unified site accounts + creator media hosting.
-- Paste into Supabase: SQL Editor → New query → Run.
-- Safe to re-run (idempotent). Also folded into supabase/schema.sql.
--
-- One account works across the whole decentraland-dashboard.org domain (the main
-- site and drive.decentraland-dashboard.org share this Supabase project and a
-- session cookie scoped to .decentraland-dashboard.org -- see assets/auth.js and
-- creators-app/src/lib/supabase/*.ts). user_profiles is every signed-up user, not
-- just people who've uploaded something -- media_files is the creator-specific part.
--
-- The actual files live on Cloudflare R2 (media-worker/), never in Supabase --
-- media_files is metadata only: who uploaded what, how big it is, and where to find it.
-- Written by:  creators-app's server-side API routes (service-role key, after
--              validating auth + quota + MIME + size -- never directly by the client).
-- Read by:     creators-app dashboard and the main site (anon key, RLS-scoped to auth.uid()).
-- =============================================================

-- One row per signed-up user. Created automatically on signup (see trigger below).
-- wallet_address is left for later (linking a wallet for a personalized ticket view,
-- per the roadmap) -- not used by anything yet, added when that feature is actually built.
--
-- is_admin: BEFORE this migration, assets/dcl.js treated *any* logged-in, non-anonymous
-- Supabase session as an admin (admin.html was the only place anyone ever logged in, so
-- that was a safe enough shortcut). Once regular users can sign up too, that check would
-- wrongly grant admin UI to every one of them. is_admin is the real flag dcl.js checks
-- now -- see the updated applyAdminUI() there. Defaults false; existing admin account(s)
-- need this set to true manually once (see the note at the bottom of this file).
create table if not exists public.user_profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  is_admin     boolean not null default false,
  quota_bytes  bigint not null default 1073741824, -- 1 GiB default per-user media quota (~1000 users -> ~1TB of R2 storage)
  created_at   timestamptz not null default now()
);
alter table public.user_profiles add column if not exists is_admin boolean not null default false;
-- Quota lowered from the original 5 GiB default to 1 GiB, sized so ~1000 users tops
-- out around 1TB of R2 storage. Re-running this against a database that already has
-- rows at an older default brings them in line with the current one too.
alter table public.user_profiles alter column quota_bytes set default 1073741824;
update public.user_profiles set quota_bytes = 1073741824 where quota_bytes in (5368709120, 524288000);

alter table public.user_profiles enable row level security;
drop policy if exists "read own profile" on public.user_profiles;
create policy "read own profile" on public.user_profiles for select using (auth.uid() = id);
-- No insert/update/delete policy for authenticated users on purpose: profiles are
-- created by the trigger below, and is_admin/quota changes are an admin/service-role action.

-- Auto-create a profile row the moment someone signs up, so the app never has to
-- special-case "new user with no profile yet".
create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_creator_profile on auth.users;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.handle_new_user_profile();

-- Backfill: the trigger above only fires for *new* signups, but the admin account(s)
-- that already use admin.html predate this table entirely -- without this, they'd have
-- no user_profiles row (and so no is_admin) until they happened to trigger one some
-- other way. Safe to re-run; does nothing once everyone has a row.
insert into public.user_profiles (id)
select id from auth.users
where id not in (select id from public.user_profiles)
on conflict (id) do nothing;

-- ⚠️ One-time manual step: the account(s) already used to log into admin.html need
-- is_admin set to true explicitly -- this migration has no way to know which account(s)
-- those are. In the Supabase SQL editor:
--   update public.user_profiles set is_admin = true where id = '<uid from auth.users>';

-- One row per uploaded file. storage_key is the R2 object key (e.g. "<user_id>/<uuid>.<ext>");
-- url is the permanent public https URL handed back to the creator to paste into a scene.
create table if not exists public.media_files (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  storage_key    text not null unique,
  original_name  text not null,
  mime_type      text not null,
  kind           text not null check (kind in ('image', 'audio', 'video')),
  size_bytes     bigint not null check (size_bytes > 0),
  url            text not null,
  created_at     timestamptz not null default now()
);
create index if not exists media_files_user_id_idx on public.media_files (user_id);

alter table public.media_files enable row level security;
drop policy if exists "read own files" on public.media_files;
create policy "read own files" on public.media_files for select using (auth.uid() = user_id);
-- Mutations (insert on upload, update on rename, delete) all go through the app's
-- server-side API routes with the service-role key, which also has to delete the
-- matching R2 object -- so there's deliberately no direct insert/update/delete
-- policy for the authenticated role here.

-- Storage used per user, for the dashboard's quota bar and for the upload API to
-- check "does this user have room" before minting an upload token.
create or replace function public.get_storage_usage(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(size_bytes), 0) from public.media_files where user_id = p_user_id;
$$;
grant execute on function public.get_storage_usage(uuid) to authenticated;
