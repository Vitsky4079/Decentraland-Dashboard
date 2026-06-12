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

let sb = null;            // supabase client
let BUGS = [], ALLITEMS = [];
let pins = [];            // [{url, position}] sorted
let overrides = {};       // url -> row
let notes = [];           // [{id, version, date_label, body, position}] sorted
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
  if (session) openPanel(session);
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
  $('whoami').textContent = (session.user && session.user.email) || 'admin';
  $('edStatus').innerHTML = '<option value="">— Auto —</option>' + BUG_STATUSES.map(s => `<option>${s}</option>`).join('');
  wireEditors();
  await Promise.all([loadDbState(), loadGithubIssues()]);
  drawAll();
}

/* ---------- Load state ---------- */
async function loadDbState() {
  const [a, s, p, o, n] = await Promise.all([
    sb.from('announcements').select('*').eq('id', 1).maybeSingle(),
    sb.from('service_status').select('*'),
    sb.from('pins').select('*').order('position'),
    sb.from('issue_overrides').select('*'),
    sb.from('patch_notes').select('*').order('position'),
  ]);
  const ann = a.data || { text: '', level: 'Info', link: '' };
  $('annText').value = ann.text || '';
  $('annLevel').value = ann.level || 'Info';
  $('annLink').value = ann.link || '';
  window.__svcLevels = {};
  (s.data || []).forEach(r => window.__svcLevels[r.name] = r.level);
  pins = p.data || [];
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

function drawAll() { drawServices(); drawPinned(); drawPicker(); drawEditPick(); drawEditedList(); drawPatchNotes(); }
const itemByUrl = u => ALLITEMS.find(x => x.url === u);

/* ---------- Wire static controls ---------- */
function wireEditors() {
  $('annSave').onclick = saveAnnouncement;
  $('pinSearch').oninput = e => { pickQ = e.target.value.toLowerCase(); drawPicker(); };
  $('editSearch').oninput = e => { editQ = e.target.value.toLowerCase(); drawEditPick(); };
  $('edApply').onclick = applyEdit;
  $('edClear').onclick = clearEdit;
  $('pnAdd').onclick = addPatchNote;
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
      <select data-svc="${esc(svc.name)}">${levels.map(l => `<option ${ (window.__svcLevels[svc.name] || 'Auto') === l ? 'selected' : '' }>${l}</option>`).join('')}</select>
    </div>`).join('');
  $('svcRows').querySelectorAll('select').forEach(sel => sel.onchange = async () => {
    const name = sel.dataset.svc;
    let error;
    if (sel.value === 'Auto') ({ error } = await sb.from('service_status').delete().eq('name', name));
    else ({ error } = await sb.from('service_status').upsert({ name, level: sel.value }));
    if (!error) window.__svcLevels[name] = sel.value === 'Auto' ? undefined : sel.value;
    setStatus(error ? 'Status save failed: ' + error.message : `${name} → ${sel.value}. Live.`, !error);
  });
}

/* ---------- Pins ---------- */
async function persistPinOrder() {
  pins.forEach((p, i) => p.position = i);
  if (!pins.length) return;
  const { error } = await sb.from('pins').upsert(pins);
  setStatus(error ? 'Pin save failed: ' + error.message : 'Pins updated. Live.', !error);
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
  el.querySelectorAll('[data-unpin]').forEach(btn => btn.onclick = async () => {
    const row = pins.splice(+btn.dataset.unpin, 1)[0];
    await sb.from('pins').delete().eq('url', row.url);
    await persistPinOrder(); drawPinned(); drawPicker();
    setStatus('Unpinned. Live.', true);
  });
  el.querySelectorAll('[data-mv]').forEach(btn => btn.onclick = async () => {
    const i = +btn.dataset.i, j = i + (+btn.dataset.mv);
    if (j < 0 || j >= pins.length) return;
    [pins[i], pins[j]] = [pins[j], pins[i]];
    await persistPinOrder(); drawPinned();
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
  el.querySelectorAll('[data-pin]').forEach(btn => btn.onclick = async () => {
    pins.push({ url: btn.dataset.pin, position: pins.length });
    await persistPinOrder(); drawPinned(); drawPicker();
  });
}

/* ---------- Issue editor ---------- */
function drawEditPick() {
  const el = $('editPick');
  if (!ALLITEMS.length) { el.innerHTML = '<div class="pin-row" style="color:var(--text-faint)">Could not load issues from GitHub.</div>'; return; }
  const list = ALLITEMS.filter(b => !editQ || b.title.toLowerCase().includes(editQ)).slice(0, 40);
  el.innerHTML = list.map(b => {
    const ov = overrides[b.url];
    const tag = ov ? (ov.hidden ? ' · hidden' : ' · edited') : '';
    return `<div class="pin-row"><span class="t">${esc(b.title)}</span><span class="a">${esc(b.area)}${tag}</span>
      <button class="mini pin" data-edit="${esc(b.url)}">Edit</button></div>`;
  }).join('') || '<div class="pin-row" style="color:var(--text-faint)">No matching issues.</div>';
  el.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => openEdit(btn.dataset.edit));
}

function openEdit(url) {
  editUrl = url;
  const b = itemByUrl(url) || {};
  const ov = overrides[url] || {};
  $('editForm').classList.remove('hidden');
  $('editHead').innerHTML = `Editing: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a><br>GitHub title: ${esc(b.rawTitle || b.title || '')}`;
  $('edTitle').value = ov.title || '';        $('edTitle').placeholder = b.title || '';
  $('edArea').value = ov.area || '';          $('edArea').placeholder = b.area || '';
  $('edSummary').value = ov.summary || '';    $('edSummary').placeholder = b.summary || '(no summary)';
  $('edStatus').value = ov.status || '';
  $('edImpact').value = ov.impact || '';
  $('edWorkaround').value = ov.workaround || '';
  $('edHidden').checked = !!ov.hidden;
  $('edPin').checked = pins.some(p => p.url === url);
  $('edPin').onchange = async () => {
    if ($('edPin').checked) { if (!pins.some(p => p.url === url)) pins.push({ url, position: pins.length }); }
    else {
      pins = pins.filter(p => p.url !== url);
      await sb.from('pins').delete().eq('url', url);
    }
    await persistPinOrder(); drawPinned(); drawPicker();
  };
  $('editForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function applyEdit() {
  if (!editUrl) return;
  const row = {
    url: editUrl,
    title: $('edTitle').value.trim() || null,
    area: $('edArea').value.trim() || null,
    summary: $('edSummary').value.trim() || null,
    status: $('edStatus').value || null,
    impact: $('edImpact').value || null,
    workaround: $('edWorkaround').value.trim() || null,
    hidden: $('edHidden').checked,
    updated_at: new Date().toISOString(),
  };
  const isEmpty = !row.title && !row.area && !row.summary && !row.status && !row.impact && !row.workaround && !row.hidden;
  let error;
  if (isEmpty) {
    ({ error } = await sb.from('issue_overrides').delete().eq('url', editUrl));
    if (!error) delete overrides[editUrl];
  } else {
    ({ error } = await sb.from('issue_overrides').upsert(row));
    if (!error) overrides[editUrl] = row;
  }
  setStatus(error ? 'Save failed: ' + error.message : 'Override saved. Live for visitors.', !error);
  drawEditPick(); drawEditedList();
}

async function clearEdit() {
  if (editUrl) {
    const { error } = await sb.from('issue_overrides').delete().eq('url', editUrl);
    if (!error) delete overrides[editUrl];
    setStatus(error ? 'Remove failed: ' + error.message : 'Override removed.', !error);
  }
  $('editForm').classList.add('hidden'); editUrl = null;
  drawEditPick(); drawEditedList();
}

function drawEditedList() {
  const el = $('editedList');
  const keys = Object.keys(overrides);
  if (!keys.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="hint" style="margin-bottom:8px">Active overrides:</div>' + keys.map(u => {
    const b = itemByUrl(u), o = overrides[u];
    const label = (o.title || (b && b.title) || u);
    const what = [o.hidden && 'hidden', o.title && 'title', o.summary && 'summary', o.status && 'status', o.impact && 'impact', o.area && 'area', o.workaround && 'workaround'].filter(Boolean).join(', ');
    return `<span class="tag">${esc(String(label).slice(0, 40))} <small style="color:var(--text-faint)">(${esc(what)})</small> <span class="x" data-rmov="${esc(u)}">✕</span></span>`;
  }).join('');
  el.querySelectorAll('[data-rmov]').forEach(x => x.onclick = async () => {
    const { error } = await sb.from('issue_overrides').delete().eq('url', x.dataset.rmov);
    if (!error) delete overrides[x.dataset.rmov];
    setStatus(error ? 'Remove failed: ' + error.message : 'Override removed.', !error);
    drawEditPick(); drawEditedList();
  });
}

/* ---------- Patch notes ---------- */
async function persistNoteOrder() {
  notes.forEach((n, i) => n.position = i);
  if (!notes.length) return;
  const { error } = await sb.from('patch_notes').upsert(notes.map(n => ({ id: n.id, version: n.version, date_label: n.date_label, body: n.body, position: n.position })));
  if (error) setStatus('Reorder failed: ' + error.message, false);
}

async function addPatchNote() {
  const body = $('pnBody').value.trim();
  if (!body) { setStatus('Paste the release notes body first.', false); return; }
  const { data, error } = await sb.from('patch_notes')
    .insert({ version: $('pnVersion').value.trim(), date_label: $('pnDate').value.trim(), body, position: -1 })
    .select().single();
  if (error) { setStatus('Add failed: ' + error.message, false); return; }
  notes.unshift(data);
  await persistNoteOrder();
  $('pnVersion').value = ''; $('pnDate').value = ''; $('pnBody').value = '';
  drawPatchNotes();
  setStatus('Release added. Live on the overview.', true);
}

function drawPatchNotes() {
  const el = $('pnList');
  if (!notes.length) { el.innerHTML = '<div class="hint">No releases yet.</div>'; return; }
  el.innerHTML = notes.map((n, i) =>
    `<div class="pin-row"><span class="t">${esc(n.version || 'Release')} ${esc(n.date_label || '')}</span>
      <button class="mini" data-pnup="${i}">↑</button>
      <button class="mini" data-pndown="${i}">↓</button>
      <button class="mini" data-pnrm="${i}">Remove</button></div>`).join('');
  el.querySelectorAll('[data-pnrm]').forEach(b => b.onclick = async () => {
    const row = notes.splice(+b.dataset.pnrm, 1)[0];
    const { error } = await sb.from('patch_notes').delete().eq('id', row.id);
    setStatus(error ? 'Remove failed: ' + error.message : 'Release removed.', !error);
    await persistNoteOrder(); drawPatchNotes();
  });
  el.querySelectorAll('[data-pnup]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.pnup; if (i === 0) return;
    [notes[i-1], notes[i]] = [notes[i], notes[i-1]];
    await persistNoteOrder(); drawPatchNotes();
  });
  el.querySelectorAll('[data-pndown]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.pndown; if (i >= notes.length - 1) return;
    [notes[i+1], notes[i]] = [notes[i], notes[i+1]];
    await persistNoteOrder(); drawPatchNotes();
  });
}

})();
