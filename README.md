# Decentraland Community Status

A community-run status board for Decentraland: known issues, feature requests,
recent fixes, workarounds and service health — pulled live from Decentraland's
public GitHub issue trackers and translated into plain, user-friendly language.

No backend, no build step, no API keys. Pure static site.

## Structure

```
index.html          Overview — service status, stats, top issues/requests, latest fixes
issues.html         All known issues with search + area filters
features.html       All feature requests with search + category filters
fixed.html          Recently resolved issues
workarounds.html    Active issues that have a confirmed workaround
report.html         Report a bug / submit a feature request (links to GitHub forms)
assets/
  config.js         ← the only file you normally edit (repos, services, overrides)
  dcl.css           Shared styles
  dcl.js            Shared logic (fetch, cache, classification, rendering)
```

## Deploy to GitHub Pages

1. Create a repo and push all files (keep the folder structure).
2. Repo → Settings → Pages → Source: `Deploy from a branch` → branch `main`, folder `/ (root)`.
3. Done — the site is live at `https://<user>.github.io/<repo>/`.

## How data works

- Each visitor's browser fetches open + recently closed issues from the
  configured repos via the public GitHub API (10 requests per fresh load).
- Results are cached in the browser for `cacheMinutes` (default 15), so
  navigating between pages costs **zero** extra API calls.
- Unauthenticated GitHub API allows 60 requests/hour per visitor IP. If a
  visitor hits the limit, the site shows cached data or a friendly retry
  message — it never breaks.

## Official status page integration

The dashboard links to https://status.decentraland.org/ and can consume it:
open the official page with DevTools → Network, find the JSON request it makes,
and paste that URL into `officialStatus.summaryUrl` in `assets/config.js`.
Once set, official component statuses **override** the GitHub-derived ones
(marked "· official" in the UI) and unresolved official incidents show as a
site-wide banner. If the endpoint is unreachable or blocked by CORS, the site
silently falls back to derived statuses — nothing breaks.

Priority order for a service's status:
`statusOverrides` (manual) → official status page → derived from GitHub issues.

## Announcements

Set `announcement` in `assets/config.js` to show a banner on every page:

```js
announcement: { text: 'Marketplace maintenance tonight 20:00–21:00 CET.', level: 'Degraded', link: '' }
```

## Copy for Discord

Every known-issue card has a "Copy for Discord" button that copies a formatted
snippet (title, status, impact, workaround, tracking link) — handy for support
replies.

## Asset bundles tab (bundles.html)

Read-only view of the asset-bundle conversion pipeline, in the spirit of
deployments.lastslice.co. It reads the **public, no-auth** registry endpoint
`GET https://asset-bundle-registry.decentraland.org/queues/status` (shape:
`{ webglPendingJobs: [cid...], windowsPendingJobs: [...], macPendingJobs: [...] }`)
and shows one column per platform with live counts, the first 25 queued
entities each (configurable via `assetBundles.maxRowsPerPlatform`), and a
"+N more" indicator. Visible entity CIDs are resolved to scene names and
parcels with a single batched `POST {contentServer}/entities/active` call.
The page auto-refreshes every `assetBundles.refreshSeconds` (default 60s).

There's also a "Check a deployment" box: paste an entity CID and it queries
`GET {registryUrl}/entities/status/{cid}` to show per-platform conversion
status (complete / pending / failed).

Note: submitting or prioritizing conversions is intentionally NOT part of this
site — that's the asset-bundle-converter's authenticated `POST /queue-task`
endpoint, which requires an infra-provisioned secret that must never live in a
public static site.

## Admin panel (admin.html)

A maintainer panel for day-to-day changes without touching code. Open
`admin.html` directly (it is intentionally unlinked from the site nav).

- **Login is a curtain, not a lock.** The passphrase (default: `admin`)
  only hides the panel UI — it is checked in the browser, so treat it as
  cosmetic. Change it with the hash generator on the login screen, then paste
  the new hash into `admin.passHash` in `config.js`. Real write protection
  comes from GitHub repo permissions (below).
- **What you can edit:** announcement banner; per-service status overrides;
  pinned issues; **per-issue overrides** (public title, summary, status,
  impact/priority, affected area, manual workaround, or hide an issue from the
  dashboard); **patch notes** (paste release notes — they render on the
  overview); and settings (fix window, page size, cache, status-derivation).
- **Pinned issues:** search open issues, click Pin, reorder with ↑/↓. Pinned
  issues show first on the overview (6 cards total), each with a "Pinned" badge.
- **Saving:** the panel regenerates `config.js`. Either *Copy* / *Download* it
  and commit via the GitHub web UI, or expand "Publish directly to GitHub",
  paste a fine-grained token (Contents: Read & write on this repo only), and
  commit in one click. The token lives only in that browser tab and is never
  written to any file. GitHub Pages redeploys about a minute after the commit.

## Maintenance

- **Add/remove a tracked repo:** edit `repos` in `assets/config.js`.
- **Declare an incident manually:** set `statusOverrides`, e.g.
  `statusOverrides: { 'Worlds': 'Partial Outage' }`, commit, done.
- **Tune behavior:** `recentFixDays`, `pageSize`, `cacheMinutes` in config.

Issue titles are automatically cleaned of internal ticket IDs (e.g. `ABC-1234`)
and `[Bug]:` prefixes; bodies are summarized; statuses, impact and community
interest are derived from labels, assignees, comments and reactions.

---
Community project — not an official Decentraland Foundation service.
