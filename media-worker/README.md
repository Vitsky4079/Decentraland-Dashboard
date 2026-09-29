# media-worker

The storage/serving origin for `media.decentraland-dashboard.org`. A Cloudflare
Worker backed by R2, serving images, audio and video for Decentraland scenes, plus
HLS adaptive streaming and live ingest for video specifically.

This started from a standalone video-origin prototype and was extended for the
`creators-app` platform: image/audio MIME types, and a scoped, one-object upload
token (`/u/<token>`) so the app's users can upload directly to R2 without ever
touching the shared admin secret.

This origin is intentionally dumb: it never decides whether a file is *allowed*
(right MIME, under quota, belongs to this user) -- that's `creators-app`'s job,
before it ever asks this worker to mint an upload token. This worker just enforces
"this token can write exactly this key, up to this size, until this time."

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # sets ADMIN_SECRET / TOKEN_SECRET for local dev
npm run dev                      # http://127.0.0.1:5250, R2 simulated on disk under .wrangler/state
```

Try the video pipeline end-to-end (optional, not needed for image/audio testing):

```bash
scripts/transcode.sh --test demo && node scripts/upload.mjs demo --title "Test pattern"
open http://localhost:5250/      # hls.js test player listing the bucket
```

Try the upload-token flow used by `creators-app` (any file type):

```bash
curl -X POST http://127.0.0.1:5250/admin/upload-token \
  -H "Authorization: Bearer $(grep ADMIN_SECRET .dev.vars | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"key":"some-user-id/some-uuid.jpg","maxSize":15000000,"ttl":600}'
# -> {"token": "...", "url": "http://127.0.0.1:5250/u/<token>", "exp": ...}

curl -X PUT "<that url>" --data-binary @photo.jpg
curl -I http://127.0.0.1:5250/v/some-user-id/some-uuid.jpg
```

## Tests

`scripts/smoke.sh` — 22 checks covering the original video/HLS behavior (HEAD/MIME/CORS,
range requests, caching, playback tokens, admin auth). Needs `demo` and `demo-private`
uploaded first (see above). Not yet extended with checks for the new upload-token route
or image/audio serving -- worth adding before this goes into real production use.

`node scripts/browser-check.mjs <url>…` — headless-Chromium playback + CORS check,
video-specific.

## Endpoints

| | |
|---|---|
| `GET/HEAD /v/<id>/<path>` | public unless `<id>/_meta.json` has `private: true` (video only; images/audio never set this) |
| `GET/HEAD /t/<token>/v/<id>/<path>` | gated playback, HMAC token `{t:"play", v, exp}` |
| `PUT /u/<token>` | scoped upload; the destination key is baked into the token, not the URL |
| `POST /admin/upload-token` `{key, maxSize, ttl}` | mint an upload token (Bearer `ADMIN_SECRET`) -- called by `creators-app`'s backend only, never the browser |
| `POST /admin/token` `{video, ttl}` | mint a playback token (video only) |
| `PUT/DELETE /admin/obj/<key>` | direct admin upload/delete + ffmpeg `-method PUT` live ingest |
| `PUT /admin/meta/<id>` `{private, title}` | per-video flags (video only) |
| `GET /api/videos`, `GET /` | listing, test player |

Caching: everything except `.m3u8` playlists is `public, max-age=31536000, immutable`
(images, audio, MP4/WebM, HLS segments alike). Every write or delete (`/admin/obj`,
`/u/<token>`) purges that key's edge-cache entry, so deleting a file actually stops
it being served, not just removes it from R2.

## Deploy

```bash
npx wrangler r2 bucket create dcl-media
npx wrangler secret put ADMIN_SECRET && npx wrangler secret put TOKEN_SECRET
npm run deploy
```

Then add a custom domain route in the Cloudflare dashboard pointing
`media.decentraland-dashboard.org` at this Worker, and set `MEDIA_WORKER_URL` /
`MEDIA_WORKER_ADMIN_SECRET` in `creators-app`'s environment to match.

## Not built yet

- Rate limiting is enforced in `creators-app` (per-user, DB-backed), not here --
  this worker will do whatever any valid token/admin-secret tells it to. A Cloudflare
  rate-limiting rule on `/u/*` would be cheap, extra insurance.
- The Referer-check idea discussed for reducing hotlinking isn't implemented.
- No per-file analytics/view counts.
- Transcoding still can't run inside Cloudflare (Workers can't run ffmpeg) -- only
  matters if video gets an HLS ladder rather than being served as a single MP4/WebM.
