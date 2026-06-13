/* =========================================================
   Admin panel — Supabase edition.
   Real login (Supabase Auth). Every edit writes straight to
   the database and is live for visitors immediately. Row
   Level Security guarantees only authenticated admins can
   write; the public site reads with the anon key.
   ========================================================= */
(function () {
'use strict';

const C = DCL_CONFIG;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const BUG_STATUSES = ['Reported','Confirmed','Investigating','In Progress','Fix Planned','Monitoring','Resolved',"Won't Fix"];
const setStatus = (msg, ok) => { const el = $('saveStatus'); if (el) { el.textContent = msg; el.className = 'statusline ' + (ok ? 'ok' : 'err'); } };

function markDirty(sec, on = true) {
  const el = $(sec + 'Dirty');
  if (el) el.classList.toggle('hidden', !on);
}

// Parse a pasted release block: extract version + date from the first line,
// e.g. "**Release Notes** v0.151.0 (10/6/2026)  🚀" → strips that line from the body.
function parseRelease(text) {
  const lines = text.split(/\r?\n/);
  const first = (lines[0] || '').trim();
  const vm = first.match(/v?\d+\.\d+(?:\.\d+)*/i);
  const dm = first.match(/\((\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})\)/);
  const isHeader = /release notes/i.test(first) || (vm && first.length < 80);
  return {
    version: vm ? (vm[0].toLowerCase().startsWith('v') ? vm[0] : 'v' + vm[0]) : '',
    date: dm ? dm[1] : '',
    body: (isHeader ? lines.slice(1) : lines).join('\n').trim(),
  };
}
if (typeof window !== 'undefined') window.__parseRelease = parseRelease;

let sb = null;            // supabase client
let BUGS = [], ALLITEMS = [];
let pins = [];            // [{url, position}] sorted (staged)
let dbPinUrls = [];       // urls currently in the database
let overrides = {};       // url -> row
let notes = [];           // staged [{id|null, version, date_label, body, position}]
let adminNotes = [];      // admin-to-admin notes [{id, body, author, position, ...}]
let deletedNoteIds = [];  // ids removed locally, deleted on save
let svcStaged = {};       // staged service levels (name -> level | undefined=Auto)
let pickQ = '', editQ = '', editUrl = null;

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  const cfg = C.supabase || {};
  if (!cfg.url || !cfg.anonKey) { $('noConfig').classList.remove('hidden'); return; }
  if (typeof supabase === 'undefined') { $('noConfig').classList.remove('hidden'); $('noConfig').querySelector('.hint').textContent = 'Could not load the Supabase client (CDN blocked?). Check your connection and reload.'; return; }

  sb = supabase.createClient(cfg.url, cfg.anonKey);

  $('loginBtn').onclick = login;
  $('passInput').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.reload(); };

  const { data: { session } } = await sb.auth.getSession();
  if (session) await openPanel(session);
  else $('gate').classList.remove('hidden');
});

async function login() {
  const el = $('gateStatus');
  el.textContent = 'Signing in…'; el.className = 'statusline';
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('emailInput').value.trim(),
    password: $('passInput').value,
  });
  if (error) { el.textContent = error.message; el.className = 'statusline err'; return; }
  openPanel(data.session);
}

async function openPanel(session) {
  $('gate').classList.add('hidden');
  $('panel').classList.remove('hidden');
  currentEmail = (session.user && session.user.email) || '';
  $('whoami').textContent = currentEmail || 'admin';
  wireEditors();
  applyAdminNotesGate();
  await Promise.all([loadDbState(), loadGithubIssues()]);
  drawAll();
}

// The admin-notes editor is shown only to the configured owner email (UI gate).
// If no ownerEmail is set, any admin may edit.
let currentEmail = '';
function isNotesOwner() {
  const owner = (DCL_CONFIG.admin && DCL_CONFIG.admin.ownerEmail || '').trim().toLowerCase();
  return !owner || currentEmail.trim().toLowerCase() === owner;
}
function applyAdminNotesGate() {
  const editor = $('anEditor');
  if (editor) editor.classList.toggle('hidden', !isNotesOwner());
  const hint = $('anHint');
  if (hint && !isNotesOwner()) hint.textContent = 'Internal notes from the admin team about platform updates (read-only for your account).';
  if (isNotesOwner()) startLiveVisitors();
}

/* ---------- Load state ---------- */
async function loadDbState() {
  const [a, s, p, o, n, an] = await Promise.all([
    sb.from('announcements').select('*').eq('id', 1).maybeSingle(),
    sb.from('service_status').select('*'),
    sb.from('pins').select('*').order('position'),
    sb.from('issue_overrides').select('*'),
    sb.from('patch_notes').select('*').order('position'),
    sb.from('admin_notes').select('*').order('position'),
  ]);
  adminNotes = an.data || [];
  const ann = a.data || { text: '', level: 'Info', link: '' };
  $('annText').value = ann.text || '';
  $('annLevel').value = ann.level || 'Info';
  $('annLink').value = ann.link || '';
  window.__svcLevels = {};
  (s.data || []).forEach(r => window.__svcLevels[r.name] = r.level);
  svcStaged = { ...window.__svcLevels };
  pins = p.data || [];
  dbPinUrls = pins.map(r => r.url);
  overrides = {};
  (o.data || []).forEach(r => overrides[r.url] = r);
  notes = n.data || [];
}

async function loadGithubIssues() {
  try {
    const { issues } = await window.DCL.loadData();
    const cl = window.DCL.classify(issues);
    BUGS = cl.bugs; ALLITEMS = [...cl.bugs, ...cl.feats];
  } catch (e) { BUGS = []; ALLITEMS = []; }
}

function drawAll() { drawServices(); drawPinned(); drawPicker(); drawWkPick(); drawWkList(); drawPatchNotes(); drawAdminNotes(); }
const itemByUrl = u => ALLITEMS.find(x => x.url === u);

/* ---------- Wire static controls ---------- */
function wireEditors() {
  $('annSave').onclick = saveAnnouncement;
  $('pinSearch').oninput = e => { pickQ = e.target.value.toLowerCase(); drawPicker(); };
  $('wkSearch').oninput = e => { editQ = e.target.value.toLowerCase(); drawWkPick(); };
  $('wkApply').onclick = applyWk;
  $('wkClear').onclick = clearWk;
  PN_STREAMS.forEach(s => { const b = $('pnAdd_' + s.key); if (b) b.onclick = () => addPatchNote(s.key); });
  { const b = $('anAdd'); if (b) b.onclick = addAdminNote; }
  { const b = $('anCancel'); if (b) b.onclick = resetAdminNoteForm; }
  $('pnSave').onclick = savePatchNotes;
  $('svcSave').onclick = saveServices;
  $('pinsSave').onclick = savePins;
}

/* ---------- Announcement ---------- */
async function saveAnnouncement() {
  const text = $('annText').value.trim();
  const { error } = await sb.from('announcements').upsert({
    id: 1, text, level: $('annLevel').value, link: $('annLink').value.trim(), active: text !== '',
  });
  setStatus(error ? 'Banner save failed: ' + error.message : (text ? 'Banner is live.' : 'Banner hidden.'), !error);
}

/* ---------- Service overrides ---------- */
function drawServices() {
  const levels = ['Auto', 'Operational', 'Degraded', 'Partial Outage', 'Outage'];
  $('svcRows').innerHTML = (C.services || []).map(svc =>
    `<div class="svc-row"><span>${esc(svc.name)}</span>
      <select data-svc="${esc(svc.name)}">${levels.map(l => `<option ${ (svcStaged[svc.name] || 'Auto') === l ? 'selected' : '' }>${l}</option>`).join('')}</select>
    </div>`).join('');
  $('svcRows').querySelectorAll('select').forEach(sel => sel.onchange = () => {
    const name = sel.dataset.svc;
    if (sel.value === 'Auto') delete svcStaged[name];
    else svcStaged[name] = sel.value;
    markDirty('svc');
  });
}

async function saveServices() {
  const names = (C.services || []).map(s => s.name);
  const toUpsert = names.filter(n => svcStaged[n]).map(n => ({ name: n, level: svcStaged[n] }));
  const toDelete = names.filter(n => !svcStaged[n] && window.__svcLevels[n]);
  let error = null;
  if (toUpsert.length) ({ error } = await sb.from('service_status').upsert(toUpsert));
  if (!error && toDelete.length) ({ error } = await sb.from('service_status').delete().in('name', toDelete));
  if (!error) { window.__svcLevels = { ...svcStaged }; markDirty('svc', false); }
  setStatus(error ? 'Status save failed: ' + error.message : 'Service statuses saved. Live.', !error);
}

/* ---------- Pins ---------- */
async function savePins() {
  pins.forEach((p, i) => p.position = i);
  const currentUrls = pins.map(p => p.url);
  const toDelete = dbPinUrls.filter(u => !currentUrls.includes(u));
  let error = null;
  if (pins.length) ({ error } = await sb.from('pins').upsert(pins.map(p => ({ url: p.url, position: p.position }))));
  if (!error && toDelete.length) ({ error } = await sb.from('pins').delete().in('url', toDelete));
  if (!error) { dbPinUrls = currentUrls; markDirty('pins', false); }
  setStatus(error ? 'Pin save failed: ' + error.message : 'Pins saved. Live.', !error);
}

function drawPinned() {
  const el = $('pinnedList');
  if (!pins.length) { el.innerHTML = '<div class="pin-row" style="color:var(--text-faint)">Nothing pinned — the overview shows top issues automatically.</div>'; return; }
  el.innerHTML = pins.map((p, i) => {
    const b = itemByUrl(p.url);
    return `<div class="pin-row">
      <span class="t">${esc(b ? b.title : p.url)}</span>
      <span class="a">${esc(b ? b.area : '')}</span>
      <button class="mini" data-mv="-1" data-i="${i}" title="Move up">↑</button>
      <button class="mini" data-mv="1" data-i="${i}" title="Move down">↓</button>
      <button class="mini" data-unpin="${i}">Unpin</button>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-unpin]').forEach(btn => btn.onclick = () => {
    pins.splice(+btn.dataset.unpin, 1);
    markDirty('pins'); drawPinned(); drawPicker();
  });
  el.querySelectorAll('[data-mv]').forEach(btn => btn.onclick = () => {
    const i = +btn.dataset.i, j = i + (+btn.dataset.mv);
    if (j < 0 || j >= pins.length) return;
    [pins[i], pins[j]] = [pins[j], pins[i]];
    markDirty('pins'); drawPinned();
  });
}

function drawPicker() {
  const el = $('issuePick');
  if (!BUGS.length) { el.innerHTML = '<div class="pin-row" style="color:var(--text-faint)">Could not load issues from GitHub (offline or rate-limited).</div>'; return; }
  const pinnedUrls = pins.map(p => p.url);
  const list = BUGS.filter(b => !pinnedUrls.includes(b.url) && (!pickQ || b.title.toLowerCase().includes(pickQ))).slice(0, 40);
  el.innerHTML = list.map(b =>
    `<div class="pin-row"><span class="t">${esc(b.title)}</span><span class="a">${esc(b.area)} · ${esc(b.impact)}</span>
      <button class="mini pin" data-pin="${esc(b.url)}">Pin</button></div>`).join('') ||
    '<div class="pin-row" style="color:var(--text-faint)">No matching open issues.</div>';
  el.querySelectorAll('[data-pin]').forEach(btn => btn.onclick = () => {
    pins.push({ url: btn.dataset.pin, position: pins.length });
    markDirty('pins'); drawPinned(); drawPicker();
  });
}

/* ---------- Workarounds (per-issue, manual only) ---------- */
function drawWkPick() {
  const el = $('wkPick');
  if (!ALLITEMS.length) { el.innerHTML = '<div class="pin-row" style="color:var(--text-faint)">Could not load issues from GitHub.</div>'; return; }
  const list = ALLITEMS.filter(b => !editQ || b.title.toLowerCase().includes(editQ)).slice(0, 40);
  el.innerHTML = list.map(b => {
    const ov = overrides[b.url];
    const tag = (ov && ov.workaround) ? ' · has workaround' : '';
    return `<div class="pin-row"><span class="t">${esc(b.title)}</span><span class="a">${esc(b.area)}${tag}</span>
      <button class="mini pin" data-wkedit="${esc(b.url)}">Set</button></div>`;
  }).join('') || '<div class="pin-row" style="color:var(--text-faint)">No matching issues.</div>';
  el.querySelectorAll('[data-wkedit]').forEach(btn => btn.onclick = () => openWk(btn.dataset.wkedit));
}

function openWk(url) {
  editUrl = url;
  const b = itemByUrl(url) || {};
  const ov = overrides[url] || {};
  $('wkForm').classList.remove('hidden');
  $('wkHead').innerHTML = `Issue: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(b.rawTitle || b.title || url)}</a>`;
  $('wkText').value = ov.workaround || '';
  $('wkForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('wkText').focus();
}

async function applyWk() {
  if (!editUrl) return;
  const text = $('wkText').value.trim();
  const existing = overrides[editUrl] || {};
  // Preserve any other override fields already on the row; only change workaround.
  const row = { ...existing, url: editUrl, workaround: text || null, updated_at: new Date().toISOString() };
  const isEmpty = !row.title && !row.area && !row.summary && !row.status && !row.impact && !row.workaround && !row.hidden;
  let error;
  if (isEmpty) {
    ({ error } = await sb.from('issue_overrides').delete().eq('url', editUrl));
    if (!error) delete overrides[editUrl];
  } else {
    ({ error } = await sb.from('issue_overrides').upsert(row));
    if (!error) overrides[editUrl] = row;
  }
  setStatus(error ? 'Save failed: ' + error.message : (text ? 'Workaround saved. Live for visitors.' : 'Workaround cleared.'), !error);
  drawWkPick(); drawWkList();
}

async function clearWk() {
  if (!editUrl) return;
  const existing = overrides[editUrl] || {};
  const remaining = { ...existing }; delete remaining.workaround;
  const stillHasOther = remaining.title || remaining.area || remaining.summary || remaining.status || remaining.impact || remaining.hidden;
  let error;
  if (stillHasOther) {
    ({ error } = await sb.from('issue_overrides').upsert({ ...remaining, url: editUrl, workaround: null, updated_at: new Date().toISOString() }));
    if (!error) overrides[editUrl] = { ...remaining, workaround: null };
  } else {
    ({ error } = await sb.from('issue_overrides').delete().eq('url', editUrl));
    if (!error) delete overrides[editUrl];
  }
  $('wkText').value = '';
  setStatus(error ? 'Clear failed: ' + error.message : 'Workaround cleared.', !error);
  drawWkPick(); drawWkList();
}

function drawWkList() {
  const el = $('wkList');
  const keys = Object.keys(overrides).filter(u => overrides[u] && overrides[u].workaround);
  if (!keys.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="hint" style="margin-bottom:8px">Issues with a workaround set — click to edit:</div>' + keys.map(u => {
    const b = itemByUrl(u), o = overrides[u];
    const label = (o.title || (b && b.title) || u);
    return `<span class="tag wk-tag"><span class="wk-tag-label" data-editwk="${esc(u)}">${esc(String(label).slice(0, 50))}</span> <span class="x" data-rmwk="${esc(u)}">✕</span></span>`;
  }).join('');
  el.querySelectorAll('[data-editwk]').forEach(s => s.onclick = () => openWk(s.dataset.editwk));
  el.querySelectorAll('[data-rmwk]').forEach(x => x.onclick = async () => {
    const u = x.dataset.rmwk;
    const existing = overrides[u] || {};
    const remaining = { ...existing }; delete remaining.workaround;
    const stillHasOther = remaining.title || remaining.area || remaining.summary || remaining.status || remaining.impact || remaining.hidden;
    let error;
    if (stillHasOther) {
      ({ error } = await sb.from('issue_overrides').upsert({ ...remaining, url: u, workaround: null, updated_at: new Date().toISOString() }));
      if (!error) overrides[u] = { ...remaining, workaround: null };
    } else {
      ({ error } = await sb.from('issue_overrides').delete().eq('url', u));
      if (!error) delete overrides[u];
    }
    setStatus(error ? 'Remove failed: ' + error.message : 'Workaround removed.', !error);
    drawWkPick(); drawWkList();
  });
}

/* ---------- Admin Patch Notes (internal release log) ---------- */
let anEditingId = null;          // id being edited, or null for "add new"
let anExpanded = {};             // id -> true when a previous release is expanded

function fmtNoteDate(s) {
  if (!s) return '';
  // release_date is 'YYYY-MM-DD'; render nicely. Fall back to timestamp.
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

// Sort releases newest-first by release_date, then by created_at.
function sortedAdminNotes() {
  return [...adminNotes].sort((a, b) => {
    const da = a.release_date || (a.created_at || '').slice(0, 10);
    const db = b.release_date || (b.created_at || '').slice(0, 10);
    if (da !== db) return db.localeCompare(da);
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });
}

function imageUrls(images) {
  return (images || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function photosHtml(images) {
  const urls = imageUrls(images);
  if (!urls.length) return '';
  return `<div class="an-note-photos">${urls.map(u =>
    `<img src="${esc(u)}" alt="" loading="lazy" onclick="window.open('${esc(u)}','_blank')">`).join('')}</div>`;
}

function fullNoteHtml(n, isCurrent, owner) {
  const actions = owner
    ? `<div class="an-note-actions">
         <button class="mini" data-anedit="${n.id}">Edit</button>
         <button class="mini" data-anrm="${n.id}">Delete</button>
       </div>`
    : '';
  return `<div class="an-note${isCurrent ? ' current' : ''}">
    <div><span class="an-note-date">${esc(fmtNoteDate(n.release_date) || fmtNoteDate(n.created_at))}</span>${isCurrent ? '<span class="an-note-current-badge">Current</span>' : ''}</div>
    <div class="an-note-body">${esc(n.body)}</div>
    ${photosHtml(n.images)}
    <div class="an-note-meta"><span>${esc(n.author || 'admin')}</span>${actions}</div>
  </div>`;
}

function drawAdminNotes() {
  const el = $('anList');
  if (!el) return;
  const owner = isNotesOwner();
  const list = sortedAdminNotes();
  if (!list.length) { el.innerHTML = '<div class="an-empty">No releases posted yet.</div>'; return; }

  const [current, ...previous] = list;
  let html = fullNoteHtml(current, true, owner);

  if (previous.length) {
    html += '<div class="an-prev-head">Previous releases</div>';
    html += previous.map(n => {
      if (anExpanded[n.id]) return fullNoteHtml(n, false, owner);
      const firstLine = (n.body || '').split(/\r?\n/)[0] || '';
      return `<div class="an-collapsed" data-anexpand="${n.id}">
        <span class="an-note-date">${esc(fmtNoteDate(n.release_date) || fmtNoteDate(n.created_at))}</span>
        <span class="an-collapsed-preview">${esc(firstLine)}</span>
        <span class="chev">▸</span>
      </div>`;
    }).join('');
  }
  el.innerHTML = html;

  el.querySelectorAll('[data-anexpand]').forEach(d => d.onclick = () => { anExpanded[+d.dataset.anexpand] = true; drawAdminNotes(); });
  if (owner) {
    el.querySelectorAll('[data-anedit]').forEach(b => b.onclick = () => editAdminNote(+b.dataset.anedit));
    el.querySelectorAll('[data-anrm]').forEach(b => b.onclick = () => removeAdminNote(+b.dataset.anrm));
  }
}

function resetAdminNoteForm() {
  anEditingId = null;
  $('anDate').value = '';
  $('anText').value = '';
  $('anImages').value = '';
  $('anAdd').textContent = 'Add release';
  $('anCancel').classList.add('hidden');
}

async function addAdminNote() {
  if (!isNotesOwner()) return;
  const body = $('anText').value.trim();
  const release_date = $('anDate').value.trim();
  const images = $('anImages').value.trim();
  if (!body) { setStatus('Describe what was added first.', false); return; }
  if (!release_date) { setStatus('Pick a release date.', false); return; }

  if (anEditingId != null) {
    const { error } = await sb.from('admin_notes')
      .update({ body, release_date, images, updated_at: new Date().toISOString() })
      .eq('id', anEditingId);
    if (error) { setStatus('Save failed: ' + error.message, false); return; }
    const n = adminNotes.find(x => x.id === anEditingId);
    if (n) { n.body = body; n.release_date = release_date; n.images = images; }
    setStatus('Release updated.', true);
    resetAdminNoteForm();
    drawAdminNotes();
    return;
  }

  const position = adminNotes.length ? Math.max(...adminNotes.map(n => n.position || 0)) + 1 : 0;
  const row = { body, release_date, images, author: currentEmail || 'admin', position, updated_at: new Date().toISOString() };
  const { data, error } = await sb.from('admin_notes').insert(row).select();
  if (error) { setStatus('Save failed: ' + error.message, false); return; }
  if (data && data[0]) adminNotes.push(data[0]);
  resetAdminNoteForm();
  setStatus('Release added.', true);
  drawAdminNotes();
}

function editAdminNote(id) {
  if (!isNotesOwner()) return;
  const n = adminNotes.find(x => x.id === id);
  if (!n) return;
  anEditingId = id;
  $('anDate').value = n.release_date || '';
  $('anText').value = n.body || '';
  $('anImages').value = n.images || '';
  $('anAdd').textContent = 'Update release';
  $('anCancel').classList.remove('hidden');
  $('anEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('anText').focus();
  setStatus('Editing release — change the fields, then click Update release.', true);
}

async function removeAdminNote(id) {
  if (!isNotesOwner()) return;
  const { error } = await sb.from('admin_notes').delete().eq('id', id);
  if (error) { setStatus('Delete failed: ' + error.message, false); return; }
  adminNotes = adminNotes.filter(n => n.id !== id);
  if (anEditingId === id) resetAdminNoteForm();
  setStatus('Release deleted.', true);
  drawAdminNotes();
}

/* ---------- Live visitors (owner-only presence observer) ---------- */
let _liveChannel = null;
let _liveTimer = null;
let _liveDetail = {};   // id -> freshest payload from broadcast (live action updates)

function relTime(sinceMs) {
  if (!sinceMs) return '';
  const s = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function renderLiveVisitors() {
  if (!_liveChannel) return;
  const state = _liveChannel.presenceState();   // { key: [ {payload...} ] }
  const currentIds = new Set();
  const sessions = [];
  Object.values(state).forEach(arr => {
    if (arr && arr[0]) {
      const base = arr[0];
      currentIds.add(base.id);
      // Membership comes from presence (reliable join/leave); the freshest
      // action comes from the broadcast detail map if we have it.
      sessions.push(_liveDetail[base.id] || base);
    }
  });
  // Drop detail for sessions that have left.
  Object.keys(_liveDetail).forEach(id => { if (!currentIds.has(id)) delete _liveDetail[id]; });
  sessions.sort((a, b) => (a.since || 0) - (b.since || 0));

  $('liveCount').textContent = String(sessions.length);
  const el = $('liveList');
  if (!sessions.length) { el.innerHTML = '<div class="an-empty">No one on the site right now.</div>'; return; }
  el.innerHTML = sessions.map(s => {
    const where = s.action
      ? `${esc(s.page || 'Site')} — <b>${esc(s.action)}</b>`
      : `On <b>${esc(s.page || 'Site')}</b>`;
    return `<div class="live-row">
      <span class="live-dot"></span>
      <span class="live-name">${esc(s.label || 'Visitor')}</span>
      <span class="live-where">${where}</span>
      <span class="live-time">${esc(relTime(s.since))}</span>
    </div>`;
  }).join('');
}

function startLiveVisitors() {
  // Owner-only; needs the realtime library + config. Safe to call repeatedly.
  if (_liveChannel || !isNotesOwner()) return;
  const card = $('liveCard');
  if (card) card.classList.remove('hidden');
  try {
    const channel = sb.channel('live-presence');
    _liveChannel = channel;
    channel
      .on('presence', { event: 'sync' }, renderLiveVisitors)
      .on('presence', { event: 'join' }, renderLiveVisitors)
      .on('presence', { event: 'leave' }, renderLiveVisitors)
      .on('broadcast', { event: 'session' }, ({ payload }) => {
        if (payload && payload.id) { _liveDetail[payload.id] = payload; renderLiveVisitors(); }
      })
      .subscribe();
    // Refresh the "time on page" labels every second so elapsed time ticks
    // smoothly (presence join/leave/sync events update the roster instantly on
    // their own — this interval is only for the relative-time text).
    if (!_liveTimer) _liveTimer = setInterval(() => { if (_liveChannel) renderLiveVisitors(); }, 1000);
  } catch (e) { /* best-effort */ }
}

/* ---------- Patch notes (per stream: explorer / creator-hub / sdk) ---------- */
const PN_STREAMS = [
  { key: 'explorer',    label: 'Explorer' },
  { key: 'creator-hub', label: 'Creator Hub' },
  { key: 'sdk',         label: 'SDK' },
];
// When a note is pulled back for editing, we remember its db id (and original
// position) here, keyed by stream, so re-adding it updates the same row.
const pnEditing = {};

// Rebuild the pasteable text (header line + body) from a stored note, so it can
// be loaded back into the textarea for editing.
function noteToText(n) {
  const header = `**Release Notes** ${n.version || ''}${n.date_label ? ` (${n.date_label})` : ''}`.trim();
  return `${header}\n${n.body || ''}`;
}

function editPatchNote(stream, gi) {
  // Find the flat index of this note within its stream group.
  let c = 0, fi = -1;
  for (let i = 0; i < notes.length; i++) { if ((notes[i].stream || 'explorer') === stream) { if (c === gi) { fi = i; break; } c++; } }
  if (fi < 0) return;
  const ta = $('pnBody_' + stream);
  // If the textarea already holds an in-progress edit, don't silently lose it.
  if (ta.value.trim() && pnEditing[stream]) {
    setStatus('Finish or clear the current edit in that box first (click "Update" or empty it).', false);
    return;
  }
  const [row] = notes.splice(fi, 1);
  pnEditing[stream] = { id: row.id, position: row.position };
  ta.value = noteToText(row);
  // Relabel the add button to make it clear this will update the existing note.
  const btn = $('pnAdd_' + stream);
  if (btn) btn.textContent = 'Update ' + (PN_STREAMS.find(s => s.key === stream) || {}).label;
  markDirty('pn'); drawPatchNotes();
  setStatus(`Editing ${row.version || 'release'} in ${stream}. Change the text, then click Update.`, true);
  ta.focus();
}

function addPatchNote(stream) {
  const ta = $('pnBody_' + stream);
  const raw = ta.value.trim();
  if (!raw) { setStatus('Paste the release notes first.', false); return; }
  const { version, date, body } = parseRelease(raw);
  if (!body) { setStatus('Could not find any notes below the header line.', false); return; }

  const editing = pnEditing[stream];
  if (editing) {
    // Re-insert the edited note at its original position, keeping its db id so
    // the save updates the existing row instead of creating a duplicate.
    const updated = { id: editing.id, stream, version, date_label: date, body, position: editing.position || 0 };
    // Place it back among its stream group near where it was.
    let inserted = false, c = 0;
    for (let i = 0; i < notes.length; i++) {
      if ((notes[i].stream || 'explorer') === stream) {
        if (c === (editing.position || 0)) { notes.splice(i, 0, updated); inserted = true; break; }
        c++;
      }
    }
    if (!inserted) notes.push(updated);
    pnEditing[stream] = null;
    const btn = $('pnAdd_' + stream);
    if (btn) btn.textContent = 'Add to ' + (PN_STREAMS.find(s => s.key === stream) || {}).label;
    ta.value = '';
    markDirty('pn'); drawPatchNotes();
    setStatus(`Updated ${version || 'release'} in ${stream} — click "Save patch notes" to publish.`, true);
    return;
  }

  // Insert at the top of this stream's group.
  notes.unshift({ id: null, stream, version, date_label: date, body, position: 0 });
  ta.value = '';
  markDirty('pn'); drawPatchNotes();
  setStatus(version ? `Parsed ${version}${date ? ' (' + date + ')' : ''} for ${stream} — click "Save patch notes" to publish.` : `Added to ${stream} — click "Save patch notes" to publish.`, true);
}

async function savePatchNotes() {
  // Position is per-stream ordering; recompute within each group.
  PN_STREAMS.forEach(s => {
    let p = 0;
    notes.forEach(n => { if ((n.stream || 'explorer') === s.key) n.position = p++; });
  });
  let error = null;
  const fresh = notes.filter(n => n.id == null);
  const existing = notes.filter(n => n.id != null);
  if (fresh.length) {
    const { data, error: e } = await sb.from('patch_notes')
      .insert(fresh.map(n => ({ stream: n.stream || 'explorer', version: n.version, date_label: n.date_label, body: n.body, position: n.position })))
      .select();
    error = e;
    if (!e && data) {
      data.forEach(row => { const m = notes.find(n => n.id == null && n.body === row.body); if (m) m.id = row.id; });
    }
  }
  if (!error && existing.length) {
    ({ error } = await sb.from('patch_notes').upsert(existing.map(n => ({ id: n.id, stream: n.stream || 'explorer', version: n.version, date_label: n.date_label, body: n.body, position: n.position }))));
  }
  if (!error && deletedNoteIds.length) {
    ({ error } = await sb.from('patch_notes').delete().in('id', deletedNoteIds));
    if (!error) deletedNoteIds = [];
  }
  if (!error) markDirty('pn', false);
  setStatus(error ? 'Patch notes save failed: ' + error.message : 'Patch notes saved. Live on the overview.', !error);
  drawPatchNotes();
}

function drawPatchNotes() {
  PN_STREAMS.forEach(s => {
    const el = $('pnList_' + s.key);
    if (!el) return;
    const group = notes.filter(n => (n.stream || 'explorer') === s.key);
    if (!group.length) { el.innerHTML = '<div class="hint">No releases yet.</div>'; return; }
    el.innerHTML = group.map((n, gi) =>
      `<div class="pn-row">
        <div class="pn-row-title">${esc(n.version || 'Release')}${n.date_label ? ` <span class="pn-row-date">${esc(n.date_label)}</span>` : ''}${n.id == null ? ' <small style="color:#FFBC5B">(unsaved)</small>' : ''}</div>
        <div class="pn-row-actions">
          <button class="mini" data-pnedit="${s.key}:${gi}">Edit</button>
          <button class="mini" data-pnup="${s.key}:${gi}">↑</button>
          <button class="mini" data-pndown="${s.key}:${gi}">↓</button>
          <button class="mini" data-pnrm="${s.key}:${gi}">Remove</button>
        </div>
      </div>`).join('');

    // Helper: map a (stream, groupIndex) to the flat index in `notes`.
    const flatIndex = (gi) => { let c = 0; for (let i = 0; i < notes.length; i++) { if ((notes[i].stream || 'explorer') === s.key) { if (c === gi) return i; c++; } } return -1; };

    el.querySelectorAll('[data-pnedit]').forEach(b => b.onclick = () => {
      const gi = +b.dataset.pnedit.split(':')[1];
      editPatchNote(s.key, gi);
    });

    el.querySelectorAll('[data-pnrm]').forEach(b => b.onclick = () => {
      const gi = +b.dataset.pnrm.split(':')[1];
      const fi = flatIndex(gi); if (fi < 0) return;
      const row = notes.splice(fi, 1)[0];
      if (row.id != null) deletedNoteIds.push(row.id);
      markDirty('pn'); drawPatchNotes();
    });
    el.querySelectorAll('[data-pnup]').forEach(b => b.onclick = () => {
      const gi = +b.dataset.pnup.split(':')[1]; if (gi === 0) return;
      const a = flatIndex(gi), c = flatIndex(gi - 1);
      [notes[a], notes[c]] = [notes[c], notes[a]];
      markDirty('pn'); drawPatchNotes();
    });
    el.querySelectorAll('[data-pndown]').forEach(b => b.onclick = () => {
      const gi = +b.dataset.pndown.split(':')[1];
      if (gi >= group.length - 1) return;
      const a = flatIndex(gi), c = flatIndex(gi + 1);
      [notes[a], notes[c]] = [notes[c], notes[a]];
      markDirty('pn'); drawPatchNotes();
    });
  });
}

})();
