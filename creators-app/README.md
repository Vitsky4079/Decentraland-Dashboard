# creators-app

The website at `drive.decentraland-dashboard.org` -- upload media, get a
permanent URL to paste into a Decentraland scene. Supabase for auth/metadata, the
sibling `media-worker/` (Cloudflare Worker + R2) for actual file storage/serving.

Deployed as its own Vercel project pointed at this subdirectory, independent from
the main static site -- see the root README for why.

**No login/signup pages here on purpose.** The main site (`../account.html` +
`../assets/auth.js`) is the one place users sign up/log in -- one account works on
both, via a session cookie shared across `.decentraland-dashboard.org`. This app
just checks for that cookie (`middleware`/`proxy.ts` + `lib/supabase/server.ts`) and
redirects to the main site's `/account` if it's missing. If you ever see this app
grow its own login form, something's gone wrong -- fix the SSO wiring instead
(`lib/supabase/cookie-domain.ts` has both the shared cookie domain and the shared
storage key, which have to exactly match `assets/auth.js`'s or sessions silently
won't be recognized across the two apps).

## How an upload works

1. Browser reads the first ~32 bytes of the file and POSTs them + metadata to
   `/api/upload/request`.
2. That route sniffs the real file type from those bytes (never trusts the
   client's claimed type/extension), checks it's an allowed type, checks size and
   quota, then asks `media-worker` to mint a short-lived token that can write to
   exactly one new object.
3. Browser PUTs the full file straight to `media-worker`, not through this app --
   Vercel's request-size limits would choke on a video file otherwise.
4. Browser POSTs to `/api/upload/complete`, which independently HEADs the public
   URL to get the real stored size/type from R2 (not whatever the client says) and
   writes the `media_files` row.

## Local setup

```bash
npm install
cp .env.local.example .env.local   # fill in the blanks, see below
npm run dev
```

Env vars (`.env.local`):
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` -- same Supabase
  project the main site uses (Project Settings -> API). Safe to share, not secrets.
- `SUPABASE_SERVICE_ROLE_KEY` -- a real secret. Needed for every write (recording
  uploads, rename, delete) since those all go through server-side routes that
  bypass RLS on purpose, rather than trusting the client to write its own rows.
- `MEDIA_WORKER_URL` -- `media-worker`'s URL (`http://127.0.0.1:5250` for local dev
  against `npm run dev` in that project, the real domain once deployed).
- `MEDIA_WORKER_ADMIN_SECRET` -- must match that worker's `ADMIN_SECRET`.
- `NEXT_PUBLIC_MAIN_SITE_URL` -- where to send unauthenticated visitors to log in
  (defaults to `https://decentraland-dashboard.org`; leave unset locally unless
  you're running the main site locally too).
- `NEXT_PUBLIC_COOKIE_DOMAIN` -- leave **blank** for local dev. A browser rejects a
  cookie Domain that doesn't match the current host, so this only makes sense set to
  `.decentraland-dashboard.org` on the real production deployment.

## Before this can go live

1. Apply `supabase/migrations/creator_media.sql` (or the matching section of
   `supabase/schema.sql`) to the Supabase project -- creates `user_profiles`,
   `media_files`, the auto-profile-on-signup trigger, and the quota RPC. Also flip
   `is_admin` on for whichever account(s) already use `admin.html` -- see the note
   at the bottom of that migration file.
2. Deploy `media-worker` (see its own README) and point
   `media.decentraland-dashboard.org` at it.
3. Set this app's real env vars in Vercel (including `NEXT_PUBLIC_COOKIE_DOMAIN=.decentraland-dashboard.org`)
   and deploy this subdirectory as its own Vercel project on
   `drive.decentraland-dashboard.org`.
4. In Supabase Auth settings, confirm email confirmation / redirect URLs are
   configured for the real domain (signup currently expects an email-confirmation
   link, per `supabase.auth.signUp`'s default behavior).

## Not built yet

- Google/wallet login -- email+password only for now; Supabase makes adding Google
  a small, separate addition later if wanted.
- Per-user default quota (5 GiB, set in the migration) isn't adjustable from any
  UI yet -- would need an admin action or a self-serve upgrade flow.
- No thumbnails/previews in the file list, just name/type/size/URL.
- The personalized ticket view mentioned on `/account` is just a stated direction,
  not built -- nothing wallet- or ticket-related exists yet beyond that one sentence
  of copy.
