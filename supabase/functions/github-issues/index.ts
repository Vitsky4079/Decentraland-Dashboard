// Supabase Edge Function: github-issues
// Fetches issues from the configured Decentraland repos using a server-side
// GitHub token (5,000 req/hour instead of 60), caches the result in memory,
// and returns the raw issue arrays for the site to process client-side.
//
// Deploy:  supabase functions deploy github-issues --no-verify-jwt
// Secret:  supabase secrets set GITHUB_TOKEN=github_pat_xxx
//
// The site calls this instead of api.github.com directly. The token NEVER
// reaches the browser. --no-verify-jwt makes it publicly readable (it only
// returns public GitHub data), which is what we want for a public dashboard.

const REPOS = [
  'decentraland/unity-explorer',
  'decentraland/sdk',
  'decentraland/creator-hub',
  'decentraland/builder',
  'decentraland/core-team',
];

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let CACHE: { at: number; payload: unknown } | null = null;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Serve from cache when fresh
  if (CACHE && Date.now() - CACHE.at < CACHE_TTL_MS) {
    return new Response(JSON.stringify(CACHE.payload), {
      headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
    });
  }

  const token = Deno.env.get('GITHUB_TOKEN') || '';
  try {
    const results = await Promise.allSettled(REPOS.map((r) => fetchRepo(r, token)));
    const repos = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchRepo>>> => r.status === 'fulfilled')
      .map((r) => r.value);
    const rateLimited = results.some((r) => r.status === 'rejected' && (r.reason as Error)?.message === 'rate');

    if (!repos.length) {
      // Total failure — surface stale cache if we have any, else error.
      if (CACHE) {
        return new Response(JSON.stringify({ ...CACHE.payload as object, stale: true }), {
          headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'STALE' },
        });
      }
      return new Response(JSON.stringify({ error: rateLimited ? 'rate' : 'network' }), {
        status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const payload = { repos, partial: rateLimited, syncedAt: Date.now() };
    CACHE = { at: Date.now(), payload };
    return new Response(JSON.stringify(payload), {
      headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  } catch (e) {
    if (CACHE) {
      return new Response(JSON.stringify({ ...CACHE.payload as object, stale: true }), {
        headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'STALE' },
      });
    }
    return new Response(JSON.stringify({ error: 'network' }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
