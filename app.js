/* HVAC Tracker: app code. Data lives in data.js (window.TRACKER_DATA). */
(function () {
'use strict';

const LS_KEY = 'filter-belt-tracker-v2';
const TYPES = ['ASH', 'AHU', 'RTU', 'MAU', 'King Heater', 'Other'];
const TYPE_NAMES = { ASH: 'Ash house', AHU: 'Air handler', RTU: 'Rooftop unit', MAU: 'Make-up air', 'King Heater': 'King Heater', Other: 'Other' };
const typeLabel = t => TYPE_NAMES[t] && TYPE_NAMES[t] !== t ? `${t} — ${TYPE_NAMES[t]}` : t;
const TYPE_PLURAL = { ASH: 'Ash houses', AHU: 'Air handlers', RTU: 'Rooftop units', MAU: 'Make-up air units', 'King Heater': 'King heaters', Other: 'Other equipment' };
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
let PUBLIC = !!(window.TRACKER_DATA && window.TRACKER_DATA.public);
let EXPORTED_AT = (window.TRACKER_DATA && window.TRACKER_DATA.exportedAt) || '';
/* Web mode (the GitHub site): data lives in Supabase. Visitors read the public copy;
   the two approved accounts sign in to read and change the private data. */
const CFG = window.TRACKER_CONFIG || null;
let sb = null, sbUser = null, sbVersion = null, sbSaving = false, sbPending = false, sbSeen = false;
let S = normalize(window.TRACKER_DATA);

let mode = 'local', artifactApi = null, readOnly = false, saveTimer = null;
let view = 'units', noteTab = 'cooling';
let selectMode = false, selected = new Set(), lastShown = [], toastTimer = null;
let typeFilter = '', openUnits = new Set(), closedGroups = new Set(), listEnter = true;
const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
/* Show a number, counting up or down to it when it changes. */
function setFig(sel, value, suffix) {
  const el = $(sel), to = Number(value), sfx = suffix || '';
  cancelAnimationFrame(el._raf);
  if (value == null || isNaN(to)) { el.textContent = '—'; delete el.dataset.v; return; }
  const from = el.dataset.v == null ? 0 : Number(el.dataset.v);
  el.dataset.v = to;
  if (reduceMotion || from === to || document.hidden) { el.textContent = num(to) + sfx; return; }
  const t0 = performance.now(), dur = 520;
  const step = now => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = num(Math.round(from + (to - from) * e)) + sfx;
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

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
  let taken = 0; const short = new Set(), logged = [];
  todo.forEach(u => {
    u[field] = date;
    const parts = part === 'belts' ? u.belts.map(b => `${b.qty || 1} × ${b.size}`) : u.filters.map(f => `${f.qty || 1} × ${dispSize(f.size)}${f.kind ? ' ' + baseKind(f.kind).toLowerCase() : ''}`);
    const entry = svcEntry(fmtD(today()), `${part === 'belts' ? 'Belts' : 'Filters'} changed (${parts.join(', ')})`, true);
    u.log = (u.log || []).concat(entry); logged.push([u.id, entry.id]);
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
    logged.forEach(([id, eid]) => { const u = S.units.find(x => x.id === id); if (u) u.log = (u.log || []).filter(l => l.id !== eid); });
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
  if (i.late >= 1) return `Overdue, was due ${fmtMonth(i.due)}`;
  if (i.late === 0) return 'Due this month';
  if (i.late === -1) return 'Due next month';
  return `Due ${fmtMonth(i.due)}`;
}

/* ---------- saving ---------- */
function lsGet() { try { const v = localStorage.getItem(LS_KEY) || localStorage.getItem('filter-belt-tracker-v1'); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function lsSet() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
function setStatus(text, cls) { $('#saveText').textContent = text; $('#save').className = 'save' + (cls ? ' ' + cls : ''); }

function dataJs() {
  return '/* HVAC Tracker data. The page rewrites this file when you save. */\n' +
    'window.TRACKER_DATA = ' + JSON.stringify(S, null, 1).replace(/</g, '\\u003c') + ';\n';
}
function publicDataJs() {
  const pub = { public: true, exportedAt: new Date().toISOString(),
    units: S.units.map(({ filterLast, beltLast, ...u }) => u), stock: S.stock, beltStock: S.beltStock, notes: S.notes };
  return '/* HVAC Tracker: public copy for GitHub. View-only, with no change dates.\n   Made with "Copy for GitHub" on ' + new Date().toLocaleString() + ' */\n' +
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
  if (mode === 'web') { setStatus('Saving…', 'busy'); clearTimeout(saveTimer); saveTimer = setTimeout(saveWeb, 1000); return; }
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
  const inClaude = !!(window.claude && typeof window.claude.use === 'function');
  if (!inClaude && CFG && window.supabase && typeof window.supabase.createClient === 'function') return initWeb();
  if (PUBLIC) { setStatus(EXPORTED_AT ? 'Updated ' + niceD(new Date(EXPORTED_AT)) : 'View only'); return; }
  try { if (inClaude) artifactApi = await window.claude.use('artifact'); } catch (e) { artifactApi = null; }
  if (artifactApi) { mode = 'shared'; document.body.classList.add('mode-claude'); setStatus('All changes saved'); return; }
  mode = 'local';
  const saved = lsGet();
  if (saved) { S = normalize(saved); render(); }
  setStatus('Saved in this browser');
}

/* ---------- web mode: Supabase ---------- */
async function initWeb() {
  mode = 'web'; PUBLIC = true;
  document.body.classList.add('mode-web');
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  applyMode(); render();
  loadPublic();
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { newPasswordBox(); return; }
    setTimeout(() => handleSession(session), 0);   // run outside the auth callback
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshIfChanged(); });
}
async function loadPublic() {
  try {
    const { data, error } = await sb.from('tracker_public').select('doc').eq('id', 1).maybeSingle();
    if (error || !data) throw error || new Error('no data');
    if (!PUBLIC) return;                       // signed in meanwhile: keep private data
    S = normalize(data.doc); EXPORTED_AT = data.doc.exportedAt || '';
    render();
    setStatus(EXPORTED_AT ? 'Updated ' + niceD(new Date(EXPORTED_AT)) : 'View only');
  } catch (e) {
    if (PUBLIC) setStatus(EXPORTED_AT ? 'Updated ' + niceD(new Date(EXPORTED_AT)) + ' (offline copy)' : 'View only', 'warn');
  }
}
async function handleSession(session) {
  const user = session && session.user;
  if (sbSeen && (user && user.id) === (sbUser && sbUser.id)) return;
  sbSeen = true;
  sbUser = user || null;
  $('#signInBtn').hidden = !!sbUser;
  $('#userChip').hidden = !sbUser;
  $('#userEmail').textContent = sbUser ? sbUser.email : '';
  if (!sbUser) { PUBLIC = true; sbVersion = null; applyMode(); loadPublic(); return; }
  setStatus('Loading your data…', 'busy');
  const ok = await loadPrivate();
  if (!ok) {
    PUBLIC = true; applyMode(); loadPublic();
    toast('Signed in, but this account doesn’t have access to the full tracker.');
  }
}
async function loadPrivate() {
  const { data, error } = await sb.from('tracker_private').select('doc, version').eq('id', 1).maybeSingle();
  if (error || !data) return false;
  S = normalize(data.doc); sbVersion = data.version;
  PUBLIC = false; listEnter = true; applyMode(); render();
  $('#toast').hidden = true;
  setStatus('All changes saved');
  return true;
}
async function saveWeb() {
  if (PUBLIC || !sb) return;
  if (sbSaving) { sbPending = true; return; }
  sbSaving = true; sbPending = false;
  setStatus('Saving…', 'busy');
  try {
    const { data, error } = await sb.rpc('save_tracker', { new_doc: S, expected_version: sbVersion });
    if (error) throw error;
    if (data == null) {
      setStatus('The other user saved first — loading their version', 'warn');
      toast('Your last change wasn’t saved because the other user saved at the same time. Their version is loaded now — please redo that change.');
      await loadPrivate();
    } else { sbVersion = data; setStatus('All changes saved'); }
  } catch (e) {
    setStatus('Save failed — check your connection and make another change to retry', 'warn');
  } finally {
    sbSaving = false;
    if (sbPending) saveWeb();
  }
}
async function refreshIfChanged() {
  if (mode !== 'web' || PUBLIC || sbSaving || sbPending || saveTimer && $('#save').classList.contains('busy')) return;
  const { data } = await sb.from('tracker_private').select('version').eq('id', 1).maybeSingle();
  if (data && data.version !== sbVersion) { await loadPrivate(); toast('Updated with the latest changes.'); }
}
function applyMode() {
  document.body.classList.toggle('public', PUBLIC);
  const o = $('#sort option[value=due]');
  o.hidden = o.disabled = PUBLIC;
  if (PUBLIC && $('#sort').value === 'due') $('#sort').value = 'group';
  placeInk();
  if (PUBLIC && view === 'today') go('units');
}
function pwField(name, label, ac, extra) {
  return `<div class="f" style="margin-top:10px"><label for="pw-${name}">${label}</label><div class="pw-wrap"><input type="password" id="pw-${name}" name="${name}" autocomplete="${ac}" autocapitalize="off" autocorrect="off" spellcheck="false" minlength="6" required ${extra || ''}><button type="button" class="pw-toggle" data-pwtoggle aria-label="Show password">Show</button></div></div>`;
}
function wirePwToggles(form) {
  form.querySelectorAll('.pw-wrap').forEach(w => w.addEventListener('click', e => { if (!e.target.closest('[data-pwtoggle]')) w.querySelector('input').focus(); }));
  form.querySelectorAll('[data-pwtoggle]').forEach(b => b.onclick = () => {
    const show = b.textContent === 'Show';
    form.querySelectorAll('.pw-wrap input').forEach(i => { i.type = show ? 'text' : 'password'; });
    form.querySelectorAll('[data-pwtoggle]').forEach(x => { x.textContent = show ? 'Hide' : 'Show'; x.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
  });
}
function authBox(kind) {
  kind = kind || 'in';
  const t = { in: ['Sign in', 'Sign in'], up: ['Create your account', 'Create account'], reset: ['Reset your password', 'Send reset link'] }[kind];
  openModal(`<form id="aform" novalidate>
    <div class="dhead"><h2>${t[0]}</h2><button type="button" class="btn ghost" data-m="cancel">✕</button></div>
    <div class="dbody">
      ${kind === 'up' ? '<p class="hint" style="margin-top:0">Only the two approved email addresses can create an account.</p>' : ''}
      <div class="f"><label for="auth-email">Email</label><input type="email" id="auth-email" name="email" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="email" autofocus required></div>
      ${kind === 'in' ? pwField('password', 'Password', 'current-password') : ''}
      ${kind === 'up' ? pwField('password', 'Choose a password', 'new-password') + pwField('password2', 'Type it again', 'new-password') : ''}
      <div class="auth-msg" id="amsg"></div>
      <p style="margin:14px 0 0;display:flex;gap:14px;flex-wrap:wrap">
        ${kind !== 'in' ? '<button type="button" class="auth-switch" data-k="in">Back to sign in</button>' : '<button type="button" class="auth-switch" data-k="up">First time? Create your account</button><button type="button" class="auth-switch" data-k="reset">Forgot password?</button>'}
      </p>
    </div>
    <div class="dfoot"><button type="button" class="btn" data-m="cancel">Cancel</button><button type="submit" class="btn primary">${t[1]}</button></div></form>`, true);
  const f = $('#aform'), msg = (m, ok) => { const el = $('#amsg'); el.textContent = m; el.className = 'auth-msg' + (ok ? ' ok' : ' err'); };
  f.querySelectorAll('[data-m=cancel]').forEach(b => b.onclick = closeModal);
  f.querySelectorAll('[data-k]').forEach(b => b.onclick = () => authBox(b.dataset.k));
  wirePwToggles(f);
  const here = location.origin + location.pathname;
  f.onsubmit = async e => {
    e.preventDefault();
    const email = f.elements.email.value.trim().toLowerCase(), password = f.elements.password ? f.elements.password.value : '';
    if (!email) return msg('Enter your email address.');
    if (kind !== 'reset' && password.length < 6) return msg('Passwords need at least 6 characters.');
    if (kind === 'up' && password !== f.elements.password2.value) return msg('The two passwords don’t match. Type them again.');
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      if (kind === 'in') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        closeModal();
      } else if (kind === 'up') {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: here } });
        if (error) throw error;
        if (data && data.session) closeModal();
        else msg('Account created. Check your email for a confirmation link, then come back here and sign in.', true);
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: here });
        if (error) throw error;
        msg('If that email has an account, a reset link is on its way.', true);
      }
    } catch (err) {
      const m = String((err && err.message) || err);
      if (/database error|not allowed|limited to approved/i.test(m)) msg('That email isn’t approved for this tracker. Check it for typos.');
      else if (/invalid login/i.test(m)) msg('Wrong email or password.');
      else if (/not confirmed/i.test(m)) msg('Confirm your email first — check your inbox for the link.');
      else if (/already registered/i.test(m)) msg('That email already has an account. Use Sign in.');
      else msg(m);
    } finally { btn.disabled = false; }
  };
}
function newPasswordBox() {
  openModal(`<form id="pform"><div class="dhead"><h2>Set a new password</h2></div>
    <div class="dbody">${pwField('password', 'New password', 'new-password', 'autofocus')}${pwField('password2', 'Type it again', 'new-password')}<div class="auth-msg" id="pmsg"></div></div>
    <div class="dfoot"><button type="submit" class="btn primary">Save password</button></div></form>`, true);
  wirePwToggles($('#pform'));
  $('#pform').onsubmit = async e => {
    e.preventDefault();
    const pw = e.target.elements.password.value;
    if (pw.length < 6) { $('#pmsg').textContent = 'Passwords need at least 6 characters.'; return; }
    if (pw !== e.target.elements.password2.value) { $('#pmsg').textContent = 'The two passwords don’t match. Type them again.'; return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) $('#pmsg').textContent = error.message; else { closeModal(); toast('Password updated.'); }
  };
}

/* ---------- Today's notes ---------- */
function normUnit(s) {
  return String(s || '').toLowerCase().replace(/[()]/g, ' ').replace(/\bhouse\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .map(t => t.replace(/^0+(?=\d)/, '').replace(/([a-z])0+(?=\d)/g, '$1')).join('');
}
function unitIndex() {
  const m = new Map();
  S.units.forEach(u => { const k = normUnit(u.name); if (!k) return; m.set(k, m.has(k) ? 'AMBIG' : u); });
  return m;
}
/* "Ash 1, Ash 2 and Ash 5", "Ash 1-11" or "Ash 12 to 25": every unit named, or null.
   A range skips numbers that aren't units (like Ash 26 and 27). */
function findMany(line, find) {
  const l = line.replace(/^[(\s]+|[)\s:]+$/g, '');
  if (l.length > 120) return null;
  const r = /^(.*?)(\d+)\s*(?:-|–|to|thru|through)\s*(\d+)$/i.exec(l);
  if (r && r[1].trim() && /[a-z]/i.test(r[1])) {
    const a = +r[2], b = +r[3], out = [];
    if (b > a && b - a <= 200) for (let n = a; n <= b; n++) { const u = find(r[1] + n); if (u && !out.includes(u)) out.push(u); }
    if (out.length >= 2) return out;
  }
  const parts = l.split(/\s*(?:,|&|\+|\band\b)\s*/i).filter(Boolean);
  if (parts.length < 2) return null;
  const out = [];
  let prefix = '';
  for (const p of parts) {
    let u = find(p);
    if (!u && /^\d+$/.test(p) && prefix) u = find(prefix + p);   // "Ash 1, 2, 5"
    if (!u) return null;
    const pm = /^(.*?)\d+$/.exec(p); if (pm && pm[1].trim()) prefix = pm[1];
    if (!out.includes(u)) out.push(u);
  }
  return out.length >= 2 ? out : null;
}
function parseToday(text) {
  const idx = unitIndex(), blocks = [];
  let cur = null, afterBlank = true;
  const find = name => { const k = normUnit(name); const u = idx.get(k); return u === 'AMBIG' ? null : u || null; };
  // a short line like "RTU 99" or "Ash 400" is meant as a unit heading even if it doesn't match one
  const looksLikeUnit = l => l.length <= 30 && /^\(?\s*(rtu|ash|sub|ahu|mau|king|lie?bert|lei?bert|ww|training|power|gear)\b.*\d/i.test(l);
  String(text || '').split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    if (!line) { afterBlank = true; return; }
    const startsBlock = afterBlank; afterBlank = false;
    // a list or range ("Ash 1, 2, 5", "Ash 1-11") first, so "Ash 1-11" isn't read as Ash 111
    const many = findMany(line, find);
    if (many) { const lines = []; many.forEach(x => blocks.push({ unit: x, label: line, lines })); cur = { lines }; return; }
    let u = find(line);
    if (u) { cur = { unit: u, label: line, lines: [] }; blocks.push(cur); return; }
    const m = /^(.{1,40}?)\s*(?::|\s-\s|\s–\s)\s*(.+)$/.exec(line);
    if (m && (u = find(m[1]))) { cur = { unit: u, label: m[1], lines: [m[2]] }; blocks.push(cur); return; }
    if (!cur || startsBlock || looksLikeUnit(line)) { cur = { unit: null, label: line, lines: [] }; blocks.push(cur); return; }
    cur.lines.push(line.replace(/^[(\s]+|[)\s]+$/g, '') || line);
  });
  return blocks.map(b => ({ ...b, text: b.lines.join('\n') }));
}
function renderToday() {
  if (!$('#todayDate').value) $('#todayDate').value = fmtD(today());
  const blocks = parseToday($('#todayText').value), el = $('#todayPreview');
  const good = blocks.filter(b => b.unit && b.text);
  $('#todayApply').disabled = !good.length;
  $('#todayApply').textContent = good.length ? `Add to ${good.length} unit${good.length === 1 ? '' : 's'}` : 'Add to service records';
  el.innerHTML = blocks.length ? blocks.map(b => b.unit
    ? `<div class="pv-block${b.text ? '' : ' bad'}"><div class="pv-unit">✓ ${esc(b.unit.name)}</div>${b.text ? `<div class="pv-text">${esc(b.text)}</div>` : '<div class="pv-warn">No notes under this unit yet.</div>'}</div>`
    : `<div class="pv-block bad"><div class="pv-unit">⚠ “${esc(b.label)}”</div><div class="pv-warn">Not a unit name I recognize. Put a unit name on the line above, or check the spelling.</div>${b.text ? `<div class="pv-text">${esc(b.text)}</div>` : ''}</div>`).join('')
    : '<p class="none">Start typing and you\'ll see which unit each note goes to.</p>';
  const all = [];
  S.units.forEach(u => (u.log || []).forEach(l => all.push({ u, l })));
  all.sort((a, b) => String(b.l.date).localeCompare(String(a.l.date)) || String(b.l.at || '').localeCompare(String(a.l.at || '')));
  $('#todayRecent').innerHTML = all.length
    ? `<div class="today-preview">${all.slice(0, 40).map(({ u, l }) => `<div class="log-entry"><span class="log-date">${niceD(parseD(l.date))}</span><span class="log-unit">${esc(u.name)}</span><span class="log-text">${esc(l.text)}</span></div>`).join('')}</div>`
    : '<p class="none">No service records yet.</p>';
}
function applyToday() {
  const date = $('#todayDate').value || fmtD(today());
  const good = parseToday($('#todayText').value).filter(b => b.unit && b.text);
  if (!good.length) return;
  const added = [];
  good.forEach(b => {
    const u = S.units.find(x => x.id === b.unit.id); if (!u) return;
    const entry = svcEntry(date, b.text);
    u.log = (u.log || []).concat(entry); added.push([u.id, entry.id]);
  });
  const draft = $('#todayText').value;
  $('#todayText').value = ''; try { localStorage.removeItem('fbt-today-draft'); } catch (e) {}
  render(); persist();
  toast(`Added to the service record of ${added.length} unit${added.length === 1 ? '' : 's'}.`, () => {
    added.forEach(([uidv, eid]) => { const u = S.units.find(x => x.id === uidv); if (u) u.log = (u.log || []).filter(l => l.id !== eid); });
    $('#todayText').value = draft; render(); persist(); toast('Undone.');
  });
}
function svcEntry(date, text, auto) {
  return { id: uid(), date, text, at: new Date().toISOString(), by: sbUser ? sbUser.email : '', ...(auto ? { auto: true } : {}) };
}
function quickNotesBlock(u) {
  if (!u.notes && PUBLIC) return '';
  return `<div class="usec wide qn" data-qn>
    <div class="usec-head"><h4>Quick notes</h4>${PUBLIC ? '' : `<button class="linkbtn sm" type="button" data-qnedit>${u.notes ? 'Edit' : 'Add'}</button>`}</div>
    ${u.notes ? `<div class="notes">${esc(u.notes)}</div>` : '<div class="none">Nothing yet. Add what someone should know before working on this unit.</div>'}
  </div>`;
}
function serviceBlock(u) {
  if (PUBLIC) return '';
  const list = (u.log || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.at || '').localeCompare(String(a.at || '')));
  return `<div class="usec wide svc">
    <div class="usec-head"><h4>Service record${list.length ? ` <span class="gcount">${list.length}</span>` : ''}</h4></div>
    <form class="svc-add" data-svcform>
      <input type="date" name="date" value="${fmtD(today())}" aria-label="Date of the work" required>
      <input type="text" name="text" placeholder="What was done, like “Replaced supply fan belt”" aria-label="What was done" enterkeyhint="done" required>
      <button class="btn sm primary" type="submit">Add</button>
    </form>
    ${list.length ? `<div class="log-list">${list.map(l =>
      `<div class="log-entry${l.auto ? ' auto' : ''}"><span class="log-date">${niceD(parseD(l.date))}</span><span class="log-text">${esc(l.text)}</span><button class="btn ghost sm" type="button" data-logdel="${esc(l.id)}" title="Delete this record" aria-label="Delete this record">✕</button></div>`).join('')}</div>`
      : '<div class="none">No work recorded yet.</div>'}
  </div>`;
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
  const pct = v === 'N/A' ? 0 : Math.max(0, Math.min(100, v)), txt = v === 'N/A' ? 'N/A' : v + '%';
  return `<span class="cool c-${coolClass(v)}" title="Cooling capacity ${txt}"><span class="cool-bar"><i style="width:${pct}%"></i></span><b>${txt}</b></span>`;
}
const PLATE = [['serial', 'Serial'], ['coolingSize', 'Cooling size'], ['heatingInput', 'Heating input'],
  ['refrigerant', 'Refrigerant'], ['refCharge', 'Refrigerant charge'], ['mfgDate', 'Manufactured']];
function plateBlock(u) {
  const rows = [['Make', u.make], ['Model', u.model], ...PLATE.map(([k, l]) => [l, u[k]])].filter(([, v]) => v);
  if (!rows.length) return '';
  return `<div class="usec"><h4>Data plate</h4><dl class="plate">${rows.map(([l, v]) => `<dt>${esc(l)}</dt><dd${/^(Model|Serial)$/.test(l) ? ' class="mono"' : ''}>${esc(v)}</dd>`).join('')}</dl></div>`;
}
function filterChip(f) {
  const extra = [f.merv ? 'MERV ' + f.merv : '', f.kind].filter(Boolean).join(', ');
  return `<span class="chip">${esc(f.size || '?')} ×${esc(f.qty || 1)}${extra ? `<small>${esc(extra)}</small>` : ''}</span>`;
}
function beltChip(b) { return `<span class="chip">${esc(b.size || '?')} ×${esc(b.qty || 1)}${b.note ? `<small>${esc(b.note)}</small>` : ''}</span>`; }
function schedLine(label, last, months, has) {
  if (!has) return '';
  const every = months ? `every ${esc(months)} month${+months === 1 ? '' : 's'}` : '';
  if (PUBLIC) return every ? `<div class="sched"><b>${label}</b> changed ${every}</div>` : '';
  const i = dueInfo(last, months), parts = [];
  parts.push(last ? 'last changed ' + niceMonth(last) : 'no change date yet');
  if (every) parts.push(every);
  if (i.due != null) parts.push(`next ${fmtMonth(i.due)}`);
  return `<div class="sched"><b>${label}</b> ${parts.join(', ')}${i.due != null ? ` <span class="pill p-${i.status}">${relText(i)}</span>` : ''}</div>`;
}
function searchText(u) {
  const cv = coolVal(u);
  return [cv === null ? '' : 'cooling ' + cv + (cv === 'N/A' ? '' : '%'), u.route, u.name, u.type, TYPE_NAMES[u.type], u.location, u.make, u.model, u.notes,
    u.serial, u.refrigerant, u.coolingSize, ...(PUBLIC ? [] : (u.log || []).map(l => l.text)),
    ...(u.filters || []).flatMap(f => [f.size, f.kind, f.merv && ('merv ' + f.merv)]),
    ...(u.belts || []).flatMap(b => [b.size, b.note])].join(' ').toLowerCase();
}

/* ---------- render ---------- */
function render() {
  const ds = S.units.map(unitDue);
  setFig('#stUnits', S.units.length);
  setFig('#stOver', ds.filter(d => d.status === 'overdue').length);
  setFig('#stSoon', ds.filter(d => d.status === 'soon').length);
  setFig('#stBelts', S.units.reduce((n, u) => n + (u.belts || []).reduce((a, b) => a + (+b.qty || 0), 0), 0));
  const cvs = S.units.filter(u => u.type === 'ASH').map(coolVal).filter(v => typeof v === 'number');
  setFig('#stCool', cvs.length ? Math.round(cvs.reduce((a, v) => a + v, 0) / cvs.length) : null, '%');
  setFig('#stFilters', S.units.reduce((n, u) => n + (u.filters || []).reduce((a, f) => a + (+f.qty || 0), 0), 0));
  const routes = [...new Set(S.units.map(u => u.route).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  $('#routeList').innerHTML = routes.map(r => `<option value="${esc(r)}">`).join('');
  const fr = $('#fRoute'), cur = fr.value;
  fr.innerHTML = '<option value="">All routes</option>' + routes.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  fr.value = routes.includes(cur) ? cur : '';
  ({ units: renderUnits, totals: renderTotals, belts: renderBeltTotals, parts: renderParts, notes: renderNotes, today: renderToday })[view]();
}

/* Sections for the unit list. "group" = by type (ash houses split by route). */
function groupRows(rows, sort) {
  const byName = (a, b) => String(a.u.name).localeCompare(String(b.u.name), undefined, { numeric: true });
  const groups = new Map();
  const put = (title, order, r) => { let g = groups.get(title); if (!g) { g = { title, order, rows: [] }; groups.set(title, g); } g.rows.push(r); };
  rows.forEach(r => {
    const u = r.u;
    if (sort === 'group') {
      const ti = TYPES.indexOf(u.type) < 0 ? TYPES.length : TYPES.indexOf(u.type);
      if (u.type === 'ASH') put('Ash houses' + (u.route ? ', ' + u.route : ''), [ti, u.route ? (/^route/i.test(u.route) ? 0 : 1) : 2, u.route || ''], r);
      else put(TYPE_PLURAL[u.type] || TYPE_PLURAL.Other, [ti, 0, ''], r);
    } else if (sort === 'due') {
      const m = { overdue: [0, 'Overdue'], soon: [1, 'Due this month'], ok: [2, 'Coming up'] }[r.d.status] || [3, 'No change date set'];
      put(m[1], [m[0]], r);
    } else if (sort === 'loc') put(u.location || 'No location set', [u.location ? 0 : 1, u.location || ''], r);
    else if (sort === 'cool') {
      const v = coolVal(u);
      const m = v === null ? [4, 'No cooling figure'] : v === 'N/A' ? [3, 'Cooling not applicable'] : v <= 0 ? [0, 'No cooling (0%)'] : v < 100 ? [1, 'Partial cooling'] : [2, 'Full cooling (100%)'];
      put(m[1], [m[0]], r);
    } else put('', [0], r);
  });
  const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i], y = b[i]; if (x === y) continue; return typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }); } return 0; };
  const list = [...groups.values()].sort((a, b) => cmp(a.order, b.order));
  list.forEach(g => g.rows.sort(sort === 'due' ? (a, b) => (a.d.due ?? Infinity) - (b.d.due ?? Infinity) || byName(a, b)
    : sort === 'cool' ? (a, b) => (typeof coolVal(a.u) === 'number' ? coolVal(a.u) : 0) - (typeof coolVal(b.u) === 'number' ? coolVal(b.u) : 0) || byName(a, b) : byName));
  return list;
}
function unitCard(u, d, sort) {
  const hasF = (u.filters || []).length, hasB = (u.belts || []).length;
  const picked = selectMode && selected.has(u.id), open = !selectMode && openUnits.has(u.id);
  const sub = [sort === 'group' ? '' : u.route, u.location].filter(Boolean).map(esc).join(', ');
  const lc = [lastOf(u, 'filters'), lastOf(u, 'belts')].filter(Boolean).sort().pop();
  const pill = PUBLIC ? '' : d.due == null ? (lc ? `<span class="pill p-unknown">Changed ${niceMonth(lc)}</span>` : '') : `<span class="pill p-${d.status}">${relText(d)}</span>`;
  const sched = schedLine('Filters', lastOf(u, 'filters'), u.filterInterval, hasF) + schedLine('Belts', lastOf(u, 'belts'), u.beltInterval, hasB);
  return `<article class="unit s-${d.status}${picked ? ' picked' : ''}${open ? ' open' : ''}" data-id="${esc(u.id)}">
    <button class="urow" type="button" aria-expanded="${open}">
      ${selectMode ? `<input type="checkbox" class="pick" tabindex="-1" ${picked ? 'checked' : ''} aria-label="Select ${esc(u.name)}">` : '<span class="chev"></span>'}
      <span class="utag">${esc(u.name)}</span>
      ${sort === 'group' ? '' : `<span class="badge" title="${esc(TYPE_NAMES[u.type] || u.type)}">${esc(u.type || 'Other')}</span>`}
      ${sub ? `<span class="usub">${sub}</span>` : ''}
      <span class="spacer"></span>
      ${coolLine(u)}
      ${pill}
    </button>
    ${u.notes ? `<div class="uqn" title="Quick notes"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg><span>${esc(u.notes.split(/\n/)[0])}</span></div>` : ''}
    <div class="uparts">
      ${hasF ? `<span class="pset"><span class="plabel">Filters</span>${u.filters.map(filterChip).join('')}</span>` : '<span class="none">No filters listed</span>'}
      ${hasB ? `<span class="pset"><span class="plabel">Belts</span>${u.belts.map(beltChip).join('')}</span>` : ''}
    </div>
    <div class="ubody"><div class="ubody-in"><div class="ubody-pad">
      ${quickNotesBlock(u)}
      ${sched ? `<div class="usec"><h4>Change schedule</h4>${sched}</div>` : ''}
      ${hasB ? '' : '<div class="usec"><h4>Belts</h4><div class="none">None listed, or direct drive</div></div>'}
      ${plateBlock(u)}
      ${serviceBlock(u)}
      ${PUBLIC ? '' : `<div class="actions">
        ${hasF ? `<button class="btn sm" data-act="fdone">Filters changed this month</button>` : ''}
        ${hasB ? `<button class="btn sm" data-act="bdone">Belts changed this month</button>` : ''}
        <span class="spacer"></span>
        <button class="btn sm" data-act="edit">Edit</button>
        <button class="btn sm" data-act="dup">Duplicate</button>
        <button class="btn sm danger" data-act="del">Delete</button>
      </div>`}
    </div></div></div>
  </article>`;
}
function updateFinder(shown) {
  const counts = {}; S.units.forEach(u => { counts[u.type] = (counts[u.type] || 0) + 1; });
  const types = [...TYPES.filter(t => counts[t]), ...Object.keys(counts).filter(t => !TYPES.includes(t))];
  if (typeFilter && !counts[typeFilter]) typeFilter = '';
  $('#typeChips').innerHTML = [['', 'All', S.units.length], ...types.map(t => [t, TYPE_PLURAL[t] || t, counts[t]])]
    .map(([t, label, n]) => `<button class="tchip" type="button" data-type="${esc(t)}" aria-pressed="${typeFilter === t}">${esc(label)} <i>${n}</i></button>`).join('');
  const extra = [$('#fRoute').value, PUBLIC ? '' : $('#fStatus').value, $('#fCool').value].filter(Boolean).length;
  $('#filterCount').hidden = !extra; $('#filterCount').textContent = extra;
  const any = extra || typeFilter || $('#q').value.trim();
  $('#clearFilters').hidden = !any;
  const total = S.units.length;
  $('#resultCount').textContent = any ? `${shown} of ${total} unit${total === 1 ? '' : 's'}` : `${total} unit${total === 1 ? '' : 's'}`;
}
function renderUnits() {
  const q = $('#q').value.trim().toLowerCase();
  const fs = PUBLIC ? '' : $('#fStatus').value, fc = $('#fCool').value, fr = $('#fRoute').value;
  let sort = $('#sort').value; if (PUBLIC && sort === 'due') sort = 'group';
  let rows = S.units.map(u => ({ u, d: unitDue(u) }));
  if (q) rows = rows.filter(r => q.split(/\s+/).every(t => searchText(r.u).includes(t)));
  if (typeFilter) rows = rows.filter(r => r.u.type === typeFilter);
  if (fr) rows = rows.filter(r => r.u.route === fr);
  if (fs) rows = rows.filter(r => r.d.status === fs);
  if (fc) rows = rows.filter(r => { const v = coolVal(r.u);
    return fc === 'set' ? v !== null : fc === 'na' ? v === 'N/A' : typeof v === 'number' && (fc === 'full' ? v >= 100 : fc === 'none' ? v <= 0 : v > 0 && v < 100); });

  lastShown = rows.map(r => r.u.id);
  updateBulkBar();
  updateFinder(rows.length);
  const list = $('#list');
  list.classList.toggle('selecting', selectMode);
  list.classList.toggle('enter', listEnter && !reduceMotion);
  if (!S.units.length) { list.innerHTML = `<div class="empty"><h2>No units yet</h2>${PUBLIC ? '' : '<p><button class="btn primary" data-act="add">Add unit</button></p>'}</div>`; return; }
  if (!rows.length) { list.innerHTML = `<div class="empty"><h2>No units match</h2><p>Try a different search, or clear the filters.</p></div>`; return; }
  if (!selectMode) {   // open the unit when the search lands on exactly one, or names one exactly
    const hit = rows.length === 1 ? rows[0] : q && rows.find(r => normUnit(r.u.name) === normUnit(q));
    if (hit) openUnits.add(hit.u.id);
  }

  const filtering = !!(q || typeFilter || fr || fs || fc);
  list.innerHTML = groupRows(rows, sort).map((g, i) => {
    const key = sort + ':' + g.title, closed = !filtering && closedGroups.has(key);
    return `<section class="group${closed ? ' closed' : ''}" data-g="${esc(key)}" style="--i:${Math.min(i, 8)}">
      ${g.title ? `<div class="ghead"><button class="gtoggle" type="button" aria-expanded="${!closed}"><span class="chev"></span><span class="gtitle">${esc(g.title)}</span><span class="gcount">${g.rows.length}</span></button>${selectMode ? '<span class="spacer"></span><button class="btn sm" type="button" data-gsel>Select these</button>' : ''}</div>` : ''}
      <div class="gbody"><div class="gbody-in">${g.rows.map(({ u, d }) => unitCard(u, d, sort)).join('')}</div></div>
    </section>`;
  }).join('');
  if (listEnter) { listEnter = false; setTimeout(() => list.classList.remove('enter'), 1200); }
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
  setFig('#tSizes', all.length);
  setFig('#tUse', all.reduce((a, e) => a + e.use, 0));
  setFig('#tStock', all.reduce((a, e) => a + e.stock, 0));
  setFig('#tOrder', all.reduce((a, e) => a + e.order, 0));
  const q = $('#tq').value.trim().toLowerCase(), onlyShort = $('#tShort').checked;
  let rows = all;
  if (q) rows = rows.filter(e => (e.size + ' ' + e.kind).toLowerCase().includes(q));
  if (onlyShort) rows = rows.filter(e => e.order > 0);
  const el = $('#totals');
  if (!rows.length) { el.innerHTML = `<div class="empty"><h2>${onlyShort ? 'Nothing short' : 'No matches'}</h2><p>${onlyShort ? 'Stock covers a full change of every filter.' : 'Nothing fits that search.'}</p></div>`; return; }
  el.innerHTML = `<table><thead><tr><th>Size</th><th class="type-col">Type</th><th class="units-col">Used in</th>
      <th style="text-align:right">Needed</th><th style="text-align:right">In stock</th><th style="text-align:right">To order</th><th></th></tr></thead><tbody>
    ${rows.map(e => `<tr class="${e.spare ? 'stock-only' : ''}" data-key="${esc(e.key)}">
      <td class="mono">${esc(e.size)}<small class="m-only">${esc(e.kind)}</small></td><td class="type-col">${esc(e.kind) || '—'}</td>
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
  setFig('#bSizes', all.length);
  setFig('#bUse', all.reduce((a, e) => a + e.use, 0));
  setFig('#bStock', all.reduce((a, e) => a + e.stock, 0));
  setFig('#bOrder', all.reduce((a, e) => a + e.order, 0));
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
  $('#selectBtn').textContent = selectMode ? 'Done' : 'Select';
  $('#selectBtn').classList.toggle('primary', selectMode);
  if (!selectMode) return;
  const n = selected.size;
  $('#bulkCount').textContent = n ? `${n} selected` : 'Tap units to select them';
  ['#bulkSvc', '#bulkF', '#bulkB', '#bulkClear'].forEach(id => { $(id).disabled = !n; });
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
    <p class="hint">${p.count} unit${p.count === 1 ? '' : 's'}, ${num(tf)} filters and ${num(tb)} belts</p>
    <h3 class="section-title">Filters</h3>
    ${p.filters.length ? `<table><thead><tr><th>Size</th><th class="type-col">Type</th><th class="units-col">Used in</th><th style="text-align:right">Qty</th></tr></thead><tbody>
      ${p.filters.map(f => `<tr><td class="mono">${esc(f.size)}<small class="m-only">${esc(f.kind)}</small></td><td class="type-col">${esc(f.kind) || '—'}</td><td class="units-col">${[...f.units].map(esc).join(', ')}</td><td class="num">${qtyCell(f.qty, f.kind)}</td></tr>`).join('')}
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
function openModal(html, narrow) { fitModal(); modal.scrollTop = 0; modal.innerHTML = `<div class="dialog${narrow ? ' narrow' : ''}">${html}</div>`; modal.classList.add('open'); const f = modal.querySelector('[autofocus]'); if (f) f.focus(); }
function closeModal() { modal.classList.remove('open'); modal.innerHTML = ''; }
/* Phones: keep the open window inside the part of the screen the keyboard doesn't cover,
   and bring whatever box you tap into view once the keyboard is up. */
const vv = window.visualViewport;
function fitModal() {
  if (!vv) return;
  modal.style.top = vv.offsetTop + 'px';
  modal.style.height = vv.height + 'px';
}
if (vv) { vv.addEventListener('resize', fitModal); vv.addEventListener('scroll', fitModal); }
const isTouch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
document.addEventListener('focusin', e => {
  const el = e.target;
  if (!isTouch || !el.matches || !el.matches('input:not([type=checkbox]):not([type=radio]), textarea, select')) return;
  setTimeout(() => { if (document.activeElement === el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 320);
});
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
      <div class="dhead"><h2>${id ? 'Edit unit' : 'Add unit'}</h2><div class="dhead-actions"><button type="submit" class="btn primary sm">${id ? 'Save changes' : 'Add unit'}</button><button type="button" class="btn ghost" data-m="cancel" title="Close">✕</button></div></div>
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
        <div class="f" style="margin-top:14px"><label>Quick notes</label><textarea name="notes" rows="3" placeholder="What someone should know before working on it: access, ladder needed, filter rack quirks…">${esc(u.notes)}</textarea><p class="hint" style="margin-top:2px">Everyone who opens the site sees quick notes. Work done goes in the service record, which only signed-in users see.</p></div>
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
    if (id) { const old = S.units.find(x => x.id === id); if (old && old.log) rec.log = old.log; }
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
  try { await navigator.clipboard.writeText(txt); btn.textContent = 'Copied'; } catch (e) { btn.textContent = 'Copy blocked'; }
  setTimeout(() => btn.textContent = label, 1600);
}

/* ---------- events ---------- */
$('#list').addEventListener('click', e => {
  const gt = e.target.closest('.gtoggle');
  if (gt) {
    const sec = gt.closest('.group'), closed = sec.classList.toggle('closed');
    gt.setAttribute('aria-expanded', String(!closed));
    if (closed) closedGroups.add(sec.dataset.g); else closedGroups.delete(sec.dataset.g);
    return;
  }
  const gs = e.target.closest('[data-gsel]');
  if (gs) { gs.closest('.group').querySelectorAll('.unit').forEach(c => selected.add(c.dataset.id)); renderUnits(); return; }
  const ld = e.target.closest('[data-logdel]');
  if (ld && !PUBLIC) {
    const u = S.units.find(x => x.id === ld.closest('.unit').dataset.id);
    confirmBox('Delete this record?', '<p style="margin:0">Remove this entry from the unit’s service record?</p>', 'Delete', () => { u.log = (u.log || []).filter(l => l.id !== ld.dataset.logdel); render(); persist(); });
    return;
  }
  const qe = e.target.closest('[data-qnedit]');
  if (qe && !PUBLIC) {
    const box = qe.closest('[data-qn]'), u = S.units.find(x => x.id === qe.closest('.unit').dataset.id);
    box.innerHTML = `<div class="usec-head"><h4>Quick notes</h4></div>
      <textarea rows="3" data-qntext placeholder="What someone should know before working on this unit">${esc(u.notes || '')}</textarea>
      <div class="qn-actions"><button class="btn sm" type="button" data-qncancel>Cancel</button><button class="btn sm primary" type="button" data-qnsave>Save</button></div>`;
    const ta = box.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    return;
  }
  if (e.target.closest('[data-qncancel]')) { renderUnits(); return; }
  if (e.target.closest('[data-qnsave]')) {
    const box = e.target.closest('[data-qn]'), u = S.units.find(x => x.id === box.closest('.unit').dataset.id);
    u.notes = box.querySelector('[data-qntext]').value.trim(); render(); persist(); toast('Quick notes saved.');
    return;
  }
  const card = e.target.closest('.unit');
  if (selectMode) {
    if (!card) return;
    const id = card.dataset.id;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    renderUnits(); return;
  }
  const btn = e.target.closest('[data-act]');
  if (btn && !PUBLIC) {
    const act = btn.dataset.act;
    if (act === 'add') return editUnit();
    const id = card.dataset.id, u = S.units.find(x => x.id === id);
    if (act === 'edit') editUnit(id);
    else if (act === 'dup') editUnit(null, u);
    else if (act === 'fdone') markChanged([u], 'filters', thisMonth());
    else if (act === 'bdone') markChanged([u], 'belts', thisMonth());
    else if (act === 'del') confirmBox('Delete unit?', `<p style="margin:0">Remove <b>${esc(u.name)}</b> and everything recorded for it?</p>`, 'Delete', () => { S.units = S.units.filter(x => x.id !== id); render(); persist(); });
    return;
  }
  // tap a unit to open or close its details (not when the tap was inside the details, or selecting text)
  if (!card || e.target.closest('.ubody') || String(window.getSelection && window.getSelection()).length) return;
  const open = card.classList.toggle('open');
  card.querySelector('.urow').setAttribute('aria-expanded', String(open));
  if (open) openUnits.add(card.dataset.id); else openUnits.delete(card.dataset.id);
});
$('#list').addEventListener('submit', e => {
  const f = e.target.closest('[data-svcform]'); if (!f || PUBLIC) return;
  e.preventDefault();
  const text = f.elements.text.value.trim(); if (!text) { f.elements.text.focus(); return; }
  const u = S.units.find(x => x.id === f.closest('.unit').dataset.id); if (!u) return;
  const entry = svcEntry(f.elements.date.value || fmtD(today()), text);
  u.log = (u.log || []).concat(entry);
  render(); persist();
  toast(`Added to ${u.name}'s service record.`, () => { u.log = (u.log || []).filter(l => l.id !== entry.id); render(); persist(); toast('Undone.'); });
});
$('#typeChips').addEventListener('click', e => {
  const c = e.target.closest('.tchip'); if (!c) return;
  typeFilter = c.dataset.type; renderUnits();
});
$('#filterToggle').onclick = () => {
  const open = $('#filters').classList.toggle('open');
  $('#filterToggle').setAttribute('aria-expanded', String(open));
};
$('#clearFilters').onclick = () => {
  $('#q').value = ''; typeFilter = ''; ['fRoute', 'fStatus', 'fCool'].forEach(i => { $('#' + i).value = ''; });
  renderUnits();
};
$('#addBtn').onclick = () => editUnit();
$('#selectBtn').onclick = () => { selectMode = !selectMode; if (!selectMode) selected.clear(); renderUnits(); };
$('#bulkAll').onclick = () => { lastShown.forEach(id => selected.add(id)); renderUnits(); };
$('#bulkClear').onclick = () => { selected.clear(); renderUnits(); };
$('#bulkSvc').onclick = () => bulkServiceBox(selectedUnits());
function bulkServiceBox(list) {
  if (!list.length) return;
  const nF = list.filter(u => (u.filters || []).length).length, nB = list.filter(u => (u.belts || []).length).length;
  const names = list.map(u => u.name);
  openModal(`<form id="bsform" novalidate>
    <div class="dhead"><h2>Add a service record</h2><div class="dhead-actions"><button type="submit" class="btn primary sm">Add</button><button type="button" class="btn ghost" data-m="cancel" title="Close">✕</button></div></div>
    <div class="dbody">
      <p class="hint" style="margin-top:0">Goes on ${list.length} unit${list.length === 1 ? '' : 's'}: ${esc(names.slice(0, 12).join(', '))}${names.length > 12 ? ` and ${names.length - 12} more` : ''}.</p>
      <div class="grid" style="margin-top:12px">
        <div class="f c2"><label for="bs-date">Date of the work</label><input type="date" id="bs-date" name="date" value="${fmtD(today())}" required></div>
      </div>
      <div class="f" style="margin-top:10px"><label for="bs-text">What was done</label><textarea id="bs-text" name="text" rows="3" placeholder="Like “Bags and pre-filters changed”"></textarea></div>
      <fieldset><legend>Also update the change schedule</legend>
        <label class="check"${nF ? '' : ' hidden'}><input type="checkbox" name="filters"> Filters were changed${nF < list.length ? ` (${nF} of these units have filters)` : ''}</label>
        <label class="check" style="margin-top:8px"${nB ? '' : ' hidden'}><input type="checkbox" name="belts"> Belts were changed${nB < list.length ? ` (${nB} of these units have belts)` : ''}</label>
        <p class="hint">Sets the last-changed month to the month of this date, unless a unit already has a later one. Stock counts aren't changed, since this is past work.</p>
      </fieldset>
      <div class="err" id="bserr"></div>
    </div>
    <div class="dfoot"><button type="button" class="btn" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Add to ${list.length} unit${list.length === 1 ? '' : 's'}</button></div></form>`);
  const f = $('#bsform');
  f.querySelectorAll('[data-m=cancel]').forEach(b => b.onclick = closeModal);
  f.onsubmit = e => {
    e.preventDefault();
    const date = f.elements.date.value, doF = f.elements.filters.checked, doB = f.elements.belts.checked;
    let text = f.elements.text.value.trim();
    if (!date) { $('#bserr').textContent = 'Pick the date the work was done.'; return; }
    if (!text && !doF && !doB) { $('#bserr').textContent = 'Write what was done, or tick filters or belts.'; f.elements.text.focus(); return; }
    if (!text) text = doF && doB ? 'Filters and belts changed' : doF ? 'Filters changed' : 'Belts changed';
    const month = date.slice(0, 7), snap = list.map(u => [u.id, u.log, u.filterLast, u.beltLast]);
    let datesSet = 0;
    list.forEach(u => {
      u.log = (u.log || []).concat(svcEntry(date, text));
      if (doF && (u.filters || []).length && (monthIdx(u.filterLast) == null || monthIdx(month) > monthIdx(u.filterLast))) { u.filterLast = month; datesSet++; }
      if (doB && (u.belts || []).length && (monthIdx(u.beltLast) == null || monthIdx(month) > monthIdx(u.beltLast))) { u.beltLast = month; datesSet++; }
    });
    closeModal(); selected.clear(); selectMode = false; render(); persist();
    toast(`Service record added to ${list.length} unit${list.length === 1 ? '' : 's'}${datesSet ? ', change dates updated' : ''}.`, () => {
      snap.forEach(([id, log, fl, bl]) => { const u = S.units.find(x => x.id === id); if (u) { u.log = log; u.filterLast = fl; u.beltLast = bl; } });
      render(); persist(); toast('Undone.');
    });
  };
}
$('#bulkF').onclick = () => {
  const list = selectedUnits(), n = list.filter(u => (u.filters || []).length).length;
  confirmBox('Mark filters changed?', `<p style="margin:0">Mark filters changed this month on <b>${n} unit${n === 1 ? '' : 's'}</b> and take their filters out of stock?</p>`, 'Mark changed', () => { markChanged(list, 'filters', thisMonth()); selected.clear(); selectMode = false; renderUnits(); });
};
$('#bulkB').onclick = () => {
  const list = selectedUnits(), n = list.filter(u => (u.belts || []).length).length;
  confirmBox('Mark belts changed?', `<p style="margin:0">Mark belts changed this month on <b>${n} unit${n === 1 ? '' : 's'}</b> and take their belts out of stock?</p>`, 'Mark changed', () => { markChanged(list, 'belts', thisMonth()); selected.clear(); selectMode = false; renderUnits(); });
};
['q', 'fStatus', 'fCool', 'fRoute', 'sort', 'pScope', 'tq', 'tShort', 'bq', 'bShort', 'nq'].forEach(i => $('#' + i).addEventListener('input', render));
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
  $('#q').value = ''; typeFilter = ''; $('#fCool').value = ''; $('#fRoute').value = '';
  if ($('#sort').value === 'cool') $('#sort').value = 'group';
  if (k === 'cool') { $('#fCool').value = 'set'; $('#sort').value = 'cool'; }
  go('units');
});
function placeInk() {
  const t = document.querySelector('.tab[aria-selected="true"]'), ink = $('#tabInk'), bar = $('#tabs');
  if (!t || !t.offsetWidth) { ink.style.opacity = 0; return; }
  ink.style.opacity = 1; ink.style.width = t.offsetWidth + 'px'; ink.style.transform = `translateX(${t.offsetLeft}px)`;
  if (t.offsetLeft < bar.scrollLeft) bar.scrollLeft = t.offsetLeft - 12;
  else if (t.offsetLeft + t.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = t.offsetLeft + t.offsetWidth - bar.clientWidth + 12;
}
window.addEventListener('resize', placeInk);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeInk);
function go(name) { if (location.hash.slice(1) === name) route(); else location.hash = name; }
function route() {
  const h = location.hash.slice(1);
  if (h === 'notes-cooling' || h === 'notes-heating') { view = 'notes'; noteTab = h.slice(6); }
  else if (h === 'notes') view = 'notes';
  else if (h === 'today' && !PUBLIC) view = 'today';
  else view = ['units', 'totals', 'belts', 'parts'].includes(h) ? h : 'units';
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  ['units', 'totals', 'belts', 'parts', 'notes', 'today'].forEach(v => { $('#view-' + v).hidden = v !== view; });
  placeInk();
  render();
}
window.addEventListener('hashchange', route);

applyMode();
$('#signInBtn').onclick = () => authBox('in');
$('#signOutBtn').onclick = async () => { if (sb) { clearTimeout(saveTimer); if (!PUBLIC && $('#save').classList.contains('busy')) await saveWeb(); await sb.auth.signOut(); } };
$('#todayText').addEventListener('input', () => { try { localStorage.setItem('fbt-today-draft', $('#todayText').value); } catch (e) {} renderToday(); });
$('#todayDate').addEventListener('input', renderToday);
$('#todayApply').onclick = applyToday;
$('#todayClear').onclick = () => { $('#todayText').value = ''; try { localStorage.removeItem('fbt-today-draft'); } catch (e) {} renderToday(); };
try { const d = localStorage.getItem('fbt-today-draft'); if (d) $('#todayText').value = d; } catch (e) {}
route();
initStorage();
})();
