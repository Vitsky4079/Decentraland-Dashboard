// Vercel Cron target: api/cron/sync-land.js
//
// Same thin-relay pattern as api/cron/sync-map.js — the actual work happens in
// the Supabase Edge Function `sync-land-parcels`, which pulls Decentraland's
// official LAND ownership/type dataset. Reuses the same CRON_SECRET/
// MAP_SYNC_SECRET/SUPABASE_URL env vars already configured for sync-map.js —
// nothing new to set in Vercel for this one.
//
// Configured in vercel.json:  { "path": "/api/cron/sync-land", "schedule": "0 5 * * *" }

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
    const upstream = await fetch(`${supabaseUrl}/functions/v1/sync-land-parcels`, {
      method: 'GET',
      headers: { 'x-sync-secret': syncSecret },
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: 'failed to reach sync-land-parcels', detail: String(e && e.message || e) });
  }
};
