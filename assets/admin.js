/* =========================================================
   Admin panel — curtain gate + config editor.
   The passphrase only hides the UI. Persisting changes means
   committing assets/config.js to the repo (copy / download /
   optional direct commit with a GitHub token kept in memory).
   ========================================================= */
(function () {
'use strict';

const C = DCL_CONFIG;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- State (initialized from deployed config) ---------- */
const state = {
  announcement: { ...(C.announcement || { text: '', level: 'Info', link: '' }) },
  statusOverrides: { ...(C.statusOverrides || {}) },
  pinned: [...(C.pinnedIssues || [])],         // array of issue URLs
  issueOverrides: JSON.parse(JSON.stringify(C.issueOverrides || {})),
  patchNotes: JSON.parse(JSON.stringify(C.patchNotes || [])),
  recentFixDays: C.recentFixDays, pageSize: C.pageSize, cacheMinutes: C.cacheMinutes,
  deriveServiceStatus: !!C.deriveServiceStatus,
};
let BUGS = [];      // open bugs for the pin picker
let ALLITEMS = [];  // bugs + feats for the issue editor
let pickQ = '', editQ = '', editUrl = null;

const BUG_STATUSES = ['Reported','Confirmed','Investigating','In Progress','Fix Planned','Monitoring','Resolved',"Won't Fix"];

/* ---------- Gate ---------- */
$('unlockBtn').onclick = unlock;
$('passInput').addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
async function unlock() {
  const h = await sha256($('passInput').value);
  if (h === (C.admin && C.admin.passHash)) {
    $('gate').classList.add('hidden');
    $('panel').classList.remove('hidden');
    initPanel();
  } else {
    const el = $('gateStatus'); el.textContent = 'Wrong passphrase.'; el.className = 'statusline err';
  }
}
$('hashBtn').onclick = async () => { $('hashOut').textContent = $('hashInput').value ? await sha256($('hashInput').value) : ''; };

/* ---------- Panel ---------- */
function initPanel() {
  // Announcement
  $('annText').value = state.announcement.text || '';
  $('annLevel').value = state.announcement.level || 'Info';
  $('annLink').value = state.announcement.link || '';
  $('annText').oninput = e => state.announcement.text = e.target.value.trim();
  $('annLevel').onchange = e => state.announcement.level = e.target.value;
  $('annLink').oninput = e => state.announcement.link = e.target.value.trim();

  // Service overrides
  const levels = ['Auto', 'Operational', 'Degraded', 'Partial Outage', 'Outage'];
  $('svcRows').innerHTML = C.services.map((s, i) =>
    `<div class="svc-row"><span>${esc(s.name)}</span>
      <select data-svc="${esc(s.name)}">${levels.map(l => `<option ${ (state.statusOverrides[s.name] || 'Auto') === l ? 'selected' : '' }>${l}</option>`).join('')}</select>
    </div>`).join('');
  $('svcRows').querySelectorAll('select').forEach(sel => sel.onchange = () => {
    const name = sel.dataset.svc;
    if (sel.value === 'Auto') delete state.statusOverrides[name];
    else state.statusOverrides[name] = sel.value;
  });

  // Settings
  $('setFixDays').value = state.recentFixDays;
  $('setPageSize').value = state.pageSize;
  $('setCache').value = state.cacheMinutes;
  $('setDerive').value = String(state.deriveServiceStatus);
  $('setFixDays').oninput = e => state.recentFixDays = Math.max(7, +e.target.value || 45);
  $('setPageSize').oninput = e => state.pageSize = Math.max(6, +e.target.value || 12);
  $('setCache').oninput = e => state.cacheMinutes = Math.max(1, +e.target.value || 15);
  $('setDerive').onchange = e => state.deriveServiceStatus = e.target.value === 'true';

  // Pins
  loadIssues();
  $('pinSearch').oninput = e => { pickQ = e.target.value.toLowerCase(); drawPicker(); };

  // Issue editor
  $('editSearch').oninput = e => { editQ = e.target.value.toLowerCase(); drawEditPick(); };
  $('edStatus').innerHTML = '<option value="">— Auto —</option>' + BUG_STATUSES.map(s => `<option>${s}</option>`).join('');
  $('edApply').onclick = applyEdit;
  $('edClear').onclick = clearEdit;

  // Patch notes
  $('pnAdd').onclick = addPatchNote;
  drawPatchNotes();

  // Save
  $('copyBtn').onclick = copyConfig;
  $('dlBtn').onclick = downloadConfig;
  $('publishBtn').onclick = publish;
  detectRepo();
}

async function loadIssues() {
  try {
    const { issues } = await window.DCL.loadData();
    const cl = window.DCL.classify(issues);
    BUGS = cl.bugs;
    ALLITEMS = [...cl.bugs, ...cl.feats];
  } catch (e) { BUGS = []; ALLITEMS = []; }
  drawPinned(); drawPicker(); drawEditPick(); drawEditedList();
}

function bugByUrl(u) { return BUGS.find(b => b.url === u); }

function drawPinned() {
  const el = $('pinnedList');
  if (!state.pinned.length) { el.innerHTML = '<div class="pin-row" style="color:var(--text-faint)">Nothing pinned — the overview shows top issues automatically.</div>'; return; }
  el.innerHTML = state.pinned.map((u, i) => {
    const b = bugByUrl(u);
    return `<div class="pin-row">
      <span class="t">${esc(b ? b.title : u)}</span>
      <span class="a">${esc(b ? b.area : '')}</span>
      <button class="mini" data-mv="-1" data-i="${i}" title="Move up">↑</button>
      <button class="mini" data-mv="1" data-i="${i}" title="Move down">↓</button>
      <button class="mini" data-unpin="${i}">Unpin</button>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-unpin]').forEach(b => b.onclick = () => { state.pinned.splice(+b.dataset.unpin, 1); drawPinned(); drawPicker(); });
  el.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, j = i + (+b.dataset.mv);
    if (j < 0 || j >= state.pinned.length) return;
    [state.pinned[i], state.pinned[j]] = [state.pinned[j], state.pinned[i]];
    drawPinned();
  });
}

function drawPicker() {
  const el = $('issuePick');
  if (!BUGS.length) { el.innerHTML = '<div class="pin-row" style="color:var(--text-faint)">Could not load issues (offline or rate-limited). Pins can still be edited above.</div>'; return; }
  const list = BUGS.filter(b => !state.pinned.includes(b.url) && (!pickQ || b.title.toLowerCase().includes(pickQ))).slice(0, 40);
  el.innerHTML = list.map(b =>
    `<div class="pin-row"><span class="t">${esc(b.title)}</span><span class="a">${esc(b.area)} · ${esc(b.impact)}</span>
      <button class="mini pin" data-pin="${esc(b.url)}">Pin</button></div>`).join('') ||
    '<div class="pin-row" style="color:var(--text-faint)">No matching open issues.</div>';
  el.querySelectorAll('[data-pin]').forEach(btn => btn.onclick = () => { state.pinned.push(btn.dataset.pin); drawPinned(); drawPicker(); });
}

/* ---------- Issue editor ---------- */
function itemByUrl(u) { return ALLITEMS.find(x => x.url === u); }

function drawEditPick() {
  const el = $('editPick');
  if (!ALLITEMS.length) { el.innerHTML = '<div class="pin-row" style="color:var(--text-faint)">Could not load issues (offline or rate-limited).</div>'; return; }
  const list = ALLITEMS.filter(b => !editQ || b.title.toLowerCase().includes(editQ)).slice(0, 40);
  el.innerHTML = list.map(b => {
    const ov = state.issueOverrides[b.url];
    const tag = ov ? (ov.hidden ? ' · hidden' : ' · edited') : '';
    return `<div class="pin-row"><span class="t">${esc(b.title)}</span><span class="a">${esc(b.area)}${tag}</span>
      <button class="mini pin" data-edit="${esc(b.url)}">Edit</button></div>`;
  }).join('') || '<div class="pin-row" style="color:var(--text-faint)">No matching issues.</div>';
  el.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => openEdit(btn.dataset.edit));
}

function openEdit(url) {
  editUrl = url;
  const b = itemByUrl(url) || {};
  const ov = state.issueOverrides[url] || {};
  $('editForm').classList.remove('hidden');
  $('editHead').innerHTML = `Editing: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a><br>GitHub title: ${esc(b.rawTitle || b.title || '')}`;
  $('edTitle').value = ov.title || '';
  $('edTitle').placeholder = b.title || '';
  $('edArea').value = ov.area || '';
  $('edArea').placeholder = b.area || '';
  $('edSummary').value = ov.summary || '';
  $('edSummary').placeholder = b.summary || '(no summary)';
  $('edStatus').value = ov.status || '';
  $('edImpact').value = ov.impact || '';
  $('edWorkaround').value = ov.workaround || '';
  $('edHidden').checked = !!ov.hidden;
  $('edPin').checked = state.pinned.includes(url);
  $('edPin').onchange = () => {
    if ($('edPin').checked) { if (!state.pinned.includes(url)) state.pinned.push(url); }
    else state.pinned = state.pinned.filter(u => u !== url);
    drawPinned();
  };
  $('editForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function applyEdit() {
  if (!editUrl) return;
  const o = {};
  const t = $('edTitle').value.trim(); if (t) o.title = t;
  const a = $('edArea').value.trim(); if (a) o.area = a;
  const s = $('edSummary').value.trim(); if (s) o.summary = s;
  const st = $('edStatus').value; if (st) o.status = st;
  const im = $('edImpact').value; if (im) o.impact = im;
  const w = $('edWorkaround').value.trim(); if (w) o.workaround = w;
  if ($('edHidden').checked) o.hidden = true;
  if (Object.keys(o).length) state.issueOverrides[editUrl] = o;
  else delete state.issueOverrides[editUrl];
  drawEditPick(); drawEditedList();
  setStatus('Override staged. Save & publish to apply it on the site.', true);
}

function clearEdit() {
  if (editUrl) { delete state.issueOverrides[editUrl]; }
  $('editForm').classList.add('hidden'); editUrl = null;
  drawEditPick(); drawEditedList();
}

function drawEditedList() {
  const el = $('editedList');
  const keys = Object.keys(state.issueOverrides);
  if (!keys.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="hint" style="margin-bottom:8px">Active overrides:</div>' + keys.map(u => {
    const b = itemByUrl(u), o = state.issueOverrides[u];
    const label = (o.title || (b && b.title) || u);
    const what = [o.hidden && 'hidden', o.title && 'title', o.summary && 'summary', o.status && 'status', o.impact && 'impact', o.area && 'area', o.workaround && 'workaround'].filter(Boolean).join(', ');
    return `<span class="tag">${esc(label.slice(0, 40))} <small style="color:var(--text-faint)">(${esc(what)})</small> <span class="x" data-rmov="${esc(u)}">✕</span></span>`;
  }).join('');
  el.querySelectorAll('[data-rmov]').forEach(x => x.onclick = () => { delete state.issueOverrides[x.dataset.rmov]; drawEditPick(); drawEditedList(); });
}

/* ---------- Patch notes ---------- */
function addPatchNote() {
  const version = $('pnVersion').value.trim();
  const date = $('pnDate').value.trim();
  const body = $('pnBody').value.trim();
  if (!body) { setStatus('Paste the release notes body first.', false); return; }
  state.patchNotes.unshift({ version, date, body });
  $('pnVersion').value = ''; $('pnDate').value = ''; $('pnBody').value = '';
  drawPatchNotes();
  setStatus('Release added. Save & publish to show it on the site.', true);
}

function drawPatchNotes() {
  const el = $('pnList');
  if (!state.patchNotes.length) { el.innerHTML = '<div class="hint">No releases yet.</div>'; return; }
  el.innerHTML = state.patchNotes.map((n, i) =>
    `<div class="pin-row"><span class="t">${esc(n.version || 'Release')} ${esc(n.date || '')}</span>
      <button class="mini" data-pnup="${i}">↑</button>
      <button class="mini" data-pndown="${i}">↓</button>
      <button class="mini" data-pnrm="${i}">Remove</button></div>`).join('');
  el.querySelectorAll('[data-pnrm]').forEach(b => b.onclick = () => { state.patchNotes.splice(+b.dataset.pnrm, 1); drawPatchNotes(); });
  el.querySelectorAll('[data-pnup]').forEach(b => b.onclick = () => { const i = +b.dataset.pnup; if (i > 0) { [state.patchNotes[i-1], state.patchNotes[i]] = [state.patchNotes[i], state.patchNotes[i-1]]; drawPatchNotes(); } });
  el.querySelectorAll('[data-pndown]').forEach(b => b.onclick = () => { const i = +b.dataset.pndown; if (i < state.patchNotes.length-1) { [state.patchNotes[i+1], state.patchNotes[i]] = [state.patchNotes[i], state.patchNotes[i+1]]; drawPatchNotes(); } });
}

/* ---------- Config generation ---------- */
const J = (v, indent) => JSON.stringify(v, null, 2).split('\n').map((l, i) => i ? indent + l : l).join('\n');

function genConfig() {
  return `/* =========================================================
   DASHBOARD CONFIG — generated by admin.html on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC
   This is the only file you normally edit (by hand or via admin.html).
   ========================================================= */

const DCL_CONFIG = {

  // GitHub repos to track.
  repos: ${J(C.repos, '  ')},

  // Services shown on the status board.
  services: ${J(C.services, '  ')},

  // Official status page integration. If the official page exposes a JSON API,
  // paste it into summaryUrl — official statuses then override everything
  // except manual overrides below.
  officialStatus: ${J(C.officialStatus, '  ')},

  // Site-wide announcement banner. Empty text hides it.
  announcement: ${J(state.announcement, '  ')},

  // Admin panel passphrase hash (see hash generator on admin.html).
  admin: ${J(C.admin, '  ')},

  // Derive service status from explicitly critical-labeled issues (opt-in).
  deriveServiceStatus: ${state.deriveServiceStatus},

  // Manual status overrides — highest priority. 'Operational' | 'Degraded' | 'Partial Outage' | 'Outage'
  statusOverrides: ${J(state.statusOverrides, '  ')},

  // Issues pinned to "Top known issues" on the overview (shown first, in order).
  pinnedIssues: ${J(state.pinned, '  ')},

  // Per-issue editorial overrides (title, summary, status, impact, area, workaround, hidden).
  issueOverrides: ${J(state.issueOverrides, '  ')},

  // Patch notes shown on the overview (newest first).
  patchNotes: ${J(state.patchNotes, '  ')},

  recentFixDays: ${state.recentFixDays},
  pageSize: ${state.pageSize},
  cacheMinutes: ${state.cacheMinutes},
};
`;
}

function setStatus(msg, ok) { const el = $('saveStatus'); el.textContent = msg; el.className = 'statusline ' + (ok ? 'ok' : 'err'); }

async function copyConfig() {
  try { await navigator.clipboard.writeText(genConfig()); setStatus('Copied. Paste into assets/config.js on GitHub (pencil icon) and commit.', true); }
  catch (e) { window.prompt('Copy this:', genConfig()); }
}

function downloadConfig() {
  const blob = new Blob([genConfig()], { type: 'text/javascript' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'config.js'; a.click();
  URL.revokeObjectURL(a.href);
  setStatus('Downloaded. Replace assets/config.js in the repo and commit.', true);
}

/* ---------- Optional direct publish ---------- */
function detectRepo() {
  const host = location.hostname, path = location.pathname.split('/').filter(Boolean);
  if (host.endsWith('.github.io')) {
    $('ghOwner').value = host.replace('.github.io', '');
    if (path.length > 1 || (path.length === 1 && !path[0].endsWith('.html'))) $('ghRepo').value = path[0];
  }
}

async function publish() {
  const owner = $('ghOwner').value.trim(), repo = $('ghRepo').value.trim(), branch = $('ghBranch').value.trim() || 'main';
  const token = $('ghToken').value.trim();
  if (!owner || !repo || !token) { setStatus('Owner, repository and token are required for direct publish.', false); return; }
  setStatus('Publishing…', true);
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/assets/config.js`;
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
  try {
    const cur = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
    if (cur.status === 401) throw new Error('Token rejected (401). Check it has Contents: Read & write on this repo.');
    if (cur.status === 404) throw new Error('assets/config.js not found in that repo/branch.');
    if (!cur.ok) throw new Error('GitHub error ' + cur.status);
    const { sha } = await cur.json();
    const content = btoa(unescape(encodeURIComponent(genConfig())));
    const put = await fetch(api, {
      method: 'PUT', headers,
      body: JSON.stringify({ message: 'Update dashboard config via admin panel', content, sha, branch }),
    });
    if (!put.ok) { const d = await put.json().catch(() => ({})); throw new Error(d.message || 'Commit failed (' + put.status + ')'); }
    setStatus('Committed ✓ — GitHub Pages will redeploy in about a minute.', true);
  } catch (e) {
    setStatus(e.message, false);
  }
}

})();
