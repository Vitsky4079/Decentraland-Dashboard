// Supabase Edge Function: github-issues
//
// Two jobs, selected by ?action=:
//   (default)        -> fetch issues from the Decentraland repos (token-backed,
//                       cached 10 min). Avoids GitHub's 60/hour browser limit.
//   ?action=resolve  -> POST { ids: [...] } resolves asset-bundle entity CIDs to
//                       scene names + parcels (catalyst) or World names (worlds
//                       server). Done server-side to bypass browser CORS, and
//                       cached so the 60s auto-refresh is cheap.
//
// Deploy:  supabase functions deploy github-issues --no-verify-jwt
// Secret:  supabase secrets set GITHUB_TOKEN=github_pat_xxx

const REPOS = [
  'decentraland/unity-explorer',
  'decentraland/sdk',
  'decentraland/creator-hub',
  'decentraland/builder',
  'decentraland/core-team',
];

const CATALYST = 'https://peer.decentraland.org/content';
const WORLDS = 'https://worlds-content-server.decentraland.org';

const CACHE_TTL_MS = 10 * 60 * 1000;       // issues cache
const SCENE_TTL_MS = 60 * 60 * 1000;       // scene name cache (1h — names rarely change)
let CACHE: { at: number; payload: unknown } | null = null;
const SCENE_CACHE = new Map<string, unknown>(); // entityId -> record | null

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', ...extra } });

/* ---------------- GitHub issues ---------------- */
async function ghPage(repo: string, state: string, page: number, perPage: number, token: string) {
  const url = `https://api.github.com/repos/${repo}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dcl-status-dashboard',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 403 || res.status === 429) throw new Error('rate');
  if (!res.ok) return null;
  return await res.json();
}

async function fetchRepo(repo: string, token: string) {
  const items: unknown[] = [];
  let capped = false;
  for (let page = 1; page <= 3; page++) {
    const data = await ghPage(repo, 'open', page, 100, token);
    if (!data) break;
    items.push(...data);
    if (data.length < 100) break;
    if (page === 3) capped = true;
  }
  const closed = await ghPage(repo, 'closed', 1, 100, token);
  if (closed) items.push(...closed);
  return { repo, items, capped };
}

async function handleIssues(): Promise<Response> {
  if (CACHE && Date.now() - CACHE.at < CACHE_TTL_MS) {
    return json(CACHE.payload, 200, { 'X-Cache': 'HIT' });
  }
  const token = Deno.env.get('GITHUB_TOKEN') || '';
  try {
    const results = await Promise.allSettled(REPOS.map((r) => fetchRepo(r, token)));
    const repos = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchRepo>>> => r.status === 'fulfilled')
      .map((r) => r.value);
    const rateLimited = results.some((r) => r.status === 'rejected' && (r.reason as Error)?.message === 'rate');
    if (!repos.length) {
      if (CACHE) return json({ ...(CACHE.payload as object), stale: true }, 200, { 'X-Cache': 'STALE' });
      return json({ error: rateLimited ? 'rate' : 'network' }, 502);
    }
    const payload = { repos, partial: rateLimited, syncedAt: Date.now() };
    CACHE = { at: Date.now(), payload };
    return json(payload, 200, { 'X-Cache': 'MISS' });
  } catch (_e) {
    if (CACHE) return json({ ...(CACHE.payload as object), stale: true }, 200, { 'X-Cache': 'STALE' });
    return json({ error: 'network' }, 502);
  }
}

/* ---------------- Scene resolution ---------------- */
function sceneFromEntity(e: any) {
  const md = e?.metadata || {};
  const worldName = md.worldConfiguration && (md.worldConfiguration.name || md.worldConfiguration.dclName);
  const title = (md.display && md.display.title) || (md.scene && md.scene.name) || md.name || null;
  const timestamp = e?.timestamp || md.timestamp || null;
  if (worldName) {
    return { type: 'world', name: (title && title !== 'interactive-text') ? title : worldName, world: worldName, parcels: [], timestamp };
  }
  const parcels = (md.scene && md.scene.parcels) || e?.pointers || [];
  const base = (md.scene && md.scene.base) || (parcels.length ? parcels[0] : null);
  return { type: 'parcel', name: title, parcels, base, timestamp };
}

// Catalyst: POST /entities/active accepts { ids } OR { pointers }. Asset-bundle
// queue CIDs are deployment entity IDs, so we query by ids. Some servers also
// accept GET /entities/scene?id=, used as a fallback.
async function resolveBatch(server: string, ids: string[], asWorld = false) {
  const out: Record<string, unknown> = {};
  if (!ids.length) return out;
  try {
    const res = await fetch(`${server}/entities/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (res.ok) {
      const arr = await res.json();
      for (const e of (Array.isArray(arr) ? arr : [])) {
        if (e && e.id) {
          const rec = sceneFromEntity(e);
          out[e.id] = asWorld && rec.type !== 'world'
            ? { ...rec, type: 'world', world: (rec as any).world || rec.name }
            : rec;
        }
      }
    }
  } catch (_e) { /* best effort */ }
  return out;
}

async function handleResolve(req: Request): Promise<Response> {
  let ids: string[] = [];
  try { ids = (await req.json()).ids || []; } catch (_e) { /* empty */ }
  ids = [...new Set(ids)].filter((x) => typeof x === 'string').slice(0, 120);

  const now = Date.now();
  const result: Record<string, unknown> = {};
  const need: string[] = [];
  for (const id of ids) {
    const c = SCENE_CACHE.get(id) as any;
    if (c && now - c._at < SCENE_TTL_MS) result[id] = c.rec;
    else need.push(id);
  }

  if (need.length) {
    // Genesis City scenes resolve on the catalyst...
    const fromCatalyst = await resolveBatch(CATALYST, need);
    const stillMissing = need.filter((id) => !(id in fromCatalyst));
    // ...Worlds resolve on the worlds server.
    const fromWorlds = await resolveBatch(WORLDS, stillMissing, true);
    for (const id of need) {
      const rec = (fromCatalyst[id] ?? fromWorlds[id] ?? null);
      SCENE_CACHE.set(id, { _at: now, rec });
      result[id] = rec;
    }
  }
  return json({ scenes: result }, 200, { 'X-Cache': need.length ? 'PARTIAL' : 'HIT' });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  if (url.searchParams.get('action') === 'resolve' || req.method === 'POST') {
    return await handleResolve(req);
  }
  return await handleIssues();
});
