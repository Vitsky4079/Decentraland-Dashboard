# Decentraland Community Status

Community status board for Decentraland: known issues, feature requests,
fixes, workarounds, patch notes, service health and the asset-bundle
conversion queue — live from public APIs, curated through a real admin panel.

**Architecture:** static frontend (vanilla JS, no build step) + Supabase
(database + admin login) + Vercel (hosting, auto-deploys from GitHub).
Content edits happen in the admin panel and are live instantly — no commits,
no redeploys. Code changes go through the GitHub repo and deploy automatically.

```
index.html / issues.html / features.html / fixed.html /
workarounds.html / bundles.html / report.html / admin.html
assets/config.js     project configuration (Supabase keys, repos, endpoints)
assets/dcl.js        site logic (GitHub data + Supabase content merge)
assets/admin.js      admin panel (Supabase Auth + instant saves)
assets/dcl.css       styles
supabase/schema.sql  database schema — paste once into Supabase
```

## One-time setup (~20 minutes)

### 1. Supabase (database + login)
1. Create a free project at supabase.com.
2. **SQL Editor → New query** → paste the entire `supabase/schema.sql` → Run.
   You should see "Success". This creates the tables, the security rules
   (public read / admin-only write) and the content API.
3. **Project Settings → API**: copy the **Project URL** and the **anon public
   key** into `assets/config.js` → `supabase: { url, anonKey }`.
   The anon key is safe to publish — Row Level Security blocks all writes
   without login.
4. **Authentication → Sign In / Up**: disable new user signups.
5. **Authentication → Users → Add user**: create your admin account
   (email + strong password). This is your admin panel login.

### 2. GitHub + Vercel (hosting)
1. Push this folder to a GitHub repository.
2. At vercel.com: **Add New → Project → Import** that repository.
   Framework preset: **Other**. No build command, no env vars. Deploy.
3. Done — the site is live at `your-project.vercel.app`. Every future push
   to the repo auto-deploys in ~30 seconds. Optional: add a custom domain
   under Project → Settings → Domains.

### 3. Verify
Open `/admin.html` on the live site, sign in with your Supabase user, set a
test announcement — it should appear on the homepage immediately in another
tab. Remove it the same way.

## Day-to-day

- **Content** (announcements, pins, issue edits, hiding issues, workarounds,
  service status, patch notes): admin panel → saves instantly. Works from
  your phone. No GitHub involved.
- **Code** (new features, design, tracked repos, endpoints): edit the repo —
  or have Claude prepare and push the change — and Vercel deploys it
  automatically. For Claude-pushed changes, use a **fine-grained GitHub
  token scoped to this single repo only** (Contents: Read & write), treat it
  as disposable, and revoke it anytime under GitHub → Settings → Developer
  settings.

## How data flows

- Issues/features/fixes: fetched in the visitor's browser from the GitHub
  API (paginated, cached 15 min in sessionStorage).
- Editorial content: one call to the Supabase RPC `get_site_content()`
  (announcement, service overrides, pins, issue overrides, patch notes),
  merged over the GitHub data. If Supabase is unreachable, the site falls
  back to the values in `config.js` and keeps working.
- Asset bundles: public registry endpoint
  `https://asset-bundle-registry.decentraland.org/queues/status` +
  batched scene-name resolution via the catalyst content server.
- Official status page: linked; can override service tiles once its JSON
  endpoint is set in `officialStatus.summaryUrl`.

## Security model

- Supabase Auth (email/password) with signups disabled = only your account exists.
- Row Level Security: `select` for everyone, `insert/update/delete` only for
  authenticated users. Enforced by the database, not by the frontend.
- No secrets in the repo: the anon key is public by design; the
  asset-bundle-converter's write API (`POST /queue-task`, needs an infra
  token) is intentionally not integrated.

---
Community project — not an official Decentraland Foundation service.
