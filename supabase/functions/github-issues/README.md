# github-issues edge function

Fetches issues from the Decentraland repos server-side using a GitHub token,
caches the result in memory for 10 minutes, and serves it to all visitors.
This avoids GitHub's 60-requests/hour unauthenticated limit (per visitor IP)
that otherwise causes "Live data unavailable" after a few refreshes.

The site (`assets/dcl.js` → `loadViaProxy`) calls this when
`config.js → github.useProxy` is `true`. If the function is missing or fails,
the site automatically falls back to fetching GitHub directly, so deploying
this is non-breaking.

## One-time deploy

You need the Supabase CLI (https://supabase.com/docs/guides/cli). Then, from
the repo root:

```bash
# 1. Log in and link the project (project ref is in your Supabase URL:
#    https://<REF>.supabase.co)
supabase login
supabase link --project-ref bkedlefssfcyashgxxqg

# 2. Store the GitHub token as a secret (server-side only — never in the repo)
supabase secrets set GITHUB_TOKEN=github_pat_xxxxxxxx

# 3. Deploy. --no-verify-jwt makes it publicly readable (it only returns
#    public GitHub data, which is what the public dashboard needs).
supabase functions deploy github-issues --no-verify-jwt
```

### The GitHub token
Create a **fine-grained personal access token** at GitHub → Settings →
Developer settings → Fine-grained tokens:
- Repository access: **Public repositories (read-only)** is enough.
- No account permissions needed.
This token only raises the rate limit; it grants no write access.

## Verify
After deploy, this should return JSON with a `repos` array:
```bash
curl https://bkedlefssfcyashgxxqg.supabase.co/functions/v1/github-issues \
  -H "apikey: <your anon/publishable key>"
```
The response header `X-Cache` shows HIT/MISS/STALE.
