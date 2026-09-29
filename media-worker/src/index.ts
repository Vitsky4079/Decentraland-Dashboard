// dcl-media-r2: HLS / MP4 / image / audio origin for Decentraland, backed by R2.
//
// Public:   GET|HEAD /v/<id>/<path>                     (unless <id>/_meta.json says private)
// Gated:    GET|HEAD /t/<token>/v/<id>/<path>           token = HMAC-signed {t:"play", v, exp}
// Upload:   PUT /u/<token>                              token = HMAC-signed {t:"upload", key, maxSize, exp}
//           -- the destination key comes from the token, never from the caller, so a leaked
//              upload token can only ever overwrite the one object it was minted for.
// Admin:    POST /admin/upload-token {key, maxSize, ttl} -> {token, url, exp}   (mint, for the app backend only)
//           POST /admin/token {video, ttl}              -> {token, url}        (playback token, video only)
//           PUT|DELETE /admin/obj/<key>                 (direct uploads + ffmpeg `-method PUT` live ingest)
//           PUT /admin/meta/<id> {private, title}
// Misc:     GET /api/videos, GET / (hls.js test player)
//
// The playback token lives in the path, not the query string, so relative URIs inside
// playlists (720p/index.m3u8, seg_001.m4s) inherit it without rewriting.
//
// This origin is intentionally dumb: it never decides whether a file is *allowed*
// (right MIME, under quota, belongs to this user) -- that's the app backend's job,
// before it ever mints an /admin/upload-token. The worker just enforces "this token
// can write exactly this key, up to this size, until this time."

import { PLAYER_HTML } from "./player";

export interface Env {
  MEDIA: R2Bucket;
  ADMIN_SECRET: string;
  TOKEN_SECRET: string;
}

type Meta = { private?: boolean; title?: string };

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-None-Match, If-Modified-Since, Content-Type",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
  "Access-Control-Max-Age": "86400",
};

const TYPES: Record<string, string> = {
  m3u8: "application/vnd.apple.mpegurl",
  m4s: "video/iso.segment",
  mp4: "video/mp4",
  m4a: "audio/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  ts: "video/mp2t",
  aac: "audio/aac",
  webm: "video/webm",
  ogg: "audio/ogg",
  ogv: "video/ogg",
  vtt: "text/vtt",
  json: "application/json",
  // images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      if (p === "/" || p === "/player") {
        return new Response(PLAYER_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (p === "/api/videos" && req.method === "GET") return listVideos(env);

      if (p.startsWith("/admin/")) {
        if (!isAdmin(req, env)) return text(401, "unauthorized");
        return admin(req, env, url);
      }

      // PUT /u/<token>  -- scoped, one-object upload; the key is baked into the token.
      let m = p.match(/^\/u\/([^/]+)$/);
      if (m && req.method === "PUT") return uploadWithToken(req, env, m[1]);

      if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed");

      // /t/<token>/v/<id>/<path>
      m = p.match(/^\/t\/([^/]+)\/v\/([A-Za-z0-9_-]+)\/(.+)$/);
      if (m) {
        const [, token, id, rest] = m;
        const claims = await verifyToken(token, env.TOKEN_SECRET);
        if (!claims || claims.t !== "play" || claims.v !== id) return text(403, "invalid or expired token");
        return serve(req, env, ctx, id, rest);
      }

      // /v/<id>/<path>
      m = p.match(/^\/v\/([A-Za-z0-9_-]+)\/(.+)$/);
      if (m) {
        const [, id, rest] = m;
        const meta = await getMeta(env, id);
        if (meta.private) return text(403, "token required");
        return serve(req, env, ctx, id, rest);
      }

      return text(404, "not found");
    } catch (e) {
      console.error(e);
      return text(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- serving

async function serve(req: Request, env: Env, ctx: ExecutionContext, id: string, rest: string): Promise<Response> {
  if (rest.includes("..") || rest.startsWith("_")) return text(404, "not found");
  const key = `${id}/${rest}`;
  const ext = rest.split(".").pop()!.toLowerCase();
  const type = TYPES[ext] ?? "application/octet-stream";

  // Cache on the token-free key so every viewer of a gated video shares one entry.
  const cacheKey = new Request(`https://media-cache.internal/${key}`, { headers: req.headers });
  const cache = (caches as unknown as { default: Cache }).default;
  if (req.method === "GET") {
    const hit = await cache.match(cacheKey);
    if (hit) return withHeaders(hit, { "X-Cache": "HIT" });
  }

  if (req.method === "HEAD") {
    const head = await env.MEDIA.head(key);
    if (!head) return text(404, "not found");
    return new Response(null, {
      headers: { ...CORS, ...baseHeaders(head, type, ext, null), "Content-Length": String(head.size) },
    });
  }

  const rangeHeader = req.headers.get("Range");
  const obj = await env.MEDIA.get(key, { range: rangeHeader ? req.headers : undefined, onlyIf: req.headers });
  if (!obj) return text(404, "not found");
  if (!("body" in obj)) {
    // precondition failed (If-None-Match matched) -> 304
    return new Response(null, { status: 304, headers: { ...CORS, ETag: obj.httpEtag } });
  }

  let body: ReadableStream | string = obj.body;
  let playlistText: string | null = null;
  if (ext === "m3u8") {
    playlistText = await obj.text();
    body = playlistText;
  }

  const headers: Record<string, string> = { ...CORS, ...baseHeaders(obj, type, ext, playlistText), "X-Cache": "MISS" };
  let status = 200;
  const r = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (rangeHeader && r) {
    const offset = r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0);
    const length = r.suffix !== undefined ? r.suffix : (r.length ?? obj.size - offset);
    headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${obj.size}`;
    headers["Content-Length"] = String(length);
    status = 206;
  } else {
    headers["Content-Length"] = String(ext === "m3u8" ? new TextEncoder().encode(playlistText!).length : obj.size);
  }

  const res = new Response(body, { status, headers });
  // Only whole objects go in the cache; the cache itself answers later Range requests.
  if (status === 200) ctx.waitUntil(cache.put(new Request(cacheKey.url), res.clone()));
  return res;
}

// Every write or delete has to purge the edge cache entry for that key -- otherwise
// a deleted (or overwritten, e.g. live-ingest re-PUTting a segment) object keeps
// being served from cache for up to a year, since normal objects are cached
// `immutable`. Cache matching ignores headers by default (no Vary set), so the
// bare-URL Request used here matches what `serve()` cached regardless of the
// original request's headers.
async function purgeCache(key: string): Promise<void> {
  const cache = (caches as unknown as { default: Cache }).default;
  await cache.delete(new Request(`https://media-cache.internal/${key}`));
}

function baseHeaders(obj: R2Object, type: string, ext: string, playlist: string | null): Record<string, string> {
  return {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    ETag: obj.httpEtag,
    "Last-Modified": obj.uploaded.toUTCString(),
    "Cache-Control": cacheControl(ext, playlist),
  };
}

// Segments never change; a VOD playlist (has ENDLIST) barely changes; a live
// playlist must be re-fetched about once per segment.
function cacheControl(ext: string, playlist: string | null): string {
  if (ext !== "m3u8") return "public, max-age=31536000, immutable";
  if (playlist === null) return "public, max-age=1";
  if (playlist.includes("#EXT-X-ENDLIST") || playlist.includes("#EXT-X-STREAM-INF")) return "public, max-age=60";
  return "public, max-age=1";
}

// ---------------------------------------------------------------- admin

function isAdmin(req: Request, env: Env): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  return !!env.ADMIN_SECRET && auth === `Bearer ${env.ADMIN_SECRET}`;
}

async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;

  if (p === "/admin/token" && req.method === "POST") {
    const { video, ttl = 3600 } = (await req.json()) as { video: string; ttl?: number };
    if (!video) return text(400, "video required");
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const token = await signToken({ t: "play", v: video, exp }, env.TOKEN_SECRET);
    return json({ token, exp, url: `${url.origin}/t/${token}/v/${video}/master.m3u8` });
  }

  if (p === "/admin/upload-token" && req.method === "POST") {
    const { key, maxSize, ttl = 300 } = (await req.json()) as { key: string; maxSize: number; ttl?: number };
    if (!key || key.includes("..")) return text(400, "valid key required");
    if (!maxSize || maxSize <= 0) return text(400, "maxSize required");
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const token = await signToken({ t: "upload", key, maxSize, exp }, env.TOKEN_SECRET);
    return json({ token, exp, url: `${url.origin}/u/${token}` });
  }

  let m = p.match(/^\/admin\/meta\/([A-Za-z0-9_-]+)$/);
  if (m && req.method === "PUT") {
    const meta = (await req.json()) as Meta;
    await env.MEDIA.put(`${m[1]}/_meta.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" },
    });
    metaCache.delete(m[1]);
    return json({ ok: true });
  }

  m = p.match(/^\/admin\/obj\/(.+)$/);
  if (m) {
    const key = decodeURIComponent(m[1]);
    if (key.includes("..")) return text(400, "bad key");
    if (req.method === "PUT" || req.method === "POST") {
      const ext = key.split(".").pop()!.toLowerCase();
      // Buffer: ffmpeg's HTTP output uses chunked encoding, which R2 can't stream without a length.
      const buf = await req.arrayBuffer();
      await env.MEDIA.put(key, buf, {
        httpMetadata: { contentType: TYPES[ext] ?? "application/octet-stream" },
      });
      await purgeCache(key);
      return json({ ok: true, key, size: buf.byteLength });
    }
    if (req.method === "DELETE") {
      await env.MEDIA.delete(key);
      await purgeCache(key);
      return json({ ok: true, key });
    }
  }

  return text(404, "not found");
}

// ---------------------------------------------------------------- token-scoped upload

async function uploadWithToken(req: Request, env: Env, token: string): Promise<Response> {
  const claims = await verifyToken(token, env.TOKEN_SECRET);
  if (!claims || claims.t !== "upload") return text(403, "invalid or expired token");

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return text(400, "empty body");
  if (buf.byteLength > claims.maxSize) return text(413, "file too large");

  const ext = claims.key.split(".").pop()!.toLowerCase();
  await env.MEDIA.put(claims.key, buf, {
    httpMetadata: { contentType: TYPES[ext] ?? "application/octet-stream" },
  });
  await purgeCache(claims.key);
  return json({ ok: true, key: claims.key, size: buf.byteLength });
}

async function listVideos(env: Env): Promise<Response> {
  const out: { id: string; private: boolean; title?: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ delimiter: "/", cursor });
    for (const prefix of page.delimitedPrefixes) {
      const id = prefix.slice(0, -1);
      const meta = await getMeta(env, id);
      out.push({ id, private: !!meta.private, title: meta.title });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json(out);
}

// Per-isolate memo; a few seconds of staleness after a meta change is fine.
const metaCache = new Map<string, { meta: Meta; at: number }>();
async function getMeta(env: Env, id: string): Promise<Meta> {
  const c = metaCache.get(id);
  if (c && Date.now() - c.at < 10_000) return c.meta;
  const obj = await env.MEDIA.get(`${id}/_meta.json`);
  const meta: Meta = obj ? await obj.json() : {};
  metaCache.set(id, { meta, at: Date.now() });
  return meta;
}

// ---------------------------------------------------------------- tokens

type Claims = { t: "play"; v: string; exp: number } | { t: "upload"; key: string; maxSize: number; exp: number };

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function signToken(claims: Claims, secret: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${b64url(sig)}`;
}

async function verifyToken(token: string, secret: string): Promise<Claims | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(unb64url(payload))) as Claims;
    return claims.exp > Date.now() / 1000 ? claims : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- helpers

function text(status: number, msg: string): Response {
  return new Response(msg + "\n", { status, headers: { ...CORS, "Content-Type": "text/plain" } });
}
function json(v: unknown): Response {
  return new Response(JSON.stringify(v), { headers: { ...CORS, "Content-Type": "application/json" } });
}
function withHeaders(res: Response, extra: Record<string, string>): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...CORS, ...extra })) r.headers.set(k, v);
  return r;
}
