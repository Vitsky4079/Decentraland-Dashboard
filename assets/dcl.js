/* =========================================================
   Decentraland Community Status — shared logic
   Data layer (GitHub fetch + cross-page cache), classification
   heuristics, and per-page renderers. Pages declare themselves
   via <body data-page="...">.
   ========================================================= */
(function () {
'use strict';

const C = DCL_CONFIG;
const CACHE_KEY = 'dclStatusCache_v2';

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
    .replace(/\s+/g, ' ')
    .trim();
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

/* ---------- Cache (sessionStorage with in-memory fallback) ---------- */
let memCache = null;
function cacheGet() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
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
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
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
    if (it.pull_request) return;
    const sentry = /automatically created by Sentry/i.test(it.body || '');
    const body = stripSentry(it.body || '');
    let title = cleanTitle(it.title);
    if (sentry || /[A-Za-z]:\\/.test(title)) title = cleanCrashTitle(title);
    const r = it.reactions || {};
    out.push({
      url: it.html_url,
      rawTitle: it.title,
      title,
      summary: summarize(body),
      workaround: findWorkaround(body),
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
      area: cfg.area,
    });
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

async function loadData(force = false) {
  if (!force) {
    const c = cacheGet();
    if (c) return { issues: c.data, partial: c.partial, capped: c.capped, fromCache: true, syncedAt: c.t };
  }
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
  const a = C.announcement || {};
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

  let bugs = issues.filter(i => i.state === 'open' && !isFeature(i))
    .map(i => ({ ...i, status: bugStatus(i), impact: impact(i) }));
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
  bugs.sort((a, b) => impRank[a.impact] - impRank[b.impact] || heat(a, b));

  const feats = issues.filter(i => i.state === 'open' && isFeature(i))
    .map(i => ({ ...i, status: featStatus(i), interest: interest(i) }));
  const intRank = { 'Very High': 0, High: 1, Medium: 2, Low: 3 };
  feats.sort((a, b) => intRank[a.interest] - intRank[b.interest] || heat(a, b));

  const fixed = issues.filter(i => i.state === 'closed' && i.closed && daysAgo(i.closed) <= C.recentFixDays && !isFeature(i) && bugStatus(i) === 'Resolved')
    .sort((a, b) => new Date(b.closed) - new Date(a.closed));

  return { bugs, feats, fixed };
}

function computeServices(bugs, official) {
  return C.services.map(svc => {
    if (C.statusOverrides[svc.name]) return { ...svc, level: C.statusOverrides[svc.name] };
    if (official && official.components[svc.name]) return { ...svc, level: official.components[svc.name], official: true };
    let crit = 0, high = 0;
    for (const b of bugs) {
      const txt = (b.title + ' ' + b.rawTitle).toLowerCase();
      const match = svc.repoAreas.includes(b.area) || svc.keys.some(k => txt.includes(k));
      if (!match) continue;
      if (b.impact === 'Critical') crit++;
      else if (b.impact === 'High') high++;
    }
    const level = crit >= 3 ? 'Partial Outage' : crit >= 1 ? 'Degraded' : high >= 5 ? 'Degraded' : 'Operational';
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

function bugCard(b, withWorkaround = true) {
  const wk = !withWorkaround ? '' : b.workaround
    ? `<div class="wk"><b>Workaround</b>${esc(b.workaround)}</div>`
    : `<div class="wk none"><b>Workaround</b>No confirmed workaround yet.</div>`;
  const extra = (b.sentry ? badge('Auto-detected', '#7C8CF8') : '') + (b.dupCount > 1 ? badge('×' + b.dupCount + ' reports', '#C77CF8') : '');
  return `<div class="card">
    <div class="card-top">${badge(b.status, BUG_STATUS_COLORS[b.status])}${badge(b.impact + ' impact', IMPACT_COLORS[b.impact])}${badge(b.area, '#A39DB3')}${extra}</div>
    <a class="card-title card-link" href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.title)}</a>
    ${b.summary ? `<div class="card-expl">${esc(b.summary)}</div>` : ''}
    ${wk}
    <div class="card-meta"><span>Reported ${esc(fmtDate(b.created))}</span><span>Updated ${esc(rel(b.updated))}</span><button class="copy-btn" data-copy="${esc(encodeURIComponent(discordSnippet(b)))}">Copy for Discord</button></div>
  </div>`;
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
  return `<a class="card" href="${esc(f.url)}" target="_blank" rel="noopener">
    <div class="card-top">${badge(f.status, FEAT_STATUS_COLORS[f.status])}${badge(f.interest + ' interest', '#FFBC5B')}${badge(f.area, '#A39DB3')}</div>
    <div class="card-title">${esc(f.title)}</div>
    ${f.summary ? `<div class="card-expl">${esc(f.summary)}</div>` : ''}
    <div class="card-meta"><span>Submitted ${esc(fmtDate(f.created))}</span><span>Updated ${esc(rel(f.updated))}</span></div>
  </a>`;
}

function fixedRow(f) {
  return `<a class="fixed-row" href="${esc(f.url)}" target="_blank" rel="noopener">
    <span class="fixed-check">✓</span>
    <span class="fixed-title">${esc(f.title)}</span>
    <span class="fixed-area">${esc(f.area)}</span>
    <span class="fixed-date">Fixed ${esc(fmtDate(f.closed))}</span>
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

/* ---------- Generic filterable card list ---------- */
const SORTS = {
  newest: (a, b) => new Date(b.created) - new Date(a.created),
  updated: (a, b) => new Date(b.updated) - new Date(a.updated),
  reported: (a, b) => (b.reactionsTotal + b.comments + (b.dupCount || 1) * 2) - (a.reactionsTotal + a.comments + (a.dupCount || 1) * 2),
};

function cardList({ items, gridId, moreId, countId, countSuffix, searchId, chipsId, sortId, cardFn, emptyMsg, plus }) {
  const grid = $(gridId), more = $(moreId), count = $(countId), search = $(searchId), chips = $(chipsId), sortSel = $(sortId);
  const areas = [...new Set(items.map(x => x.area))];
  let st = { area: 'All', q: '', pages: 1, sort: 'default' };

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
    if (chips) {
      chips.innerHTML = ['All', ...areas].map(a =>
        `<button class="chip ${a === st.area ? 'on' : ''}" data-a="${esc(a)}">${esc(a)}</button>`).join('');
      chips.querySelectorAll('.chip').forEach(c => c.onclick = () => { st.area = c.dataset.a; st.pages = 1; draw(); });
    }
  }
  if (search) search.oninput = e => { st.q = e.target.value.toLowerCase(); st.pages = 1; draw(); };
  if (more) more.onclick = () => { st.pages++; draw(); };
  if (sortSel) sortSel.onchange = () => { st.sort = sortSel.value; st.pages = 1; draw(); };
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
function initChrome() {
  // active nav link
  const page = document.body.dataset.page;
  document.querySelectorAll('.nav-links a').forEach(a => {
    if (a.dataset.nav === page) a.classList.add('active');
  });
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

/* ---------- Pages ---------- */
const PAGES = {

  overview({ bugs, feats, fixed }, meta) {
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

    $('topIssues').innerHTML = bugs.slice(0, 3).map(b => bugCard(b)).join('') || '<div class="empty" style="grid-column:1/-1">No active issues right now.</div>';
    bindCopyButtons($('topIssues'));
    $('topFeats').innerHTML = feats.slice(0, 3).map(featCard).join('') || '<div class="empty" style="grid-column:1/-1">No open requests right now.</div>';
    $('latestFixed').innerHTML = fixed.slice(0, 5).map(fixedRow).join('') || '<div class="empty">No fixes in the recent window.</div>';
  },

  issues({ bugs }, meta) {
    cardList({
      items: bugs, gridId: 'issuesGrid', moreId: 'issuesMore', countId: 'issuesCount',
      countSuffix: 'active', searchId: 'issueSearch', chipsId: 'issueAreaChips', sortId: 'issueSort',
      cardFn: b => bugCard(b), emptyMsg: "No issues match — that's good news.", plus: meta.capped
    });
  },

  features({ feats }) {
    cardList({
      items: feats, gridId: 'featGrid', moreId: 'featMore', countId: 'featCount',
      countSuffix: 'open', searchId: 'featSearch', chipsId: 'featAreaChips', sortId: 'featSort',
      cardFn: featCard, emptyMsg: 'No requests match your filters.'
    });
  },

  fixed({ fixed }) {
    $('fixedCount').textContent = `${fixed.length} in the last ${C.recentFixDays} days`;
    $('fixedList').innerHTML = fixed.length ? fixed.map(fixedRow).join('') : '<div class="empty">No fixes closed in the recent window.</div>';
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
    const fill = (selId, btnId, params) => {
      const sel = $(selId), btn = $(btnId);
      sel.innerHTML = C.repos.map((r, i) => `<option value="${i}">${esc(r.reportAs)}</option>`).join('');
      const upd = () => { const r = C.repos[sel.value] || C.repos[0]; btn.href = `https://github.com/${r.repo}/issues/new${params}`; };
      sel.onchange = upd; upd();
    };
    fill('bugRepo', 'bugBtn', '?labels=bug&title=' + encodeURIComponent('[Bug] '));
    fill('featRepo', 'featBtn', '?title=' + encodeURIComponent('[Feature Request] '));
  },
};

/* ---------- Boot ---------- */
async function boot() {
  initChrome();
  const page = document.body.dataset.page;
  if (!PAGES[page]) return;

  if (page === 'report') { initBanners(null); PAGES.report(); return; }

  try {
    const [{ issues, partial, fromCache, syncedAt }, official] = await Promise.all([loadData(), loadOfficial()]);
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
})();
