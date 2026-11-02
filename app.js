/* Filter & Belt Tracker — app code. Data lives in data.js (window.TRACKER_DATA). */
(function () {
'use strict';

const LS_KEY = 'filter-belt-tracker-v2';
const TYPES = ['ASH', 'AHU', 'RTU', 'MAU', 'King Heater', 'Other'];
const TYPE_NAMES = { ASH: 'Ash house', AHU: 'Air handler', RTU: 'Rooftop unit', MAU: 'Make-up air', 'King Heater': 'King Heater', Other: 'Other' };
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
  return { units: arr(d.units), stock: arr(d.stock), beltStock: arr(d.beltStock), notes: { cooling: arr(n.cooling), heating: arr(n.heating) } };
}
/* PUBLIC: set when data.js was made with "Copy for GitHub". That copy has no change
   dates in it, and the site runs view-only: no editing, nothing saved. */
const PUBLIC = !!(window.TRACKER_DATA && window.TRACKER_DATA.public);
const EXPORTED_AT = (window.TRACKER_DATA && window.TRACKER_DATA.exportedAt) || '';
let S = normalize(window.TRACKER_DATA);

let mode = 'local', artifactApi = null, readOnly = false, saveTimer = null;
let view = 'units', noteTab = 'cooling';
let selectMode = false, selected = new Set(), lastShown = [], toastTimer = null;

function lastOf(u, part) { return (part === 'belts' ? u.beltLast : u.filterLast) || ''; }
/* Mark filters or belts changed on one or more units. Takes the parts out of stock
   (never below 0) and offers Undo. Units already marked this month are skipped so a
   double-click can't take stock twice. */
function markChanged(list, part, date) {
  const field = part === 'belts' ? 'beltLast' : 'filterLast';
  const items = list.filter(u => (part === 'belts' ? u.belts : u.filters || []).length);
  const todo = items.filter(u => monthIdx(u[field]) !== monthIdx(date)), skipped = items.length - todo.length;
  if (!todo.length) { toast(skipped ? `Already marked ${part} changed this month.` : `No ${part} listed on ${list.length === 1 ? 'that unit' : 'those units'}.`); return; }
  const snap = JSON.stringify({ stock: S.stock, beltStock: S.beltStock, dates: todo.map(u => [u.id, u[field]]) });
  let taken = 0; const short = new Set();
  todo.forEach(u => {
    u[field] = date;
    if (part === 'belts') u.belts.forEach(b => {
      const k = bkey(b.size); let st = S.beltStock.find(x => bkey(x.size) === k);
      if (!st) { st = { size: k, qty: 0 }; S.beltStock.push(st); }
      const q = +b.qty || 0; if (st.qty < q) short.add(k); st.qty = Math.max(0, (+st.qty || 0) - q); taken += q;
    });
    else u.filters.forEach(f => {
      const k = fkey(f.size, f.kind); let st = S.stock.find(x => fkey(x.size, x.kind) === k);
      if (!st) { st = { size: dispSize(f.size), kind: baseKind(f.kind), qty: 0 }; S.stock.push(st); }
      const q = +f.qty || 0; if (st.qty < q) short.add(dispSize(f.size) + ' ' + baseKind(f.kind)); st.qty = Math.max(0, (+st.qty || 0) - q); taken += q;
    });
  });
  render(); persist();
  const who = todo.length === 1 ? todo[0].name : `${todo.length} units`;
  let msg = `${who}: ${part} marked changed. ${num(taken)} ${part === 'belts' ? 'belt' : 'filter'}${taken === 1 ? '' : 's'} taken out of stock.`;
  if (skipped) msg += ` ${skipped} already done this month.`;
  if (short.size) msg += ` Not enough in stock for: ${[...short].slice(0, 4).join(', ')}${short.size > 4 ? '…' : ''}.`;
  toast(msg, () => {
    const o = JSON.parse(snap); S.stock = o.stock; S.beltStock = o.beltStock;
    o.dates.forEach(([id, v]) => { const u = S.units.find(x => x.id === id); if (u) u[field] = v; });
    render(); persist(); toast('Undone.');
  });
}
function toast(msg, undo) {
  const t = $('#toast'); clearTimeout(toastTimer);
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="btn sm" id="toastUndo">Undo</button>' : ''}<button class="btn ghost sm" id="toastX" title="Close">✕</button>`;
  t.hidden = false;
  if (undo) $('#toastUndo').onclick = () => { t.hidden = true; undo(); };
  $('#toastX').onclick = () => { t.hidden = true; };
  toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 12000 : 4000);
}

/* ---------- dates ---------- */
function parseD(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function fmtD(d) { return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : ''; }
function niceD(d) { return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function today() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
/* Change dates are kept as month + year ("2026-11"). Older full dates still read fine. */
function monthIdx(s) { const m = /^(\d{4})-(\d{2})/.exec(s || ''); return m ? +m[1] * 12 + (+m[2] - 1) : null; }
function thisMonth() { const t = new Date(); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); }
function fmtMonth(idx) { return idx == null ? '—' : new Date(Math.floor(idx / 12), idx % 12, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); }
function niceMonth(s) { return fmtMonth(monthIdx(s)); }

/* due = the month it should be changed. "soon" = due this month.
   Overdue only once a full month has passed after the due month. */
function dueInfo(last, months) {
  const l = monthIdx(last), m = Math.round(Number(months));
  if (l == null || !m) return { status: 'unknown', due: null, late: null };
  const due = l + m, late = monthIdx(thisMonth()) - due;
  return { status: late >= 1 ? 'overdue' : late === 0 ? 'soon' : 'ok', due, late };
}
function unitDue(u) {
  if (PUBLIC) return { status: 'none', due: null, late: null };
  const items = [];
  if ((u.filters || []).length) items.push(dueInfo(lastOf(u, 'filters'), u.filterInterval));
  if ((u.belts || []).length) items.push(dueInfo(lastOf(u, 'belts'), u.beltInterval));
  const known = items.filter(i => i.due != null).sort((a, b) => a.due - b.due);
  return known[0] || { status: 'unknown', due: null, days: null };
}
function relText(i) {
  if (i.due == null) return 'No date set';
  if (i.late >= 1) return `Overdue · was due ${fmtMonth(i.due)}`;
  if (i.late === 0) return 'Due this month';
  if (i.late === -1) return 'Due next month';
  return `Due ${fmtMonth(i.due)}`;
}

/* ---------- saving ---------- */
function lsGet() { try { const v = localStorage.getItem(LS_KEY) || localStorage.getItem('filter-belt-tracker-v1'); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function lsSet() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
function setStatus(text, cls) { $('#saveText').textContent = text; $('#save').className = 'save' + (cls ? ' ' + cls : ''); }

function dataJs() {
  return '/* Filter & Belt Tracker data. The page rewrites this file when you save. */\n' +
    'window.TRACKER_DATA = ' + JSON.stringify(S, null, 1).replace(/</g, '\\u003c') + ';\n';
}
function publicDataJs() {
  const pub = { public: true, exportedAt: new Date().toISOString(),
    units: S.units.map(({ filterLast, beltLast, ...u }) => u), stock: S.stock, beltStock: S.beltStock, notes: S.notes };
  return '/* Filter & Belt Tracker: public copy for GitHub. View-only, with no change dates.\n   Made with "Copy for GitHub" on ' + new Date().toLocaleString() + ' */\n' +
    'window.TRACKER_DATA = ' + JSON.stringify(pub, null, 1).replace(/</g, '\\u003c') + ';\n';
}
function githubBox() {
  const txt = publicDataJs();
  openModal(`<div class="dhead"><h2>Copy for GitHub</h2><button class="btn ghost" data-m="cancel">✕</button></div>
    <div class="dbody">
      <p style="margin-top:0">This is your <b>data.js</b> for the public GitHub site. It has <b>no change dates</b>, and it turns the site view-only for everyone who opens it.</p>
      <ol class="steps">
        <li>Press <b>Copy</b>.</li>
        <li>On GitHub, open <b>data.js</b> in your repository and click the pencil icon (Edit).</li>
        <li>Select everything in the file, delete it, and paste.</li>
        <li>Click <b>Commit changes</b>. The site updates in a minute or two.</li>
      </ol>
      <textarea id="ghTxt" rows="8" readonly style="font-family:var(--mono);font-size:12px">${esc(txt)}</textarea>
      <div class="err" id="ghErr"></div>
    </div>
    <div class="dfoot"><button class="btn" data-m="cancel">Close</button><button class="btn primary" id="ghCopy">Copy</button></div>`);
  modal.querySelectorAll('[data-m=cancel]').forEach(b => b.onclick = closeModal);
  $('#ghCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#ghTxt').value); $('#ghCopy').textContent = 'Copied ✓'; }
    catch (e) { $('#ghTxt').select(); $('#ghErr').textContent = 'Copy blocked — the text is selected, press Ctrl/Cmd+C.'; }
  };
}
function persist() {
  if (PUBLIC) return;
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
  if (PUBLIC) { setStatus(EXPORTED_AT ? 'Updated ' + niceD(new Date(EXPORTED_AT)) : 'View only'); return; }
  try { if (window.claude && typeof window.claude.use === 'function') artifactApi = await window.claude.use('artifact'); } catch (e) { artifactApi = null; }
  if (artifactApi) { mode = 'shared'; setStatus('All changes saved'); return; }
  mode = 'local';
  const saved = lsGet();
  if (saved) { S = normalize(saved); render(); }
  setStatus('Saved in this browser');
}

/* ---------- helpers ---------- */
function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s*[x×*]\s*/g, 'x').replace(/\s+/g, ''); }
function dispSize(s) { return /^\s*\d/.test(s || '') ? norm(s) : String(s || '').trim(); }
function bkey(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ''); }
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
const PLATE = [['serial', 'Serial'], ['coolingSize', 'Cooling size'], ['heatingInput', 'Heating input'],
  ['refrigerant', 'Refrigerant'], ['refCharge', 'Refrigerant charge'], ['mfgDate', 'Manufactured']];
function plateBlock(u) {
  const rows = [['Make', u.make], ['Model', u.model], ...PLATE.map(([k, l]) => [l, u[k]])].filter(([, v]) => v);
  if (!PLATE.some(([k]) => u[k])) return '';
  return `<details class="plate"><summary>Data plate</summary><dl>${rows.map(([l, v]) => `<dt>${esc(l)}</dt><dd${/^(Model|Serial)$/.test(l) ? ' class="mono"' : ''}>${esc(v)}</dd>`).join('')}</dl></details>`;
}
function filterChip(f) {
  const extra = [f.merv ? 'MERV ' + f.merv : '', f.kind].filter(Boolean).join(' · ');
  return `<span class="chip">${esc(f.size || '?')} ×${esc(f.qty || 1)}${extra ? `<small>${esc(extra)}</small>` : ''}</span>`;
}
function beltChip(b) { return `<span class="chip">${esc(b.size || '?')} ×${esc(b.qty || 1)}${b.note ? `<small>${esc(b.note)}</small>` : ''}</span>`; }
function schedLine(label, last, months, has) {
  if (!has) return '';
  if (PUBLIC) return months ? `<div class="sched"><b>${label}:</b> changed every ${esc(months)} mo</div>` : '';
  const i = dueInfo(last, months), parts = [`<b>${label}:</b>`];
  parts.push(last ? 'last ' + niceMonth(last) : 'no last-change date');
  if (months) parts.push(`every ${esc(months)} mo`);
  if (i.due != null) parts.push(`next <b>${fmtMonth(i.due)}</b> <span class="pill p-${i.status}">${relText(i)}</span>`);
  return `<div class="sched">${parts.join(' · ')}</div>`;
}
function searchText(u) {
  const cv = coolVal(u);
  return [cv === null ? '' : 'cooling ' + cv + (cv === 'N/A' ? '' : '%'), u.route, u.name, u.type, TYPE_NAMES[u.type], u.location, u.make, u.model, u.notes,
    u.serial, u.refrigerant, u.coolingSize,
    ...(u.filters || []).flatMap(f => [f.size, f.kind, f.merv && ('merv ' + f.merv)]),
    ...(u.belts || []).flatMap(b => [b.size, b.note])].join(' ').toLowerCase();
}

/* ---------- render ---------- */
function render() {
  const ds = S.units.map(unitDue);
  $('#stUnits').textContent = S.units.length;
  $('#stOver').textContent = ds.filter(d => d.status === 'overdue').length;
  $('#stSoon').textContent = ds.filter(d => d.status === 'soon').length;
  $('#stBelts').textContent = num(S.units.reduce((n, u) => n + (u.belts || []).reduce((a, b) => a + (+b.qty || 0), 0), 0));
  const cvs = S.units.filter(u => u.type === 'ASH').map(coolVal).filter(v => typeof v === 'number');
  $('#stCool').textContent = cvs.length ? Math.round(cvs.reduce((a, v) => a + v, 0) / cvs.length) + '%' : '—';
  $('#stFilters').textContent = num(S.units.reduce((n, u) => n + (u.filters || []).reduce((a, f) => a + (+f.qty || 0), 0), 0));
  const routes = [...new Set(S.units.map(u => u.route).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  $('#routeList').innerHTML = routes.map(r => `<option value="${esc(r)}">`).join('');
  const fr = $('#fRoute'), cur = fr.value;
  fr.innerHTML = '<option value="">All routes / groups</option>' + routes.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  fr.value = routes.includes(cur) ? cur : '';
  ({ units: renderUnits, totals: renderTotals, belts: renderBeltTotals, parts: renderParts, notes: renderNotes })[view]();
}

function renderUnits() {
  const q = $('#q').value.trim().toLowerCase();
  const ft = $('#fType').value, fs = PUBLIC ? '' : $('#fStatus').value, fc = $('#fCool').value, fr = $('#fRoute').value;
  let sort = $('#sort').value; if (PUBLIC && sort === 'due') sort = 'name';
  let rows = S.units.map(u => ({ u, d: unitDue(u) }));
  if (q) rows = rows.filter(r => q.split(/\s+/).every(t => searchText(r.u).includes(t)));
  if (ft) rows = rows.filter(r => r.u.type === ft);
  if (fr) rows = rows.filter(r => r.u.route === fr);
  if (fs) rows = rows.filter(r => r.d.status === fs);
  if (fc) rows = rows.filter(r => { const v = coolVal(r.u);
    return fc === 'set' ? v !== null : fc === 'na' ? v === 'N/A' : typeof v === 'number' && (fc === 'full' ? v >= 100 : fc === 'none' ? v <= 0 : v > 0 && v < 100); });
  const byName = (a, b) => String(a.u.name).localeCompare(String(b.u.name), undefined, { numeric: true });
  if (sort === 'name') rows.sort(byName);
  else if (sort === 'route') rows.sort((a, b) => String(a.u.route || '~').localeCompare(String(b.u.route || '~'), undefined, { numeric: true }) || byName(a, b));
  else if (sort === 'loc') rows.sort((a, b) => String(a.u.location || '').localeCompare(String(b.u.location || ''), undefined, { numeric: true }) || byName(a, b));
  else if (sort === 'cool') { const cv = r => { const v = coolVal(r.u); return typeof v === 'number' ? v : v === 'N/A' ? 1000 : 2000; }; rows.sort((a, b) => cv(a) - cv(b) || byName(a, b)); }
  else rows.sort((a, b) => (a.d.due ?? Infinity) - (b.d.due ?? Infinity) || byName(a, b));

  lastShown = rows.map(r => r.u.id);
  updateBulkBar();
  const list = $('#list');
  list.classList.toggle('selecting', selectMode);
  if (!S.units.length) { list.innerHTML = `<div class="empty"><h2>No units yet</h2><p><button class="btn primary" data-act="add">+ Add unit</button></p></div>`; return; }
  if (!rows.length) { list.innerHTML = `<div class="empty"><h2>No matches</h2><p>Nothing fits that search or filter.</p></div>`; return; }

  list.innerHTML = rows.map(({ u, d }) => {
    const meta = [u.route, u.location, [u.make, u.model].filter(Boolean).join(' ')].filter(Boolean).map(esc).join(' · ');
    const hasF = (u.filters || []).length, hasB = (u.belts || []).length;
    const picked = selectMode && selected.has(u.id);
    return `<article class="unit s-${d.status}${picked ? ' picked' : ''}" data-id="${esc(u.id)}">
      <div class="uhead">
        <div>
          <div class="uname">${selectMode ? `<input type="checkbox" class="pick" ${picked ? 'checked' : ''} aria-label="Select ${esc(u.name)}">` : ''}<span class="badge" title="${esc(TYPE_NAMES[u.type] || u.type)}">${esc(u.type || 'Other')}</span><h3>${esc(u.name)}</h3></div>
          ${meta ? `<div class="meta">${meta}</div>` : ''}
          ${coolLine(u)}
        </div>
        ${PUBLIC ? '' : (() => { const lc = [lastOf(u, 'filters'), lastOf(u, 'belts')].filter(Boolean).sort().pop();
          return d.due == null && lc ? `<span class="pill p-unknown">Last changed ${niceMonth(lc)}</span>` : `<span class="pill p-${d.status}">${relText(d)}</span>`; })()}
      </div>
      <div class="parts">
        <div class="pg"><h4>Filters</h4><div class="chips">${hasF ? u.filters.map(filterChip).join('') : '<span class="none">None listed</span>'}</div></div>
        <div class="pg"><h4>Belts</h4><div class="chips">${hasB ? u.belts.map(beltChip).join('') : '<span class="none">None / direct drive</span>'}</div></div>
      </div>
      ${schedLine('Filters', lastOf(u, 'filters'), u.filterInterval, hasF)}
      ${schedLine('Belts', lastOf(u, 'belts'), u.beltInterval, hasB)}
      ${plateBlock(u)}
      ${u.notes ? `<div class="notes">${esc(u.notes)}</div>` : ''}
      ${selectMode || PUBLIC ? '' : `<div class="actions">
        ${hasF ? `<button class="btn sm" data-act="fdone">✓ Filters changed this month</button>` : ''}
        ${hasB ? `<button class="btn sm" data-act="bdone">✓ Belts changed this month</button>` : ''}
        <span class="spacer"></span>
        <button class="btn sm" data-act="dup">Duplicate</button>
        <button class="btn sm" data-act="edit">Edit</button>
        <button class="btn sm danger" data-act="del">Delete</button>
      </div>`}
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
      <td style="text-align:right">${PUBLIC ? `<b>${num(e.stock)}</b>` : `<input class="stock-in" type="number" min="0" inputmode="numeric" value="${e.stock}" data-key="${esc(e.key)}" aria-label="In stock ${esc(e.size)} ${esc(e.kind)}">`}</td>
      <td class="num ${e.order ? 'order-yes' : 'order-no'}">${e.order ? qtyCell(e.order, e.kind) : '✓'}</td>
      <td>${e.spare && !PUBLIC ? `<button class="btn ghost sm" data-rmstock="${esc(e.key)}" title="Remove">✕</button>` : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;
}
function setStock(key, qty) {
  const e = totalsData().find(x => x.key === key); if (!e) return;
  const s = S.stock.find(x => fkey(x.size, x.kind) === key);
  if (s) s.qty = qty; else S.stock.push({ size: e.size, kind: e.kind, qty });
  persist();
}

/* Belt totals: same as filter totals, keyed by belt size */
function beltTotalsData() {
  const m = new Map();
  S.units.forEach(u => (u.belts || []).forEach(b => {
    const k = bkey(b.size); if (!k) return;
    const e = m.get(k) || { key: k, size: k, use: 0, stock: 0, units: new Set() };
    e.use += +b.qty || 0; e.units.add(u.name); m.set(k, e);
  }));
  S.beltStock.forEach(st => {
    const k = bkey(st.size); if (!k) return;
    let e = m.get(k);
    if (!e) { e = { key: k, size: k, use: 0, stock: 0, units: new Set(), spare: true }; m.set(k, e); }
    e.stock = +st.qty || 0;
  });
  return [...m.values()].map(e => ({ ...e, order: Math.max(0, e.use - e.stock) }))
    .sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));
}
function renderBeltTotals() {
  const all = beltTotalsData();
  $('#bSizes').textContent = all.length;
  $('#bUse').textContent = num(all.reduce((a, e) => a + e.use, 0));
  $('#bStock').textContent = num(all.reduce((a, e) => a + e.stock, 0));
  $('#bOrder').textContent = num(all.reduce((a, e) => a + e.order, 0));
  const q = $('#bq').value.trim().toLowerCase(), onlyShort = $('#bShort').checked;
  let rows = all;
  if (q) rows = rows.filter(e => (e.size + ' ' + [...e.units].join(' ')).toLowerCase().includes(q));
  if (onlyShort) rows = rows.filter(e => e.order > 0);
  const el = $('#btotals');
  if (!rows.length) { el.innerHTML = `<div class="empty"><h2>${onlyShort ? 'Nothing short' : 'No matches'}</h2><p>${onlyShort ? 'Stock covers a full change of every belt.' : 'Nothing fits that search.'}</p></div>`; return; }
  el.innerHTML = `<table><thead><tr><th>Belt</th><th class="units-col">Used in</th>
      <th style="text-align:right">Needed</th><th style="text-align:right">In stock</th><th style="text-align:right">To order</th><th></th></tr></thead><tbody>
    ${rows.map(e => `<tr class="${e.spare ? 'stock-only' : ''}">
      <td class="mono">${esc(e.size)}</td>
      <td class="units-col" title="${esc([...e.units].join(', '))}">${e.units.size ? `${e.units.size} unit${e.units.size === 1 ? '' : 's'}<small>${esc([...e.units].slice(0, 6).join(', '))}${e.units.size > 6 ? '…' : ''}</small>` : '—'}</td>
      <td class="num">${num(e.use)}</td>
      <td style="text-align:right">${PUBLIC ? `<b>${num(e.stock)}</b>` : `<input class="stock-in" type="number" min="0" inputmode="numeric" value="${e.stock}" data-belt="1" data-key="${esc(e.key)}" aria-label="In stock ${esc(e.size)}">`}</td>
      <td class="num ${e.order ? 'order-yes' : 'order-no'}">${e.order ? num(e.order) : '✓'}</td>
      <td>${e.spare && !PUBLIC ? `<button class="btn ghost sm" data-rmbelt="${esc(e.key)}" title="Remove">✕</button>` : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;
}
function setBeltStock(key, qty) {
  const s = S.beltStock.find(x => bkey(x.size) === key);
  if (s) s.qty = qty; else S.beltStock.push({ size: key, qty });
  persist();
}

/* Bulk select on the Units tab */
function updateBulkBar() {
  const bar = $('#bulkbar');
  bar.hidden = !selectMode;
  $('#selectBtn').textContent = selectMode ? 'Done selecting' : 'Select…';
  $('#selectBtn').classList.toggle('primary', selectMode);
  if (!selectMode) return;
  const n = selected.size;
  $('#bulkCount').textContent = n ? `${n} selected` : 'Tap units to select them';
  ['#bulkF', '#bulkB', '#bulkClear'].forEach(id => { $(id).disabled = !n; });
}
function selectedUnits() { return S.units.filter(u => selected.has(u.id)); }

/* Parts list: filters + belts for units in scope */
function partsData() {
  const scope = PUBLIC ? 'all' : $('#pScope').value;
  const sel = S.units.filter(u => {
    if (scope === 'all') return true;
    const d = unitDue(u); if (d.due == null) return false;
    return scope === 'overdue' ? d.late >= 1 : scope === 'month' ? d.late >= 0 : d.late >= -1;
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
      ${PUBLIC ? '' : `<button class="btn sm" data-nact="edit">Edit</button>
      <button class="btn sm danger" data-nact="del">Delete</button>`}
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
          <div class="f c2"><label>Route / group</label><input type="text" name="route" list="routeList" value="${esc(u.route)}" placeholder="Route 1, Mezzanine…"></div>
          <div class="f c2"><label>Make</label><input type="text" name="make" value="${esc(u.make)}" placeholder="Carrier, Trane…"></div>
          <div class="f c2"><label>Model #</label><input type="text" name="model" value="${esc(u.model)}"></div>
          <div class="f c2"><label>Cooling capacity (%)</label><input type="text" name="cooling" list="coolList" value="${esc(u.cooling ?? '')}" placeholder="100, 50, 0, N/A…"></div>
        </div>
        <fieldset><legend>Filters</legend>
          <div class="rows" id="frows">${(u.filters || []).map(filterRow).join('')}</div>
          <button type="button" class="btn sm" id="addF">+ Add filter size</button>
          <div class="grid" style="margin-top:12px">
            <div class="f c3"><label>Change every (months)</label><input type="number" min="0" step="1" name="filterInterval" value="${esc(u.filterInterval)}"></div>
            <div class="f c3"><label>Last changed (month)</label><input type="month" name="filterLast" value="${esc(String(u.filterLast || '').slice(0, 7))}"></div>
          </div>
        </fieldset>
        <fieldset><legend>Belts</legend>
          <div class="rows" id="brows">${(u.belts || []).map(beltRow).join('')}</div>
          <button type="button" class="btn sm" id="addB">+ Add belt</button>
          <div class="grid" style="margin-top:12px">
            <div class="f c3"><label>Change every (months)</label><input type="number" min="0" step="1" name="beltInterval" value="${esc(u.beltInterval)}"></div>
            <div class="f c3"><label>Last changed (month)</label><input type="month" name="beltLast" value="${esc(String(u.beltLast || '').slice(0, 7))}"></div>
          </div>
          <p class="hint">Leave belts empty for direct-drive units.</p>
        </fieldset>
        <fieldset><legend>Data plate</legend>
          <div class="grid">
            <div class="f c3"><label>Serial number</label><input type="text" name="serial" value="${esc(u.serial)}"></div>
            <div class="f c3"><label>Manufactured</label><input type="text" name="mfgDate" value="${esc(u.mfgDate)}" placeholder="2014, Oct 2014…"></div>
            <div class="f c3"><label>Cooling size</label><input type="text" name="coolingSize" value="${esc(u.coolingSize)}" placeholder="10 tons"></div>
            <div class="f c3"><label>Heating input</label><input type="text" name="heatingInput" value="${esc(u.heatingInput)}" placeholder="250,000 BTU/h"></div>
            <div class="f c3"><label>Refrigerant</label><input type="text" name="refrigerant" value="${esc(u.refrigerant)}" placeholder="R-410A" list="refList"></div>
            <div class="f c3"><label>Refrigerant charge</label><input type="text" name="refCharge" value="${esc(u.refCharge)}" placeholder="12 lb"></div>
          </div>
          <p class="hint">Make and model are at the top of this form.</p>
          <datalist id="refList"><option>R-410A</option><option>R-22</option><option>R-454B</option><option>R-32</option><option>R-407C</option></datalist>
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
      id: id || uid(), name: v('name'), type: v('type'), location: v('location'), route: v('route'), make: v('make'), model: v('model'),
      serial: v('serial'), mfgDate: v('mfgDate'), coolingSize: v('coolingSize'), heatingInput: v('heatingInput'), refrigerant: v('refrigerant'), refCharge: v('refCharge'),
      filters, belts, filterInterval: v('filterInterval'), filterLast: v('filterLast').slice(0, 7), beltInterval: v('beltInterval'), beltLast: v('beltLast').slice(0, 7), cooling, notes: form.elements.notes.value.trim()
    };
    if (id) S.units = S.units.map(x => x.id === id ? rec : x); else S.units.push(rec);
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
  if (PUBLIC) return;
  if (selectMode) {
    const card = e.target.closest('.unit'); if (!card) return;
    const id = card.dataset.id;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    renderUnits(); return;
  }
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'add') return editUnit();
  const id = btn.closest('.unit').dataset.id, u = S.units.find(x => x.id === id);
  if (act === 'edit') editUnit(id);
  else if (act === 'dup') editUnit(null, u);
  else if (act === 'fdone') markChanged([u], 'filters', thisMonth());
  else if (act === 'bdone') markChanged([u], 'belts', thisMonth());
  else if (act === 'del') confirmBox('Delete unit?', `<p style="margin:0">Remove <b>${esc(u.name)}</b> and its filter and belt info?</p>`, 'Delete', () => { S.units = S.units.filter(x => x.id !== id); render(); persist(); });
});
$('#addBtn').onclick = () => editUnit();
$('#selectBtn').onclick = () => { selectMode = !selectMode; if (!selectMode) selected.clear(); renderUnits(); };
$('#bulkAll').onclick = () => { lastShown.forEach(id => selected.add(id)); renderUnits(); };
$('#bulkClear').onclick = () => { selected.clear(); renderUnits(); };
$('#bulkF').onclick = () => {
  const list = selectedUnits(), n = list.filter(u => (u.filters || []).length).length;
  confirmBox('Mark filters changed?', `<p style="margin:0">Mark filters changed this month on <b>${n} unit${n === 1 ? '' : 's'}</b> and take their filters out of stock?</p>`, 'Mark changed', () => { markChanged(list, 'filters', thisMonth()); selected.clear(); selectMode = false; renderUnits(); });
};
$('#bulkB').onclick = () => {
  const list = selectedUnits(), n = list.filter(u => (u.belts || []).length).length;
  confirmBox('Mark belts changed?', `<p style="margin:0">Mark belts changed this month on <b>${n} unit${n === 1 ? '' : 's'}</b> and take their belts out of stock?</p>`, 'Mark changed', () => { markChanged(list, 'belts', thisMonth()); selected.clear(); selectMode = false; renderUnits(); });
};
['q', 'fType', 'fStatus', 'fCool', 'fRoute', 'sort', 'pScope', 'tq', 'tShort', 'bq', 'bShort', 'nq'].forEach(i => $('#' + i).addEventListener('input', render));
$('#backupBtn').onclick = backupBox;
$('#githubBtn').onclick = githubBox;

function onStockChange(e) {
  const inp = e.target.closest('.stock-in'); if (!inp) return;
  const qty = Math.max(0, Math.round(+inp.value || 0));
  if (inp.dataset.belt) setBeltStock(inp.dataset.key, qty); else setStock(inp.dataset.key, qty);
  setTimeout(() => {   // re-render without losing the field the user tabbed to
    const a = document.activeElement, k = a && a.classList.contains('stock-in') ? a.dataset.key : null;
    render();
    if (k) { const n = document.querySelector(`.stock-in[data-key="${CSS.escape(k)}"]`); if (n) { n.focus(); n.select(); } }
  }, 0);
}
['#totals', '#btotals'].forEach(sel => {
  $(sel).addEventListener('change', onStockChange);
  $(sel).addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('stock-in')) e.target.blur(); });
});
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
$('#btotals').addEventListener('click', e => {
  const b = e.target.closest('[data-rmbelt]'); if (!b) return;
  S.beltStock = S.beltStock.filter(st => bkey(st.size) !== b.dataset.rmbelt); render(); persist();
});
$('#addBeltStock').onsubmit = e => {
  e.preventDefault();
  const f = e.target, size = bkey(f.elements.size.value); if (!size) return;
  setBeltStock(size, Math.max(0, Math.round(+f.elements.qty.value || 0)));
  f.reset(); render();
};
$('#copyBeltOrder').onclick = () => {
  const rows = beltTotalsData().filter(e => e.order > 0);
  const txt = rows.length ? ['BELTS TO ORDER', ...rows.map(e => `${e.order}  ${e.size}`)].join('\n') : 'Nothing to order — stock covers a full change.';
  copyText($('#copyBeltOrder'), txt, 'Copy order list');
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
  else view = ['units', 'totals', 'belts', 'parts'].includes(h) ? h : 'units';
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  ['units', 'totals', 'belts', 'parts', 'notes'].forEach(v => { $('#view-' + v).hidden = v !== view; });
  render();
}
window.addEventListener('hashchange', route);

document.body.classList.toggle('public', PUBLIC);
if (PUBLIC) { const o = $('#sort option[value=due]'); o.hidden = o.disabled = true; $('#sort').value = 'name'; }
$('#fType').innerHTML += TYPES.map(t => `<option value="${t}">${typeLabel(t)}</option>`).join('');
route();
initStorage();
})();
