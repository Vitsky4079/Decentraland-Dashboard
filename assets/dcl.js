/* =========================================================
   Decentraland Community Status — shared logic
   Data layer (GitHub fetch + cross-page cache), classification
   heuristics, and per-page renderers. Pages declare themselves
   via <body data-page="...">.
   ========================================================= */
(function () {
'use strict';

const C = DCL_CONFIG;
const CACHE_KEY = 'dclStatusCache_v3';

/* ---------- Vocabularies ---------- */
const SVC_LEVELS = {
  'Operational':    { color: 'var(--ok)',      rank: 0 },
  'Degraded':       { color: 'var(--warn)',    rank: 1 },
  'Partial Outage': { color: 'var(--partial)', rank: 2 },
  'Outage':         { color: 'var(--down)',    rank: 3 },
};
const BUG_STATUS_COLORS = {
  'Reported':'#A39DB3','Confirmed':'#E8B33C','Investigating':'#F0883E','In Progress':'#7C8CF8',
  'Fix Planned':'#5BC8F5','Monitoring':'#3FCB6E','Resolved':'#3FCB6E',"Won't Fix":'#6E6880'
};
const FEAT_STATUS_COLORS = {
  'Submitted':'#A39DB3','Under Review':'#E8B33C','Needs More Feedback':'#F0883E','Planned':'#5BC8F5',
  'In Design':'#C77CF8','In Development':'#7C8CF8','Released':'#3FCB6E','Not Planned':'#6E6880'
};
const IMPACT_COLORS = { 'Critical':'#FF4D5E','High':'#F0883E','Medium':'#E8B33C','Low':'#A39DB3' };

// Display-only relabeling of internal area names. The underlying area value
// (used for filtering/matching) is unchanged; this only affects what users see.
const AREA_LABELS = { 'Creator Hub': 'Creator Tools', 'Explorer': 'Desktop app' };
const areaLabel = (a) => AREA_LABELS[a] || a;

/* ---------- Helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const daysAgo = iso => Math.floor((Date.now() - new Date(iso)) / 86400000);
const fmtDate = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const rel = iso => { const d = daysAgo(iso); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : fmtDate(iso); };

function cleanTitle(t) {
  return t
    .replace(/\[?[A-Z]{2,}-\d{2,}\]?:?\s*/g, '')
    .replace(/^\[(bug|feature( request)?|fr|qa|task)\]:?\s*/i, '')
    .replace(/^(bug|feature( request)?)\s*:\s*/i, '')
    .trim() || t;
}

// Strip Sentry auto-creation boilerplate so summaries read human
function stripSentry(body) {
  if (!body) return body;
  return body
    .replace(/Sentry [Ii]ssue:\s*\S+/g, ' ')
    .replace(/This issue was automatically created by Sentry via[^.\n]*\.?/gi, ' ');
}

// Make crash-exception titles presentable: drop file paths and 'because of' tails
function cleanCrashTitle(t) {
  let s = t
    .replace(/because of\s+['‘"][^'’"]*['’"]?/gi, '')
    .replace(/['‘"]?[A-Za-z]:\\[^\s'’"]+/g, '')
    .replace(/Tried the load the following dynamic libraries:?/gi, '—')
    .replace(/\s+/g, ' ')
    .trim().replace(/[—:,\-\s]+$/, '');
  if (s.length > 110) s = s.slice(0, 107) + '…';
  return s || t.slice(0, 110);
}

function summarize(body) {
  if (!body) return '';
  let t = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/^\s*([-*]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/^(describe the bug|description|what happened\??|current behavior|expected behavior|steps to reproduce|context)\s*:?/gim, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S*(datadoghq|sentry\.io|grafana)\S*/gi, ' ')
    .replace(/[()\[\]{}<>|\\\/]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Reject leftovers that are mostly punctuation / path fragments
  const letters = (t.match(/[A-Za-z]{3,}/g) || []).join('');
  if (letters.length < 15) return '';
  return t.length > 220 ? t.slice(0, 217) + '…' : t;
}

function findWorkaround(body) {
  if (!body) return null;
  const m = body.match(/work[\s-]?around[s]?\s*:?\s*([\s\S]{10,400}?)(?:\n\s*\n|$)/i);
  if (!m) return null;
  let t = m[1].replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length < 12) return null;
  return t.length > 200 ? t.slice(0, 197) + '…' : t;
}

const labelText = i => i.labels.map(l => (l.name || '').toLowerCase()).join(' | ');
const hasLabel = (i, re) => re.test(labelText(i));

function isFeature(i) {
  const lt = labelText(i), title = i.rawTitle.toLowerCase();
  if (/(^|\W)(bug|defect|crash|regression|broken)(\W|$)/.test(lt)) return false;
  if (/feature|enhancement|request|idea|proposal|improvement|suggestion/.test(lt)) return true;
  return /^\[?(feature|fr|idea|proposal|request)/.test(title) || /feature request/.test(title);
}

function bugStatus(i) {
  if (i.state === 'closed') {
    return hasLabel(i, /wont.?fix|won't fix|invalid|not planned|duplicate|stale/) ? "Won't Fix" : 'Resolved';
  }
  if (hasLabel(i, /monitor/)) return 'Monitoring';
  if (hasLabel(i, /fix planned|planned|scheduled|milestone/)) return 'Fix Planned';
  if (hasLabel(i, /in progress|in-progress|wip|doing/) || (i.assigneeCount > 0)) return 'In Progress';
  if (hasLabel(i, /investigat|needs info|needs-info|repro/)) return 'Investigating';
  if (hasLabel(i, /confirmed|triaged|accepted|verified/) || i.comments > 0) return 'Confirmed';
  return 'Reported';
}

function featStatus(i) {
  if (i.state === 'closed') {
    return hasLabel(i, /wont.?fix|won't fix|not planned|declined|duplicate|stale/) ? 'Not Planned' : 'Released';
  }
  if (hasLabel(i, /in development|in-development|wip|in progress/) || (i.assigneeCount > 0)) return 'In Development';
  if (hasLabel(i, /design/)) return 'In Design';
  if (hasLabel(i, /planned|roadmap|accepted|approved/)) return 'Planned';
  if (hasLabel(i, /feedback|discussion|needs votes/)) return 'Needs More Feedback';
  if (i.comments > 0) return 'Under Review';
  return 'Submitted';
}

function isQA(i) {
  return hasLabel(i, /qa|need qa|qa-team|qa validation/) || /^\[qa\]/i.test(i.rawTitle);
}

function impact(i) {
  if (hasLabel(i, /critical|blocker|p0|sev.?0|sev.?1/)) return 'Critical';
  if (hasLabel(i, /high|major|p1/)) return 'High';
  if (hasLabel(i, /low|minor|p3|trivial/)) return 'Low';
  const heat = (i.reactionsTotal || 0) + i.comments;
  return heat >= 12 ? 'High' : heat >= 4 ? 'Medium' : 'Low';
}

function interest(i) {
  const score = (i.thumbs || 0) + Math.floor(i.comments / 2);
  return score >= 15 ? 'Very High' : score >= 6 ? 'High' : score >= 2 ? 'Medium' : 'Low';
}

/* ---------- Editorial content (Supabase with config fallback) ---------- */
let CONTENT = {
  announcement: C.announcement || {},
  statusOverrides: C.statusOverrides || {},
  pinnedIssues: C.pinnedIssues || [],
  issueOverrides: C.issueOverrides || {},
  patchNotes: C.patchNotes || [],
  announcementPosts: [],
};

async function loadContent() {
  const sb = C.supabase || {};
  if (!sb.url || !sb.anonKey) return CONTENT;
  try {
    const res = await fetch(`${sb.url}/rest/v1/rpc/get_site_content`, {
      method: 'POST',
      headers: { apikey: sb.anonKey, Authorization: 'Bearer ' + sb.anonKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error();
    const d = await res.json();
    CONTENT = {
      announcement: d.announcement || {},
      statusOverrides: d.service_status || {},
      pinnedIssues: d.pins || [],
      issueOverrides: d.issue_overrides || {},
      patchNotes: d.patch_notes || [],
      announcementPosts: d.announcement_posts || [],
    };
  } catch (e) { /* fall back to config values */ }
  return CONTENT;
}

/* ---------- Cache (localStorage with in-memory fallback) ---------- */
let memCache = null;
function cacheGet() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (Date.now() - c.t < C.cacheMinutes * 60000) return c;
    }
  } catch (e) { /* private mode etc. */ }
  if (memCache && Date.now() - memCache.t < C.cacheMinutes * 60000) return memCache;
  return null;
}
function cacheSet(data, partial, capped) {
  const c = { t: Date.now(), data, partial, capped };
  memCache = c;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
}

/* ---------- Fetch ---------- */
async function fetchRepo(cfg) {
  const out = [];
  let capped = false;

  async function getPage(state, page, perPage) {
    const url = `https://api.github.com/repos/${cfg.repo}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`;
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 403 || res.status === 429) throw new Error('rate');
    if (!res.ok) return null;
    return res.json();
  }

  function push(it) {
    const p = processIssue(it, cfg.area);
    if (p) out.push(p);
  }

  // Open issues: paginate up to 3 pages of 100 (covers repos with hundreds of issues)
  for (let page = 1; page <= 3; page++) {
    const data = await getPage('open', page, 100);
    if (!data) break;
    data.forEach(push);
    if (data.length < 100) break;
    if (page === 3) capped = true; // repo has even more — counts will show "+"
  }
  // Closed: most recently updated 100 is plenty for the recent-fixes window
  const closedData = await getPage('closed', 1, 100);
  if (closedData) closedData.forEach(push);

  return { items: out, capped };
}

// Process a raw GitHub issue into the site's normalized shape.
function processIssue(it, area) {
  if (it.pull_request) return null;
  const sentry = /automatically created by Sentry/i.test(it.body || '');
  const body = stripSentry(it.body || '');
  let title = cleanTitle(it.title);
  if (sentry || /[A-Za-z]:\\/.test(title)) title = cleanCrashTitle(title);
  const r = it.reactions || {};
  return {
    url: it.html_url,
    rawTitle: it.title,
    title,
    summary: sentry ? 'Automatically captured crash report from the client. Open on GitHub for technical details.' : summarize(body),
    workaround: null,
    sentry,
    state: it.state,
    labels: (it.labels || []).map(l => ({ name: l.name })),
    comments: it.comments || 0,
    reactionsTotal: r.total_count || 0,
    thumbs: (r['+1'] || 0) + (r.heart || 0) + (r.rocket || 0),
    assigneeCount: (it.assignees || []).length,
    created: it.created_at,
    updated: it.updated_at,
    closed: it.closed_at,
    area,
  };
}

// Try the Supabase edge function (server-side token, shared cache, 5000/hr).
// Returns null if not configured or unreachable, so callers fall back to direct GitHub.
async function loadViaProxy() {
  const sb = C.supabase || {};
  if (!sb.url || !sb.anonKey || !(C.github && C.github.useProxy)) return null;
  try {
    const res = await fetch(`${sb.url}/functions/v1/github-issues`, {
      headers: { apikey: sb.anonKey, Authorization: 'Bearer ' + sb.anonKey, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.repos)) return null;
    const areaFor = {};
    (C.repos || []).forEach(r => areaFor[r.repo] = r.area);
    const issues = [];
    let capped = false;
    for (const r of data.repos) {
      if (r.capped) capped = true;
      const area = areaFor[r.repo] || 'Platform';
      (r.items || []).forEach(it => { const p = processIssue(it, area); if (p) issues.push(p); });
    }
    if (!issues.length) return null;
    return { issues, partial: !!data.partial || !!data.stale, capped };
  } catch (e) { return null; }
}

async function loadData(force = false) {
  if (!force) {
    const c = cacheGet();
    if (c) return { issues: c.data, partial: c.partial, capped: c.capped, fromCache: true, syncedAt: c.t };
  }
  // Preferred path: server-side proxy (avoids the 60/hour unauthenticated limit).
  const viaProxy = await loadViaProxy();
  if (viaProxy) {
    cacheSet(viaProxy.issues, viaProxy.partial, viaProxy.capped);
    return { ...viaProxy, fromCache: false, syncedAt: Date.now() };
  }
  // Fallback: fetch GitHub directly from the browser (works, but rate-limited).
  const results = await Promise.allSettled(C.repos.map(fetchRepo));
  const rateLimited = results.some(r => r.status === 'rejected' && r.reason && r.reason.message === 'rate');
  const issues = results.flatMap(r => r.status === 'fulfilled' ? r.value.items : []);
  const capped = results.some(r => r.status === 'fulfilled' && r.value.capped);
  if (!issues.length) {
    const err = new Error(rateLimited ? 'rate' : 'network');
    throw err;
  }
  cacheSet(issues, rateLimited, capped);
  return { issues, partial: rateLimited, capped, fromCache: false, syncedAt: Date.now() };
}

/* ---------- Official status page ---------- */
const STATUSPAGE_MAP = {
  operational: 'Operational', degraded_performance: 'Degraded', under_maintenance: 'Degraded',
  partial_outage: 'Partial Outage', major_outage: 'Outage',
};
let officialCache = undefined; // undefined = not tried, null = unavailable

async function loadOfficial() {
  if (officialCache !== undefined) return officialCache;
  const o = C.officialStatus || {};
  if (!o.summaryUrl) { officialCache = null; return null; }
  try {
    const res = await fetch(o.summaryUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('http');
    const d = await res.json();
    const components = {};
    for (const comp of d.components || []) {
      const svc = o.componentMap[(comp.name || '').toLowerCase()];
      if (svc && STATUSPAGE_MAP[comp.status]) components[svc] = STATUSPAGE_MAP[comp.status];
    }
    const incidents = (d.incidents || [])
      .filter(i => i.status !== 'resolved' && i.status !== 'completed')
      .map(i => ({ name: i.name, impact: i.impact, url: i.shortlink || o.pageUrl }));
    officialCache = { components, incidents };
  } catch (e) {
    officialCache = null; // CORS / network / format — fall back silently
  }
  return officialCache;
}

/* ---------- Site-wide banner ---------- */
const BANNER_COLORS = { 'Info':'var(--info)', 'Degraded':'var(--warn)', 'Partial Outage':'var(--partial)', 'Outage':'var(--down)' };
function showBanner(text, level, link) {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  const color = BANNER_COLORS[level] || 'var(--info)';
  const more = link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">More details →</a>` : '';
  nav.insertAdjacentHTML('afterend',
    `<div class="banner" style="--banner-color:${color}" role="status"><span class="dot pulse" style="background:${color}"></span><span>${esc(text)}${more}</span></div>`);
}

function initBanners(official) {
  const a = CONTENT.announcement || {};
  if (a.text) showBanner(a.text, a.level, a.link);
  if (official && official.incidents && official.incidents.length) {
    const inc = official.incidents[0];
    const lvl = inc.impact === 'critical' ? 'Outage' : inc.impact === 'major' ? 'Partial Outage' : 'Degraded';
    showBanner(`Ongoing incident: ${inc.name}`, lvl, inc.url);
  }
}

/* ---------- Classification ---------- */
function classify(issues) {
  const heat = (a, b) => (b.reactionsTotal + b.comments) - (a.reactionsTotal + a.comments) || (new Date(b.updated) - new Date(a.updated));

  const OV = CONTENT.issueOverrides || {};
  function applyOverride(item) {
    const o = OV[item.url];
    if (!o) return item;
    const m = { ...item };
    if (o.title) m.title = o.title;
    if (o.summary !== undefined) m.summary = o.summary;
    if (o.status) m.status = o.status;
    if (o.impact) m.impact = o.impact;
    if (o.area) m.area = o.area;
    if (o.workaround !== undefined) m.workaround = o.workaround;
    m._edited = true;
    return m;
  }
  const isHidden = i => OV[i.url] && OV[i.url].hidden;

  let bugs = issues.filter(i => i.state === 'open' && !isFeature(i) && !isHidden(i))
    .map(i => applyOverride({ ...i, status: bugStatus(i), impact: impact(i) }));
  // Merge duplicate reports (identical titles, e.g. Sentry re-filing the same crash)
  const seen = new Map();
  for (const b of bugs) {
    const key = b.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    const prev = seen.get(key);
    if (!prev) { b.dupCount = 1; seen.set(key, b); }
    else {
      prev.dupCount++;
      prev.comments += b.comments; prev.reactionsTotal += b.reactionsTotal; prev.thumbs += b.thumbs;
      if (new Date(b.updated) > new Date(prev.updated)) prev.updated = b.updated;
      if (new Date(b.created) < new Date(prev.created)) prev.created = b.created;
      if (!prev.workaround && b.workaround) prev.workaround = b.workaround;
    }
  }
  bugs = [...seen.values()];
  const impRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  bugs.forEach(b => b.qa = isQA(b));
  // Default order: QA-prioritized Explorer tickets first, then impact, then heat
  bugs.sort((a, b) => (b.qa && a.area === 'Explorer' ? 1 : 0) - (a.qa && b.area === 'Explorer' ? 1 : 0)
    || (a.qa === b.qa ? 0 : a.qa ? -1 : 1)
    || impRank[a.impact] - impRank[b.impact] || heat(a, b));

  const feats = issues.filter(i => i.state === 'open' && isFeature(i) && !isHidden(i))
    .map(i => applyOverride({ ...i, status: featStatus(i), interest: interest(i) }));
  const intRank = { 'Very High': 0, High: 1, Medium: 2, Low: 3 };
  feats.sort((a, b) => intRank[a.interest] - intRank[b.interest] || heat(a, b));

  const fixed = issues.filter(i => i.state === 'closed' && i.closed && daysAgo(i.closed) <= C.recentFixDays && !isFeature(i) && bugStatus(i) === 'Resolved' && !isHidden(i))
    .map(i => applyOverride({ ...i, status: bugStatus(i), impact: impact(i) }))
    .sort((a, b) => new Date(b.closed) - new Date(a.closed));

  return { bugs, feats, fixed };
}

function computeServices(bugs, official) {
  return C.services.map(svc => {
    if (CONTENT.statusOverrides[svc.name]) return { ...svc, level: CONTENT.statusOverrides[svc.name] };
    if (official && official.components[svc.name]) return { ...svc, level: official.components[svc.name], official: true };
    if (!C.deriveServiceStatus) return { ...svc, level: 'Operational' };
    // Opt-in derivation: only explicitly labeled critical issues count — heat,
    // reactions, and auto-detected crash reports never flip a service.
    let crit = 0;
    for (const b of bugs) {
      if (b.sentry) continue;
      if (!hasLabel(b, /critical|blocker|p0|sev.?0|sev.?1|outage/)) continue;
      const txt = (b.title + ' ' + b.rawTitle).toLowerCase();
      if (svc.repoAreas.includes(b.area) || svc.keys.some(k => txt.includes(k))) crit++;
    }
    const level = crit >= 3 ? 'Partial Outage' : crit >= 1 ? 'Degraded' : 'Operational';
    return { ...svc, level };
  });
}

/* ---------- Render helpers ---------- */
function badge(text, color) {
  return `<span class="badge" style="color:${color};border-color:${color}55;background:${color}14">${esc(text)}</span>`;
}

function svcCard(name, desc, level, unknown = false, officialFlag = false) {
  const meta = SVC_LEVELS[level] || SVC_LEVELS['Operational'];
  return `<div class="svc" style="--svc-color:${unknown ? 'var(--text-faint)' : meta.color}">
    <div class="svc-name">${esc(name)}</div>
    <div class="svc-desc">${esc(desc)}</div>
    <div class="svc-status"><span class="dot ${level !== 'Operational' && !unknown ? 'pulse' : ''}" style="background:currentColor"></span>${unknown ? 'Unknown' : esc(level)}${officialFlag ? ' <span class="svc-src" title="From the official status page">· official</span>' : ''}</div>
  </div>`;
}

function discordSnippet(b) {
  return `**${b.title}**\n` +
    `Status: ${b.status} | Impact: ${b.impact} | Area: ${b.area}\n` +
    `Workaround: ${b.workaround || 'no confirmed workaround yet'}\n` +
    `Track it here: <${b.url}>`;
}

const CARD_STORE = {};   // id -> issue, for preview modal
let _cardId = 0;

function bugCard(b, withWorkaround = true) {
  const wk = (withWorkaround && b.workaround)
    ? `<div class="wk"><b>Workaround</b>${esc(b.workaround)}</div>`
    : '';
  const extra = (b.pinned ? badge('Pinned', '#FFBC5B') : '') + (b.qa ? badge('QA priority', '#F0883E') : '') + (b.sentry && !b._edited ? badge('Auto-detected', '#7C8CF8') : '') + (b.dupCount > 1 ? badge('×' + b.dupCount + ' reports', '#C77CF8') : '');
  const id = 'c' + (_cardId++);
  CARD_STORE[id] = b;
  const longSummary = b.summary && b.summary.length > 150;
  return `<div class="card">
    <div class="card-top">${badge(b.status, BUG_STATUS_COLORS[b.status])}${badge(b.impact + ' impact', IMPACT_COLORS[b.impact])}${badge(areaLabel(b.area), '#A39DB3')}${extra}</div>
    <button class="card-title card-link" data-preview="${id}">${esc(b.title)}</button>
    ${b.summary ? `<div class="card-expl${longSummary ? ' clamp' : ''}" data-expl>${esc(b.summary)}</div>${longSummary ? `<button class="more-link" data-preview="${id}">Show more</button>` : ''}` : ''}
    ${wk}
    <div class="card-meta"><span>Reported ${esc(fmtDate(b.created))}</span><span>Updated ${esc(rel(b.updated))}</span><button class="copy-btn" data-copy="${esc(encodeURIComponent(discordSnippet(b)))}">Copy for Discord</button></div>
  </div>`;
}

function bindCardInteractions(scope) {
  (scope || document).querySelectorAll('[data-preview]').forEach(btn => btn.onclick = (e) => {
    e.preventDefault();
    openPreview(CARD_STORE[btn.dataset.preview]);
  });
}

function bindCopyButtons(scope) {
  (scope || document).querySelectorAll('.copy-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const text = decodeURIComponent(btn.dataset.copy);
      try {
        await navigator.clipboard.writeText(text);
        const old = btn.textContent;
        btn.textContent = 'Copied ✓';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1600);
      } catch (err) {
        window.prompt('Copy this:', text); // clipboard blocked — manual fallback
      }
    };
  });
}

function featCard(f) {
  const id = 'c' + (_cardId++);
  CARD_STORE[id] = f;
  const longSummary = f.summary && f.summary.length > 150;
  return `<div class="card">
    <div class="card-top">${badge(f.status, FEAT_STATUS_COLORS[f.status])}${badge(f.interest + ' interest', '#FFBC5B')}${badge(areaLabel(f.area), '#A39DB3')}</div>
    <button class="card-title card-link" data-preview="${id}">${esc(f.title)}</button>
    ${f.summary ? `<div class="card-expl${longSummary ? ' clamp' : ''}" data-expl>${esc(f.summary)}</div>${longSummary ? `<button class="more-link" data-preview="${id}">Show more</button>` : ''}` : ''}
    <div class="card-meta"><span>Submitted ${esc(fmtDate(f.created))}</span><span>Updated ${esc(rel(f.updated))}</span><button class="copy-btn" data-copy="${esc(encodeURIComponent(discordSnippet(f)))}">Copy for Discord</button></div>
  </div>`;
}

function fixedRow(f) {
  return `<a class="fixed-row" href="${esc(f.url)}" target="_blank" rel="noopener">
    <span class="fixed-check">✓</span>
    <span class="fixed-body">
      <span class="fixed-title">${esc(f.title)}</span>
      <span class="fixed-meta">
        <span class="fixed-area">${esc(areaLabel(f.area))}</span>
        <span class="fixed-dot">·</span>
        <span class="fixed-date">Fixed ${esc(fmtDate(f.closed))}</span>
      </span>
    </span>
    <span class="fixed-arrow" aria-hidden="true">→</span>
  </a>`;
}

function shortCid(id) { return id.length > 18 ? id.slice(0, 10) + '…' + id.slice(-5) : id; }

const LOOKUP_STATUS_COLORS = { complete: 'var(--ok)', pending: 'var(--warn)', queued: 'var(--warn)', failed: 'var(--down)', error: 'var(--down)' };

function initEntityLookup() {
  const btn = $('lookupBtn'), input = $('lookupInput'), out = $('lookupResult');
  if (!btn || btn._wired) return;
  btn._wired = true;
  const go = async () => {
    const cid = input.value.trim();
    if (!cid) return;
    out.innerHTML = '<div class="loading" style="border:none;padding:14px">Checking…</div>';
    const base = (C.assetBundles && C.assetBundles.registryUrl) || 'https://asset-bundle-registry.decentraland.org';
    try {
      const res = await fetch(`${base}/entities/status/${encodeURIComponent(cid)}`, { headers: { Accept: 'application/json' } });
      if (res.status === 404) { out.innerHTML = '<div class="lookup-card">Entity not found in the registry. Double-check the CID, or the deployment may not be registered yet.</div>'; return; }
      if (!res.ok) throw new Error();
      const d = await res.json();
      const ab = d.assetBundles || {};
      const rows = Object.keys(PLATFORM_META).map(p => {
        const st = (ab[p] || (d.platforms && d.platforms[p]) || 'unknown').toString().toLowerCase();
        const color = LOOKUP_STATUS_COLORS[st] || 'var(--text-faint)';
        return `<div class="lookup-row"><span>${esc(PLATFORM_META[p].label)}</span><span style="color:${color};font-family:var(--mono);text-transform:uppercase;font-size:12px">${esc(st)}</span></div>`;
      }).join('');
      out.innerHTML = `<div class="lookup-card">
        <div class="lookup-head">${d.complete ? '<span style="color:var(--ok)">✓ All bundles ready</span>' : '<span style="color:var(--warn)">⧗ Conversion in progress</span>'}</div>
        ${rows}
      </div>`;
    } catch (e) {
      out.innerHTML = '<div class="lookup-card">Could not check this entity right now. Try again in a moment.</div>';
    }
  };
  btn.onclick = go;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

function jobRow(j) {
  const base = (C.assetBundles && C.assetBundles.registryUrl) || 'https://asset-bundle-registry.decentraland.org';
  const statusColor = j.status.includes('fail') || j.status.includes('error') ? 'var(--down)'
    : j.status.includes('process') || j.status.includes('progress') ? 'var(--info)'
    : j.status.includes('retry') ? 'var(--warn)' : 'var(--text-faint)';
  return `<a class="queue-item" data-entity="${esc(j.entityId)}" href="${esc(base)}/entities/status/${encodeURIComponent(j.entityId)}" target="_blank" rel="noopener" title="${esc(j.entityId)}">
    <div class="queue-scene">${esc(shortCid(j.entityId))}</div>
    <div class="queue-meta">
      <span class="queue-kind" data-kind-for="${esc(j.entityId)}"></span>
      <span class="queue-status" style="color:${statusColor}">${esc(j.status)}</span>
      ${j.retries != null ? `<span class="queue-retry">${esc(String(j.retries))} retries</span>` : ''}
      ${j.createdAt ? `<span class="queue-age">${esc(rel(j.createdAt))}</span>` : ''}
    </div>
  </a>`;
}

function errorBox(kind) {
  const msg = kind === 'rate'
    ? 'GitHub is temporarily limiting requests from your network. Cached data will be used when available — please try again in a little while.'
    : 'Could not reach the Decentraland issue trackers. Check your connection and try again.';
  return `<div class="error-box">${esc(msg)}<br><button onclick="location.reload()">Retry</button></div>`;
}

function setSync(syncedAt, fromCache, partial) {
  const el = $('syncNote'), foot = $('footSync');
  const t = new Date(syncedAt).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  const txt = `Synced from GitHub · ${t}${fromCache ? ' (cached)' : ''}${partial ? ' · partial data' : ''}`;
  if (el) el.textContent = txt;
  if (foot) foot.textContent = `Last sync ${t}`;
}

/* ---------- Issue preview modal ---------- */
let _modalEl = null;
function ensureModal() {
  if (_modalEl) return _modalEl;
  _modalEl = document.createElement('div');
  _modalEl.className = 'modal-overlay';
  _modalEl.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <button class="modal-close" aria-label="Close">✕</button>
    <div class="modal-body"></div>
  </div>`;
  document.body.appendChild(_modalEl);
  const close = () => {
    _modalEl.classList.remove('open');
    document.body.style.overflow = '';
    presenceSetAction('');  // back to just the page in the live roster
    // Stop any playing media so audio doesn't continue after closing.
    _modalEl.querySelectorAll('video, audio').forEach(v => { try { v.pause(); v.currentTime = 0; } catch (e) {} });
    // Iframes (e.g. Google Drive preview) keep playing when hidden; blanking
    // the src halts their audio. The modal body is rebuilt on next open, so a
    // fresh iframe is created then — no need to restore it here.
    _modalEl.querySelectorAll('iframe').forEach(f => { try { f.src = 'about:blank'; } catch (e) {} });
  };
  _modalEl.addEventListener('click', e => { if (e.target === _modalEl) close(); });
  _modalEl.querySelector('.modal-close').onclick = close;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  return _modalEl;
}

// very small, safe markdown -> html (headings, bold, italic, code, links, lists)
function miniMarkdown(md) {
  // GitHub's image/video paste inserts raw HTML tags (e.g. <img width=.. src="..">).
  // Pull the src out to a bare URL on its own line *before* escaping, so the URL
  // rules below turn it into an inline image/video. Fixes evidence in both bodies
  // and comments that use this format instead of markdown.
  md = String(md || '')
    .replace(/<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi, '\n$1\n')
    .replace(/<(?:video|source)\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi, '\n$1\n');
  let h = esc(md)
    .replace(/```([\s\S]*?)```/g, (m, c) => `<pre><code>${c.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^#{4,6}\s*(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s*(.+)$/gm, '<h4>$1</h4>')
    .replace(/^##\s*(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#\s*(.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    // Images first (![alt](url)), so they aren't mistaken for links. Lazy-loaded,
    // click to open full size on GitHub.
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-img-link"><img class="md-img" src="$2" alt="$1" loading="lazy"></a>')
    // Then links.
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Google Drive file links (bare drive.google.com/file/d/<id>/...). Show an
    // inline preview iframe plus an always-present link, since the embed shows a
    // sign-in wall if the file isn't shared publicly.
    .replace(/(^|\s)(https?:\/\/drive\.google\.com\/file\/d\/([-\w]+)[^\s<]*)(?=\s|$)/gi,
      '$1<span class="md-drive"><iframe class="md-drive-frame" src="https://drive.google.com/file/d/$3/preview" allow="autoplay" loading="lazy"></iframe><a class="md-drive-link" href="$2" target="_blank" rel="noopener">Open in Google Drive →</a></span>')
    // Explicit video URLs (.mp4/.mov/.webm, incl. ?query) → inline player.
    // Must run before the image/S3 rules so an .mp4 isn't wrapped in <img>.
    .replace(/(^|\s)(https?:\/\/[^\s<]+?\.(?:mp4|mov|webm)(?:\?[^\s<]*)?)(?=\s|$)/gim, '$1<video class="md-video" src="$2" controls preload="metadata" playsinline></video>')
    // Bare image URLs on their own (GitHub/S3 user-attachment assets, or any
    // .png/.jpg/.gif/.webp link) become inline images too.
    .replace(/(^|\s)(https?:\/\/[^\s<]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s<]*)?)(?=\s|$)/gim, '$1<a href="$2" target="_blank" rel="noopener" class="md-img-link"><img class="md-img" src="$2" alt="" loading="lazy"></a>')
    .replace(/(^|\s)(https?:\/\/github-production-user-asset[^\s<]+)(?=\s|$)/gi, '$1<a href="$2" target="_blank" rel="noopener" class="md-img-link"><img class="md-img md-img-maybe" src="$2" alt="" loading="lazy"></a>')
    // GitHub's modern attachment URLs have no file extension
    // (github.com/user-attachments/assets/<uuid>). Render as an image; a JS
    // onerror fallback (attached after render) swaps it for a link if it's a
    // video or other non-image asset.
    .replace(/(^|\s)(https?:\/\/github\.com\/user-attachments\/assets\/[^\s<)]+)(?=\s|$)/gi, '$1<a href="$2" target="_blank" rel="noopener" class="md-img-link"><img class="md-img md-img-maybe" src="$2" alt="" loading="lazy"></a>')
    .replace(/&lt;!--[\s\S]*?--&gt;/g, '')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  return h.split(/\n{2,}/).map(p => /^<(h\d|ul|pre)/.test(p.trim()) ? p : (p.trim() ? `<p>${p.trim().replace(/\n/g, '<br>')}</p>` : '')).join('');
}

async function openPreview(b) {
  const m = ensureModal();
  presenceSetAction('Viewing: ' + (b.title || 'an item'));
  const colors = b.status in BUG_STATUS_COLORS ? BUG_STATUS_COLORS : FEAT_STATUS_COLORS;
  const tags = (b.pinned ? badge('Pinned', '#FFBC5B') : '') + (b.qa ? badge('QA priority', '#F0883E') : '') +
    badge(b.status, colors[b.status]) + (b.impact ? badge(b.impact + ' impact', IMPACT_COLORS[b.impact]) : '') +
    (b.interest ? badge(b.interest + ' interest', '#FFBC5B') : '') + badge(areaLabel(b.area), '#A39DB3') +
    (b.sentry ? badge('Auto-detected', '#7C8CF8') : '');
  m.querySelector('.modal-body').innerHTML = `
    <div class="card-top" style="margin-bottom:14px">${tags}</div>
    <h2 class="modal-title">${esc(b.title)}</h2>
    <div class="modal-meta">Reported ${esc(fmtDate(b.created))} · Updated ${esc(rel(b.updated))}${b.dupCount > 1 ? ' · ' + b.dupCount + ' reports merged' : ''}</div>
    ${b.workaround ? `<div class="wk" style="margin:14px 0"><b>Workaround</b>${esc(b.workaround)}</div>` : ''}
    <div class="modal-md" id="modalMd"><div class="loading" style="border:none">Loading description…</div></div>
    <div class="modal-comments" id="modalComments"></div>
    <div class="modal-actions">
      <button class="copy-btn" data-copy="${esc(encodeURIComponent(discordSnippet(b)))}" style="margin:0">Copy for Discord</button>
      <a class="report-btn" href="${esc(b.url)}" target="_blank" rel="noopener" style="padding:10px 20px">Open on GitHub →</a>
    </div>`;
  m.classList.add('open');
  document.body.style.overflow = 'hidden';
  bindCopyButtons(m);
  // lazy-load body + comments (evidence is often in the comments)
  const md = m.querySelector('#modalMd');
  const cm = m.querySelector('#modalComments');
  if (b.fullBody !== undefined) { renderModalBody(md, b.fullBody); loadComments(b, cm); return; }
  try {
    const api = b.url.replace('https://github.com/', 'https://api.github.com/repos/').replace('/issues/', '/issues/');
    const res = await fetch(api, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error();
    const data = await res.json();
    b.fullBody = (data.body || '').slice(0, 6000);
    if (typeof data.comments === 'number') b.comments = data.comments;
    renderModalBody(md, b.fullBody);
    loadComments(b, cm);
  } catch (e) {
    md.innerHTML = '<p class="modal-empty">Could not load the description here. Use “Open on GitHub” for the full ticket.</p>';
  }
}

// Render the issue body markdown and wire fallbacks for extensionless GitHub
// attachment URLs (the URL doesn't reveal its type): try as an image first; if
// that fails, try as a <video>; if that also fails, show a plain link.
function renderModalBody(md, body) {
  md.innerHTML = body ? miniMarkdown(body) : '<p class="modal-empty">No description provided.</p>';
  wireAttachmentFallbacks(md);
}

// Extensionless GitHub attachment URLs don't reveal their type: try image first,
// then a <video>, then a plain link. Shared by the body and comment renderers.
function wireAttachmentFallbacks(root) {
  root.querySelectorAll('img.md-img-maybe').forEach(img => {
    img.onerror = () => {
      const url = img.getAttribute('src');
      const wrap = img.closest('.md-img-link') || img;
      const vid = document.createElement('video');
      vid.className = 'md-video';
      vid.src = url;
      vid.controls = true;
      vid.preload = 'metadata';
      vid.playsInline = true;
      vid.onerror = () => {
        const link = document.createElement('a');
        link.href = url; link.target = '_blank'; link.rel = 'noopener';
        link.textContent = 'View attachment on GitHub →';
        vid.replaceWith(link);
      };
      wrap.replaceWith(vid);
    };
  });
}

// Lazily fetch + render a ticket's GitHub comments (evidence is often posted
// there rather than in the body). One request per opened ticket, cached on the
// item; bot comments (CI / triage automation) are filtered out. Fails silently —
// the "Open on GitHub" link always covers the full thread.
async function loadComments(b, host) {
  if (!host || !b.comments) return;
  try {
    if (b.fullComments === undefined) {
      host.innerHTML = '<div class="loading" style="border:none">Loading comments…</div>';
      const api = b.url.replace('https://github.com/', 'https://api.github.com/repos/') + '/comments?per_page=100';
      const res = await fetch(api, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error();
      const data = await res.json();
      b.fullComments = (Array.isArray(data) ? data : [])
        .filter(c => c.user && c.user.type !== 'Bot' && !/\[bot\]$/i.test(c.user.login || ''))
        .map(c => ({ author: c.user.login, avatar: c.user.avatar_url, date: c.created_at, body: (c.body || '').slice(0, 4000) }));
    }
    renderComments(host, b.fullComments);
  } catch (e) { host.innerHTML = ''; }
}
function renderComments(host, comments) {
  if (!comments || !comments.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="modal-comments-head">${comments.length} comment${comments.length > 1 ? 's' : ''} from GitHub</div>` +
    comments.map(c => `
      <div class="modal-comment">
        <div class="mc-head">
          <img class="mc-av" src="${esc(c.avatar || '')}" alt="" loading="lazy" decoding="async">
          <span class="mc-author">${esc(c.author || 'user')}</span>
          <span class="mc-date">${esc(rel(c.date))}</span>
        </div>
        <div class="mc-body">${miniMarkdown(c.body)}</div>
      </div>`).join('');
  wireAttachmentFallbacks(host);
}

/* ---------- Generic filterable card list ---------- */
const SORTS = {
  newest: (a, b) => new Date(b.created) - new Date(a.created),
  updated: (a, b) => new Date(b.updated) - new Date(a.updated),
  reported: (a, b) => (b.reactionsTotal + b.comments + (b.dupCount || 1) * 2) - (a.reactionsTotal + a.comments + (a.dupCount || 1) * 2),
};

function cardList({ items, gridId, moreId, countId, countSuffix, searchId, chipsId, sortId, cardFn, emptyMsg, plus, defaultSort }) {
  const grid = $(gridId), more = $(moreId), count = $(countId), search = $(searchId), chips = $(chipsId), sortSel = $(sortId);
  const AREA_ORDER = ['Explorer', 'Creator Hub', 'Website', 'SDK'];
  // Pills are driven by the configured repo areas (not by whatever happens to be
  // in the live data), so every section always shows in a stable order — even if a
  // repo is momentarily quiet — and stray/legacy areas never spawn rogue pills.
  const areas = [...new Set((C.repos || []).map(r => r.area))].sort((a, b) => {
    const ia = AREA_ORDER.indexOf(a), ib = AREA_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  let st = { area: 'All', q: '', pages: 1, sort: defaultSort || 'default' };

  function draw() {
    let list = items.filter(x =>
      (st.area === 'All' || x.area === st.area) &&
      (!st.q || (x.title + ' ' + x.summary).toLowerCase().includes(st.q)));
    if (SORTS[st.sort]) list = [...list].sort(SORTS[st.sort]);
    const showPlus = plus && st.area === 'All' && !st.q ? '+' : '';
    if (count) count.textContent = `${list.length}${showPlus} ${countSuffix}`;
    const shown = list.slice(0, st.pages * C.pageSize);
    grid.innerHTML = shown.length ? shown.map(cardFn).join('') : `<div class="empty" style="grid-column:1/-1">${esc(emptyMsg)}</div>`;
    if (more) more.hidden = list.length <= shown.length;
    bindCopyButtons(grid);
    bindCardInteractions(grid);
    if (chips) {
      chips.innerHTML = ['All', ...areas].map(a =>
        `<button class="chip ${a === st.area ? 'on' : ''}" data-a="${esc(a)}">${esc(a === 'All' ? 'All' : areaLabel(a))}</button>`).join('');
      chips.querySelectorAll('.chip').forEach(c => c.onclick = () => { st.area = c.dataset.a; st.pages = 1; draw(); });
    }
  }
  if (search) search.oninput = e => { st.q = e.target.value.toLowerCase(); st.pages = 1; draw(); };
  if (more) more.onclick = () => { st.pages++; draw(); };
  if (sortSel) { sortSel.value = st.sort; sortSel.dispatchEvent(new Event('change')); sortSel.onchange = () => { st.sort = sortSel.value; st.pages = 1; draw(); }; }
  draw();
}

/* ---------- Motion helpers ---------- */
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function countUp(el, target, suffix = '') {
  if (!el) return;
  if (REDUCED || target === 0) { el.textContent = target + suffix; return; }
  const dur = 700, t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))) + (p === 1 ? suffix : '');
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function initReveals() {
  if (REDUCED || typeof IntersectionObserver === 'undefined') return;
  const els = document.querySelectorAll('section .wrap');
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' });
  els.forEach(el => { el.classList.add('reveal'); io.observe(el); });
}

/* ---------- Chrome: nav, hero parcels ---------- */
/* ---------- Custom themed dropdowns ----------
   Replaces native <select> popups (whose open-list hover color is OS-controlled
   and can't be themed) with a styled listbox. The real <select> stays in the
   DOM (visually hidden) and remains the source of truth: choosing an option
   sets its value and dispatches a native 'change' event, so all existing
   handlers keep working. Keyboard- and outside-click-aware. */
let _ddOpen = null;   // currently open custom dropdown root, or null

function enhanceSelects(scope) {
  (scope || document).querySelectorAll('select:not([data-enhanced])').forEach(sel => {
    sel.setAttribute('data-enhanced', '1');

    const root = document.createElement('div');
    root.className = 'cdd';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cdd-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
    const label = document.createElement('span');
    label.className = 'cdd-label';
    btn.appendChild(label);
    btn.insertAdjacentHTML('beforeend', '<span class="cdd-chev" aria-hidden="true">▾</span>');

    const list = document.createElement('div');
    list.className = 'cdd-list';
    list.setAttribute('role', 'listbox');

    const opts = Array.from(sel.options);
    opts.forEach((o, i) => {
      const item = document.createElement('div');
      item.className = 'cdd-opt';
      item.setAttribute('role', 'option');
      item.dataset.index = i;
      item.textContent = o.textContent;
      if (o.disabled) item.classList.add('disabled');
      list.appendChild(item);
    });

    // Insert the custom UI right after the (now hidden) select.
    sel.classList.add('cdd-native');
    sel.parentNode.insertBefore(root, sel.nextSibling);
    root.appendChild(btn);
    root.appendChild(list);

    const syncLabel = () => {
      const o = sel.options[sel.selectedIndex];
      label.textContent = o ? o.textContent : '';
      label.classList.toggle('placeholder', !!(o && o.disabled));
      list.querySelectorAll('.cdd-opt').forEach((el, i) => {
        el.classList.toggle('selected', i === sel.selectedIndex);
        el.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false');
      });
    };
    syncLabel();
    // Keep the custom UI in sync when the underlying value is set in code
    // (e.g. a per-list default sort), not just on user clicks.
    sel.addEventListener('change', syncLabel);

    const open = () => {
      if (_ddOpen && _ddOpen !== root) closeDropdown(_ddOpen);
      root.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      _ddOpen = root;
      const selEl = list.querySelector('.cdd-opt.selected') || list.querySelector('.cdd-opt:not(.disabled)');
      if (selEl) selEl.scrollIntoView({ block: 'nearest' });
    };
    const choose = (i) => {
      if (sel.options[i] && sel.options[i].disabled) return;
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      syncLabel();
      closeDropdown(root);
      btn.focus();
    };

    btn.onclick = () => { root.classList.contains('open') ? closeDropdown(root) : open(); };
    list.querySelectorAll('.cdd-opt').forEach(el => {
      el.onclick = () => choose(+el.dataset.index);
    });

    // Keyboard support on the button.
    btn.addEventListener('keydown', (e) => {
      const isOpen = root.classList.contains('open');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) { open(); return; }
        moveHighlight(list, e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!isOpen) { open(); return; }
        const hi = list.querySelector('.cdd-opt.highlight');
        if (hi) choose(+hi.dataset.index);
      } else if (e.key === 'Escape') {
        if (isOpen) { e.preventDefault(); closeDropdown(root); }
      }
    });

    // Keep the custom UI in sync if other code changes the select value.
    sel.addEventListener('change', syncLabel);
  });
}

function moveHighlight(list, dir) {
  const items = Array.from(list.querySelectorAll('.cdd-opt:not(.disabled)'));
  if (!items.length) return;
  let idx = items.findIndex(el => el.classList.contains('highlight'));
  if (idx < 0) idx = items.findIndex(el => el.classList.contains('selected'));
  idx = Math.max(0, Math.min(items.length - 1, idx + dir));
  list.querySelectorAll('.cdd-opt').forEach(el => el.classList.remove('highlight'));
  items[idx].classList.add('highlight');
  items[idx].scrollIntoView({ block: 'nearest' });
}

function closeDropdown(root) {
  root.classList.remove('open');
  const btn = root.querySelector('.cdd-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  root.querySelectorAll('.cdd-opt.highlight').forEach(el => el.classList.remove('highlight'));
  if (_ddOpen === root) _ddOpen = null;
}

// Close on outside click.
document.addEventListener('click', (e) => {
  if (_ddOpen && !_ddOpen.contains(e.target)) closeDropdown(_ddOpen);
});

function initChrome() {
  // active nav link
  const page = document.body.dataset.page;
  document.querySelectorAll('.nav-links a').forEach(a => {
    if (a.dataset.nav === page) a.classList.add('active');
  });
  enhanceSelects(document);
  // mobile menu
  const btn = $('menuBtn'), links = $('navLinks');
  if (btn && links) btn.onclick = () => links.classList.toggle('open');
  // hero glow
  const hero = document.querySelector('.hero');
  if (hero) hero.insertAdjacentHTML('afterbegin', '<div class="hero-glow" aria-hidden="true"></div>');
  initReveals();
  // parcels
  const grid = $('parcelGrid');
  if (grid) {
    const colors = ['#FF2D55', '#FFBC5B', '#3FCB6E', '#7C8CF8'];
    const n = document.body.dataset.page === 'overview' ? 14 : 8;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('div');
      p.className = 'parcel';
      p.style.left = Math.floor(Math.random() * 26) * 44 + 'px';
      p.style.top = Math.floor(Math.random() * 6) * 44 + 'px';
      p.style.background = colors[i % colors.length] + '22';
      p.style.border = '1px solid ' + colors[i % colors.length] + '66';
      p.style.animationDelay = (Math.random() * 7).toFixed(2) + 's';
      grid.appendChild(p);
    }
  }
}

/* ---------- Asset bundle queue ---------- */
const PLATFORM_META = {
  webgl:   { label: 'WebGL',   color: '#5BC8F5', desc: 'Browser / web client' },
  windows: { label: 'Windows', color: '#7C8CF8', desc: 'Windows desktop' },
  mac:     { label: 'macOS',   color: '#C77CF8', desc: 'macOS desktop' },
};
const SCENE_CACHE = {};   // entityId -> { name, parcels } | null

// Accept several plausible registry shapes and flatten to a job list.
function normalizeQueue(data) {
  const jobs = [];
  const pushJob = (j, platformHint) => {
    if (!j) return;
    if (typeof j === 'string') j = { entityId: j };   // registry returns plain CID strings
    const entityId = j.entityId || j.entity_id || j.id || (j.entity && j.entity.entityId) || '';
    if (!entityId) return;
    let platform = (j.platform || j.target || platformHint || '').toString().toLowerCase();
    if (platform.includes('web')) platform = 'webgl';
    else if (platform.includes('win')) platform = 'windows';
    else if (platform.includes('mac') || platform.includes('osx')) platform = 'mac';
    jobs.push({
      entityId,
      platform: PLATFORM_META[platform] ? platform : 'webgl',
      status: (j.status || j.state || 'pending').toString().toLowerCase(),
      retries: j.retries ?? j.retry ?? j.attempts ?? null,
      createdAt: j.createdAt || j.created_at || j.queuedAt || j.timestamp || null,
    });
  };
  // Real registry shape: { webglPendingJobs: [...], windowsPendingJobs: [...], macPendingJobs: [...] }
  if (data && (data.webglPendingJobs || data.windowsPendingJobs || data.macPendingJobs)) {
    [['webglPendingJobs', 'webgl'], ['windowsPendingJobs', 'windows'], ['macPendingJobs', 'mac']]
      .forEach(([key, plat]) => Array.isArray(data[key]) && data[key].forEach(j => pushJob(j, plat)));
    return jobs;
  }
  if (Array.isArray(data)) data.forEach(j => pushJob(j));
  else if (data && Array.isArray(data.jobs)) data.jobs.forEach(j => pushJob(j));
  else if (data && data.queues && typeof data.queues === 'object') {
    Object.entries(data.queues).forEach(([plat, arr]) => Array.isArray(arr) && arr.forEach(j => pushJob(j, plat)));
  } else if (data && typeof data === 'object') {
    // last resort: object keyed by platform -> array
    Object.entries(data).forEach(([plat, arr]) => Array.isArray(arr) && arr.forEach(j => pushJob(j, plat)));
  }
  return jobs;
}

// Turn an entity manifest into a normalized scene record, classifying it as a
// World (named, e.g. "myworld.dcl.eth") or a Genesis City scene (parcel coords).
function sceneFromEntity(e) {
  const md = e.metadata || {};
  const worldName = md.worldConfiguration && (md.worldConfiguration.name || md.worldConfiguration.dclName);
  const title = (md.display && md.display.title) || (md.scene && md.scene.name) || md.name || null;
  const timestamp = e.timestamp || md.timestamp || null;
  if (worldName) {
    return { type: 'world', name: title && title !== 'interactive-text' ? title : worldName, world: worldName, parcels: [], timestamp };
  }
  const parcels = (md.scene && md.scene.parcels) || e.pointers || [];
  let base = (md.scene && md.scene.base) || (parcels.length ? parcels[0] : null);
  return { type: 'parcel', name: title, parcels, base, timestamp };
}

// Resolve a batch of entityIds against a content server (one GET /contents/{id}
// each), returning id -> normalized scene/world record.
async function fetchEntities(server, ids) {
  const out = {};
  if (!ids.length) return out;
  // The asset-bundle registry only returns entityIds; the entity itself
  // (pointers, timestamp, metadata) is content-addressed on the catalyst. This
  // is how DCL resolves it internally: GET {server}/contents/{entityId}.
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(`${server}/contents/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const e = await res.json();
      if (e && typeof e === 'object' && (e.metadata || e.pointers)) out[id] = sceneFromEntity(e);
    } catch (_) { /* best-effort per entity */ }
  }));
  return out;
}

// Batch-resolve entity CIDs to scene names + parcels (or World names).
// Preferred: the Supabase edge function (?action=resolve) — server-side, so it
// bypasses browser CORS against the content servers and caches results for all
// visitors. Falls back to direct dual-server fetching if the proxy is absent.
async function resolveScenes(ids) {
  const todo = ids.filter(id => !(id in SCENE_CACHE));

  if (todo.length) {
    let resolved = {};

    // Try the edge function first.
    const sb = C.supabase || {};
    if (sb.url && sb.anonKey && C.github && C.github.useProxy) {
      try {
        const res = await fetch(`${sb.url}/functions/v1/github-issues?action=resolve`, {
          method: 'POST',
          headers: { apikey: sb.anonKey, Authorization: 'Bearer ' + sb.anonKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ ids: todo }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.scenes) resolved = data.scenes;
        }
      } catch (e) { /* fall through to direct */ }
    }

    // Apply whatever the proxy resolved; resolve the rest directly from the
    // content servers via the per-entity /contents/{id} method (catalyst, then
    // worlds). This keeps working even before the edge function is redeployed.
    const missing = [];
    for (const id of todo) {
      if (resolved[id]) SCENE_CACHE[id] = resolved[id];
      else missing.push(id);
    }
    if (missing.length) {
      const catalyst = (C.assetBundles && C.assetBundles.contentServer) || 'https://peer.decentraland.org/content';
      const worlds = (C.assetBundles && C.assetBundles.worldsServer) || 'https://worlds-content-server.decentraland.org';
      const fromCatalyst = await fetchEntities(catalyst, missing);
      Object.assign(SCENE_CACHE, fromCatalyst);
      const worldMissing = missing.filter(id => !(id in SCENE_CACHE));
      if (worldMissing.length) {
        const fromWorlds = await fetchEntities(worlds, worldMissing);
        for (const [id, rec] of Object.entries(fromWorlds)) {
          SCENE_CACHE[id] = rec.type === 'world' ? rec : { ...rec, type: 'world', world: rec.world || rec.name };
        }
      }
      missing.forEach(id => { if (!(id in SCENE_CACHE)) SCENE_CACHE[id] = null; });
    }
  }

  const out = {};
  ids.forEach(id => out[id] = SCENE_CACHE[id]);
  return out;
}

async function loadQueue() {
  const cfg = C.assetBundles || {};
  if (!cfg.queueUrl) return { configured: false, jobs: [] };
  const res = await fetch(cfg.queueUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error('http ' + res.status);
  const data = await res.json();
  return { configured: true, jobs: normalizeQueue(data) };
}

/* ---------- Patch notes ---------- */
function patchNotesToHtml(body) {
  // Render the pasted release-notes text. Lines starting with - become list items;
  // lines ending with ':' (with optional emoji) become subheadings.
  const lines = esc(body).split(/\r?\n/);
  let html = '', inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const linked = line.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
                       .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul class="pn-list">'; inList = true; }
      html += `<li>${linked.replace(/^[-*]\s+/, '')}</li>`;
    } else if (/:\s*$/.test(line)) {
      closeList(); html += `<div class="pn-sub">${linked}</div>`;
    } else {
      closeList(); html += `<div class="pn-line">${linked}</div>`;
    }
  }
  closeList();
  return html;
}

// The three patch-note streams shown side by side. Order here = column order.
const PATCH_STREAMS = [
  { key: 'explorer',    label: 'Explorer',    link: 'https://github.com/decentraland/unity-explorer/releases' },
  { key: 'creator-hub', label: 'Creator Hub', link: 'https://github.com/decentraland/creator-hub/releases' },
  { key: 'sdk',         label: 'SDK',         link: 'https://github.com/decentraland/sdk/releases' },
];

function renderPatchNotes() {
  const sec = $('patchNotesSec'), wrap = $('patchNotes');
  if (!wrap) return;
  const notes = CONTENT.patchNotes || [];
  if (!notes.length) { if (sec) sec.style.display = 'none'; return; }
  if (sec) sec.style.display = '';

  // Group notes by stream, preserving their stored order (already position-sorted).
  const byStream = {};
  PATCH_STREAMS.forEach(s => byStream[s.key] = []);
  notes.forEach(n => {
    const k = (n.stream && byStream[n.stream] !== undefined) ? n.stream : 'explorer';
    byStream[k].push(n);
  });

  // Always show all three columns in fixed order (Explorer, Creator Hub, SDK),
  // so the layout stays a stable 3-up grid even when a stream has no notes yet.
  wrap.dataset.cols = PATCH_STREAMS.length;

  wrap.innerHTML = PATCH_STREAMS.map(s => {
    const list = byStream[s.key];
    let cards;
    if (!list.length) {
      cards = `<div class="pn-empty">No releases posted yet.</div>`;
    } else {
      const latest = list[0];
      const latestCard = `
      <div class="pn-card latest">
        <div class="pn-head">
          <span class="pn-version">${esc(latest.version || 'Release')}</span>
          ${latest.date ? `<span class="pn-date">${esc(latest.date)}</span>` : ''}
          <span class="pn-badge">Latest</span>
        </div>
        <div class="pn-body">${patchNotesToHtml(latest.body || '')}</div>
      </div>`;
      // Older releases collapse into one-line rows so they don't dominate the page.
      const prev = list.slice(1).map(n => {
        const cnt = ((n.body || '').match(/^\s*[-*]\s+/gm) || []).length;
        return `
      <div class="pn-card prev">
        <button class="pn-toggle" type="button" aria-expanded="false">
          <span class="pn-chev" aria-hidden="true"></span>
          <span class="pn-version">${esc(n.version || 'Release')}</span>
          ${n.date ? `<span class="pn-date">${esc(n.date)}</span>` : ''}
          ${cnt ? `<span class="pn-count">${cnt} update${cnt > 1 ? 's' : ''}</span>` : ''}
        </button>
        <div class="pn-collapse"><div class="pn-inner"><div class="pn-body">${patchNotesToHtml(n.body || '')}</div></div></div>
      </div>`;
      }).join('');
      cards = latestCard + (prev ? `<div class="pn-prev-label">Previous releases</div>${prev}` : '');
    }
    return `
      <div class="pn-col">
        <div class="pn-col-head">
          <span class="pn-col-title">${esc(s.label)}</span>
          <a class="pn-col-link" href="${esc(s.link)}" target="_blank" rel="noopener">Releases →</a>
        </div>
        <div class="pn-col-cards">${cards}</div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.pn-toggle').forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest('.pn-card');
      const open = card.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
  });

  setupPatchCarousel(wrap);
}

// On mobile the .pn-grid is a horizontal scroll-snap carousel. Add arrow + dot
// controls (the nav is display:none on desktop via CSS) and keep them in sync
// with swipe scrolling.
function setupPatchCarousel(wrap) {
  const parent = wrap.parentNode;
  if (!parent) return;
  // Remove any stale nav from a previous render.
  const existing = parent.querySelector('.pn-carousel-nav');
  if (existing) existing.remove();

  const cols = Array.from(wrap.children);
  if (cols.length < 2) return;

  const nav = document.createElement('div');
  nav.className = 'pn-carousel-nav';
  nav.innerHTML =
    `<button class="pn-carousel-btn" data-pncar="prev" aria-label="Previous">‹</button>
     <div class="pn-carousel-dots">${cols.map((c, i) =>
       `<button class="pn-carousel-dot${i === 0 ? ' active' : ''}" data-pncardot="${i}" aria-label="Go to ${i + 1}"></button>`).join('')}</div>
     <button class="pn-carousel-btn" data-pncar="next" aria-label="Next">›</button>`;
  parent.insertBefore(nav, wrap.nextSibling);

  const dots = Array.from(nav.querySelectorAll('[data-pncardot]'));
  const prevBtn = nav.querySelector('[data-pncar="prev"]');
  const nextBtn = nav.querySelector('[data-pncar="next"]');

  let startPage = 0, settleTimer = null, programmatic = false;
  const current = () => Math.round(wrap.scrollLeft / wrap.clientWidth);
  const goTo = (i) => {
    const idx = Math.max(0, Math.min(cols.length - 1, i));
    programmatic = true;           // this jump is intentional; don't clamp it
    startPage = idx;
    wrap.scrollTo({ left: idx * wrap.clientWidth, behavior: 'smooth' });
  };
  const sync = () => {
    const i = current();
    dots.forEach((d, di) => d.classList.toggle('active', di === i));
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i >= cols.length - 1;
  };

  prevBtn.onclick = () => goTo(current() - 1);
  nextBtn.onclick = () => goTo(current() + 1);
  dots.forEach((d, i) => d.onclick = () => goTo(i));

  // Limit each swipe to at most one page so a hard fling can't skip the middle
  // card. Record where the gesture started; when scrolling settles, clamp the
  // landing page to within ±1 of the start and snap there.
  wrap.addEventListener('touchstart', () => { startPage = current(); programmatic = false; }, { passive: true });

  let raf;
  const onScroll = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(sync);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const landed = current();
      if (programmatic) { programmatic = false; startPage = landed; sync(); return; }
      const clamped = Math.max(startPage - 1, Math.min(startPage + 1, landed));
      if (clamped !== landed) goTo(clamped);
      else { startPage = landed; sync(); }
    }, 90);
  };
  wrap.addEventListener('scroll', onScroll, { passive: true });
  sync();
}

/* ---------- Report URLs (use repo issue templates) ---------- */
function reportUrl(kind) {
  const r = C.reporting || {};
  const repo = r.primaryRepo || (C.repos[0] && C.repos[0].repo);
  const tpl = kind === 'feature' ? r.featureTemplate : r.bugTemplate;
  const base = `https://github.com/${repo}/issues/new`;
  return tpl ? `${base}?template=${encodeURIComponent(tpl)}` : `${base}/choose`;
}

function mountReportButton(elId, kind) {
  const el = $(elId);
  if (el) el.href = reportUrl(kind);
}

/* ---------- Report form (structured → Intercom via edge function) ---------- */
const REPORT_BUCKET = 'reports';
let _reportFiles = [];   // [{ url, name, type }]

function initReportForm() {
  const form = $('reportForm');
  if (!form) return;
  _reportFiles = [];

  const uploadBtn = $('rfUploadBtn');
  const fileInput = $('rfFiles');
  if (uploadBtn && fileInput) {
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => { uploadReportFiles(fileInput.files); fileInput.value = ''; };
  }

  $('rfAnother') && ($('rfAnother').onclick = () => {
    $('reportDone').classList.add('hidden');
    form.classList.remove('hidden');
    form.reset();
    $('rfSTR').value = '1. \n2. \n3. ';
    _reportFiles = []; renderReportAttachments();
  });

  form.onsubmit = (e) => { e.preventDefault(); submitReport(); };
}

async function uploadReportFiles(files) {
  if (!files || !files.length) return;
  const sb = C.supabase || {};
  if (!window.supabase || !sb.url || !sb.anonKey) { setReportStatus('Uploads are unavailable right now — you can still send the report without evidence.', 'err'); return; }
  const client = (initReportForm._sb = initReportForm._sb || window.supabase.createClient(sb.url, sb.anonKey));
  const note = $('rfUploadNote');
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file.size > 25 * 1024 * 1024) { setReportNote(`"${file.name}" is over 25 MB — skipped.`, true); continue; }
    setReportNote(`Uploading ${i + 1} of ${files.length}…`, true);
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    try {
      const { error } = await client.storage.from(REPORT_BUCKET).upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type || undefined });
      if (error) { setReportNote('Upload failed: ' + error.message, true); continue; }
      const { data } = client.storage.from(REPORT_BUCKET).getPublicUrl(path);
      if (data && data.publicUrl) _reportFiles.push({ url: data.publicUrl, name: file.name, type: file.type || '' });
    } catch (err) { setReportNote('Upload error — is the "reports" bucket created?', true); }
  }
  setReportNote('images or short video (optional)', false);
  renderReportAttachments();
}

function renderReportAttachments() {
  const el = $('rfAttachments');
  if (!el) return;
  el.innerHTML = _reportFiles.map((f, i) => {
    const media = /^video\//.test(f.type) ? `<video src="${esc(f.url)}" muted></video>` : `<img src="${esc(f.url)}" alt="">`;
    return `<div class="rf-thumb">${media}<button type="button" class="rf-rm" data-rm="${i}" aria-label="Remove">&times;</button></div>`;
  }).join('');
  el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { _reportFiles.splice(+b.dataset.rm, 1); renderReportAttachments(); });
}

function setReportNote(t, busy) { const n = $('rfUploadNote'); if (n) { n.textContent = t; n.classList.toggle('busy', !!busy); } }
function setReportStatus(t, kind) { const s = $('rfStatus'); if (s) { s.textContent = t; s.className = 'rf-status' + (kind ? ' ' + kind : ''); } }

function emailValid(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

function submitReport() {
  const fields = {
    email: $('rfEmail').value.trim(),
    build: $('rfBuild').value.trim(),
    area: $('rfArea').value,
    desc: $('rfDesc').value.trim(),
    str: $('rfSTR').value.trim(),
    expected: $('rfExpected').value.trim(),
    actual: $('rfActual').value.trim(),
    repro: $('rfRepro').value,
    notes: $('rfNotes').value.trim(),
  };
  // Validate required: email, build, area, desc, str, actual
  const required = { rfEmail: fields.email, rfBuild: fields.build, rfArea: fields.area, rfDesc: fields.desc, rfSTR: fields.str && fields.str !== '1.\n2.\n3.', rfActual: fields.actual };
  let firstBad = null;
  Object.keys(required).forEach(id => {
    const ok = !!required[id];
    $(id).classList.toggle('invalid', !ok);
    if (!ok && !firstBad) firstBad = id;
  });
  if (!fields.email || !emailValid(fields.email)) { $('rfEmail').classList.add('invalid'); firstBad = firstBad || 'rfEmail'; }
  if (firstBad) {
    setReportStatus('Please fill in the highlighted required fields.', 'err');
    $(firstBad).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  doSubmitReport(fields);
}

async function doSubmitReport(fields) {
  const sb = C.supabase || {};
  const fn = (C.reporting && C.reporting.submitFn) || (sb.url ? sb.url + '/functions/v1/submit-report' : '');
  if (!fn || !sb.anonKey) { setReportStatus('Reporting isn\u2019t configured yet. Please try again later.', 'err'); return; }

  setReportStatus('Sending your report…', '');
  $('rfSubmit').disabled = true;

  const areaLabelText = areaLabel(fields.area);
  const payload = {
    email: fields.email,
    area: fields.area,
    area_label: areaLabelText,
    build: fields.build,
    description: fields.desc,
    steps: fields.str,
    expected: fields.expected,
    actual: fields.actual,
    reproduction_rate: fields.repro,
    os_notes: fields.notes,
    attachments: _reportFiles.map(f => f.url),
    source: 'status-dashboard',
  };

  try {
    const res = await fetch(fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: sb.anonKey, Authorization: 'Bearer ' + sb.anonKey },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(txt || ('HTTP ' + res.status));
    }
    $('reportForm').classList.add('hidden');
    $('reportDone').classList.remove('hidden');
    $('reportDone').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    setReportStatus('Sorry — sending failed. Please try again in a moment.', 'err');
  } finally {
    $('rfSubmit').disabled = false;
  }
}

/* ---------- Image lightbox (full-size preview) ---------- */
let _lightboxEl = null;
function openLightbox(url) {
  if (!_lightboxEl) {
    _lightboxEl = document.createElement('div');
    _lightboxEl.className = 'lightbox';
    _lightboxEl.innerHTML = '<button class="lightbox-close" aria-label="Close">&times;</button><img alt="">';
    document.body.appendChild(_lightboxEl);
    const close = () => _lightboxEl.classList.remove('open');
    _lightboxEl.onclick = (e) => { if (e.target === _lightboxEl || e.target.classList.contains('lightbox-close')) close(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  _lightboxEl.querySelector('img').src = url;
  _lightboxEl.classList.add('open');
}

/* ---------- Pages ---------- */
const PAGES = {

  announcements() {
    const el = $('announceList');
    const posts = CONTENT.announcementPosts || [];
    if (!posts.length) { el.innerHTML = '<div class="empty">No announcements yet — check back soon.</div>'; return; }
    el.innerHTML = posts.map(p => {
      const imgs = (p.images || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const photos = imgs.length
        ? `<div class="blog-photos">${imgs.map(u => `<img src="${esc(u)}" alt="" loading="lazy" data-lightbox="${esc(u)}">`).join('')}</div>`
        : '';
      return `<article class="blog-post">
        ${p.date ? `<div class="blog-date">${esc(fmtDate(p.date))}</div>` : ''}
        ${p.title ? `<h2 class="blog-title">${esc(p.title)}</h2>` : ''}
        <div class="blog-body">${miniMarkdown(p.body || '')}</div>
        ${photos}
      </article>`;
    }).join('');
    // Click any photo to preview it full-size in a lightbox.
    el.querySelectorAll('[data-lightbox]').forEach(img => {
      img.onclick = () => openLightbox(img.dataset.lightbox);
    });
  },

  overview({ bugs, feats, fixed }, meta) {
    renderPatchNotes();
    const services = computeServices(bugs, meta.official);
    $('servicesGrid').innerHTML = services.map(s => svcCard(s.name, s.desc, s.level, false, !!s.official)).join('');
    const worst = services.reduce((m, s) => Math.max(m, SVC_LEVELS[s.level].rank), 0);
    const overall = worst === 0 ? ['All systems operational', 'var(--ok)'] : worst === 1 ? ['Some services degraded', 'var(--warn)'] : ['Service disruption ongoing', 'var(--down)'];
    $('overallPill').innerHTML = `<span class="dot pulse" style="background:${overall[1]}"></span>${overall[0]}`;

    const wkCount = bugs.filter(b => b.workaround).length;
    countUp($('statBugs'), bugs.length, meta.capped ? '+' : '');
    countUp($('statFeats'), feats.length);
    countUp($('statFixed'), fixed.length);
    countUp($('statWk'), wkCount);

    const pinned = (CONTENT.pinnedIssues || []).map(u => bugs.find(b => b.url === u)).filter(Boolean).map(b => ({ ...b, pinned: true }));
    const rest = bugs.filter(b => !pinned.some(p => p.url === b.url));
    const topPool = [...pinned, ...rest.filter(b => !b.sentry), ...rest.filter(b => b.sentry)];
    $('topIssues').innerHTML = topPool.slice(0, 6).map(b => bugCard(b)).join('') || '<div class="empty" style="grid-column:1/-1">No active issues right now.</div>';
    bindCopyButtons($('topIssues')); bindCardInteractions($('topIssues'));
    $('topFeats').innerHTML = feats.slice(0, 6).map(featCard).join('') || '<div class="empty" style="grid-column:1/-1">No open requests right now.</div>';
    bindCopyButtons($('topFeats')); bindCardInteractions($('topFeats'));
    $('latestFixed').innerHTML = fixed.length ? fixed.slice(0, 6).map(b => bugCard(b)).join('') : '<div class="empty" style="grid-column:1/-1">No fixes in the recent window.</div>';
    bindCopyButtons($('latestFixed')); bindCardInteractions($('latestFixed'));
  },

  issues({ bugs }, meta) {
    cardList({
      items: bugs, gridId: 'issuesGrid', moreId: 'issuesMore', countId: 'issuesCount',
      countSuffix: 'active', searchId: 'issueSearch', chipsId: 'issueAreaChips', sortId: 'issueSort',
      cardFn: b => bugCard(b), emptyMsg: "No issues match — that's good news.", plus: meta.capped, defaultSort: 'newest'
    });
  },

  features({ feats }) {
    mountReportButton('reportFeatBtn', 'feature');
    cardList({
      items: feats, gridId: 'featGrid', moreId: 'featMore', countId: 'featCount',
      countSuffix: 'open', searchId: 'featSearch', chipsId: 'featAreaChips', sortId: 'featSort',
      cardFn: featCard, emptyMsg: 'No requests match your filters.'
    });
  },

  fixed({ fixed }) {
    $('fixedCount').textContent = `${fixed.length} in the last ${C.recentFixDays} days`;
    $('fixedList').innerHTML = fixed.length ? fixed.map(b => bugCard(b)).join('') : '<div class="empty" style="grid-column:1/-1">No fixes closed in the recent window.</div>';
    bindCopyButtons($('fixedList')); bindCardInteractions($('fixedList'));
  },

  workarounds({ bugs }) {
    const withWk = bugs.filter(b => b.workaround);
    cardList({
      items: withWk, gridId: 'wkGrid', moreId: 'wkMore', countId: 'wkCount',
      countSuffix: 'available', searchId: 'wkSearch', chipsId: 'wkAreaChips', sortId: 'wkSort',
      cardFn: b => bugCard(b), emptyMsg: 'No confirmed workarounds yet for the current active issues.'
    });
  },

  report() {
    initReportForm();
  },

  async bundles() {
    const cfg = C.assetBundles || {};
    const wrap = $('queueGrid'), totalEl = $('queueTotal'), sync = $('queueSync');
    if (cfg.registryUrl) { const a = $('contentServerLink'); if (a) a.href = cfg.registryUrl + '/queues/status'; }
    initEntityLookup();

    const registry = cfg.registryUrl || 'https://asset-bundle-registry.decentraland.org';
    const PAGE = cfg.pageSize || 20;
    const POOL = cfg.resolvePool || 150;

    // State persists across polls so the search text and "Load more" position
    // survive the per-second refresh below.
    const state = (window.__queueState = window.__queueState || { rows: [], query: '', limit: PAGE, sig: '' });

    const matches = (r, q) => {
      if (!q) return true;
      const sc = r.scene || {};
      return [sc.name, sc.world, sc.base, ...(sc.parcels || []), r.entityId]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    };

    const rowHtml = (r) => {
      const sc = r.scene;
      let name = esc(shortCid(r.entityId)), parcel = '—', deployed = '—', waiting = '—';
      if (sc) {
        if (sc.type === 'world') {
          name = `${esc(sc.name || sc.world || 'Unnamed World')} <span class="queue-kind kind-world" title="${esc(sc.world || '')}">World</span>`;
          parcel = esc(sc.world || '—');
        } else if (sc.name || (sc.parcels && sc.parcels.length)) {
          const n = (sc.parcels && sc.parcels.length) || 0;
          name = `${esc(sc.name || 'Unnamed scene')}${n ? ` <span class="queue-kind kind-parcel" title="${esc((sc.parcels || []).join('  '))}">${n} parcel${n > 1 ? 's' : ''}</span>` : ''}`;
          parcel = esc(sc.base || (sc.parcels && sc.parcels[0]) || '—');
        }
        if (sc.timestamp) {
          deployed = new Date(sc.timestamp).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          waiting = rel(sc.timestamp).replace(' ago', '');
        }
      }
      const prod = r.prodReady
        ? '<span class="qt-prod ok" title="Asset bundles built for Windows &amp; macOS — live on the desktop client">✓ Live</span>'
        : `<span class="qt-prod wait" title="Still converting for ${esc([r.winPending && 'Windows', r.macPending && 'macOS'].filter(Boolean).join(' &amp; ') || 'Windows / macOS')}">⏳ Pending</span>`;
      return `<tr data-entity="${esc(r.entityId)}" style="cursor:pointer">
        <td class="qt-scene"><span class="qt-name">${name}</span></td>
        <td class="qt-parcel">${parcel}</td>
        <td class="qt-deployed">${deployed}</td>
        <td class="qt-elapsed">${waiting}</td>
        <td class="qt-prodcol">${prod}</td>
      </tr>`;
    };

    const draw = () => {
      const body = $('qtBody'); if (!body) return;
      const q = state.query;
      const filtered = state.rows.filter(r => matches(r, q));
      const slice = filtered.slice(0, state.limit);
      // Only touch the DOM when the visible set actually changes (avoids
      // flicker / lost hover while polling every second).
      const sig = q + '|' + state.limit + '|' + slice.map(r => r.entityId + (r.prodReady ? '1' : '0') + (r.scene ? '1' : '0')).join(',');
      if (sig !== state.sig) {
        state.sig = sig;
        body.innerHTML = slice.length
          ? slice.map(rowHtml).join('')
          : `<tr><td colspan="5" class="qt-empty">${q ? 'No deployments match your search.' : 'Queue is empty — nothing pending.'}</td></tr>`;
        body.querySelectorAll('tr[data-entity]').forEach(tr => {
          tr.onclick = () => window.open(`${registry}/entities/status/${encodeURIComponent(tr.dataset.entity)}`, '_blank', 'noopener');
        });
        const moreWrap = $('qtMoreWrap');
        if (moreWrap) {
          const remaining = filtered.length - slice.length;
          moreWrap.innerHTML = remaining > 0
            ? `<button class="report-btn ghost qt-more-btn" id="qtMoreBtn">Load ${Math.min(PAGE, remaining)} more</button>`
            : (filtered.length ? `<div class="queue-more">Showing ${slice.length} of ${filtered.length}${q ? ' matching' : ''} pending ${filtered.length === 1 ? 'entity' : 'entities'}.</div>` : '');
          const mb = $('qtMoreBtn'); if (mb) mb.onclick = () => { state.limit += PAGE; state.sig = ''; draw(); };
        }
      }
      if (totalEl) totalEl.textContent = `${state.rows.length} pending`;
    };

    const poll = async () => {
      if (document.body.dataset.page !== 'bundles') return;   // bail if navigated away
      let qs;
      try { qs = await loadQueue(); }
      catch (e) { if (sync) sync.textContent = 'Queue unavailable'; return; }
      if (!qs.configured) {
        wrap.innerHTML = `<div class="empty">The asset-bundle queue endpoint isn't set in <code>assetBundles.queueUrl</code>.</div>`;
        if (totalEl) totalEl.textContent = 'not configured';
        return;
      }

      // Split the pending jobs by platform. An entity is "live on prod" once it
      // is no longer pending for Windows AND macOS (WebGL is the browser client
      // and is excluded — matching how the registry computes `complete`).
      const winSet = new Set(), macSet = new Set(), webglSet = new Set();
      for (const j of qs.jobs) {
        if (j.platform === 'windows') winSet.add(j.entityId);
        else if (j.platform === 'mac') macSet.add(j.entityId);
        else webglSet.add(j.entityId);
      }
      const ids = [...new Set(qs.jobs.map(j => j.entityId))];

      // Resolve only entities we haven't seen yet (cached in SCENE_CACHE),
      // capped so a fresh load never fires hundreds of lookups at once.
      const fresh = ids.filter(id => !(id in SCENE_CACHE));
      if (fresh.length) await resolveScenes(fresh.slice(0, POOL));

      state.rows = ids.map(id => {
        const sc = SCENE_CACHE[id] || null;
        return {
          entityId: id, scene: sc, ts: (sc && sc.timestamp) || 0,
          winPending: winSet.has(id), macPending: macSet.has(id), webglPending: webglSet.has(id),
          prodReady: !winSet.has(id) && !macSet.has(id),
        };
      }).sort((a, b) => b.ts - a.ts);   // newest deployment first

      if (sync) sync.textContent = `WebGL ${webglSet.size} · Windows ${winSet.size} · macOS ${macSet.size} · synced ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      draw();
    };

    // Wire the search box once (filters scene name, World name, coordinates).
    const searchEl = $('queueSearch');
    if (searchEl && !searchEl.dataset.wired) {
      searchEl.dataset.wired = '1';
      searchEl.addEventListener('input', () => {
        state.query = searchEl.value.trim().toLowerCase();
        state.limit = PAGE; state.sig = ''; draw();
      });
    }

    // Table shell (drawn once; only the tbody updates on each poll).
    wrap.innerHTML = `
      <div class="qtable-scroll">
        <table class="qtable">
          <thead><tr>
            <th>Scene</th><th>Base parcel</th><th>Deployed</th><th>Waiting</th><th>Prod (Win + Mac)</th>
          </tr></thead>
          <tbody id="qtBody"><tr><td colspan="5" class="loading" style="border:none">Loading queue…</td></tr></tbody>
        </table>
      </div>
      <div class="qt-more-wrap" id="qtMoreWrap"></div>`;

    await poll();

    // Poll frequently so a newly-started deployment shows up within ~1s. The
    // "Waiting" value is recomputed on each poll, so no live ticking is needed.
    if (!window.__queueTimer) {
      window.__queueTimer = setInterval(poll, Math.max(1, cfg.refreshSeconds || 2) * 1000);
    }
  },
};

/* ---------- Boot ---------- */
async function boot() {
  initChrome();
  const page = document.body.dataset.page;
  if (!PAGES[page]) return;

  if (page === 'report') { await loadContent(); initBanners(null); PAGES.report(); return; }
  if (page === 'bundles') { await loadContent(); initBanners(null); await PAGES.bundles(); return; }
  if (page === 'announcements') { await loadContent(); initBanners(null); PAGES.announcements(); return; }

  try {
    const [{ issues, partial, fromCache, syncedAt }, official] = await Promise.all([loadData(), loadOfficial(), loadContent()]);
    const data = classify(issues);
    setSync(syncedAt, fromCache, partial);
    initBanners(official);
    PAGES[page](data, { partial, official });
  } catch (e) {
    const html = errorBox(e.message);
    ['issuesGrid','featGrid','wkGrid','fixedList','topIssues','topFeats','latestFixed'].forEach(id => { const el = $(id); if (el) el.innerHTML = html; });
    const sg = $('servicesGrid');
    if (sg) sg.innerHTML = C.services.map(s => svcCard(s.name, s.desc, 'Operational', true)).join('');
    const pill = $('overallPill');
    if (pill) pill.innerHTML = `<span class="dot" style="background:var(--text-faint)"></span>Status unavailable`;
    const sn = $('syncNote');
    if (sn) sn.textContent = 'Live data unavailable right now';
  }
}

document.addEventListener('DOMContentLoaded', boot);

/* ---------- Live presence (anonymous; broadcasts current page/action) -------
   Each open tab joins a Supabase Realtime channel and reports an anonymous
   session id, a friendly label, the current page, and the current action
   (e.g. which issue modal is open). The owner-only admin view subscribes to
   the same channel to see who's currently on the site. No personal data, no
   storage — presence is ephemeral and auto-drops when a tab closes. */
const PRESENCE_CHANNEL = 'live-presence';
let _presence = { channel: null, state: { page: '', action: '' } };

function friendlyLabel() {
  const adj = ['Calm', 'Swift', 'Brave', 'Lucky', 'Clever', 'Mellow', 'Bright', 'Quiet', 'Bold', 'Cosmic', 'Pixel', 'Neon'];
  const animal = ['Otter', 'Fox', 'Llama', 'Falcon', 'Panda', 'Koala', 'Heron', 'Lynx', 'Tapir', 'Gecko', 'Moth', 'Yak'];
  return adj[Math.floor(Math.random() * adj.length)] + ' ' + animal[Math.floor(Math.random() * animal.length)];
}

// Map a pathname to a human page name shown in the admin roster.
function pageName(path) {
  const p = (path || location.pathname).replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  const map = { '/': 'Overview', '/issues': 'Known issues', '/features': 'Feature requests', '/fixed': 'Recently fixed', '/workarounds': 'Workarounds', '/bundles': 'Asset bundles', '/report': 'Report' };
  return map[p] || (p === '' ? 'Overview' : p);
}

function initPresence() {
  try {
    const CFG = (typeof window !== 'undefined' && window.DCL_CONFIG) || (typeof DCL_CONFIG !== 'undefined' ? DCL_CONFIG : null);
    const cfg = (CFG && CFG.supabase) || {};
    if (!window.supabase || !cfg.url || !cfg.anonKey) return; // library/config missing → skip silently
    if (/\/admin(\.html)?$/.test(location.pathname)) return;  // don't broadcast from the admin panel

    const client = window.supabase.createClient(cfg.url, cfg.anonKey);
    const id = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'sess-' + Math.random().toString(36).slice(2));
    const label = friendlyLabel();
    const since = Date.now();
    _presence.state = { id, label, page: pageName(), action: '', since };

    const channel = client.channel(PRESENCE_CHANNEL, { config: { presence: { key: id } } });
    _presence.channel = channel;

    const push = () => { try { channel.track(_presence.state); } catch (e) {} };
    const announce = () => { try { channel.send({ type: 'broadcast', event: 'session', payload: _presence.state }); } catch (e) {} };
    channel.subscribe((status) => { if (status === 'SUBSCRIBED') { push(); announce(); } });

    setInterval(() => { push(); announce(); }, 25000);  // keep the connection warm
    window.addEventListener('beforeunload', () => { try { channel.untrack(); } catch (e) {} });
  } catch (e) { /* presence is best-effort; never break the page */ }
}

// Called by openPreview / modal close to update the action shown in the roster.
function presenceSetAction(action) {
  if (!_presence.channel) return;
  _presence.state = { ..._presence.state, action: action || '' };
  // Presence re-track keeps fresh page loads accurate; the broadcast is what
  // pushes the change live to already-connected admin observers (presence
  // re-track of the same key isn't reliably propagated to subscribers).
  try { _presence.channel.track(_presence.state); } catch (e) {}
  try { _presence.channel.send({ type: 'broadcast', event: 'session', payload: _presence.state }); } catch (e) {}
}

document.addEventListener('DOMContentLoaded', initPresence);

/* ---------- Admin-only UI gating ---------- */
// "Copy for Discord" buttons are a moderator tool, not for regular visitors.
// They're hidden by CSS and revealed (via body.is-admin) for any signed-in
// admin — anyone with a Supabase Auth login, not just the owner. Reuses the
// same session as /admin, which is persisted per-origin, so logging in there
// carries over to the public pages here.
let _authClient = null;
function authClient() {
  const sb = C.supabase || {};
  if (!window.supabase || !sb.url || !sb.anonKey) return null;
  return (_authClient = _authClient || window.supabase.createClient(sb.url, sb.anonKey));
}
async function applyAdminUI() {
  try {
    const client = authClient();
    if (!client) return;
    // An admin is any authenticated (non-anonymous) session. Regular visitors
    // only ever use the anon API key, so they have no session.user here.
    const isAdmin = s => !!(s && s.user && !s.user.is_anonymous);
    const { data: { session } } = await client.auth.getSession();
    if (isAdmin(session)) document.body.classList.add('is-admin');
    // Stay in sync if an admin signs in/out without a full page reload.
    client.auth.onAuthStateChange((_e, s) => document.body.classList.toggle('is-admin', isAdmin(s)));
  } catch (e) { /* not signed in / library missing → stay a normal visitor */ }
}
document.addEventListener('DOMContentLoaded', applyAdminUI);

// Minimal API for admin.html
window.DCL = { loadData, classify, loadContent, enhanceSelects };
})();
