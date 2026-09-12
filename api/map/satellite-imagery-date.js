// Vercel serverless function: reports when the live satellite tile set
// (api/map/land-tile.js's sibling — the real image tiles rendered directly by
// the browser from media.githubusercontent.com, see assets/map.js
// satelliteSource) was actually last regenerated.
//
// This turned out to matter: the imagery is a periodic manual snapshot (the
// genesis-city/parcels "new-client-images" branch), not a live render — a
// prior version of this feature assumed it was continuously up to date and
// was wrong. Rather than hardcode a date that will silently go stale, this
// reads GitHub's own commit history for that branch, so the label on the map
// stays accurate as new snapshots are published.
//
// No secrets needed (public repo, public API); cached at Vercel's edge for
// 12h since this changes on the order of weeks, to stay well under GitHub's
// unauthenticated rate limit regardless of traffic.

const COMMITS_URL = 'https://api.github.com/repos/genesis-city/parcels/commits?sha=new-client-images&per_page=1';

module.exports = async (req, res) => {
  try {
    const upstream = await fetch(COMMITS_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dcl-status-dashboard' } });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const commits = await upstream.json();
    const date = commits && commits[0] && commits[0].commit && commits[0].commit.author && commits[0].commit.author.date;
    if (!date) throw new Error('no commit date in response');

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=604800');
    res.status(200).json({ date });
  } catch (e) {
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
