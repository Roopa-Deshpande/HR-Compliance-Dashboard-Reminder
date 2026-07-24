// Dashboard rendering — adapted from the original static tracker, but now
// driven by realtime Firestore data instead of in-memory arrays. Every
// mutation (add / delete / mark-done) goes through db.js, which persists
// it, syncs it to every open browser instantly, and writes an audit entry.
import { subscribeRecords, addRecord, updateRecord, deleteRecord, toggleRecordDone, toDate } from "./db.js";
import { subscribeAuditLog, deleteAuditEntry } from "./audit.js";
import { subscribeUsers, createUser, setUserRole, setUserActive, updateUserProfile, deleteUserProfile } from "./admin.js";
import { currentUser, isAdmin } from "./auth.js";

const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// ── Local realtime caches (kept fresh by Firestore onSnapshot) ──────
let monthly = [], quarterly = [], clra = [], hyEsic = [], hyPt = [], yearly = [], licenses = [], auditRows = [], users = [];

let activeMonthIdx = new Date().getMonth();
let activeCatFilter = 'all';
let activeLocFilter = 'all';
let activeLicFilter = 'all';
let currentAddSection = 'monthly';
let reminderDays = 7;

// Indian fiscal year: 1 Apr – 31 Mar. "2026-27" means Apr 2026–Mar 2027.
// Licenses aren't tagged with a fiscal year — a license's validity isn't
// tied to one FY the way a monthly/quarterly/yearly filing is, so the
// Licenses tab always shows everything regardless of the switcher below.
function computeFiscalYear(date) {
  if (!date) return null;
  const y = date.getFullYear(), m = date.getMonth(); // 0-indexed, April = 3
  return m >= 3 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}
let activeFiscalYear = computeFiscalYear(new Date());
function fyLabel(fy) { return fy ? `FY ${fy}` : '–'; }

function fmt(d) { return (!d || isNaN(d)) ? '–' : d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); }
function fmtShort(d) { return (!d || isNaN(d)) ? '–' : d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' }); }
function fmtDateTime(d) { return (!d || isNaN(d)) ? '–' : d.toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }

function getStatus(date) {
  if (!date) return 'upcoming';
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(date); d.setHours(0,0,0,0);
  const diff = (d - today) / 86400000;
  if (diff < 0) return 'overdue';
  if (diff <= 7) return 'due-soon';
  return 'upcoming';
}
function statusPill(status, done) {
  if (done) return `<span class="status-pill status-done"><span class="status-dot"></span>Done</span>`;
  if (status === 'overdue') return `<span class="status-pill status-overdue"><span class="status-dot"></span>Overdue</span>`;
  if (status === 'due-soon') return `<span class="status-pill status-due-soon"><span class="status-dot"></span>Due Soon</span>`;
  return `<span class="status-pill status-upcoming"><span class="status-dot"></span>Upcoming</span>`;
}
function catBadge(cat) {
  const map = { PF:'cat-pf', ESI:'cat-esi', PT:'cat-pt', LWF:'cat-lwf', Bonus:'cat-bonus', Gratuity:'cat-grat', SE:'cat-se', CLRA:'cat-clra' };
  const lbl = { PF:'Provident Fund', ESI:'ESI', PT:'Prof. Tax', LWF:'Labour WF', Bonus:'Bonus', Gratuity:'Gratuity', SE:'S&E', CLRA:'CLRA' };
  return `<span class="cat-badge ${map[cat]||'cat-se'}">${lbl[cat]||cat}</span>`;
}
function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Small inline icon set reused across JS-generated markup — kept as plain
// SVG strings (no icon library dependency) so generated HTML stays cheap.
const ICONS = {
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>`,
  alertTriangle: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  alertOctagon: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9Z"/><path d="M12 8v4M12 16h.01"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
  mapPin: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>`,
  barChart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`,
  calClock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/></svg>`,
  clipboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3M16 3v3M6 21h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/><path d="m9 14 2 2 4-4"/></svg>`,
  building: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6"/></svg>`,
  fileText: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>`,
  checkCircle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.3 2.3L16 10"/></svg>`,
  alertCircle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>`,
  inbox: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7Z"/></svg>`,
};
const TYPE_ICON_SVG = { monthly: ICONS.calendar, quarterly: ICONS.barChart, clra: ICONS.barChart, halfyearly_esic: ICONS.calClock, halfyearly_pt: ICONS.calClock, yearly: ICONS.clipboard, license: ICONS.building };

function delBtnHtml(id, type, summary) {
  return `<button class="del-btn" onclick="appDeleteRecord('${id}','${type}','${esc(summary).replace(/'/g,"\\'")}')" title="Delete">${ICONS.trash}</button>`;
}
function emptyStateHtml(title, sub) {
  return `<div class="empty-state"><span class="icon">${ICONS.inbox}</span><div class="empty-state-title">${title}</div>${sub ? `<div>${sub}</div>` : ''}</div>`;
}

// ═══════════════════════════════════════════
// TOASTS & CONFIRM DIALOG — replace native alert()/confirm() with styled
// UI. Same trigger points, same messages; purely a presentation swap.
// ═══════════════════════════════════════════
export function showToast(message, type = 'info') {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const icon = type === 'success' ? ICONS.checkCircle : type === 'error' ? ICONS.alertCircle : ICONS.info;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${esc(message)}</span><button class="toast-close" aria-label="Dismiss">×</button>`;
  const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 180); };
  el.querySelector('.toast-close').onclick = remove;
  stack.appendChild(el);
  setTimeout(remove, 4200);
}

export function showConfirm(message, { title = 'Are you sure?', confirmLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmDialog');
    if (!overlay) { resolve(window.confirm(message)); return; }
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = message;
    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    okBtn.textContent = confirmLabel;
    overlay.classList.add('show');
    const cleanup = (result) => {
      overlay.classList.remove('show');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
  });
}

// ═══════════════════════════════════════════
// SUBSCRIPTIONS
// ═══════════════════════════════════════════
export function initDashboard() {
  document.querySelectorAll('.fy-switch-btn').forEach(b => b.classList.toggle('active', b.dataset.fy === activeFiscalYear));
  const unsubs = [];
  unsubs.push(subscribeRecords('monthly', rows => {
    monthly = rows.map(r => { const date = toDate(r.fields.date); return { id: r.id, done: r.done, ...r.fields, date, fiscalYear: r.fields.fiscalYear || computeFiscalYear(date) }; });
    buildLocFilter(); buildMonthTabs(); renderMonthlyTable(activeMonthIdx); updateSummary(); buildReminders();
  }));
  unsubs.push(subscribeRecords('quarterly', rows => {
    quarterly = rows.map(r => { const due = toDate(r.fields.due); return { id: r.id, done: r.done, ...r.fields, due, fiscalYear: r.fields.fiscalYear || computeFiscalYear(due) }; });
    renderQuarterlyTable();
  }));
  unsubs.push(subscribeRecords('clra', rows => {
    clra = rows.map(r => { const due = toDate(r.fields.due); return { id: r.id, done: r.done, ...r.fields, due, fiscalYear: r.fields.fiscalYear || computeFiscalYear(due) }; });
    renderQuarterlyTable();
  }));
  unsubs.push(subscribeRecords('halfyearly_esic', rows => {
    hyEsic = rows.map(r => { const due = toDate(r.fields.due); return { id: r.id, done: r.done, ...r.fields, due, fiscalYear: r.fields.fiscalYear || computeFiscalYear(due) }; });
    renderHalfYearlyTables();
  }));
  unsubs.push(subscribeRecords('halfyearly_pt', rows => {
    hyPt = rows.map(r => { const due = toDate(r.fields.due); return { id: r.id, done: r.done, ...r.fields, due, fiscalYear: r.fields.fiscalYear || computeFiscalYear(due) }; });
    renderHalfYearlyTables();
  }));
  unsubs.push(subscribeRecords('yearly', rows => {
    yearly = rows.map(r => { const dateObj = toDate(r.fields.dateObj); return { id: r.id, done: r.done, ...r.fields, dateObj, fiscalYear: r.fields.fiscalYear || computeFiscalYear(dateObj) }; });
    renderYearlyTable();
  }));
  unsubs.push(subscribeRecords('license', rows => {
    licenses = rows.map(r => ({ id: r.id, done: r.done, ...r.fields, expiry: toDate(r.fields.expiry) }));
    renderLicenses();
  }));
  unsubs.push(subscribeAuditLog(rows => {
    auditRows = rows.map(r => ({ ...r, timestamp: toDate(r.timestamp) }));
    renderAuditLog();
  }));
  unsubs.push(subscribeUsers(rows => {
    users = rows;
    renderUsersPanel();
  }));
  return unsubs;
}

// ═══════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════
export function switchTab(id, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  el.classList.add('active');
}

// Same as switchTab, but callable without already having the nav element
// in hand (e.g. from a search result click) — looks it up by data-tab.
function switchTabById(id) {
  const el = document.querySelector(`.main-tab[data-tab="${id}"]`);
  if (el) switchTab(id, el);
}

// ═══════════════════════════════════════════
// FISCAL YEAR SWITCHER
// ═══════════════════════════════════════════
export function switchFiscalYear(fy) {
  activeFiscalYear = fy;
  document.querySelectorAll('.fy-switch-btn').forEach(b => b.classList.toggle('active', b.dataset.fy === fy));
  buildLocFilter(); buildMonthTabs(); renderMonthlyTable(activeMonthIdx); updateSummary();
  renderQuarterlyTable(); renderHalfYearlyTables(); renderYearlyTable();
}

export function getActiveFiscalYear() { return activeFiscalYear; }

// ═══════════════════════════════════════════
// MONTHLY TABLE
// ═══════════════════════════════════════════
function buildLocFilter() {
  const wrap = document.getElementById('locFilterWrap');
  if (!wrap) return;
  const allLocs = ['all', ...new Set(monthly.filter(d => d.fiscalYear === activeFiscalYear).map(d => d.loc))].filter(Boolean);
  let html = '<span class="loc-filter-label">Location:</span>';
  allLocs.forEach(l => {
    const lbl = l === 'all' ? 'All' : l;
    html += `<button class="filter-btn ${l===activeLocFilter?'active':''}" onclick="appFilterLoc('${l}',this)">${lbl}</button>`;
  });
  wrap.innerHTML = html;
}
export function filterLoc(loc, btn) {
  activeLocFilter = loc;
  document.querySelectorAll('#locFilterWrap .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderMonthlyTable(activeMonthIdx);
}
export function filterCat(cat, btn) {
  activeCatFilter = cat;
  document.querySelectorAll('#panel-monthly .filter-row .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderMonthlyTable(activeMonthIdx);
}

function renderMonthlyTable(mIdx) {
  activeMonthIdx = mIdx;
  const tbody = document.getElementById('complianceTbody');
  if (!tbody) return;
  let filtered = monthly
    .filter(d => d.fiscalYear === activeFiscalYear)
    .filter(d => d.date && d.date.getMonth() === mIdx)
    .filter(d => activeCatFilter === 'all' || d.cat === activeCatFilter)
    .filter(d => activeLocFilter === 'all' || d.loc === activeLocFilter)
    .sort((a,b) => a.date - b.date);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7">${emptyStateHtml('Nothing due this month', monthly.some(d=>d.fiscalYear===activeFiscalYear) ? 'Try a different month or filter.' : `Nothing imported for ${fyLabel(activeFiscalYear)} yet.`)}</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(item => {
    const status = getStatus(item.date);
    return `<tr data-record-id="${item.id}" style="${item.done?'opacity:0.5':''}">
      <td><input type="checkbox" class="done-check" ${item.done?'checked':''} onchange="appToggleDone('${item.id}','monthly',this,${JSON.stringify(item.desc)})" title="Mark done"></td>
      <td class="date-cell">${fmt(item.date)}</td>
      <td class="desc-cell">${esc(item.desc)}${item.notes ? `<br><span style="color:var(--text-muted);font-size:11px">${esc(item.notes)}</span>` : ''}</td>
      <td>${catBadge(item.cat)}</td>
      <td><span class="location-tag">${esc(item.loc)||'–'}</span></td>
      <td>${statusPill(status, item.done)}</td>
      <td>${delBtnHtml(item.id, 'monthly', item.desc)}</td>
    </tr>`;
  }).join('');
}

export async function toggleDone(id, type, cb, summary) {
  try {
    await toggleRecordDone(id, type, {}, cb.checked, summary);
  } catch (e) { showToast('Could not update: ' + e.message, 'error'); cb.checked = !cb.checked; }
}

export async function deleteEntry(id, type, summary) {
  if (!(await showConfirm(`Delete "${summary}"?`, { title: 'Delete entry', confirmLabel: 'Delete' }))) return;
  try { await deleteRecord(id, type, {}, summary); showToast('Entry deleted.', 'success'); }
  catch (e) { showToast('Could not delete: ' + e.message, 'error'); }
}

function buildMonthTabs() {
  const tabs = document.getElementById('monthTabs');
  if (!tabs) return;
  const overdueMonths = new Set();
  monthly.forEach(item => { if (item.fiscalYear === activeFiscalYear && !item.done && item.date && getStatus(item.date) === 'overdue') overdueMonths.add(item.date.getMonth()); });
  tabs.innerHTML = '';
  months.forEach((m, i) => {
    const btn = document.createElement('div');
    btn.className = 'month-tab' + (i === activeMonthIdx ? ' active' : '');
    btn.innerHTML = m + (overdueMonths.has(i) ? '<span class="dot"></span>' : '');
    btn.onclick = () => {
      activeMonthIdx = i;
      document.querySelectorAll('.month-tab').forEach((t,j) => t.classList.toggle('active', j===i));
      renderMonthlyTable(i);
    };
    tabs.appendChild(btn);
  });
}

function updateSummary() {
  const today = new Date(); today.setHours(0,0,0,0);
  const fyItems = monthly.filter(item => item.fiscalYear === activeFiscalYear);
  let overdue=0, thisMonth=0, upcoming=0, pf=0, esi=0, other=0;
  fyItems.forEach(item => {
    if (!item.done && item.date) {
      const d = new Date(item.date); d.setHours(0,0,0,0);
      const diff = (d - today) / 86400000;
      if (diff < 0) overdue++;
      else if (d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear()) thisMonth++;
      else if (diff <= 30) upcoming++;
    }
    if (item.cat === 'PF') pf++; else if (item.cat === 'ESI') esi++; else other++;
  });
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('cnt-overdue', overdue); set('cnt-month', thisMonth); set('cnt-upcoming', upcoming);
  set('cnt-pf', pf); set('cnt-esi', esi); set('cnt-other', other);
  set('tc-monthly', overdue + thisMonth);
  renderStatusBreakdown(fyItems);
}

// Status-breakdown chart: a single segmented proportion bar + labeled
// legend (status color + icon-free text label, never color alone) — every
// monthly item in the active fiscal year, bucketed into the same four
// states already used by statusPill().
function renderStatusBreakdown(items) {
  const bar = document.getElementById('statusBreakdownBar');
  const legend = document.getElementById('statusBreakdownLegend');
  if (!bar || !legend) return;
  let overdueN = 0, dueSoonN = 0, upcomingN = 0, doneN = 0;
  items.forEach(item => {
    if (item.done) { doneN++; return; }
    const s = getStatus(item.date);
    if (s === 'overdue') overdueN++; else if (s === 'due-soon') dueSoonN++; else upcomingN++;
  });
  const total = items.length;
  const segs = [
    { label: 'Overdue', count: overdueN, color: 'var(--status-critical)' },
    { label: 'Due Soon', count: dueSoonN, color: 'var(--status-warning)' },
    { label: 'Upcoming', count: upcomingN, color: 'var(--status-good)' },
    { label: 'Done', count: doneN, color: 'var(--gray-400)' },
  ];
  if (!total) {
    bar.innerHTML = `<div class="status-bar-seg" style="width:100%;background:var(--gray-100)"></div>`;
    legend.innerHTML = `<div class="status-bar-legend-item">No items for ${fyLabel(activeFiscalYear)} yet.</div>`;
    return;
  }
  bar.innerHTML = segs.filter(s => s.count > 0).map(s => `<div class="status-bar-seg" style="width:${(s.count/total*100).toFixed(2)}%;background:${s.color}" title="${s.label}: ${s.count}"></div>`).join('');
  legend.innerHTML = segs.map(s => `<div class="status-bar-legend-item"><span class="status-bar-dot" style="background:${s.color}"></span>${s.label} <strong>${s.count}</strong></div>`).join('');
}

// ═══════════════════════════════════════════
// QUARTERLY / CLRA
// ═══════════════════════════════════════════
function renderQuarterlyTable() {
  const tbody = document.getElementById('quarterlyTbody');
  if (tbody) {
    tbody.innerHTML = quarterly.filter(r => r.fiscalYear === activeFiscalYear).map((row, i) => {
      const status = getStatus(row.due);
      const period = row.from && row.to ? `${row.from} – ${row.to}` : (row.period || '–');
      return `<tr data-record-id="${row.id}">
        <td>${i+1}</td>
        <td class="loc">${esc(row.loc)||'–'}</td>
        <td>${esc(period)}</td>
        <td class="date-cell">${fmt(row.due)}</td>
        <td>${row.submitted ? `<span style="color:var(--status-good);font-weight:600">${esc(row.submitted)}</span>` : '<em style="color:var(--text-muted)">Pending</em>'}</td>
        <td>${row.submitted ? statusPill('done',true) : statusPill(status,false)}</td>
        <td style="display:flex;gap:4px;align-items:center"><input type="checkbox" class="done-check" ${row.submitted?'checked':''} onchange="appQuarterlyDone('${row.id}',this)">${delBtnHtml(row.id,'quarterly', period)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="7">${emptyStateHtml('No entries yet', `Nothing for ${fyLabel(activeFiscalYear)}.`)}</td></tr>`;
  }
  const clraTbody = document.getElementById('clraTbody');
  if (clraTbody) {
    clraTbody.innerHTML = clra.filter(r => r.fiscalYear === activeFiscalYear).map((row, i) => {
      const status = getStatus(row.due);
      return `<tr data-record-id="${row.id}">
        <td>${i+1}</td>
        <td class="loc">${esc(row.loc)||'–'}</td>
        <td style="font-size:12px">${esc(row.contractors)||'–'}</td>
        <td>${esc(row.period)||'–'}</td>
        <td class="date-cell">${fmt(row.due)}</td>
        <td style="display:flex;gap:4px;align-items:center">${statusPill(status, row.done)}${delBtnHtml(row.id,'clra', row.period||row.loc)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="6">${emptyStateHtml('No entries yet', `Nothing for ${fyLabel(activeFiscalYear)}.`)}</td></tr>`;
  }
}

export async function quarterlyDone(id, cb) {
  const row = quarterly.find(r => r.id === id);
  if (!row) return;
  try { await updateRecord(id, 'quarterly', { submitted: row.submitted }, { ...stripId(row), submitted: cb.checked ? 'Marked done' : '' }, row.loc); }
  catch (e) { showToast('Could not update: ' + e.message, 'error'); cb.checked = !cb.checked; }
}
function stripId(r) { const { id, ...rest } = r; return rest; }

// ═══════════════════════════════════════════
// HALF-YEARLY
// ═══════════════════════════════════════════
function renderHalfYearlyTables() {
  const esicTbody = document.getElementById('halfYearlyEsicTbody');
  if (esicTbody) {
    const doneClass = v => v === 'Done' ? `<span style="color:var(--status-good);font-weight:600">✓</span>` : `<span style="color:var(--gray-300)">–</span>`;
    esicTbody.innerHTML = hyEsic.filter(r => r.fiscalYear === activeFiscalYear).map((row, i) => {
      const status = getStatus(row.due);
      return `<tr data-record-id="${row.id}">
        <td>${i+1}</td><td>${esc(row.period)}</td><td class="date-cell">${fmt(row.due)}</td>
        <td>${doneClass(row.blr)}</td><td>${doneClass(row.coorg)}</td><td>${doneClass(row.kabini)}</td>
        <td>${doneClass(row.hampi)}</td><td>${doneClass(row.eblr)}</td><td>${doneClass(row.ewd)}</td><td>${doneClass(row.tl)}</td>
        <td style="display:flex;gap:4px;align-items:center">${statusPill(status, row.blr === 'Done')}${delBtnHtml(row.id,'halfyearly_esic', row.period)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="11">${emptyStateHtml('No entries yet', `Nothing for ${fyLabel(activeFiscalYear)}.`)}</td></tr>`;
  }
  const ptTbody = document.getElementById('halfYearlyPtTbody');
  if (ptTbody) {
    ptTbody.innerHTML = hyPt.filter(r => r.fiscalYear === activeFiscalYear).map((row,i) => {
      const status = getStatus(row.due);
      return `<tr data-record-id="${row.id}">
        <td>${i+1}</td><td>${esc(row.period)}</td><td class="date-cell">${fmt(row.due)}</td><td class="loc">${esc(row.loc)}</td>
        <td style="display:flex;gap:4px;align-items:center">${statusPill(status, row.status === 'Done')}${delBtnHtml(row.id,'halfyearly_pt', row.period)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="5">${emptyStateHtml('No entries yet', `Nothing for ${fyLabel(activeFiscalYear)}.`)}</td></tr>`;
  }
}

// ═══════════════════════════════════════════
// YEARLY
// ═══════════════════════════════════════════
function renderYearlyTable() {
  const tbody = document.getElementById('yearlyTbody');
  if (!tbody) return;
  tbody.innerHTML = yearly.filter(r => r.fiscalYear === activeFiscalYear).map((row,i) => {
    const status = row.dateObj ? getStatus(row.dateObj) : 'upcoming';
    const doneClass = v => v === '✓' ? `<span style="color:var(--status-good);font-weight:700">✓</span>` : `<span style="color:var(--gray-300);font-size:11px">${esc(v)||'–'}</span>`;
    return `<tr data-record-id="${row.id}">
      <td>${i+1}</td>
      <td><strong style="font-size:13px">${esc(row.name)}</strong></td>
      <td style="font-size:11px;color:var(--text-muted)">${esc(row.act)||'–'}</td>
      <td class="date-cell" style="font-size:12px">${esc(row.due)||'–'}</td>
      <td style="font-size:11px">${esc(row.mode)||'–'}</td>
      <td>${doneClass(row.blr)}</td><td>${doneClass(row.coorg)}</td><td>${doneClass(row.kabini)}</td>
      <td>${doneClass(row.hampi)}</td><td>${doneClass(row.ear)}</td><td>${doneClass(row.tl)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${esc(row.others)||'–'}</td>
      <td style="display:flex;gap:4px;align-items:center">${statusPill(status, row.done)}${delBtnHtml(row.id,'yearly', row.name)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="13">${emptyStateHtml('No entries yet', `Nothing for ${fyLabel(activeFiscalYear)}.`)}</td></tr>`;
}

// ═══════════════════════════════════════════
// LICENSES
// ═══════════════════════════════════════════
export function filterLic(type, btn) {
  activeLicFilter = type;
  document.querySelectorAll('#panel-licenses .filter-row .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderLicenses();
}

function renderLicenses() {
  const today = new Date(); today.setHours(0,0,0,0);
  const typeMap = { SE:'lt-se', EPFO:'lt-epf', ESIC:'lt-esic', PT:'lt-pt', Factory:'lt-factory', CLRA:'lt-clra', ISMW:'lt-clra' };
  const typeLbl = { SE:'Shops & Establishment', EPFO:'EPFO / PF', ESIC:'ESIC', PT:'Prof. Tax (EC/RC)', Factory:'Factory License', CLRA:'CLRA', ISMW:'ISMW' };

  const filtered = licenses.filter(l => activeLicFilter === 'all' || l.type === activeLicFilter);
  const grid = document.getElementById('licenseGrid');
  if (!grid) return;
  grid.innerHTML = '';
  let count = 0;

  filtered.forEach((lic) => {
    let daysToExpiry = null, expired = false, expiringSoon = false;
    if (lic.expiry) {
      const expD = new Date(lic.expiry); expD.setHours(0,0,0,0);
      daysToExpiry = Math.ceil((expD - today) / 86400000);
      expired = daysToExpiry < 0; expiringSoon = daysToExpiry >= 0 && daysToExpiry <= 180;
    }
    let limitNear = false, limitExceeded = false, pct = 0;
    if (lic.limit && lic.current !== null && lic.current !== undefined) {
      pct = Math.round((lic.current / lic.limit) * 100);
      limitNear = pct >= 80 && pct < 100; limitExceeded = pct >= 100;
    }
    let cardClass = 'license-card';
    if (expired || limitExceeded) cardClass += ' expired'; else if (expiringSoon || limitNear) cardClass += ' expiring-soon';

    let expiryHtml = '–', expiryClass = 'ok';
    if (lic.expiry) {
      if (expired) { expiryHtml = fmtShort(lic.expiry); expiryClass = 'danger'; }
      else if (expiringSoon) { expiryHtml = `${fmtShort(lic.expiry)} (${daysToExpiry}d left)`; expiryClass = 'warn'; }
      else { expiryHtml = fmtShort(lic.expiry); expiryClass = 'ok'; }
    } else if (['EPFO','ESIC'].includes(lic.type)) { expiryHtml = 'Permanent'; expiryClass = 'ok'; }
    else if (lic.type === 'PT') { expiryHtml = 'Renew Annually'; expiryClass = ''; }

    let empBarHtml = '';
    if (lic.limit && (lic.current !== null && lic.current !== undefined)) {
      const barClass = limitExceeded ? 'danger' : limitNear ? 'warn' : 'safe';
      empBarHtml = `<div class="employee-bar-wrap"><div class="employee-bar-label"><span>Employees</span><strong>${lic.current} / ${lic.limit} (${pct}%)</strong></div><div class="emp-bar"><div class="emp-bar-fill ${barClass}" style="width:${Math.min(pct,100)}%"></div></div></div>`;
      if (limitExceeded) empBarHtml += `<div class="license-alert-tag red">${ICONS.alertTriangle} LIMIT EXCEEDED – Amend License</div>`;
      else if (limitNear) empBarHtml += `<div class="license-alert-tag">${ICONS.alertTriangle} 80%+ Capacity – Plan Renewal</div>`;
    }
    let alertHtml = '';
    if (expired) alertHtml = `<div class="license-alert-tag red">${ICONS.alertOctagon} EXPIRED – Renew Immediately</div>`;
    else if (expiringSoon) alertHtml = `<div class="license-alert-tag">${ICONS.clock} Expiring in ${daysToExpiry} days</div>`;

    const folderHtml = `<div class="license-folder">${ICONS.folder} Document in folder: <span class="${lic.folder==='Yes'?'folder-yes':lic.folder==='No'?'folder-no':''}">${esc(lic.folder)}</span></div>`;

    grid.insertAdjacentHTML('beforeend', `
      <div class="${cardClass}" data-record-id="${lic.id}">
        <div class="license-card-header">
          <div><div class="license-card-title">${esc(lic.company)}</div><div class="license-card-company">${ICONS.mapPin} ${esc(lic.loc)}</div></div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="license-type-badge ${typeMap[lic.type]||'lt-se'}">${typeLbl[lic.type]||lic.type}</span>
            ${delBtnHtml(lic.id,'license', lic.company)}
          </div>
        </div>
        <div class="license-meta">
          <div class="license-meta-item"><div class="lm-label">Expiry / Validity</div><div class="lm-val ${expiryClass}">${expiryHtml}</div></div>
          <div class="license-meta-item"><div class="lm-label">Status</div><div class="lm-val">${expired ? '<span style="color:var(--status-critical)">Expired</span>' : expiringSoon ? '<span style="color:var(--status-warning)">Expiring Soon</span>' : '<span style="color:var(--status-good)">Valid</span>'}</div></div>
        </div>
        ${empBarHtml}${alertHtml}
        ${lic.remarks ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px">${esc(lic.remarks)}</div>` : ''}
        ${folderHtml}
      </div>`);
    count++;
  });

  if (!count) grid.innerHTML = `<div style="grid-column:1/-1">${emptyStateHtml('No licenses for this filter', 'Try a different filter, or add one.')}</div>`;
  const expiredCount = licenses.filter(l => l.expiry && l.expiry < new Date()).length;
  const tcLic = document.getElementById('tc-lic');
  if (tcLic) tcLic.textContent = expiredCount;
}

// ═══════════════════════════════════════════
// ADD MODALS
// ═══════════════════════════════════════════
export function openAddModal(section) {
  currentAddSection = section;
  const title = document.getElementById('addModalTitle');
  if (title) title.textContent = `Add Entry – ${section.charAt(0).toUpperCase()+section.slice(1)}`;
  const catRow = document.getElementById('f-cat-row');
  if (catRow) catRow.style.display = section === 'monthly' ? '' : 'none';
  document.getElementById('addModal').classList.add('show');
}
export function openAddLicModal() { document.getElementById('addLicModal').classList.add('show'); }
export function closeModal(id) { document.getElementById(id).classList.remove('show'); }

export async function saveNewEntry() {
  const dateVal = document.getElementById('f-date').value;
  const desc = document.getElementById('f-desc').value.trim();
  if (!dateVal || !desc) { showToast('Please fill in date and description.', 'error'); return; }
  const loc = document.getElementById('f-loc').value;
  const notes = document.getElementById('f-notes').value.trim();
  const dateObj = new Date(dateVal);
  const fiscalYear = computeFiscalYear(dateObj);

  try {
    if (currentAddSection === 'monthly') {
      await addRecord('monthly', { date: dateObj, desc, cat: document.getElementById('f-cat').value, loc, reminderDays: parseInt(document.getElementById('f-reminder').value) || 7, notes, fiscalYear }, desc);
    } else if (currentAddSection === 'quarterly') {
      await addRecord('quarterly', { loc, period: desc, due: dateObj, submitted: '', note: notes, fiscalYear }, desc);
    } else if (currentAddSection === 'halfyearly') {
      await addRecord('halfyearly_pt', { loc, period: desc, due: dateObj, status: '', fiscalYear }, desc);
    } else if (currentAddSection === 'yearly') {
      await addRecord('yearly', { name: desc, act: notes || '–', due: dateVal, mode: '–', loc, blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj, fiscalYear }, desc);
    }
    closeModal('addModal');
    ['f-date','f-desc','f-notes'].forEach(id => document.getElementById(id).value = '');
    showToast('Entry added.', 'success');
  } catch (e) { showToast('Could not save: ' + e.message, 'error'); }
}

export async function saveNewLicense() {
  const company = document.getElementById('lf-company').value.trim();
  if (!company) { showToast('Company name required.', 'error'); return; }
  const expiryVal = document.getElementById('lf-expiry').value;
  const fields = {
    company, loc: document.getElementById('lf-loc').value, type: document.getElementById('lf-type').value,
    expiry: expiryVal ? new Date(expiryVal) : null,
    limit: parseInt(document.getElementById('lf-limit').value) || null,
    current: parseInt(document.getElementById('lf-current').value) || null,
    folder: document.getElementById('lf-folder').value,
    remarks: document.getElementById('lf-remarks').value.trim(),
  };
  try {
    await addRecord('license', fields, company);
    closeModal('addLicModal');
    ['lf-company','lf-expiry','lf-limit','lf-current','lf-remarks'].forEach(id => document.getElementById(id).value = '');
    showToast('License added.', 'success');
  } catch (e) { showToast('Could not save: ' + e.message, 'error'); }
}

// ═══════════════════════════════════════════
// REMINDERS — lightweight in-app banner only; the bell icon / settings
// panel were removed in favor of real email notifications (see the
// scheduled email reminder script under scripts/).
// ═══════════════════════════════════════════
function buildReminders() {
  const today = new Date(); today.setHours(0,0,0,0);
  const items = monthly.filter(item => {
    if (!item.date || item.done) return false;
    const d = new Date(item.date); d.setHours(0,0,0,0);
    const diff = (d - today) / 86400000;
    return diff >= 0 && diff <= reminderDays;
  }).sort((a,b) => a.date - b.date).slice(0, 8);

  if (items.length > 0) {
    const list = items.map(i => `• ${fmt(i.date)} – ${esc(i.desc.substring(0,60))}... (${esc(i.loc)})`).join('<br>');
    document.getElementById('reminderBannerList').innerHTML = list;
    document.getElementById('reminderBanner').classList.add('show');
  }
}
export function toggleSharePanel() {
  document.getElementById('sharePanel').classList.toggle('show');
}

// ═══════════════════════════════════════════
// EXPORT (Administrator only)
// ═══════════════════════════════════════════
export function exportCSV() {
  if (!isAdmin()) { showToast('Only the Administrator can export reports.', 'error'); return; }
  const rows = [['Section','Date','Description','Category','Location','Status']];
  monthly.forEach(i => rows.push(['Monthly', fmt(i.date), i.desc, i.cat, i.loc, i.done ? 'Done' : getStatus(i.date)]));
  quarterly.forEach(i => rows.push(['Quarterly', fmt(i.due), i.period || `${i.from||''} - ${i.to||''}`, '', i.loc, i.submitted ? 'Submitted' : getStatus(i.due)]));
  clra.forEach(i => rows.push(['CLRA', fmt(i.due), i.period, '', i.loc, getStatus(i.due)]));
  hyEsic.forEach(i => rows.push(['Half-Yearly ESIC', fmt(i.due), i.period, 'ESIC', '', getStatus(i.due)]));
  hyPt.forEach(i => rows.push(['Half-Yearly PT', fmt(i.due), i.period, 'PT', i.loc, i.status || getStatus(i.due)]));
  yearly.forEach(i => rows.push(['Yearly', i.due, i.name, i.act, '', i.done ? 'Done' : 'Pending']));
  licenses.forEach(i => rows.push(['License', i.expiry ? fmt(i.expiry) : '', i.company, i.type, i.loc, i.expiry && i.expiry < new Date() ? 'Expired' : 'Valid']));
  const csv = rows.map(r => r.map(c => `"${(c ?? '').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'HR_Compliance_Export.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ═══════════════════════════════════════════
// AUDIT LOG (view: everyone · delete: admin only)
// ═══════════════════════════════════════════
function renderAuditLog() {
  const tbody = document.getElementById('auditTbody');
  if (!tbody) return;
  if (!auditRows.length) { tbody.innerHTML = `<tr><td colspan="7">${emptyStateHtml('No activity recorded yet', 'Every change will show up here.')}</td></tr>`; return; }
  tbody.innerHTML = auditRows.map(r => `
    <tr>
      <td>${fmtDateTime(r.timestamp)}</td>
      <td>${esc(r.userName)}<br><span style="font-size:11px;color:var(--text-muted)">${esc(r.userEmail)}</span></td>
      <td><span class="cat-badge ${r.action==='Delete'?'cat-grat':r.action==='Create'?'cat-esi':'cat-pt'}">${esc(r.action)}</span></td>
      <td>${esc(r.recordType)}</td>
      <td>${esc(r.recordSummary)}</td>
      <td style="max-width:220px;font-size:11px;word-break:break-word">${r.previousValue ? esc(r.previousValue) : '–'}</td>
      <td style="max-width:220px;font-size:11px;word-break:break-word">${r.newValue ? esc(r.newValue) : '–'}</td>
      ${isAdmin() ? `<td><button class="del-btn" onclick="appDeleteAudit('${r.id}')" title="Delete (Administrator only)">🗑</button></td>` : ''}
    </tr>`).join('');
  const headRow = document.getElementById('auditTheadRow');
  if (headRow) {
    const existingAction = headRow.querySelector('.audit-admin-col');
    if (isAdmin() && !existingAction) {
      const th = document.createElement('th'); th.textContent = 'Admin'; th.className = 'audit-admin-col'; headRow.appendChild(th);
    } else if (!isAdmin() && existingAction) { existingAction.remove(); }
  }
}
export async function deleteAuditEntryUI(id) {
  if (!(await showConfirm('Permanently delete this audit log entry? This cannot be undone.', { title: 'Delete audit entry', confirmLabel: 'Delete' }))) return;
  try { await deleteAuditEntry(id); showToast('Audit entry deleted.', 'success'); } catch (e) { showToast(e.message, 'error'); }
}

// ═══════════════════════════════════════════
// ADMIN — USER MANAGEMENT
// ═══════════════════════════════════════════
let editingUid = null; // uid of the row currently in inline-edit mode, or null

function renderUsersPanel() {
  const tbody = document.getElementById('usersTbody');
  if (!tbody) return;
  tbody.innerHTML = users.map(u => {
    const isYou = u.uid === currentUser?.uid;
    if (editingUid === u.uid) {
      return `
        <tr>
          <td><input class="edit-input" id="eu-name-${u.uid}" value="${esc(u.name)}"></td>
          <td><input class="edit-input" id="eu-email-${u.uid}" value="${esc(u.email)}" type="email"></td>
          <td colspan="2" style="color:var(--text-muted);font-size:11px">
            ${isYou ? 'Changing your email updates your actual login credential.' : "Changing another user's email here updates only the contact address shown in the app — it does not change their login credential (they'd need to do that themselves)."}
          </td>
          <td style="display:flex;gap:6px">
            <button class="save-btn" onclick="appSaveUserEdit('${u.uid}')">Save</button>
            <button class="filter-btn" style="padding:3px 10px" onclick="appCancelUserEdit()">Cancel</button>
          </td>
        </tr>`;
    }
    return `
    <tr style="${u.active===false?'opacity:0.5':''}">
      <td>${esc(u.name)}${isYou ? ' <span style="font-size:10px;color:var(--text-muted)">(you)</span>' : ''}</td>
      <td>${esc(u.email)}</td>
      <td>
        <select class="edit-select" onchange="appSetUserRole('${u.uid}','${u.role}',this)" ${isYou ? 'disabled title="You cannot change your own role"' : ''}>
          <option value="user" ${u.role==='user'?'selected':''}>Standard User</option>
          <option value="admin" ${u.role==='admin'?'selected':''}>Administrator</option>
        </select>
      </td>
      <td>${u.active===false ? '<span style="color:var(--status-critical);font-weight:600">Deactivated</span>' : '<span style="color:var(--status-good);font-weight:600">Active</span>'}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="filter-btn" style="padding:3px 10px" onclick="appStartUserEdit('${u.uid}')">Edit</button>
        ${isYou ? '' : `<button class="filter-btn" style="padding:3px 10px" onclick="appSetUserActive('${u.uid}',${u.active===false})">${u.active===false?'Reactivate':'Deactivate'}</button>`}
        ${isYou ? '' : `<button class="del-btn" onclick="appDeleteUser('${u.uid}')" title="Permanently remove this user">🗑</button>`}
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="5">${emptyStateHtml('No users yet', 'Add your first teammate below.')}</td></tr>`;
}

export async function createUserFromForm() {
  const name = document.getElementById('u-name').value.trim();
  const email = document.getElementById('u-email').value.trim();
  const password = document.getElementById('u-password').value;
  const role = document.getElementById('u-role').value;
  if (!name || !email || password.length < 6) { showToast('Name, email, and a password of at least 6 characters are required.', 'error'); return; }
  try {
    await createUser(name, email, password, role);
    ['u-name','u-email','u-password'].forEach(id => document.getElementById(id).value = '');
    showToast(`User created. Share these credentials with ${name} securely — they should change their password after first login.`, 'success');
  } catch (e) { showToast('Could not create user: ' + e.message, 'error'); }
}
export async function setUserRoleUI(uid, prevRole, sel) {
  try { await setUserRole(uid, sel.value, prevRole); showToast('Role updated.', 'success'); } catch (e) { showToast(e.message, 'error'); sel.value = prevRole; }
}
export async function setUserActiveUI(uid, activate) {
  try { await setUserActive(uid, activate); showToast(activate ? 'User reactivated.' : 'User deactivated.', 'success'); } catch (e) { showToast(e.message, 'error'); }
}

export function startUserEdit(uid) { editingUid = uid; renderUsersPanel(); }
export function cancelUserEdit() { editingUid = null; renderUsersPanel(); }

export async function saveUserEdit(uid) {
  const prevProfile = users.find(u => u.uid === uid);
  if (!prevProfile) return;
  const name = document.getElementById(`eu-name-${uid}`).value.trim();
  const email = document.getElementById(`eu-email-${uid}`).value.trim();
  if (!name || !email) { showToast('Name and email are required.', 'error'); return; }
  try {
    await updateUserProfile(uid, { name, email }, prevProfile, async () => {
      return prompt(`For security, Firebase needs you to confirm your current password before changing your login email (${prevProfile.email}):`);
    });
    editingUid = null;
    showToast(uid === currentUser?.uid ? 'Your profile was updated. If your login email changed, use the new address next time you sign in.' : 'Profile updated.', 'success');
  } catch (e) {
    showToast('Could not save changes: ' + e.message, 'error');
  }
}

export async function deleteUserUI(uid) {
  const prevProfile = users.find(u => u.uid === uid);
  if (!prevProfile) return;
  if (!(await showConfirm(`Permanently remove ${prevProfile.name} (${prevProfile.email})? They will lose all access immediately. This cannot be undone from the app.`, { title: 'Remove user', confirmLabel: 'Remove' }))) return;
  try { await deleteUserProfile(uid, prevProfile); showToast('User removed.', 'success'); }
  catch (e) { showToast('Could not delete user: ' + e.message, 'error'); }
}

export function getUsers() { return users; }

// ═══════════════════════════════════════════
// GLOBAL SEARCH — quick jump to any item from any tab
// ═══════════════════════════════════════════
const TYPE_TO_TAB = {
  monthly: 'monthly', quarterly: 'quarterly', clra: 'quarterly',
  halfyearly_esic: 'halfyearly', halfyearly_pt: 'halfyearly',
  yearly: 'yearly', license: 'licenses',
};
function buildSearchIndex() {
  const rows = [];
  monthly.forEach(i => rows.push({ id: i.id, type: 'monthly', fiscalYear: i.fiscalYear, title: i.desc, sub: `${fyLabel(i.fiscalYear)} · ${fmt(i.date)} · ${i.loc || ''}`, monthIdx: i.date ? i.date.getMonth() : null, text: `${i.desc} ${i.loc} ${i.cat}`.toLowerCase() }));
  quarterly.forEach(i => { const period = i.from && i.to ? `${i.from} – ${i.to}` : (i.period || ''); rows.push({ id: i.id, type: 'quarterly', fiscalYear: i.fiscalYear, title: `${i.loc || 'ER-1'} Return`, sub: `${fyLabel(i.fiscalYear)} · ${fmt(i.due)} · ${period}`, text: `${i.loc} ${period} er-1 quarterly`.toLowerCase() }); });
  clra.forEach(i => rows.push({ id: i.id, type: 'clra', fiscalYear: i.fiscalYear, title: `${i.loc || 'CLRA'} Return`, sub: `${fyLabel(i.fiscalYear)} · ${fmt(i.due)} · ${i.contractors || ''}`, text: `${i.loc} ${i.contractors} ${i.period} clra`.toLowerCase() }));
  hyEsic.forEach(i => rows.push({ id: i.id, type: 'halfyearly_esic', fiscalYear: i.fiscalYear, title: 'ESIC Half-Yearly Return', sub: `${fyLabel(i.fiscalYear)} · ${fmt(i.due)} · ${i.period || ''}`, text: `esic half yearly ${i.period}`.toLowerCase() }));
  hyPt.forEach(i => rows.push({ id: i.id, type: 'halfyearly_pt', fiscalYear: i.fiscalYear, title: `Professional Tax – ${i.loc || ''}`, sub: `${fyLabel(i.fiscalYear)} · ${fmt(i.due)} · ${i.period || ''}`, text: `professional tax ${i.loc} ${i.period}`.toLowerCase() }));
  yearly.forEach(i => rows.push({ id: i.id, type: 'yearly', fiscalYear: i.fiscalYear, title: i.name, sub: `${fyLabel(i.fiscalYear)} · ${i.due || ''} · ${i.act || ''}`, text: `${i.name} ${i.act} ${i.mode}`.toLowerCase() }));
  licenses.forEach(i => rows.push({ id: i.id, type: 'license', fiscalYear: null, title: i.company, sub: `${i.type} · ${i.loc || ''}`, text: `${i.company} ${i.type} ${i.loc} license`.toLowerCase() }));
  return rows;
}

let searchResultIndex = [];

export function handleGlobalSearch(query) {
  const q = query.trim().toLowerCase();
  const resultsEl = document.getElementById('globalSearchResults');
  const clearBtn = document.getElementById('globalSearchClear');
  if (clearBtn) clearBtn.style.display = q ? '' : 'none';
  if (!resultsEl) return;

  if (q.length < 2) {
    resultsEl.classList.remove('show');
    resultsEl.innerHTML = '';
    return;
  }

  const matches = buildSearchIndex().filter(r => r.text.includes(q)).slice(0, 20);
  searchResultIndex = matches;

  if (!matches.length) {
    resultsEl.innerHTML = `<div class="gsr-empty">No matches for "${esc(query)}"</div>`;
  } else {
    resultsEl.innerHTML = matches.map((r, i) => `
      <div class="gsr-item" data-idx="${i}" onclick="appJumpToSearchResult(${i})">
        <div class="icon" style="width:16px;height:16px;color:var(--text-muted)">${TYPE_ICON_SVG[r.type] || ICONS.fileText}</div>
        <div class="gsr-item-main">
          <div class="gsr-item-title">${esc(r.title)}</div>
          <div class="gsr-item-sub">${esc(r.sub)}</div>
        </div>
      </div>`).join('');
  }
  resultsEl.classList.add('show');
}

export function clearGlobalSearch() {
  const input = document.getElementById('globalSearchInput');
  if (input) input.value = '';
  handleGlobalSearch('');
}

export function jumpToSearchResult(idx) {
  const r = searchResultIndex[idx];
  if (!r) return;
  clearGlobalSearch();

  if (r.fiscalYear && r.fiscalYear !== activeFiscalYear) {
    activeFiscalYear = r.fiscalYear;
    document.querySelectorAll('.fy-switch-btn').forEach(b => b.classList.toggle('active', b.dataset.fy === r.fiscalYear));
  }

  const tabId = TYPE_TO_TAB[r.type];
  if (tabId) switchTabById(tabId);

  if (r.type === 'monthly' && r.monthIdx !== null) {
    activeMonthIdx = r.monthIdx;
    activeCatFilter = 'all';
    activeLocFilter = 'all';
    document.querySelectorAll('#panel-monthly .filter-row .filter-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    document.querySelectorAll('#locFilterWrap .filter-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    buildLocFilter();
    renderMonthlyTable(r.monthIdx);
    buildMonthTabs();
  } else if (r.type === 'quarterly' || r.type === 'clra') {
    renderQuarterlyTable();
  } else if (r.type === 'halfyearly_esic' || r.type === 'halfyearly_pt') {
    renderHalfYearlyTables();
  } else if (r.type === 'yearly') {
    renderYearlyTable();
  } else if (r.type === 'license') {
    activeLicFilter = 'all';
    document.querySelectorAll('#panel-licenses .filter-row .filter-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    renderLicenses();
  }

  setTimeout(() => {
    const el = document.querySelector(`[data-record-id="${r.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('search-highlight');
      setTimeout(() => el.classList.remove('search-highlight'), 2000);
    }
  }, 80);
}
