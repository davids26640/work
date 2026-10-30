/* Filter & Belt Tracker — app code. Data lives in data.js (window.TRACKER_DATA). */
(function () {
'use strict';

const LS_KEY = 'filter-belt-tracker-v2';
const TYPES = ['AHU', 'RTU', 'MAU', 'King Heater', 'Other'];
const TYPE_NAMES = { AHU: 'Air handler', RTU: 'Rooftop unit', MAU: 'Make-up air', 'King Heater': 'King Heater', Other: 'Other' };
const typeLabel = t => TYPE_NAMES[t] && TYPE_NAMES[t] !== t ? `${t} — ${TYPE_NAMES[t]}` : t;
const NOTE_KINDS = { cooling: 'Cooling', heating: 'Heating' };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const arr = v => Array.isArray(v) ? v : [];

function normalize(d) {
  if (Array.isArray(d)) d = { units: d };
  if (!d || typeof d !== 'object') d = {};
  const n = d.notes || {};
  return { units: arr(d.units), stock: arr(d.stock), notes: { cooling: arr(n.cooling), heating: arr(n.heating) } };
}
let S = normalize(window.TRACKER_DATA);

let mode = 'local', artifactApi = null, readOnly = false, saveTimer = null;
let view = 'units', noteTab = 'cooling';

/* Change history is PRIVATE: it lives in the artifact's database, readable only by the
   owner and Editors (see the db rules). It is never written into data.js, so Viewers
   can't see change dates even in the page source. */
let priv = false, dbApi = null, userApi = null, myId = null;
let HIST = [], LAST = new Map(), names = {};
const LS_HIST = 'filter-belt-tracker-history';
function lastOf(u, part) { return LAST.get(u.id + '|' + part) || ''; }
function recompute() {
  LAST = new Map();
  HIST.forEach(h => { const k = h.unitId + '|' + h.part; if (!LAST.has(k) || String(h.date) > LAST.get(k)) LAST.set(k, String(h.date)); });
}

/* ---------- dates ---------- */
function parseD(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function fmtD(d) { return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : ''; }
function niceD(d) { return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function today() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
function addMonths(d, n) { const r = new Date(d.getFullYear(), d.getMonth() + n, 1); const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate(); r.setDate(Math.min(d.getDate(), last)); return r; }
function daysUntil(d) { return Math.round((d - today()) / 86400000); }

function dueInfo(last, months) {
  const l = parseD(last), m = Number(months);
  if (!l || !m) return { status: 'unknown', due: null, days: null };
  const due = addMonths(l, m), days = daysUntil(due);
  return { status: days < 0 ? 'overdue' : days <= 14 ? 'soon' : 'ok', due, days };
}
function unitDue(u) {
  if (!priv) return { status: 'none', due: null, days: null };
  const items = [];
  if ((u.filters || []).length) items.push(dueInfo(lastOf(u, 'filters'), u.filterInterval));
  if ((u.belts || []).length) items.push(dueInfo(lastOf(u, 'belts'), u.beltInterval));
  const known = items.filter(i => i.due).sort((a, b) => a.due - b.due);
  return known[0] || { status: 'unknown', due: null, days: null };
}
function relText(i) {
  if (!i.due) return 'No date set';
  if (i.days < 0) return `Overdue ${-i.days} day${i.days === -1 ? '' : 's'}`;
  if (i.days === 0) return 'Due today';
  return `Due in ${i.days} day${i.days === 1 ? '' : 's'}`;
}

/* ---------- saving ---------- */
function lsGet() { try { const v = localStorage.getItem(LS_KEY) || localStorage.getItem('filter-belt-tracker-v1'); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function lsSet() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
function setStatus(text, cls) { $('#saveText').textContent = text; $('#save').className = 'save' + (cls ? ' ' + cls : ''); }

function dataJs() {
  return '/* Filter & Belt Tracker data. The page rewrites this file when you save. */\n' +
    'window.TRACKER_DATA = ' + JSON.stringify({ ...S, units: S.units.map(({ filterLast, beltLast, ...u }) => u) }, null, 1).replace(/</g, '\\u003c') + ';\n';
}
function persist() {
  lsSet();
  if (mode === 'local') { setStatus('Saved in this browser'); return; }
  if (readOnly) { setStatus('View only — changes are not saved', 'warn'); return; }
  setStatus('Saving…', 'busy');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doPublish, 1200);
}
async function doPublish() {
  try {
    await artifactApi.publish({ 'data.js': { content: dataJs(), contentType: 'text/javascript' } });
    setStatus('All changes saved');
  } catch (e) {
    const code = String((e && e.code) || '');
    if (/not_granted|not_writer|consent_required|not_declared/.test(code)) { readOnly = true; setStatus('View only — changes are not saved', 'warn'); }
    else if (/capability_disabled|capability_removed/.test(code)) { readOnly = true; setStatus('Saving isn’t available in this view', 'warn'); }
    else if (code === 'conflict') setStatus('Someone else saved first — reloading', 'warn');
    else if (code === 'rate_limited') { setStatus('Saving…', 'busy'); clearTimeout(saveTimer); saveTimer = setTimeout(doPublish, 5000); }
    else setStatus('Save failed — make another change to retry', 'warn');
  }
}
async function initStorage() {
  const hasClaude = window.claude && typeof window.claude.use === 'function';
  try { if (hasClaude) artifactApi = await window.claude.use('artifact'); } catch (e) { artifactApi = null; }
  if (artifactApi) {
    mode = 'shared'; setStatus('All changes saved');
    let db = null, user = null;
    try { [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]); } catch (e) {}
    userApi = user;
    let canSee = false;
    try { canSee = !!(user && await user.canEdit()); } catch (e) {}
    if (db && canSee) {
      dbApi = db; priv = true;
      try { myId = await user.id(); } catch (e) {}
      subscribeHistory();
    }
    applyPrivacy(); render();
    return;
  }
  // Opened as plain files (no Claude): everything stays in this browser, history included.
  mode = 'local'; priv = true;
  const saved = lsGet();
  if (saved) S = normalize(saved);
  try { HIST = JSON.parse(localStorage.getItem(LS_HIST) || '[]'); } catch (e) { HIST = []; }
  // carry over dates saved by older versions of the page
  S.units.forEach(u => {
    if (u.filterLast && !HIST.some(h => h.unitId === u.id && h.part === 'filters')) HIST.push({ id: uid(), unitId: u.id, unitName: u.name, part: 'filters', date: u.filterLast, at: '' });
    if (u.beltLast && !HIST.some(h => h.unitId === u.id && h.part === 'belts')) HIST.push({ id: uid(), unitId: u.id, unitName: u.name, part: 'belts', date: u.beltLast, at: '' });
    delete u.filterLast; delete u.beltLast;
  });
  recompute(); applyPrivacy(); render();
  setStatus('Saved in this browser');
}

function applyPrivacy() {
  document.body.classList.toggle('is-private', priv);
  const opt = $('#sort option[value=due]');
  opt.hidden = opt.disabled = !priv;
  if (!priv && $('#sort').value === 'due') $('#sort').value = 'name';
  if (!priv && view === 'history') go('units');
}

/* ---------- private change history ---------- */
function subscribeHistory() {
  let loaded = false;
  const t = setTimeout(() => { if (!loaded) setStatus('Change history can’t be reached yet', 'warn'); }, 10000);
  dbApi.collection('history').onSnapshot(snap => {
    HIST = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    recompute(); render();
    if (!snap.metadata.fromCache && !loaded) { loaded = true; clearTimeout(t); setStatus('All changes saved'); }
  }, () => { clearTimeout(t); setStatus('Change history unavailable', 'warn'); });
}
async function addHistory(u, part, date) {
  const rec = { unitId: u.id, unitName: u.name, part, date, at: new Date().toISOString(), by: myId || '' };
  if (mode === 'local') {
    HIST.push({ id: uid(), ...rec });
    try { localStorage.setItem(LS_HIST, JSON.stringify(HIST)); } catch (e) {}
    recompute(); render(); return;
  }
  try { await dbApi.collection('history').add(rec); }
  catch (e) { setStatus(e && e.code === 'quota_exceeded' ? 'History is full — delete old entries' : 'Couldn’t save that change — try again', 'warn'); }
}
async function deleteHistory(hid) {
  if (mode === 'local') {
    HIST = HIST.filter(h => h.id !== hid);
    try { localStorage.setItem(LS_HIST, JSON.stringify(HIST)); } catch (e) {}
    recompute(); render(); return;
  }
  try { await dbApi.collection('history').doc(hid).delete(); } catch (e) { setStatus('Couldn’t delete that entry', 'warn'); }
}
function renderHistory() {
  const q = $('#hq').value.trim().toLowerCase(), part = $('#hPart').value;
  const unitName = h => (S.units.find(u => u.id === h.unitId) || {}).name || h.unitName || '?';
  let rows = HIST.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.at).localeCompare(String(a.at)));
  if (part) rows = rows.filter(h => h.part === part);
  if (q) rows = rows.filter(h => unitName(h).toLowerCase().includes(q));
  const el = $('#history');
  if (!rows.length) { el.innerHTML = `<div class="empty"><h2>${HIST.length ? 'No matches' : 'No changes logged yet'}</h2><p>${HIST.length ? 'Nothing fits that search.' : 'Use “Filters changed today” or “Belts changed today” on a unit, or set a last-changed date when editing one.'}</p></div>`; return; }
  const missing = [...new Set(rows.map(h => h.by).filter(b => b && !(b in names)))];
  if (missing.length && userApi && userApi.profiles) {
    missing.forEach(b => names[b] = '');
    Promise.resolve(userApi.profiles(missing)).then(ps => { missing.forEach(b => names[b] = (ps && ps[b] && ps[b].name) || ''); if (view === 'history') renderHistory(); }).catch(() => {});
  }
  el.innerHTML = `<table class="hist-table"><thead><tr><th>Date</th><th>Unit</th><th>What</th><th class="units-col">Logged by</th><th></th></tr></thead><tbody>
    ${rows.map(h => `<tr><td>${niceD(parseD(h.date))}</td><td><b>${esc(unitName(h))}</b></td><td>${h.part === 'belts' ? 'Belts' : 'Filters'} changed</td>
      <td class="units-col">${h.by ? esc(names[h.by] || 'Someone') : (mode === 'local' ? 'This browser' : '—')}</td>
      <td style="text-align:right"><button class="btn ghost sm" data-hdel="${esc(h.id)}" title="Delete entry">✕</button></td></tr>`).join('')}
  </tbody></table>`;
}

/* ---------- helpers ---------- */
function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s*[x×*]\s*/g, 'x').replace(/\s+/g, ''); }
function dispSize(s) { return /^\s*\d/.test(s || '') ? norm(s) : String(s || '').trim(); }
function baseKind(k) { return String(k || '').split(' · ')[0].trim(); }
function fkey(size, kind) { return norm(size) + '|' + baseKind(kind).toLowerCase(); }
const isBag = k => /^bag/i.test(k || '');
const num = n => Number(n || 0).toLocaleString();
const bySize = (a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }) || a.kind.localeCompare(b.kind);

function coolVal(u) { const c = u.cooling; if (c === 'N/A') return 'N/A'; return c === '' || c == null || isNaN(+c) ? null : +c; }
function coolClass(v) { return v === 'N/A' ? 'na' : v >= 100 ? 'full' : v >= 50 ? 'part' : v > 0 ? 'low' : 'none'; }
function coolLine(u) {
  const v = coolVal(u); if (v === null) return '';
  const pct = v === 'N/A' ? 0 : Math.max(0, Math.min(100, v));
  return `<div class="cool c-${coolClass(v)}"><span class="cool-lbl">Cooling capacity</span><span class="cool-bar"><i style="width:${pct}%"></i></span><b>${v === 'N/A' ? 'N/A' : v + '%'}</b></div>`;
}
function filterChip(f) {
  const extra = [f.merv ? 'MERV ' + f.merv : '', f.kind].filter(Boolean).join(' · ');
  return `<span class="chip">${esc(f.size || '?')} ×${esc(f.qty || 1)}${extra ? `<small>${esc(extra)}</small>` : ''}</span>`;
}
function beltChip(b) { return `<span class="chip">${esc(b.size || '?')} ×${esc(b.qty || 1)}${b.note ? `<small>${esc(b.note)}</small>` : ''}</span>`; }
function schedLine(label, last, months, has) {
  if (!has) return '';
  if (!priv) return months ? `<div class="sched"><b>${label}:</b> changed every ${esc(months)} mo</div>` : '';
  const i = dueInfo(last, months), parts = [`<b>${label}:</b>`];
  parts.push(last ? 'last ' + niceD(parseD(last)) : 'no last-change date');
  if (months) parts.push(`every ${esc(months)} mo`);
  if (i.due) parts.push(`next <b>${niceD(i.due)}</b> <span class="pill p-${i.status}">${relText(i)}</span>`);
  return `<div class="sched">${parts.join(' · ')}</div>`;
}
function searchText(u) {
  const cv = coolVal(u);
  return [cv === null ? '' : 'cooling ' + cv + (cv === 'N/A' ? '' : '%'), u.name, u.type, TYPE_NAMES[u.type], u.location, u.make, u.model, u.notes,
    ...(u.filters || []).flatMap(f => [f.size, f.kind, f.merv && ('merv ' + f.merv)]),
    ...(u.belts || []).flatMap(b => [b.size, b.note])].join(' ').toLowerCase();
}

/* ---------- render ---------- */
function render() {
  const ds = S.units.map(unitDue);
  $('#stUnits').textContent = S.units.length;
  $('#stOver').textContent = ds.filter(d => d.status === 'overdue').length;
  $('#stSoon').textContent = ds.filter(d => d.status === 'soon').length;
  $('#stFilters').textContent = num(S.units.reduce((n, u) => n + (u.filters || []).reduce((a, f) => a + (+f.qty || 0), 0), 0));
  $('#stBelts').textContent = num(S.units.reduce((n, u) => n + (u.belts || []).reduce((a, b) => a + (+b.qty || 0), 0), 0));
  const cvs = S.units.filter(u => /^ash/i.test(u.name)).map(coolVal).filter(v => typeof v === 'number');
  $('#stCool').textContent = cvs.length ? Math.round(cvs.reduce((a, v) => a + v, 0) / cvs.length) + '%' : '—';
  $('#unitList').innerHTML = S.units.map(u => `<option value="${esc(u.name)}">`).join('');
  $('#cCool').textContent = S.notes.cooling.length;
  $('#cHeat').textContent = S.notes.heating.length;
  ({ units: renderUnits, totals: renderTotals, parts: renderParts, notes: renderNotes, history: renderHistory })[view]();
}

function renderUnits() {
  const q = $('#q').value.trim().toLowerCase();
  const ft = $('#fType').value, fs = priv ? $('#fStatus').value : '', fc = $('#fCool').value;
  let sort = $('#sort').value; if (!priv && sort === 'due') sort = 'name';
  let rows = S.units.map(u => ({ u, d: unitDue(u) }));
  if (q) rows = rows.filter(r => q.split(/\s+/).every(t => searchText(r.u).includes(t)));
  if (ft) rows = rows.filter(r => r.u.type === ft);
  if (fs) rows = rows.filter(r => r.d.status === fs);
  if (fc) rows = rows.filter(r => { const v = coolVal(r.u);
    return fc === 'set' ? v !== null : fc === 'na' ? v === 'N/A' : typeof v === 'number' && (fc === 'full' ? v >= 100 : fc === 'none' ? v <= 0 : v > 0 && v < 100); });
  const byName = (a, b) => String(a.u.name).localeCompare(String(b.u.name), undefined, { numeric: true });
  if (sort === 'name') rows.sort(byName);
  else if (sort === 'loc') rows.sort((a, b) => String(a.u.location || '').localeCompare(String(b.u.location || ''), undefined, { numeric: true }) || byName(a, b));
  else if (sort === 'cool') { const cv = r => { const v = coolVal(r.u); return typeof v === 'number' ? v : v === 'N/A' ? 1000 : 2000; }; rows.sort((a, b) => cv(a) - cv(b) || byName(a, b)); }
  else rows.sort((a, b) => (a.d.due ? a.d.due.getTime() : Infinity) - (b.d.due ? b.d.due.getTime() : Infinity) || byName(a, b));

  const list = $('#list');
  if (!S.units.length) { list.innerHTML = `<div class="empty"><h2>No units yet</h2><p><button class="btn primary" data-act="add">+ Add unit</button></p></div>`; return; }
  if (!rows.length) { list.innerHTML = `<div class="empty"><h2>No matches</h2><p>Nothing fits that search or filter.</p></div>`; return; }

  list.innerHTML = rows.map(({ u, d }) => {
    const meta = [u.location, [u.make, u.model].filter(Boolean).join(' ')].filter(Boolean).map(esc).join(' · ');
    const hasF = (u.filters || []).length, hasB = (u.belts || []).length;
    return `<article class="unit s-${d.status}" data-id="${esc(u.id)}">
      <div class="uhead">
        <div>
          <div class="uname"><span class="badge" title="${esc(TYPE_NAMES[u.type] || u.type)}">${esc(u.type || 'Other')}</span><h3>${esc(u.name)}</h3></div>
          ${meta ? `<div class="meta">${meta}</div>` : ''}
          ${coolLine(u)}
        </div>
        ${priv ? (() => { const lc = [lastOf(u, 'filters'), lastOf(u, 'belts')].filter(Boolean).sort().pop();
          return !d.due && lc ? `<span class="pill p-unknown">Last changed ${niceD(parseD(lc))}</span>` : `<span class="pill p-${d.status}">${relText(d)}</span>`; })() : ''}
      </div>
      <div class="parts">
        <div class="pg"><h4>Filters</h4><div class="chips">${hasF ? u.filters.map(filterChip).join('') : '<span class="none">None listed</span>'}</div></div>
        <div class="pg"><h4>Belts</h4><div class="chips">${hasB ? u.belts.map(beltChip).join('') : '<span class="none">None / direct drive</span>'}</div></div>
      </div>
      ${schedLine('Filters', lastOf(u, 'filters'), u.filterInterval, hasF)}
      ${schedLine('Belts', lastOf(u, 'belts'), u.beltInterval, hasB)}
      ${u.notes ? `<div class="notes">${esc(u.notes)}</div>` : ''}
      ${priv ? `<div class="actions">
        ${priv && hasF ? `<button class="btn sm" data-act="fdone">✓ Filters changed today</button>` : ''}
        ${priv && hasB ? `<button class="btn sm" data-act="bdone">✓ Belts changed today</button>` : ''}
        <span class="spacer"></span>
        <button class="btn sm" data-act="dup">Duplicate</button>
        <button class="btn sm" data-act="edit">Edit</button>
        <button class="btn sm danger" data-act="del">Delete</button>
      </div>` : ''}
    </article>`;
  }).join('');
}

/* Filter totals: every filter size across all units, plus what's in stock */
function totalsData() {
  const m = new Map();
  S.units.forEach(u => (u.filters || []).forEach(f => {
    const k = fkey(f.size, f.kind);
    const e = m.get(k) || { key: k, size: dispSize(f.size), kind: baseKind(f.kind), use: 0, stock: 0, units: new Set() };
    e.use += +f.qty || 0; e.units.add(u.name); m.set(k, e);
  }));
  S.stock.forEach(s => {
    const k = fkey(s.size, s.kind);
    let e = m.get(k);
    if (!e) { e = { key: k, size: dispSize(s.size), kind: baseKind(s.kind), use: 0, stock: 0, units: new Set(), spare: true }; m.set(k, e); }
    e.stock = +s.qty || 0;
  });
  return [...m.values()].map(e => ({ ...e, order: Math.max(0, e.use - e.stock) })).sort(bySize);
}
function qtyCell(n, kind) { return `${num(n)}${isBag(kind) && n ? `<small>${num(Math.ceil(n / 5))} boxes</small>` : ''}`; }

function renderTotals() {
  const all = totalsData();
  $('#tSizes').textContent = all.length;
  $('#tUse').textContent = num(all.reduce((a, e) => a + e.use, 0));
  $('#tStock').textContent = num(all.reduce((a, e) => a + e.stock, 0));
  $('#tOrder').textContent = num(all.reduce((a, e) => a + e.order, 0));
  const q = $('#tq').value.trim().toLowerCase(), onlyShort = $('#tShort').checked;
  let rows = all;
  if (q) rows = rows.filter(e => (e.size + ' ' + e.kind).toLowerCase().includes(q));
  if (onlyShort) rows = rows.filter(e => e.order > 0);
  const el = $('#totals');
  if (!rows.length) { el.innerHTML = `<div class="empty"><h2>${onlyShort ? 'Nothing short' : 'No matches'}</h2><p>${onlyShort ? 'Stock covers a full change of every filter.' : 'Nothing fits that search.'}</p></div>`; return; }
  el.innerHTML = `<table><thead><tr><th>Size</th><th>Type</th><th class="units-col">Used in</th>
      <th style="text-align:right">Needed</th><th style="text-align:right">In stock</th><th style="text-align:right">To order</th><th></th></tr></thead><tbody>
    ${rows.map(e => `<tr class="${e.spare ? 'stock-only' : ''}" data-key="${esc(e.key)}">
      <td class="mono">${esc(e.size)}</td><td>${esc(e.kind) || '—'}</td>
      <td class="units-col" title="${esc([...e.units].join(', '))}">${e.units.size ? `${e.units.size} unit${e.units.size === 1 ? '' : 's'}<small>${esc([...e.units].slice(0, 6).join(', '))}${e.units.size > 6 ? '…' : ''}</small>` : '—'}</td>
      <td class="num">${qtyCell(e.use, e.kind)}</td>
      <td style="text-align:right">${priv ? `<input class="stock-in" type="number" min="0" inputmode="numeric" value="${e.stock}" data-key="${esc(e.key)}" aria-label="In stock ${esc(e.size)} ${esc(e.kind)}">` : `<b>${num(e.stock)}</b>`}</td>
      <td class="num ${e.order ? 'order-yes' : 'order-no'}">${e.order ? qtyCell(e.order, e.kind) : '✓'}</td>
      <td>${e.spare && priv ? `<button class="btn ghost sm" data-rmstock="${esc(e.key)}" title="Remove">✕</button>` : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;
}
function setStock(key, qty) {
  const e = totalsData().find(x => x.key === key); if (!e) return;
  const s = S.stock.find(x => fkey(x.size, x.kind) === key);
  if (s) s.qty = qty; else S.stock.push({ size: e.size, kind: e.kind, qty });
  persist();
}

/* Parts list: filters + belts for units in scope */
function partsData() {
  const scope = priv ? $('#pScope').value : 'all';
  const sel = S.units.filter(u => {
    if (scope === 'all') return true;
    const d = unitDue(u); if (!d.due) return false;
    return scope === 'overdue' ? d.days < 0 : d.days <= +scope;
  });
  const fm = new Map(), bm = new Map();
  sel.forEach(u => {
    (u.filters || []).forEach(f => {
      const key = fkey(f.size, f.kind);
      const e = fm.get(key) || { size: dispSize(f.size), kind: baseKind(f.kind), qty: 0, units: new Set() };
      e.qty += +f.qty || 0; e.units.add(u.name); fm.set(key, e);
    });
    (u.belts || []).forEach(b => {
      const key = String(b.size || '').trim().toUpperCase();
      const e = bm.get(key) || { size: key, kind: '', qty: 0, units: new Set() };
      e.qty += +b.qty || 0; e.units.add(u.name); bm.set(key, e);
    });
  });
  return { count: sel.length, filters: [...fm.values()].sort(bySize), belts: [...bm.values()].sort(bySize) };
}
function renderParts() {
  const p = partsData(), el = $('#parts');
  if (!p.count) { el.innerHTML = `<div class="empty"><h2>Nothing here</h2><p>No units match this selection. Due-date options need change dates set on units.</p></div>`; return; }
  const tf = p.filters.reduce((a, f) => a + f.qty, 0), tb = p.belts.reduce((a, b) => a + b.qty, 0);
  el.innerHTML = `
    <p class="hint">${p.count} unit${p.count === 1 ? '' : 's'} · ${num(tf)} filters · ${num(tb)} belts</p>
    <h3 class="section-title">Filters</h3>
    ${p.filters.length ? `<table><thead><tr><th>Size</th><th>Type</th><th class="units-col">Used in</th><th style="text-align:right">Qty</th></tr></thead><tbody>
      ${p.filters.map(f => `<tr><td class="mono">${esc(f.size)}</td><td>${esc(f.kind) || '—'}</td><td class="units-col">${[...f.units].map(esc).join(', ')}</td><td class="num">${qtyCell(f.qty, f.kind)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="none">No filters.</p>'}
    <h3 class="section-title">Belts</h3>
    ${p.belts.length ? `<table><thead><tr><th>Belt</th><th class="units-col">Used in</th><th style="text-align:right">Qty</th></tr></thead><tbody>
      ${p.belts.map(b => `<tr><td class="mono">${esc(b.size)}</td><td class="units-col">${[...b.units].map(esc).join(', ')}</td><td class="num">${b.qty}</td></tr>`).join('')}
    </tbody></table>` : '<p class="none">No belts.</p>'}`;
}

/* Notes: cooling / heating */
function renderNotes() {
  document.querySelectorAll('.subtab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.nt === noteTab)));
  $('#noteForm').elements.text.placeholder = `Write a ${NOTE_KINDS[noteTab].toLowerCase()} note…`;
  const q = $('#nq').value.trim().toLowerCase();
  let list = S.notes[noteTab].slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || 0);
  if (q) list = list.filter(n => (n.text + ' ' + (n.unit || '')).toLowerCase().includes(q));
  const el = $('#notesList');
  if (!list.length) { el.innerHTML = `<div class="empty"><h2>${q ? 'No matches' : `No ${NOTE_KINDS[noteTab].toLowerCase()} notes yet`}</h2><p>${q ? 'Nothing fits that search.' : 'Add one above.'}</p></div>`; return; }
  el.innerHTML = list.map(n => `<article class="note ${noteTab}" data-nid="${esc(n.id)}">
    <div class="note-head">
      <span>${niceD(parseD(n.date))}</span>
      ${n.unit ? `<span class="chip">${esc(n.unit)}</span>` : ''}
      <span class="spacer"></span>
      ${priv ? `<button class="btn sm" data-nact="edit">Edit</button>
      <button class="btn sm danger" data-nact="del">Delete</button>` : ''}
    </div>
    <div class="note-text">${esc(n.text)}</div>
  </article>`).join('');
}

/* ---------- modal ---------- */
const modal = $('#modal');
function openModal(html, narrow) { modal.innerHTML = `<div class="dialog${narrow ? ' narrow' : ''}">${html}</div>`; modal.classList.add('open'); const f = modal.querySelector('[autofocus]'); if (f) f.focus(); }
function closeModal() { modal.classList.remove('open'); modal.innerHTML = ''; }
modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(); });

function confirmBox(title, msg, okLabel, onOk) {
  openModal(`<div class="dhead"><h2>${esc(title)}</h2></div><div class="dbody">${msg}</div>
    <div class="dfoot"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="ok" autofocus>${esc(okLabel)}</button></div>`, true);
  modal.querySelector('[data-m=cancel]').onclick = closeModal;
  modal.querySelector('[data-m=ok]').onclick = () => { closeModal(); onOk(); };
}

function filterRow(f = {}) {
  return `<div class="row filter">
  <div class="f"><label>Size (W×H×D)</label><input type="text" name="fsize" value="${esc(f.size)}" placeholder="20x25x2"></div>
  <div class="f"><label>Qty</label><input type="number" min="1" name="fqty" value="${esc(f.qty || 1)}"></div>
  <div class="f"><label>MERV</label><input type="text" name="fmerv" value="${esc(f.merv)}" placeholder="8"></div>
  <div class="f"><label>Type</label><input type="text" class="note-in" name="fkind" value="${esc(f.kind)}" placeholder="Pleated, poly, bag…" list="kindList"></div>
  <button type="button" class="btn ghost rm" data-rm title="Remove">✕</button></div>`;
}
function beltRow(b = {}) {
  return `<div class="row belt">
  <div class="f"><label>Belt size / part #</label><input type="text" name="bsize" value="${esc(b.size)}" placeholder="B52 or 4L520"></div>
  <div class="f"><label>Qty</label><input type="number" min="1" name="bqty" value="${esc(b.qty || 1)}"></div>
  <div class="f"><label>Note</label><input type="text" class="note-in" name="bnote" value="${esc(b.note)}" placeholder="Supply fan, matched set…"></div>
  <button type="button" class="btn ghost rm" data-rm title="Remove">✕</button></div>`;
}

function editUnit(id, copyFrom) {
  const src = id ? S.units.find(u => u.id === id) : copyFrom;
  const u = src ? JSON.parse(JSON.stringify(src)) : { type: 'RTU', filters: [{}], belts: [], filterInterval: 3, beltInterval: 12 };
  if (copyFrom) u.name = (u.name || '') + ' (copy)';
  openModal(`
    <form id="uform" novalidate>
      <div class="dhead"><h2>${id ? 'Edit unit' : 'Add unit'}</h2><button type="button" class="btn ghost" data-m="cancel">✕</button></div>
      <div class="dbody">
        <div class="grid">
          <div class="f c2"><label>Unit name / tag *</label><input type="text" name="name" value="${esc(u.name)}" placeholder="RTU-3" autofocus></div>
          <div class="f c2"><label>Type</label><select name="type">${TYPES.map(t => `<option value="${t}"${u.type === t ? ' selected' : ''}>${typeLabel(t)}</option>`).join('')}</select></div>
          <div class="f c2"><label>Location</label><input type="text" name="location" value="${esc(u.location)}" placeholder="Roof, Mezzanine…"></div>
          <div class="f c2"><label>Make</label><input type="text" name="make" value="${esc(u.make)}" placeholder="Carrier, Trane…"></div>
          <div class="f c2"><label>Model #</label><input type="text" name="model" value="${esc(u.model)}"></div>
          <div class="f c2"><label>Cooling capacity (%)</label><input type="text" name="cooling" list="coolList" value="${esc(u.cooling ?? '')}" placeholder="100, 50, 0, N/A…"></div>
        </div>
        <fieldset><legend>Filters</legend>
          <div class="rows" id="frows">${(u.filters || []).map(filterRow).join('')}</div>
          <button type="button" class="btn sm" id="addF">+ Add filter size</button>
          <div class="grid" style="margin-top:12px">
            <div class="f c3"><label>Change every (months)</label><input type="number" min="0" step="0.5" name="filterInterval" value="${esc(u.filterInterval)}"></div>
            <div class="f c3 priv-only"><label>🔒 Last changed (private)</label><input type="date" name="filterLast" value="${esc(id ? lastOf(u, 'filters') : '')}"></div>
          </div>
        </fieldset>
        <fieldset><legend>Belts</legend>
          <div class="rows" id="brows">${(u.belts || []).map(beltRow).join('')}</div>
          <button type="button" class="btn sm" id="addB">+ Add belt</button>
          <div class="grid" style="margin-top:12px">
            <div class="f c3"><label>Change every (months)</label><input type="number" min="0" step="0.5" name="beltInterval" value="${esc(u.beltInterval)}"></div>
            <div class="f c3 priv-only"><label>🔒 Last changed (private)</label><input type="date" name="beltLast" value="${esc(id ? lastOf(u, 'belts') : '')}"></div>
          </div>
          <p class="hint">Leave belts empty for direct-drive units.</p>
        </fieldset>
        <div class="f" style="margin-top:14px"><label>Notes</label><textarea name="notes" rows="2" placeholder="Access, ladder needed, filter rack quirks…">${esc(u.notes)}</textarea></div>
        <div class="err" id="ferr"></div>
      </div>
      <div class="dfoot"><button type="button" class="btn" data-m="cancel">Cancel</button><button type="submit" class="btn primary">${id ? 'Save changes' : 'Add unit'}</button></div>
    </form>`);
  const form = $('#uform');
  form.querySelectorAll('[data-m=cancel]').forEach(b => b.onclick = closeModal);
  $('#addF').onclick = () => { $('#frows').insertAdjacentHTML('beforeend', filterRow()); $('#frows').lastElementChild.querySelector('input').focus(); };
  $('#addB').onclick = () => { $('#brows').insertAdjacentHTML('beforeend', beltRow()); $('#brows').lastElementChild.querySelector('input').focus(); };
  form.addEventListener('click', e => { if (e.target.closest('[data-rm]')) e.target.closest('.row').remove(); });
  form.onsubmit = e => {
    e.preventDefault();
    const v = n => form.elements[n].value.trim();
    if (!v('name')) { $('#ferr').textContent = 'Give the unit a name or tag.'; form.elements.name.focus(); return; }
    let cooling = v('cooling').replace('%', '').trim();
    if (/^n\/?a$/i.test(cooling)) cooling = 'N/A';
    else if (cooling !== '') { if (isNaN(+cooling) || +cooling < 0 || +cooling > 100) { $('#ferr').textContent = 'Cooling capacity should be 0–100, or N/A.'; form.elements.cooling.focus(); return; } cooling = +cooling; }
    const filters = [...form.querySelectorAll('.row.filter')].map(r => ({
      size: r.querySelector('[name=fsize]').value.trim().replace(/\s*[xX×*]\s*/g, 'x'),
      qty: Math.max(1, +r.querySelector('[name=fqty]').value || 1),
      merv: r.querySelector('[name=fmerv]').value.trim(), kind: r.querySelector('[name=fkind]').value.trim()
    })).filter(f => f.size);
    const belts = [...form.querySelectorAll('.row.belt')].map(r => ({
      size: r.querySelector('[name=bsize]').value.trim().toUpperCase(),
      qty: Math.max(1, +r.querySelector('[name=bqty]').value || 1), note: r.querySelector('[name=bnote]').value.trim()
    })).filter(b => b.size);
    const rec = {
      id: id || uid(), name: v('name'), type: v('type'), location: v('location'), make: v('make'), model: v('model'),
      filters, belts, filterInterval: v('filterInterval'), beltInterval: v('beltInterval'), cooling, notes: form.elements.notes.value.trim()
    };
    if (id) S.units = S.units.map(x => x.id === id ? rec : x); else S.units.push(rec);
    if (priv) {
      const fl = v('filterLast'), bl = v('beltLast');
      if (fl && fl !== lastOf(rec, 'filters') && filters.length) addHistory(rec, 'filters', fl);
      if (bl && bl !== lastOf(rec, 'belts') && belts.length) addHistory(rec, 'belts', bl);
    }
    closeModal(); render(); persist();
  };
}

function editNote(nid) {
  const n = S.notes[noteTab].find(x => x.id === nid); if (!n) return;
  openModal(`<form id="nform">
    <div class="dhead"><h2>Edit ${NOTE_KINDS[noteTab].toLowerCase()} note</h2><button type="button" class="btn ghost" data-m="cancel">✕</button></div>
    <div class="dbody">
      <div class="f"><label>Note</label><textarea name="text" rows="5" autofocus>${esc(n.text)}</textarea></div>
      <div class="grid" style="margin-top:10px">
        <div class="f c3"><label>Unit (optional)</label><input type="text" name="unit" list="unitList" value="${esc(n.unit)}"></div>
        <div class="f c3"><label>Date</label><input type="date" name="date" value="${esc(n.date)}"></div>
      </div>
    </div>
    <div class="dfoot"><button type="button" class="btn" data-m="cancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
  const f = $('#nform');
  f.querySelectorAll('[data-m=cancel]').forEach(b => b.onclick = closeModal);
  f.onsubmit = e => {
    e.preventDefault();
    const text = f.elements.text.value.trim(); if (!text) return;
    n.text = text; n.unit = f.elements.unit.value.trim(); n.date = f.elements.date.value || n.date;
    closeModal(); render(); persist();
  };
}

function backupBox() {
  openModal(`<div class="dhead"><h2>Backup / restore</h2><button class="btn ghost" data-m="cancel">✕</button></div>
    <div class="dbody">
      <p class="hint" style="margin-top:0">Copy this text somewhere safe as a backup — it has every unit, stock count and note. To restore, paste a backup in and press Restore. It replaces everything.</p>
      <textarea id="bk" rows="12" style="font-family:var(--mono);font-size:12px">${esc(JSON.stringify(S, null, 2))}</textarea>
      <div class="err" id="bkerr"></div>
    </div>
    <div class="dfoot"><button class="btn" id="bkCopy">Copy</button><button class="btn danger" id="bkRestore">Restore from text</button></div>`);
  modal.querySelector('[data-m=cancel]').onclick = closeModal;
  $('#bkCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#bk').value); $('#bkCopy').textContent = 'Copied ✓'; } catch (e) { $('#bk').select(); $('#bkerr').textContent = 'Copy blocked — the text is selected, press Ctrl/Cmd+C.'; } };
  $('#bkRestore').onclick = () => {
    let data; try { data = JSON.parse($('#bk').value); } catch (e) { $('#bkerr').textContent = 'That text isn’t a valid backup.'; return; }
    const d = normalize(data);
    d.units = d.units.filter(u => u && u.name).map(u => ({ ...u, id: u.id || uid(), filters: u.filters || [], belts: u.belts || [] }));
    S = d; closeModal(); render(); persist();
  };
}

async function copyText(btn, txt, label) {
  try { await navigator.clipboard.writeText(txt); btn.textContent = 'Copied ✓'; } catch (e) { btn.textContent = 'Copy blocked'; }
  setTimeout(() => btn.textContent = label, 1600);
}

/* ---------- events ---------- */
$('#list').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'add') return editUnit();
  const id = btn.closest('.unit').dataset.id, u = S.units.find(x => x.id === id);
  if (act === 'edit') editUnit(id);
  else if (act === 'dup') editUnit(null, u);
  else if (act === 'fdone') addHistory(u, 'filters', fmtD(today()));
  else if (act === 'bdone') addHistory(u, 'belts', fmtD(today()));
  else if (act === 'del') confirmBox('Delete unit?', `<p style="margin:0">Remove <b>${esc(u.name)}</b> and its filter and belt info?</p>`, 'Delete', () => { S.units = S.units.filter(x => x.id !== id); render(); persist(); });
});
$('#addBtn').onclick = () => editUnit();
['q', 'fType', 'fStatus', 'fCool', 'sort', 'pScope', 'tq', 'tShort', 'nq', 'hq', 'hPart'].forEach(i => $('#' + i).addEventListener('input', render));
$('#backupBtn').onclick = backupBox;

$('#totals').addEventListener('change', e => {
  const inp = e.target.closest('.stock-in'); if (!inp) return;
  setStock(inp.dataset.key, Math.max(0, Math.round(+inp.value || 0)));
  setTimeout(() => {   // re-render without losing the field the user tabbed to
    const a = document.activeElement, k = a && a.classList.contains('stock-in') ? a.dataset.key : null;
    render();
    if (k) { const n = document.querySelector(`.stock-in[data-key="${CSS.escape(k)}"]`); if (n) { n.focus(); n.select(); } }
  }, 0);
});
$('#totals').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('stock-in')) e.target.blur(); });
$('#totals').addEventListener('click', e => {
  const b = e.target.closest('[data-rmstock]'); if (!b) return;
  S.stock = S.stock.filter(s => fkey(s.size, s.kind) !== b.dataset.rmstock); render(); persist();
});
$('#addStock').onsubmit = e => {
  e.preventDefault();
  const f = e.target, size = dispSize(f.elements.size.value), kind = f.elements.kind.value.trim() || 'Pleated';
  if (!size) return;
  const k = fkey(size, kind), qty = Math.max(0, Math.round(+f.elements.qty.value || 0));
  const s = S.stock.find(x => fkey(x.size, x.kind) === k);
  if (s) s.qty = qty; else S.stock.push({ size, kind, qty });
  f.reset(); f.elements.kind.value = 'Pleated'; render(); persist();
};
$('#copyOrder').onclick = () => {
  const rows = totalsData().filter(e => e.order > 0);
  const txt = rows.length ? ['FILTERS TO ORDER', ...rows.map(e => `${e.order}  ${e.size}  ${e.kind}${isBag(e.kind) ? `  (${Math.ceil(e.order / 5)} boxes)` : ''}`)].join('\n') : 'Nothing to order — stock covers a full change.';
  copyText($('#copyOrder'), txt, 'Copy order list');
};
$('#copyParts').onclick = () => {
  const p = partsData();
  const txt = ['FILTERS', ...p.filters.map(f => `${f.qty}  ${f.size}  ${f.kind}`), '', 'BELTS', ...p.belts.map(b => `${b.qty}  ${b.size}`)].join('\n');
  copyText($('#copyParts'), txt, 'Copy list');
};

$('#noteForm').onsubmit = e => {
  e.preventDefault();
  const f = e.target, text = f.elements.text.value.trim(); if (!text) return;
  S.notes[noteTab].push({ id: uid(), date: fmtD(today()), unit: f.elements.unit.value.trim(), text });
  f.elements.text.value = ''; f.elements.unit.value = ''; render(); persist();
};
$('#notesList').addEventListener('click', e => {
  const b = e.target.closest('[data-nact]'); if (!b) return;
  const nid = b.closest('.note').dataset.nid;
  if (b.dataset.nact === 'edit') editNote(nid);
  else confirmBox('Delete note?', '<p style="margin:0">This note will be removed.</p>', 'Delete', () => { S.notes[noteTab] = S.notes[noteTab].filter(n => n.id !== nid); render(); persist(); });
});
document.querySelectorAll('.subtab').forEach(t => t.onclick = () => go('notes-' + t.dataset.nt));

$('#history').addEventListener('click', e => {
  const b = e.target.closest('[data-hdel]'); if (!b) return;
  confirmBox('Delete history entry?', '<p style="margin:0">This removes that change from the history. The unit’s next-due date will be worked out from the remaining entries.</p>', 'Delete', () => deleteHistory(b.dataset.hdel));
});

/* tabs, with #units / #totals / #parts / #notes-cooling / #notes-heating links */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => go(t.dataset.view === 'notes' ? 'notes-' + noteTab : t.dataset.view));
document.querySelectorAll('.stat').forEach(s => s.onclick = () => {
  const k = s.dataset.stat;
  $('#fStatus').value = (k === 'overdue' || k === 'soon') ? k : '';
  $('#q').value = ''; $('#fType').value = ''; $('#fCool').value = '';
  if (k === 'cool') { $('#fCool').value = 'set'; $('#sort').value = 'cool'; }
  go('units');
});
function go(name) { if (location.hash.slice(1) === name) route(); else location.hash = name; }
function route() {
  const h = location.hash.slice(1);
  if (h === 'notes-cooling' || h === 'notes-heating') { view = 'notes'; noteTab = h.slice(6); }
  else if (h === 'notes') view = 'notes';
  else if (h === 'history' && priv) view = 'history';
  else view = ['units', 'totals', 'parts'].includes(h) ? h : 'units';
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  ['units', 'totals', 'parts', 'notes', 'history'].forEach(v => { $('#view-' + v).hidden = v !== view; });
  render();
}
window.addEventListener('hashchange', route);

$('#fType').innerHTML += TYPES.map(t => `<option value="${t}">${typeLabel(t)}</option>`).join('');
route();
initStorage();
})();
