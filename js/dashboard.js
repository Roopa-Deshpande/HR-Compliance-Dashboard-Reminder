// Dashboard rendering — adapted from the original static tracker, but now
// driven by realtime Firestore data instead of in-memory arrays. Every
// mutation (add / edit / delete / mark-done / reorder) goes through db.js,
// which persists it, syncs it to every open browser instantly, and writes
// an audit entry.
import { subscribeRecords, addRecord, updateRecord, deleteRecord, toggleRecordDone, reorderRecords, toDate } from "./db.js";
import { subscribeAuditLog, deleteAuditEntry } from "./audit.js";
import { subscribeUsers, createUser, setUserRole, setUserActive, updateUserProfile, deleteUserProfile } from "./admin.js";
import { currentUser, isAdmin } from "./auth.js";

const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
// Real Date.getMonth() indices, but in fiscal display order (Apr..Mar)
// instead of calendar order — only affects how the month tabs are drawn.
// Filtering elsewhere still compares against the real month index, so
// underlying dates and business logic are untouched.
const FISCAL_MONTH_ORDER = [3,4,5,6,7,8,9,10,11,0,1,2];

// ── Local realtime caches (kept fresh by Firestore onSnapshot) ──────
let monthly = [], quarterly = [], clra = [], hyEsic = [], hyPt = [], yearly = [], licenses = [], auditRows = [], users = [];

let activeMonthIdx = new Date().getMonth();
let activeCatFilter = 'all';
let activeLocFilter = 'all';
let activeLicFilter = 'all';
let currentAddSection = 'monthly';
let currentEditId = null;
let currentEditType = null;
let currentSubtype = null;
let currentLicEditId = null;
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
// Shown next to the Done pill once a record has been completed via the
// delay-confirmation checkbox flow (fields.completedDelayed). Records
// marked done before this flow existed (or via a legacy proxy field) have
// no completedDelayed value and simply show no badge.
function onTimeLateBadge(row) {
  if (row.completedDelayed === undefined || row.completedDelayed === null) return '';
  const cd = toDate(row.completedDate);
  const dateStr = cd ? ` · ${fmtShort(cd)}` : '';
  return row.completedDelayed
    ? `<span class="status-pill ontime-badge late">⚠ Late${dateStr}</span>`
    : `<span class="status-pill ontime-badge on-time">✓ On Time${dateStr}</span>`;
}
function catBadge(cat) {
  const map = { PF:'cat-pf', ESI:'cat-esi', PT:'cat-pt', LWF:'cat-lwf', Bonus:'cat-bonus', Gratuity:'cat-grat', SE:'cat-se', CLRA:'cat-clra' };
  const lbl = { PF:'Provident Fund', ESI:'ESI', PT:'Prof. Tax', LWF:'Labour WF', Bonus:'Bonus', Gratuity:'Gratuity', SE:'S&E', CLRA:'CLRA' };
  return `<span class="cat-badge ${map[cat]||'cat-se'}">${lbl[cat]||cat}</span>`;
}
function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function delBtnHtml(id, type, summary) {
  return `<button class="del-btn" onclick="appDeleteRecord('${id}','${type}','${esc(summary).replace(/'/g,"\\'")}')" title="Delete">🗑</button>`;
}
function editBtnHtml(id, type) {
  return `<button class="edit-btn" onclick="appEditRecord('${id}','${type}')" title="Edit">✏️</button>`;
}
function stripId(r) { const { id, ...rest } = r; return rest; }

// ═══════════════════════════════════════════
// SORT MODE (per-table "Due Date" vs "Custom Order" view preference —
// a local UI preference, independent of the drag ORDER itself, which is
// real shared data saved via reorderRecords/fields.sortOrder).
// ═══════════════════════════════════════════
const SORT_MODE_KEY = 'hrDashSortModes';
function loadSortModes() {
  try { return JSON.parse(localStorage.getItem(SORT_MODE_KEY) || '{}'); } catch { return {}; }
}
let sortModes = loadSortModes();
function getSortMode(section) { return sortModes[section] || 'date'; }
export function setSortMode(section, mode) {
  sortModes[section] = mode;
  try { localStorage.setItem(SORT_MODE_KEY, JSON.stringify(sortModes)); } catch {}
  RENDER_BY_SECTION[section] && RENDER_BY_SECTION[section]();
}
function applySortMode(rows, section, dateField) {
  const arr = [...rows];
  if (getSortMode(section) === 'custom') return arr.sort((a,b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  return arr.sort((a,b) => (a[dateField]?.getTime() ?? 0) - (b[dateField]?.getTime() ?? 0));
}
function initSortSelects() {
  ['monthly','quarterly','clra','esic','pt','yearly','licenses'].forEach(section => {
    const sel = document.getElementById('sort-' + section);
    if (sel) sel.value = getSortMode(section);
  });
}

// ═══════════════════════════════════════════
// ROW / CARD DRAG-AND-DROP REORDERING
// ═══════════════════════════════════════════
function enableRowDragReorder(tbodyId, type) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody || tbody.dataset.dragWired) return;
  tbody.dataset.dragWired = '1';
  let dragId = null;
  tbody.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-record-id][draggable="true"]');
    if (!tr) return;
    dragId = tr.dataset.recordId;
    e.dataTransfer.effectAllowed = 'move';
  });
  tbody.addEventListener('dragover', (e) => {
    const tr = e.target.closest('tr[data-record-id][draggable="true"]');
    if (!tr || !dragId) return;
    e.preventDefault();
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-row'));
    tr.classList.add('drag-over-row');
  });
  tbody.addEventListener('dragleave', (e) => {
    const tr = e.target.closest('tr[data-record-id]');
    if (tr) tr.classList.remove('drag-over-row');
  });
  tbody.addEventListener('drop', async (e) => {
    const tr = e.target.closest('tr[data-record-id][draggable="true"]');
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-row'));
    if (!tr || !dragId) return;
    e.preventDefault();
    const targetId = tr.dataset.recordId;
    if (targetId === dragId) return;
    const rows = Array.from(tbody.querySelectorAll('tr[data-record-id]'));
    const ids = rows.map(r => r.dataset.recordId);
    const fromIdx = ids.indexOf(dragId), toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
    const updates = ids.map((id, i) => ({ id, sortOrder: i * 10 }));
    try { await reorderRecords(type, updates, `Reordered ${type}`); }
    catch (err) { alert('Could not save new order: ' + err.message); }
    dragId = null;
  });
  tbody.addEventListener('dragend', () => {
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-row'));
    dragId = null;
  });
}
function enableLicenseDragReorder() {
  const grid = document.getElementById('licenseGrid');
  if (!grid || grid.dataset.dragWired) return;
  grid.dataset.dragWired = '1';
  let dragId = null;
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-record-id][draggable="true"]');
    if (!card) return;
    dragId = card.dataset.recordId;
    e.dataTransfer.effectAllowed = 'move';
  });
  grid.addEventListener('dragover', (e) => {
    const card = e.target.closest('[data-record-id][draggable="true"]');
    if (!card || !dragId) return;
    e.preventDefault();
    grid.querySelectorAll('.license-card').forEach(c => c.classList.remove('drag-over-card'));
    card.classList.add('drag-over-card');
  });
  grid.addEventListener('dragleave', (e) => {
    const card = e.target.closest('[data-record-id]');
    if (card) card.classList.remove('drag-over-card');
  });
  grid.addEventListener('drop', async (e) => {
    const card = e.target.closest('[data-record-id][draggable="true"]');
    grid.querySelectorAll('.license-card').forEach(c => c.classList.remove('drag-over-card'));
    if (!card || !dragId) return;
    e.preventDefault();
    const targetId = card.dataset.recordId;
    if (targetId === dragId) return;
    const cards = Array.from(grid.querySelectorAll('[data-record-id]'));
    const ids = cards.map(c => c.dataset.recordId);
    const fromIdx = ids.indexOf(dragId), toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
    const updates = ids.map((id, i) => ({ id, sortOrder: i * 10 }));
    try { await reorderRecords('license', updates, 'Reordered licenses'); }
    catch (err) { alert('Could not save new order: ' + err.message); }
    dragId = null;
  });
  grid.addEventListener('dragend', () => {
    grid.querySelectorAll('.license-card').forEach(c => c.classList.remove('drag-over-card'));
    dragId = null;
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

  initSortSelects();
  enableRowDragReorder('complianceTbody', 'monthly');
  enableRowDragReorder('quarterlyTbody', 'quarterly');
  enableRowDragReorder('clraTbody', 'clra');
  enableRowDragReorder('halfYearlyEsicTbody', 'halfyearly_esic');
  enableRowDragReorder('halfYearlyPtTbody', 'halfyearly_pt');
  enableRowDragReorder('yearlyTbody', 'yearly');
  enableLicenseDragReorder();

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
    .filter(d => activeLocFilter === 'all' || d.loc === activeLocFilter);
  filtered = applySortMode(filtered, 'monthly', 'date');
  const draggable = getSortMode('monthly') === 'custom';

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">No compliance items for this month / filter${monthly.some(d=>d.fiscalYear===activeFiscalYear) ? '' : ' — nothing imported for ' + fyLabel(activeFiscalYear) + ' yet'}.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(item => {
    const status = getStatus(item.date);
    return `<tr data-record-id="${item.id}" draggable="${draggable}" style="${item.done?'opacity:0.5':''}">
      <td class="drag-handle-cell ${draggable?'':'disabled'}">⠿</td>
      <td><input type="checkbox" class="done-check" ${item.done?'checked':''} onchange="appConfirmCheck('${item.id}','monthly',this,${JSON.stringify(item.desc)},${item.date ? item.date.getTime() : 'null'})" title="Mark done"></td>
      <td class="date-cell">${fmt(item.date)}</td>
      <td class="desc-cell">${esc(item.desc)}${item.notes ? `<br><span style="color:var(--text-muted);font-size:11px">${esc(item.notes)}</span>` : ''}</td>
      <td>${catBadge(item.cat)}</td>
      <td><span class="location-tag">${esc(item.loc)||'–'}</span></td>
      <td style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">${statusPill(status, item.done)}${onTimeLateBadge(item)}</td>
      <td style="display:flex;gap:4px;align-items:center">${editBtnHtml(item.id,'monthly')}${delBtnHtml(item.id, 'monthly', item.desc)}</td>
    </tr>`;
  }).join('');
}

export async function deleteEntry(id, type, summary) {
  if (!confirm(`Delete "${summary}"?`)) return;
  try { await deleteRecord(id, type, {}, summary); }
  catch (e) { alert('Could not delete: ' + e.message); }
}

function buildMonthTabs() {
  const tabs = document.getElementById('monthTabs');
  if (!tabs) return;
  const overdueMonths = new Set();
  monthly.forEach(item => { if (item.fiscalYear === activeFiscalYear && !item.done && item.date && getStatus(item.date) === 'overdue') overdueMonths.add(item.date.getMonth()); });
  tabs.innerHTML = '';
  FISCAL_MONTH_ORDER.forEach(realIdx => {
    const btn = document.createElement('div');
    btn.className = 'month-tab' + (realIdx === activeMonthIdx ? ' active' : '');
    btn.dataset.monthIdx = realIdx;
    btn.innerHTML = months[realIdx] + (overdueMonths.has(realIdx) ? '<span class="dot"></span>' : '');
    btn.onclick = () => {
      activeMonthIdx = realIdx;
      document.querySelectorAll('.month-tab').forEach(t => t.classList.toggle('active', Number(t.dataset.monthIdx) === realIdx));
      renderMonthlyTable(realIdx);
    };
    tabs.appendChild(btn);
  });
}

function updateSummary() {
  const today = new Date(); today.setHours(0,0,0,0);
  let overdue=0, thisMonth=0, upcoming=0, pf=0, esi=0, other=0;
  monthly.filter(item => item.fiscalYear === activeFiscalYear).forEach(item => {
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
}

// ═══════════════════════════════════════════
// QUARTERLY / CLRA
// ═══════════════════════════════════════════
function renderQuarterlyTable() {
  const tbody = document.getElementById('quarterlyTbody');
  if (tbody) {
    const draggable = getSortMode('quarterly') === 'custom';
    const rows = applySortMode(quarterly.filter(r => r.fiscalYear === activeFiscalYear), 'quarterly', 'due');
    tbody.innerHTML = rows.map((row, i) => {
      const status = getStatus(row.due);
      const period = row.period || (row.from && row.to ? `${row.from} – ${row.to}` : '–');
      const done = !!row.submitted || !!row.done;
      return `<tr data-record-id="${row.id}" draggable="${draggable}">
        <td class="drag-handle-cell ${draggable?'':'disabled'}">⠿</td>
        <td>${i+1}</td>
        <td class="loc">${esc(row.loc)||'–'}</td>
        <td>${esc(period)}</td>
        <td class="date-cell">${fmt(row.due)}</td>
        <td>${row.submitted ? `<span style="color:var(--upcoming);font-weight:600">${esc(row.submitted)}</span>` : '<em style="color:#9ca3af">Pending</em>'}</td>
        <td style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">${done ? statusPill('done',true) : statusPill(status,false)}${onTimeLateBadge(row)}</td>
        <td style="display:flex;gap:4px;align-items:center"><input type="checkbox" class="done-check" ${done?'checked':''} onchange="appConfirmCheck('${row.id}','quarterly',this,${JSON.stringify(period)},${row.due ? row.due.getTime() : 'null'})">${editBtnHtml(row.id,'quarterly')}${delBtnHtml(row.id,'quarterly', period)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="8"><div class="empty-state">No entries yet.</div></td></tr>`;
  }
  const clraTbody = document.getElementById('clraTbody');
  if (clraTbody) {
    const draggable = getSortMode('clra') === 'custom';
    const rows = applySortMode(clra.filter(r => r.fiscalYear === activeFiscalYear), 'clra', 'due');
    clraTbody.innerHTML = rows.map((row, i) => {
      const status = getStatus(row.due);
      return `<tr data-record-id="${row.id}" draggable="${draggable}">
        <td class="drag-handle-cell ${draggable?'':'disabled'}">⠿</td>
        <td>${i+1}</td>
        <td class="loc">${esc(row.loc)||'–'}</td>
        <td style="font-size:12px">${esc(row.contractors)||'–'}</td>
        <td>${esc(row.period)||'–'}</td>
        <td class="date-cell">${fmt(row.due)}</td>
        <td style="display:flex;gap:4px;align-items:center;flex-wrap:wrap"><input type="checkbox" class="done-check" ${row.done?'checked':''} onchange="appConfirmCheck('${row.id}','clra',this,${JSON.stringify(row.period||row.loc)},${row.due ? row.due.getTime() : 'null'})">${statusPill(status, row.done)}${onTimeLateBadge(row)}${editBtnHtml(row.id,'clra')}${delBtnHtml(row.id,'clra', row.period||row.loc)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="7"><div class="empty-state">No entries yet.</div></td></tr>`;
  }
}

// ═══════════════════════════════════════════
// HALF-YEARLY — PT is long-format ({ period, due, loc, status }). ESIC
// stays in the original wide format (one row per period, a column per
// location) — a long-format rewrite was prepared and deferred, see
// scripts/migrate-longformat.js. It's still fully reorderable and now has
// its own single per-row completion checkbox (marking "this whole
// six-month filing period is done"), same as every other sheet.
// ═══════════════════════════════════════════
function renderHalfYearlyTables() {
  const esicTbody = document.getElementById('halfYearlyEsicTbody');
  if (esicTbody) {
    const draggable = getSortMode('esic') === 'custom';
    const rows = applySortMode(hyEsic.filter(r => r.fiscalYear === activeFiscalYear), 'esic', 'due');
    const doneClass = v => v === 'Done' ? `<span style="color:var(--upcoming);font-weight:600">✓</span>` : `<span style="color:#d1d5db">–</span>`;
    esicTbody.innerHTML = rows.map((row, i) => {
      const status = getStatus(row.due);
      // Backward-compatible: periods already fully filed under the old
      // per-location columns (before this checkbox existed) show as Done
      // via that legacy signal until someone explicitly (un)checks them —
      // otherwise real completed FY2025-26 filings would wrongly flip to
      // "Pending" the moment this shipped. Once touched, the real `done`
      // flag always wins (see doneTouched in promptCompletion).
      const done = row.doneTouched ? !!row.done : (!!row.done || row.blr === 'Done');
      return `<tr data-record-id="${row.id}" draggable="${draggable}">
        <td class="drag-handle-cell ${draggable?'':'disabled'}">⠿</td>
        <td>${i+1}</td><td>${esc(row.period)}</td><td class="date-cell">${fmt(row.due)}</td>
        <td>${doneClass(row.blr)}</td><td>${doneClass(row.coorg)}</td><td>${doneClass(row.kabini)}</td>
        <td>${doneClass(row.hampi)}</td><td>${doneClass(row.eblr)}</td><td>${doneClass(row.ewd)}</td><td>${doneClass(row.tl)}</td>
        <td style="display:flex;gap:4px;align-items:center;flex-wrap:wrap"><input type="checkbox" class="done-check" ${done?'checked':''} onchange="appConfirmCheck('${row.id}','halfyearly_esic',this,${JSON.stringify(row.period)},${row.due ? row.due.getTime() : 'null'})">${statusPill(status, done)}${onTimeLateBadge(row)}${editBtnHtml(row.id,'halfyearly_esic')}${delBtnHtml(row.id,'halfyearly_esic', row.period)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="12"><div class="empty-state">No entries yet.</div></td></tr>`;
  }
  // PT was already long-format before this round of changes, so it keeps
  // every new feature (edit, delay-checkbox, drag-reorder) same as
  // Monthly/Quarterly/CLRA.
  const ptTbody = document.getElementById('halfYearlyPtTbody');
  if (ptTbody) {
    const draggable = getSortMode('pt') === 'custom';
    const rows = applySortMode(hyPt.filter(r => r.fiscalYear === activeFiscalYear), 'pt', 'due');
    ptTbody.innerHTML = rows.map((row,i) => {
      const status = getStatus(row.due);
      const done = row.status === 'Done' || !!row.done;
      return `<tr data-record-id="${row.id}" draggable="${draggable}">
        <td class="drag-handle-cell ${draggable?'':'disabled'}">⠿</td>
        <td>${i+1}</td><td>${esc(row.period)}</td><td class="date-cell">${fmt(row.due)}</td><td class="loc">${esc(row.loc)}</td>
        <td style="display:flex;gap:4px;align-items:center;flex-wrap:wrap"><input type="checkbox" class="done-check" ${done?'checked':''} onchange="appConfirmCheck('${row.id}','halfyearly_pt',this,${JSON.stringify((row.period||'')+' – '+(row.loc||''))},${row.due ? row.due.getTime() : 'null'})">${statusPill(status, done)}${onTimeLateBadge(row)}${editBtnHtml(row.id,'halfyearly_pt')}${delBtnHtml(row.id,'halfyearly_pt', row.period)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="6"><div class="empty-state">No entries yet.</div></td></tr>`;
  }
}

// ═══════════════════════════════════════════
// YEARLY — stays in the original wide format (one row per filing type, a
// column per location) — matching what's still live in Firestore. Not yet
// editable field-by-field, but fully reorderable and now has its own
// single per-row completion checkbox ("this filing is done"), same as
// every other sheet.
// ═══════════════════════════════════════════
function renderYearlyTable() {
  const tbody = document.getElementById('yearlyTbody');
  if (!tbody) return;
  const draggable = getSortMode('yearly') === 'custom';
  const rows = applySortMode(yearly.filter(r => r.fiscalYear === activeFiscalYear), 'yearly', 'dateObj');
  tbody.innerHTML = rows.map((row,i) => {
    const status = row.dateObj ? getStatus(row.dateObj) : 'upcoming';
    const doneClass = v => v === '✓' ? `<span style="color:var(--upcoming);font-weight:700">✓</span>` : `<span style="color:#d1d5db;font-size:11px">${esc(v)||'–'}</span>`;
    // Backward-compatible: a few filings (e.g. CLRA Annual Return, Factory
    // License Renewal) already carry ✓ marks in their old per-location
    // columns — treat that as historically done too, so the new checkbox
    // doesn't show unchecked next to a row that visibly has ✓'s in it.
    // Once touched, the real `done` flag always wins (see doneTouched in
    // promptCompletion).
    const done = row.doneTouched ? !!row.done : (!!row.done || [row.blr,row.coorg,row.kabini,row.hampi,row.ear,row.tl].includes('✓'));
    return `<tr data-record-id="${row.id}" draggable="${draggable}">
      <td class="drag-handle-cell ${draggable?'':'disabled'}">⠿</td>
      <td>${i+1}</td>
      <td><strong style="font-size:13px">${esc(row.name)}</strong></td>
      <td style="font-size:11px;color:var(--text-muted)">${esc(row.act)||'–'}</td>
      <td class="date-cell" style="font-size:12px">${esc(row.due)||'–'}</td>
      <td style="font-size:11px">${esc(row.mode)||'–'}</td>
      <td>${doneClass(row.blr)}</td><td>${doneClass(row.coorg)}</td><td>${doneClass(row.kabini)}</td>
      <td>${doneClass(row.hampi)}</td><td>${doneClass(row.ear)}</td><td>${doneClass(row.tl)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${esc(row.others)||'–'}</td>
      <td style="display:flex;gap:4px;align-items:center;flex-wrap:wrap"><input type="checkbox" class="done-check" ${done?'checked':''} onchange="appConfirmCheck('${row.id}','yearly',this,${JSON.stringify(row.name)},${row.dateObj ? row.dateObj.getTime() : 'null'})">${statusPill(status, done)}${onTimeLateBadge(row)}${editBtnHtml(row.id,'yearly')}${delBtnHtml(row.id,'yearly', row.name)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="14"><div class="empty-state">No entries yet.</div></td></tr>`;
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
  const sorted = applySortMode(filtered, 'licenses', 'expiry');
  const draggable = getSortMode('licenses') === 'custom';
  const grid = document.getElementById('licenseGrid');
  if (!grid) return;
  grid.innerHTML = '';
  let count = 0;

  sorted.forEach((lic) => {
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
      if (limitExceeded) empBarHtml += `<div class="license-alert-tag red">⚠️ LIMIT EXCEEDED – Amend License</div>`;
      else if (limitNear) empBarHtml += `<div class="license-alert-tag">⚠️ 80%+ Capacity – Plan Renewal</div>`;
    }
    let alertHtml = '';
    if (expired) alertHtml = `<div class="license-alert-tag red">🚨 EXPIRED – Renew Immediately</div>`;
    else if (expiringSoon) alertHtml = `<div class="license-alert-tag">⏰ Expiring in ${daysToExpiry} days</div>`;

    const folderHtml = `<div class="license-folder">📁 Document in folder: <span class="${lic.folder==='Yes'?'folder-yes':lic.folder==='No'?'folder-no':''}">${esc(lic.folder)}</span></div>`;

    grid.insertAdjacentHTML('beforeend', `
      <div class="${cardClass}" data-record-id="${lic.id}" draggable="${draggable}">
        <div class="license-card-header">
          <div style="display:flex;align-items:center;gap:6px">
            ${draggable ? '<span class="license-drag-handle">⠿</span>' : ''}
            <div><div class="license-card-title">${esc(lic.company)}</div><div class="license-card-company">📍 ${esc(lic.loc)}</div></div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="license-type-badge ${typeMap[lic.type]||'lt-se'}">${typeLbl[lic.type]||lic.type}</span>
            <div style="display:flex;gap:2px">${editBtnHtml(lic.id,'license')}${delBtnHtml(lic.id,'license', lic.company)}</div>
          </div>
        </div>
        <div class="license-meta">
          <div class="license-meta-item"><div class="lm-label">Expiry / Validity</div><div class="lm-val ${expiryClass}">${expiryHtml}</div></div>
          <div class="license-meta-item"><div class="lm-label">Status</div><div class="lm-val">${expired ? '<span style="color:var(--overdue)">Expired</span>' : expiringSoon ? '<span style="color:#d97706">Expiring Soon</span>' : '<span style="color:var(--upcoming)">Valid</span>'}</div></div>
        </div>
        ${empBarHtml}${alertHtml}
        ${lic.remarks ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px">${esc(lic.remarks)}</div>` : ''}
        ${folderHtml}
      </div>`);
    count++;
  });

  if (!count) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">No licenses for this filter.</div>`;
  const expiredCount = licenses.filter(l => l.expiry && l.expiry < new Date()).length;
  const tcLic = document.getElementById('tc-lic');
  if (tcLic) tcLic.textContent = expiredCount;
}

// ═══════════════════════════════════════════
// ADD / EDIT MODAL — one modal, driven by currentAddSection / currentSubtype
// / currentEditId, reused for both creating and editing every record type.
// ═══════════════════════════════════════════
const TYPE_TO_SECTION = { monthly:'monthly', quarterly:'quarterly', clra:'quarterly', halfyearly_esic:'halfyearly', halfyearly_pt:'halfyearly', yearly:'yearly' };
const TYPE_TO_SUBTYPE = { quarterly:'er1', clra:'clra', halfyearly_esic:'esic', halfyearly_pt:'pt' };
const RENDER_BY_SECTION = {
  monthly: () => renderMonthlyTable(activeMonthIdx),
  quarterly: renderQuarterlyTable,
  clra: renderQuarterlyTable,
  esic: renderHalfYearlyTables,
  pt: renderHalfYearlyTables,
  yearly: renderYearlyTable,
  licenses: renderLicenses,
};

function cacheFor(type) {
  return { monthly, quarterly, clra, halfyearly_esic: hyEsic, halfyearly_pt: hyPt, yearly, license: licenses }[type];
}
function findRow(type, id) {
  const arr = cacheFor(type);
  return arr && arr.find(r => r.id === id);
}
function nextSortOrder(arr) {
  const vals = arr.filter(r => r.fiscalYear === activeFiscalYear).map(r => r.sortOrder || 0);
  return (vals.length ? Math.max(...vals) : 0) + 10;
}

// Half-Yearly only ever *adds* Professional Tax entries here — ESIC has no
// natural "add a new period" action (its two periods per FY are fixed),
// but existing ESIC rows are still fully editable via the ✏️ button, which
// sets currentSubtype to 'esic' directly (bypassing this dropdown).
function subtypeOptionsHtml(section) {
  if (section === 'quarterly') return `<option value="er1">Employment Exchange (ER-1)</option><option value="clra">CLRA Return</option>`;
  return '';
}

function configureEntryFormFields(section, subtype, isEdit) {
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  const isEsic = section === 'halfyearly' && subtype === 'esic';
  show('f-cat-row', section === 'monthly');
  show('f-reminder-row', section === 'monthly');
  show('f-subtype-row', section === 'quarterly');
  show('f-actmode-row', section === 'yearly');
  // Yearly and ESIC stay wide-format (one row covers every location via a
  // checkbox matrix instead of a single Location field).
  show('f-loc-row', section !== 'yearly' && !isEsic);
  show('f-esicloc-row', isEsic);
  show('f-yearlyloc-row', section === 'yearly');
  show('f-submitted-row', section === 'quarterly' && subtype === 'er1');
  show('f-clra-row', section === 'quarterly' && subtype === 'clra');
  const subtypeSel = document.getElementById('f-subtype');
  if (subtypeSel) {
    subtypeSel.innerHTML = subtypeOptionsHtml(section);
    subtypeSel.value = subtype || '';
    subtypeSel.disabled = isEdit;
  }
}
document.getElementById('f-subtype')?.addEventListener('change', (e) => {
  currentSubtype = e.target.value;
  configureEntryFormFields(currentAddSection, currentSubtype, !!currentEditId);
});

const ESIC_LOC_CHECKBOX_IDS = ['f-esic-blr','f-esic-coorg','f-esic-kabini','f-esic-hampi','f-esic-eblr','f-esic-ewd','f-esic-tl'];
const YEARLY_LOC_CHECKBOX_IDS = ['f-yr-blr','f-yr-coorg','f-yr-kabini','f-yr-hampi','f-yr-ear','f-yr-tl'];

function clearEntryForm() {
  ['f-date','f-desc','f-notes','f-act','f-mode','f-submitted','f-contractors','f-workers','f-yr-others'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const cat = document.getElementById('f-cat'); if (cat) cat.selectedIndex = 0;
  const loc = document.getElementById('f-loc'); if (loc) loc.selectedIndex = 0;
  const rem = document.getElementById('f-reminder'); if (rem) rem.value = 7;
  [...ESIC_LOC_CHECKBOX_IDS, ...YEARLY_LOC_CHECKBOX_IDS].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.checked = false; el.disabled = false;
    const label = el.closest('label'); if (label) label.title = '';
  });
}

function toInputDateStr(d) {
  if (!d || isNaN(d)) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function fillEntryForm(type, row) {
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  if (type === 'monthly') {
    setVal('f-date', toInputDateStr(row.date)); setVal('f-desc', row.desc); setVal('f-cat', row.cat);
    setVal('f-loc', row.loc); setVal('f-reminder', row.reminderDays || 7); setVal('f-notes', row.notes);
  } else if (type === 'quarterly') {
    setVal('f-date', toInputDateStr(row.due)); setVal('f-desc', row.period || (row.from && row.to ? `${row.from} – ${row.to}` : ''));
    setVal('f-loc', row.loc); setVal('f-submitted', row.submitted); setVal('f-notes', row.note);
  } else if (type === 'clra') {
    setVal('f-date', toInputDateStr(row.due)); setVal('f-desc', row.period); setVal('f-loc', row.loc);
    setVal('f-contractors', row.contractors); setVal('f-workers', row.workers);
  } else if (type === 'halfyearly_pt') {
    setVal('f-date', toInputDateStr(row.due)); setVal('f-desc', row.period); setVal('f-loc', row.loc);
  } else if (type === 'halfyearly_esic') {
    setVal('f-date', toInputDateStr(row.due)); setVal('f-desc', row.period);
    const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v === 'Done'; };
    setChk('f-esic-blr', row.blr); setChk('f-esic-coorg', row.coorg); setChk('f-esic-kabini', row.kabini);
    setChk('f-esic-hampi', row.hampi); setChk('f-esic-eblr', row.eblr); setChk('f-esic-ewd', row.ewd); setChk('f-esic-tl', row.tl);
  } else if (type === 'yearly') {
    setVal('f-date', row.dateObj ? toInputDateStr(row.dateObj) : ''); setVal('f-desc', row.name);
    setVal('f-act', row.act); setVal('f-mode', row.mode); setVal('f-yr-others', row.others);
    // 'N/A' locations are disabled (not just unchecked) — saveNewEntry
    // preserves N/A regardless of the checkbox, this just makes that
    // visible instead of looking like an ordinary pending checkbox.
    const setChk = (id, v) => {
      const el = document.getElementById(id); if (!el) return;
      el.checked = v === '✓'; el.disabled = v === 'N/A';
      const label = el.closest('label'); if (label) label.title = v === 'N/A' ? 'Not applicable at this location' : '';
    };
    setChk('f-yr-blr', row.blr); setChk('f-yr-coorg', row.coorg); setChk('f-yr-kabini', row.kabini);
    setChk('f-yr-hampi', row.hampi); setChk('f-yr-ear', row.ear); setChk('f-yr-tl', row.tl);
  }
}

export function openAddModal(section) {
  currentAddSection = section;
  currentEditId = null; currentEditType = null;
  currentSubtype = section === 'quarterly' ? 'er1' : null;
  const title = document.getElementById('addModalTitle');
  if (title) title.textContent = `Add Entry – ${section.charAt(0).toUpperCase()+section.slice(1)}`;
  const saveBtn = document.getElementById('addModalSaveBtn');
  if (saveBtn) saveBtn.textContent = 'Add Entry';
  clearEntryForm();
  configureEntryFormFields(section, currentSubtype, false);
  document.getElementById('addModal').classList.add('show');
}

export function openEditModal(id, type) {
  const row = findRow(type, id);
  if (!row) return;
  currentEditId = id; currentEditType = type;
  currentAddSection = TYPE_TO_SECTION[type];
  currentSubtype = TYPE_TO_SUBTYPE[type] || null;
  const title = document.getElementById('addModalTitle');
  if (title) title.textContent = 'Edit Entry';
  const saveBtn = document.getElementById('addModalSaveBtn');
  if (saveBtn) saveBtn.textContent = 'Save Changes';
  clearEntryForm();
  configureEntryFormFields(currentAddSection, currentSubtype, true);
  fillEntryForm(type, row);
  document.getElementById('addModal').classList.add('show');
}

export function openAddLicModal() {
  currentLicEditId = null;
  const title = document.querySelector('#addLicModal .modal-header h3');
  if (title) title.textContent = 'Add License';
  const saveBtn = document.getElementById('addLicModalSaveBtn');
  if (saveBtn) saveBtn.textContent = 'Save License';
  ['lf-company','lf-expiry','lf-limit','lf-current','lf-remarks'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const type = document.getElementById('lf-type'); if (type) type.selectedIndex = 0;
  const loc = document.getElementById('lf-loc'); if (loc) loc.selectedIndex = 0;
  const folder = document.getElementById('lf-folder'); if (folder) folder.selectedIndex = 0;
  document.getElementById('addLicModal').classList.add('show');
}

export function openEditLicModal(id) {
  const lic = licenses.find(l => l.id === id);
  if (!lic) return;
  currentLicEditId = id;
  const title = document.querySelector('#addLicModal .modal-header h3');
  if (title) title.textContent = 'Edit License';
  const saveBtn = document.getElementById('addLicModalSaveBtn');
  if (saveBtn) saveBtn.textContent = 'Save Changes';
  const setVal = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v ?? ''; };
  setVal('lf-company', lic.company); setVal('lf-type', lic.type); setVal('lf-loc', lic.loc);
  setVal('lf-expiry', toInputDateStr(lic.expiry)); setVal('lf-limit', lic.limit); setVal('lf-current', lic.current);
  setVal('lf-folder', lic.folder); setVal('lf-remarks', lic.remarks);
  document.getElementById('addLicModal').classList.add('show');
}

export function closeModal(id) { document.getElementById(id).classList.remove('show'); }

export async function saveNewEntry() {
  const dateVal = document.getElementById('f-date').value;
  const desc = document.getElementById('f-desc').value.trim();
  if (!dateVal || !desc) { alert('Please fill in date and description.'); return; }
  const loc = document.getElementById('f-loc').value;
  const notes = document.getElementById('f-notes').value.trim();
  const dateObj = new Date(dateVal);
  const fiscalYear = computeFiscalYear(dateObj);
  const isEdit = !!currentEditId;

  let type, fields, cacheArr;
  if (currentAddSection === 'monthly') {
    type = 'monthly'; cacheArr = monthly;
    fields = { date: dateObj, desc, cat: document.getElementById('f-cat').value, loc, reminderDays: parseInt(document.getElementById('f-reminder').value) || 7, notes, fiscalYear };
  } else if (currentAddSection === 'quarterly' && currentSubtype === 'clra') {
    type = 'clra'; cacheArr = clra;
    fields = { loc, period: desc, due: dateObj, contractors: document.getElementById('f-contractors').value.trim(), workers: document.getElementById('f-workers').value.trim(), fiscalYear };
  } else if (currentAddSection === 'quarterly') {
    type = 'quarterly'; cacheArr = quarterly;
    fields = { loc, period: desc, due: dateObj, submitted: document.getElementById('f-submitted').value.trim(), note: notes, fiscalYear };
  } else if (currentAddSection === 'halfyearly' && currentSubtype === 'esic') {
    // ESIC stays wide-format — editable (7-location checkbox matrix) but
    // never addable: its two periods per FY are fixed, this branch is
    // edit-only (Add always implies the 'pt' subtype, never 'esic').
    type = 'halfyearly_esic'; cacheArr = hyEsic;
    const chk = id => document.getElementById(id)?.checked ? 'Done' : '';
    fields = {
      period: desc, due: dateObj,
      blr: chk('f-esic-blr'), coorg: chk('f-esic-coorg'), kabini: chk('f-esic-kabini'), hampi: chk('f-esic-hampi'),
      eblr: chk('f-esic-eblr'), ewd: chk('f-esic-ewd'), tl: chk('f-esic-tl'),
      fiscalYear
    };
  } else if (currentAddSection === 'halfyearly') {
    type = 'halfyearly_pt'; cacheArr = hyPt;
    fields = { loc, period: desc, due: dateObj, status: isEdit ? (findRow(type, currentEditId)?.status || '') : '', fiscalYear };
  } else if (currentAddSection === 'yearly') {
    // Yearly stays wide-format (one doc per filing, a column per
    // location) — the 6-location checkbox matrix + Others field cover the
    // same ground a per-location edit would.
    type = 'yearly'; cacheArr = yearly;
    const prevYearly = isEdit ? findRow(type, currentEditId) : null;
    // A checkbox only has two states, but a few rows (e.g. Factory License
    // Renewal) use 'N/A' for genuinely-not-applicable locations — preserve
    // that distinction rather than collapsing it to blank/✓.
    const chk = (id, key) => (prevYearly && prevYearly[key] === 'N/A') ? 'N/A' : (document.getElementById(id)?.checked ? '✓' : '');
    fields = {
      name: desc, act: document.getElementById('f-act').value.trim() || '–', due: dateVal, mode: document.getElementById('f-mode').value.trim() || '–',
      blr: chk('f-yr-blr','blr'), coorg: chk('f-yr-coorg','coorg'), kabini: chk('f-yr-kabini','kabini'), hampi: chk('f-yr-hampi','hampi'), ear: chk('f-yr-ear','ear'), tl: chk('f-yr-tl','tl'),
      others: document.getElementById('f-yr-others').value.trim(), dateObj, fiscalYear
    };
  } else {
    return;
  }

  try {
    if (isEdit) {
      const prevRow = findRow(currentEditType, currentEditId);
      const prevFields = prevRow ? stripId(prevRow) : {};
      await updateRecord(currentEditId, currentEditType, prevFields, fields, desc);
    } else {
      fields.sortOrder = nextSortOrder(cacheArr);
      await addRecord(type, fields, desc);
    }
    closeModal('addModal');
    clearEntryForm();
    currentEditId = null; currentEditType = null;
  } catch (e) { alert('Could not save: ' + e.message); }
}

export async function saveNewLicense() {
  const company = document.getElementById('lf-company').value.trim();
  if (!company) { alert('Company name required.'); return; }
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
    if (currentLicEditId) {
      const prevLic = licenses.find(l => l.id === currentLicEditId);
      await updateRecord(currentLicEditId, 'license', prevLic ? stripId(prevLic) : {}, fields, company);
      currentLicEditId = null;
    } else {
      fields.sortOrder = nextSortOrder(licenses);
      await addRecord('license', fields, company);
    }
    closeModal('addLicModal');
    ['lf-company','lf-expiry','lf-limit','lf-current','lf-remarks'].forEach(id => document.getElementById(id).value = '');
  } catch (e) { alert('Could not save: ' + e.message); }
}

// Shared by every editable table/grid's ✏️ button.
export function editRecord(id, type) {
  if (type === 'license') openEditLicModal(id);
  else openEditModal(id, type);
}

// ═══════════════════════════════════════════
// COMPLETION CHECKBOX — checking a box always asks for the actual
// completion date; On Time vs Late is derived automatically by comparing
// that date to the record's due date (not a separate self-reported
// choice). Late completions get flagged for an escalation email (picked
// up by the next daily reminder run). Unchecking (marking not-done) is
// always a direct toggle, no prompt.
// ═══════════════════════════════════════════
let pendingCompletion = null; // { id, type, cb, summary, due }

export async function promptCompletion(id, type, cb, summary, dueMs) {
  if (!cb.checked) {
    // doneTouched: a few Half-Yearly ESIC / Yearly rows carry old
    // per-location ✓ marks that render.js treats as an implicit "done"
    // signal for rows never explicitly (un)checked via this flow. Without
    // this flag, unchecking one of those rows would render checked again
    // on the very next refresh — the legacy marks are still there and
    // would keep winning. Once a row's been explicitly touched, the real
    // `done` flag always wins from then on.
    const extra = { doneTouched: true };
    if (type === 'quarterly') extra.submitted = '';
    if (type === 'halfyearly_pt') extra.status = '';
    try { await toggleRecordDone(id, type, {}, false, summary, extra); }
    catch (e) { alert('Could not update: ' + e.message); cb.checked = true; }
    return;
  }
  const due = dueMs ? new Date(dueMs) : null;
  pendingCompletion = { id, type, cb, summary, due };
  const summaryEl = document.getElementById('delayModalSummary');
  if (summaryEl) summaryEl.textContent = summary || '';
  const dueEl = document.getElementById('delayModalDue');
  if (dueEl) dueEl.textContent = due ? `Due date: ${fmt(due)}` : '';
  const dateInput = document.getElementById('f-delay-date');
  if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
  document.getElementById('delayModal').classList.add('show');
}

// A completion is Late when its date falls strictly after the due date
// (compared by calendar day, not time-of-day). No due date on record (a
// handful of Yearly filings have none) means there's nothing to be late
// against, so it's treated as On Time.
function isLate(completedDate, due) {
  if (!due) return false;
  const c = new Date(completedDate); c.setHours(0,0,0,0);
  const d = new Date(due); d.setHours(0,0,0,0);
  return c > d;
}

export async function confirmCompletion() {
  if (!pendingCompletion) return;
  const { id, type, cb, summary, due } = pendingCompletion;
  const dateVal = document.getElementById('f-delay-date').value;
  if (!dateVal) { alert('Please enter the completion date.'); return; }
  const completedDate = new Date(dateVal);
  const delayed = isLate(completedDate, due);
  const extra = { completedDelayed: delayed, completedDate, doneTouched: true };
  if (delayed) extra.escalationPending = true;
  if (type === 'quarterly') extra.submitted = fmtShort(completedDate);
  if (type === 'halfyearly_pt') extra.status = 'Done';
  try {
    await toggleRecordDone(id, type, {}, true, summary, extra);
    closeModal('delayModal');
    pendingCompletion = null;
  } catch (e) { alert('Could not update: ' + e.message); cb.checked = false; }
}

export function cancelCompletion() {
  if (pendingCompletion) { pendingCompletion.cb.checked = false; pendingCompletion = null; }
  closeModal('delayModal');
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
  if (!isAdmin()) { alert('Only the Administrator can export reports.'); return; }
  const rows = [['Section','Date','Description','Category','Location','Status']];
  monthly.forEach(i => rows.push(['Monthly', fmt(i.date), i.desc, i.cat, i.loc, i.done ? 'Done' : getStatus(i.date)]));
  quarterly.forEach(i => rows.push(['Quarterly', fmt(i.due), i.period || `${i.from||''} - ${i.to||''}`, '', i.loc, (i.submitted || i.done) ? 'Submitted' : getStatus(i.due)]));
  clra.forEach(i => rows.push(['CLRA', fmt(i.due), i.period, '', i.loc, i.done ? 'Done' : getStatus(i.due)]));
  hyEsic.forEach(i => rows.push(['Half-Yearly ESIC', fmt(i.due), i.period, 'ESIC', '', getStatus(i.due)]));
  hyPt.forEach(i => rows.push(['Half-Yearly PT', fmt(i.due), i.period, 'PT', i.loc, (i.status==='Done'||i.done) ? 'Submitted' : getStatus(i.due)]));
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
  if (!auditRows.length) { tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No activity recorded yet.</div></td></tr>`; return; }
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
  if (!confirm('Permanently delete this audit log entry? This cannot be undone.')) return;
  try { await deleteAuditEntry(id); } catch (e) { alert(e.message); }
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
      <td>${u.active===false ? '<span style="color:var(--overdue);font-weight:600">Deactivated</span>' : '<span style="color:var(--upcoming);font-weight:600">Active</span>'}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="filter-btn" style="padding:3px 10px" onclick="appStartUserEdit('${u.uid}')">Edit</button>
        ${isYou ? '' : `<button class="filter-btn" style="padding:3px 10px" onclick="appSetUserActive('${u.uid}',${u.active===false})">${u.active===false?'Reactivate':'Deactivate'}</button>`}
        ${isYou ? '' : `<button class="del-btn" onclick="appDeleteUser('${u.uid}')" title="Permanently remove this user">🗑</button>`}
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="5"><div class="empty-state">No users yet.</div></td></tr>`;
}

export async function createUserFromForm() {
  const name = document.getElementById('u-name').value.trim();
  const email = document.getElementById('u-email').value.trim();
  const password = document.getElementById('u-password').value;
  const role = document.getElementById('u-role').value;
  if (!name || !email || password.length < 6) { alert('Name, email, and a password of at least 6 characters are required.'); return; }
  try {
    await createUser(name, email, password, role);
    ['u-name','u-email','u-password'].forEach(id => document.getElementById(id).value = '');
    alert(`User created. Share these credentials with ${name} securely — they should change their password after first login.`);
  } catch (e) { alert('Could not create user: ' + e.message); }
}
export async function setUserRoleUI(uid, prevRole, sel) {
  try { await setUserRole(uid, sel.value, prevRole); } catch (e) { alert(e.message); sel.value = prevRole; }
}
export async function setUserActiveUI(uid, activate) {
  try { await setUserActive(uid, activate); } catch (e) { alert(e.message); }
}

export function startUserEdit(uid) { editingUid = uid; renderUsersPanel(); }
export function cancelUserEdit() { editingUid = null; renderUsersPanel(); }

export async function saveUserEdit(uid) {
  const prevProfile = users.find(u => u.uid === uid);
  if (!prevProfile) return;
  const name = document.getElementById(`eu-name-${uid}`).value.trim();
  const email = document.getElementById(`eu-email-${uid}`).value.trim();
  if (!name || !email) { alert('Name and email are required.'); return; }
  try {
    await updateUserProfile(uid, { name, email }, prevProfile, async () => {
      return prompt(`For security, Firebase needs you to confirm your current password before changing your login email (${prevProfile.email}):`);
    });
    editingUid = null;
    if (uid === currentUser?.uid) alert('Your profile was updated. If your login email changed, use the new address next time you sign in.');
  } catch (e) {
    alert('Could not save changes: ' + e.message);
  }
}

export async function deleteUserUI(uid) {
  const prevProfile = users.find(u => u.uid === uid);
  if (!prevProfile) return;
  if (!confirm(`Permanently remove ${prevProfile.name} (${prevProfile.email})? They will lose all access immediately. This cannot be undone from the app.`)) return;
  try { await deleteUserProfile(uid, prevProfile); }
  catch (e) { alert('Could not delete user: ' + e.message); }
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
const TYPE_ICON = {
  monthly: '📅', quarterly: '📊', clra: '📊', halfyearly_esic: '🗓️',
  halfyearly_pt: '🗓️', yearly: '📋', license: '🏛️',
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
        <div style="font-size:15px">${TYPE_ICON[r.type] || '📄'}</div>
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
