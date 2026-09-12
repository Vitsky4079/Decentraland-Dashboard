// Vercel Cron target: api/cron/sync-map.js
//
// Deliberately thin — the actual Catalyst/Supabase sync logic lives in the
// Supabase Edge Function `sync-map-changes` (supabase/functions/sync-map-changes),
// same place this project already keeps anything that needs a secret
// (see supabase/functions/github-issues). This function's only job is to be
// something Vercel Cron can call, check it's really Vercel calling it, and
// relay to that Edge Function with its own shared secret.
//
// Configured in vercel.json:  { "path": "/api/cron/sync-map", "schedule": "0 6 * * *" }
//
// Required Vercel project env vars:
//   CRON_SECRET       Vercel sends "Authorization: Bearer <CRON_SECRET>" on cron
//                     invocations automatically once this is set — see
//                     https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
//   SUPABASE_URL      same project URL as assets/config.js (not secret, but kept
//                     as an env var here since this runs server-side)
//   MAP_SYNC_SECRET   same value as the Supabase secret of the same name
//                     (supabase secrets set MAP_SYNC_SECRET=...)

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const syncSecret = process.env.MAP_SYNC_SECRET;
  if (!supabaseUrl || !syncSecret) {
    res.status(500).json({ error: 'server misconfigured: missing SUPABASE_URL/MAP_SYNC_SECRET' });
    return;
  }

  try {
    const upstream = await fetch(`${supabaseUrl}/functions/v1/sync-map-changes${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`, {
      method: 'GET',
      headers: { 'x-sync-secret': syncSecret },
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: 'failed to reach sync-map-changes', detail: String(e && e.message || e) });
  }
};
