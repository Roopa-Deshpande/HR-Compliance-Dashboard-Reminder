// Import of the Excel-derived compliance data into Firestore, parameterized
// by fiscal year. Only an Administrator can run these (buttons live in the
// Admin panel). Each guards against re-running for the same fiscal year so
// it can never silently duplicate data.
//
// Licenses are NOT duplicated per fiscal year — a license's validity isn't
// tied to one FY the way a monthly/quarterly/yearly filing is (see the
// fiscalYear filtering logic in dashboard.js), so they're only seeded once,
// as part of the very first import.
import {
  collection, getDocs, query, where, limit, writeBatch, doc, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { currentUser, isAdmin } from "./auth.js";
import { logAction } from "./audit.js";

const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function excelDateToJS(serial) {
  return new Date((serial - 25569) * 86400 * 1000);
}
const ts = (d) => d ? Timestamp.fromDate(d) : null;

const LOCS = {
  BLR: 'Bangalore (BLR)', COORG: 'Coorg', KABINI: 'Kabini', HAMPI: 'Hampi',
  EBLR: 'Earthitects BLR', EWD: 'Earthitects Wayanad', TL: 'Terralife',
  ER: 'Earth Reserve', MANDAV: 'Mandav', ELK: 'Elkhill', ALL: 'All Locations'
};

// yearOffset: 0 = the original FY2025-26 dataset's dates as written below;
// +1 shifts every date forward exactly one year, producing FY2026-27, etc.
//
// COMPLIANCE MONTH vs DUE DATE: PF/ESI/PT are compliance obligations for a
// given wage month, but are actually filed/paid the FOLLOWING month (PF &
// ESI by the 15th, PT by the 20th) — e.g. April's compliance is filed in
// May, due 15 May. Each record therefore carries two separate fields:
//   complianceMonth — 1st of the month the obligation is FOR (drives which
//                      month-tab sheet it's grouped under, and fiscalYear)
//   date            — the real statutory due date, one month later (drives
//                      status/overdue, reminders, and On Time/Late)
// This keeps "April's sheet" showing April's compliance items even though
// their due date falls in May — they never get shifted into May's sheet
// just because that's when the challan is actually filed.
function buildMonthlyData(yearOffset) {
  const data = [];
  const pfEntities = [
    { name:'EPFO – OCRHL (BLR+Coorg+Kabini)', loc: LOCS.BLR },
    { name:'EPFO – Hampi', loc: LOCS.HAMPI },
    { name:'EPFO – Elkhill Estates', loc: LOCS.ELK },
    { name:'EPFO – Earthitects', loc: LOCS.EBLR },
    { name:'EPFO – Terralife', loc: LOCS.TL },
  ];
  const esicEntities = [
    { name:'ESIC – Bangalore', loc: LOCS.BLR },
    { name:'ESIC – Hampi', loc: LOCS.HAMPI },
    { name:'ESIC – Kabini', loc: LOCS.KABINI },
    { name:'ESIC – Coorg', loc: LOCS.COORG },
    { name:'ESIC – Earthitects Wayanad', loc: LOCS.EWD },
    { name:'ESIC – Earthitects HO', loc: LOCS.EBLR },
    { name:'ESIC – Terralife', loc: LOCS.TL },
  ];
  const ptEntities = [
    { name:'PT – OCRHL', loc: LOCS.BLR },
    { name:'PT – Earthitects', loc: LOCS.EBLR },
    { name:'PT – Terralife', loc: LOCS.TL },
    { name:'PT – Earth Reserve', loc: LOCS.ER },
  ];
  for (let m = 3; m <= 14; m++) {
    const complianceYr = (m > 11 ? 2026 : 2025) + yearOffset;
    const complianceMo = m % 12;
    const complianceMonth = new Date(complianceYr, complianceMo, 1);
    // new Date() normalizes month overflow itself (Dec + 1 → Jan of the
    // next year), so a March compliance month's due date correctly lands
    // in April of the following calendar year without special-casing.
    const dueDate = (day) => new Date(complianceYr, complianceMo + 1, day);
    const label = `${months[complianceMo]} ${complianceYr}`;
    pfEntities.forEach(e => data.push({ date: dueDate(15), complianceMonth, desc: `PF Challan Payment – ${label} (${e.name})`, cat: 'PF', loc: e.loc, reminderDays: 7, notes: '' }));
    esicEntities.forEach(e => data.push({ date: dueDate(15), complianceMonth, desc: `ESI Challan Payment – ${label} (${e.name})`, cat: 'ESI', loc: e.loc, reminderDays: 7, notes: '' }));
    ptEntities.forEach(e => data.push({ date: dueDate(20), complianceMonth, desc: `Professional Tax Return – ${label} (${e.name})`, cat: 'PT', loc: e.loc, reminderDays: 7, notes: '' }));
    // LWF is an annual (not monthly-recurring) filing, due within the same
    // month it's for — no compliance/due-date split needed here.
    if (complianceMo === 0) data.push({ date: new Date(complianceYr, 0, 15), complianceMonth, desc: `Labour Welfare Fund – Payment & Return (Karnataka)`, cat: 'LWF', loc: LOCS.ALL, reminderDays: 7, notes: '' });
  }
  return data;
}

function buildQuarterlyData(yearOffset) {
  const D = (y, m, d) => new Date(y + yearOffset, m, d);
  const locs = ['Bangalore', 'Coorg', 'Kabini', 'Hampi', 'Earthitects BLR', 'Earthitects Wayanad', 'Terralife'];
  const quarters = [
    { from:'01 Apr', to:'30 Jun', fromY:2025, toY:2025, due: D(2025,6,30) },
    { from:'01 Jul', to:'30 Sep', fromY:2025, toY:2025, due: D(2025,9,30) },
    { from:'01 Oct', to:'31 Dec', fromY:2025, toY:2025, due: D(2026,0,30) },
    { from:'01 Jan', to:'31 Mar', fromY:2026, toY:2026, due: D(2026,3,30) },
  ];
  const data = [];
  // Submitted-date year must come from the due date itself (due.getFullYear()),
  // not the quarter's label year — Q3's due date (30 Jan) falls in the
  // calendar year AFTER the "Oct–Dec" period it belongs to.
  // These "already submitted" markers reflect the real FY2025-26 (offset 0)
  // filing history — a future fiscal year can't have anything submitted yet.
  locs.forEach(loc => quarters.forEach(q => data.push({
    loc, from: `${q.from} ${q.fromY + yearOffset}`, to: `${q.to} ${q.toY + yearOffset}`, due: q.due,
    submitted: (yearOffset === 0 && loc === 'Bangalore') ? (q.due.getMonth() === 6 ? '29-Jul-' + q.due.getFullYear() : q.due.getMonth() === 9 ? '31-Oct-' + q.due.getFullYear() : q.due.getMonth() === 0 ? '30-Jan-' + q.due.getFullYear() : '') : '',
    note: loc === 'Bangalore' && q.due.getMonth() === 6 ? '25+ employees' : ''
  })));
  return data;
}

function buildClraData(yearOffset) {
  const D = (y, m, d) => new Date(y + yearOffset, m, d);
  const fyLabel = `FY ${2025 + yearOffset}-${String(2026 + yearOffset).slice(2)}`;
  return [
    { loc:'Coorg', contractors:'SIS, G4S, PIC, Mandav (4 contracts)', workers:'SIS:16, G4S:3, PIC:2', period: fyLabel, due: D(2026,0,31) },
    { loc:'Kabini', contractors:'SIS, G4S (2 contracts)', workers:'SIS:8, G4S:12', period: fyLabel, due: D(2026,0,31) },
    { loc:'Hampi', contractors:'SIS, G4S, PIC (4 contracts)', workers:'SIS:7, G4S:9, PIC:1', period: fyLabel, due: D(2026,0,31) },
    { loc:'Bangalore', contractors:'Ramapuram 2 contracts, 3 additional', workers:'3', period: fyLabel, due: D(2026,0,31) },
  ];
}

// NOTE: this stays in the original wide format (one doc per period, a
// column per location) — matching what's still live in Firestore. A
// long-format rewrite (matching halfyearly_pt's { period, due, loc,
// status } shape) was prepared and reverted; see js/seed-data-longformat
// history / scripts/migrate-longformat.js if that upgrade is picked back
// up later.
function buildHalfYearlyEsic(yearOffset) {
  const D = (y, m, d) => new Date(y + yearOffset, m, d);
  // The actual FY2025-26 filings (offset 0) were already done at the time
  // this dataset was written; future years start blank since nothing's
  // been filed yet.
  const done = yearOffset === 0 ? 'Done' : '';
  return [
    { period:`Apr ${2025+yearOffset} – Sep ${2025+yearOffset}`, due: D(2025,10,11), blr:done, coorg:done, kabini:done, hampi:done, eblr:done, ewd:'', tl:done },
    { period:`Oct ${2025+yearOffset} – Mar ${2026+yearOffset}`, due: D(2026,4,11), blr:done, coorg:done, kabini:done, hampi:done, eblr:done, ewd:'', tl:done },
  ];
}
function buildHalfYearlyPt(yearOffset) {
  const D = (y, m, d) => new Date(y + yearOffset, m, d);
  return [
    { period:`Apr ${2025+yearOffset} – Aug ${2025+yearOffset}`, due: D(2025,7,31), loc:'Earthitects Wayanad', status: yearOffset === 0 ? 'Done' : '' },
    { period:`Oct ${2025+yearOffset} – Mar ${2026+yearOffset}`, due: D(2026,2,31), loc:'Earthitects Wayanad', status:'' },
  ];
}

// NOTE: this stays in the original wide format (one doc per filing type, a
// column per location) — matching what's still live in Firestore. A
// long-format rewrite was prepared and reverted; see
// scripts/migrate-longformat.js if that upgrade is picked back up later.
function buildYearlyData(yearOffset) {
  const D = (y, m, d) => new Date(y + yearOffset, m, d);
  // ✓ marks below record filings already completed for the actual
  // FY2025-26 (offset 0) at the time this dataset was written — future
  // years start unmarked since nothing's been filed yet.
  const done = yearOffset === 0 ? '✓' : '';
  return [
    { name:'PT Annual Return (Form 5A)', act:'Prof. Tax Act', due:`30 May ${2026+yearOffset}`, mode:'Online', blr:done,coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: D(2026,4,30) },
    { name:'Labour Form U (Annual Return)', act:'Contract Labour Act', due:`31 Jan ${2026+yearOffset}`, mode:'Online', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: D(2026,0,31) },
    { name:'Bonus Return (Form D)', act:'Payment of Bonus Act', due:`31 Dec ${2025+yearOffset}`, mode:'Hard Copy to Labour Dept', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: D(2025,11,31) },
    { name:'Holiday List (NFH / Form Q)', act:'Karnataka S&E Act / NI Act', due:`31 Dec ${2025+yearOffset}`, mode:'Display at premises', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: D(2025,11,31) },
    { name:'POSH / She-Box Annual Return', act:'POSH Act, 2013', due:`31 Jan ${2026+yearOffset}`, mode:'She-Box Portal (Online)', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: D(2026,0,31) },
    { name:'LWF Annual Return (Form D)', act:'Karnataka LWF Act', due:`15 Jan ${2026+yearOffset}`, mode:'Submission to LWF Board', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: D(2026,0,15) },
    { name:'ESIC – Form 1A (Changes)', act:'ESIC Act, 1948', due:'On any change', mode:'ESIC Portal', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: null },
    { name:'CLRA Annual Return (Form XXIV)', act:'CLRA, 1970', due:`31 Jan ${2026+yearOffset}`, mode:'Registering Officer', blr:'',coorg:done,kabini:done,hampi:done,ear:'',tl:'',others:'', dateObj: D(2026,0,31) },
    { name:'Gratuity Annual Return (Form R)', act:'Payment of Gratuity Act', due:`31 Jan ${2026+yearOffset}`, mode:'Controlling Authority', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: D(2026,0,31) },
    { name:'Apprentice Act Return', act:'Apprentices Act, 1961', due:'As notified', mode:'RDAT / State Adviser', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'TBD', dateObj: null },
    { name:'Equal Remuneration Return (Form D)', act:'Equal Remuneration Act', due:`31 Jan ${2026+yearOffset}`, mode:'Labour Inspector', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: D(2026,0,31) },
    { name:'Minimum Wages Return (Form III)', act:'Minimum Wages Act, 1948', due:`31 Jan ${2026+yearOffset}`, mode:'Online / Inspector', blr:'',coorg:'',kabini:'',hampi:'',ear:'',tl:'',others:'', dateObj: D(2026,0,31) },
    { name:'Factory License Renewal', act:'Factories Act, 1948', due:`Before 31 Dec ${2025+yearOffset} of expiry year`, mode:'District Factory Inspector', blr:'N/A',coorg:'N/A',kabini:'N/A',hampi:'N/A',ear:'N/A',tl:done,others: yearOffset === 0 ? 'Elkhill ✓' : '', dateObj: D(2025,11,31) },
  ];
}

const licenseData = [
  { company:'OCRHL', loc:'Bangalore', type:'SE', expiry: excelDateToJS(47848), limit:148, current:132, folder:'Yes', remarks:'' },
  { company:'OCRHL', loc:'Coorg', type:'SE', expiry: excelDateToJS(46387), limit:250, current:220, folder:'Yes', remarks:'' },
  { company:'OCRHL', loc:'Kabini', type:'SE', expiry: excelDateToJS(46387), limit:200, current:143, folder:'Yes', remarks:'' },
  { company:'OCRHL', loc:'Hampi', type:'SE', expiry: excelDateToJS(47483), limit:180, current:173, folder:'Yes', remarks:'' },
  { company:'Earthitects Pvt Ltd', loc:'Bangalore', type:'SE', expiry: excelDateToJS(46752), limit:62, current:30, folder:'Yes', remarks:'' },
  { company:'Earthitects Pvt Ltd', loc:'Wayanad', type:'SE', expiry: excelDateToJS(46387), limit:35, current:26, folder:'Yes', remarks:'' },
  { company:'Terralife', loc:'Richmond Road', type:'SE', expiry: excelDateToJS(46387), limit:45, current:15, folder:'Yes', remarks:'Richmond Road' },
  { company:'Terralife', loc:'JP Nagar', type:'SE', expiry: excelDateToJS(47118), limit:9, current:0, folder:'Yes', remarks:'JP Nagar' },
  { company:'House of Ramapuram', loc:'Bangalore', type:'SE', expiry: excelDateToJS(46387), limit:6, current:0, folder:'Yes', remarks:'' },
  { company:'Earth Reserve Pvt Ltd', loc:'Bangalore', type:'SE', expiry: null, limit:null, current:null, folder:'No', remarks:'Registration pending' },
  { company:'Elkhill Estates', loc:'Hassan', type:'SE', expiry: null, limit:null, current:null, folder:'NA', remarks:'N/A (Factory)' },
  { company:'OCRHL', loc:'Bangalore', type:'ESIC', expiry: null, limit:null, current:132, folder:'Yes', remarks:'Registration valid' },
  { company:'OCRHL', loc:'Kabini', type:'ESIC', expiry: null, limit:null, current:143, folder:'Yes', remarks:'' },
  { company:'OCRHL', loc:'Coorg', type:'ESIC', expiry: null, limit:null, current:220, folder:'Yes', remarks:'' },
  { company:'OCRHL', loc:'Hampi', type:'ESIC', expiry: null, limit:null, current:173, folder:'Yes', remarks:'' },
  { company:'Earthitects Pvt Ltd', loc:'Bangalore', type:'ESIC', expiry: null, limit:null, current:30, folder:'Yes', remarks:'' },
  { company:'OCRHL', loc:'Bangalore', type:'EPFO', expiry: null, limit:null, current:132, folder:'Yes', remarks:'' },
  { company:'OCRHL', loc:'Hampi', type:'EPFO', expiry: null, limit:null, current:173, folder:'Yes', remarks:'' },
  { company:'Earthitects Pvt Ltd', loc:'Bangalore', type:'EPFO', expiry: null, limit:null, current:30, folder:'Yes', remarks:'' },
  { company:'Elkhill Estates', loc:'Hassan', type:'EPFO', expiry: null, limit:null, current:null, folder:'Yes', remarks:'' },
  { company:'OCRHL', loc:'Bangalore', type:'PT', expiry: null, limit:null, current:132, folder:'Yes', remarks:'EC + RC Certificate' },
  { company:'Earthitects Pvt Ltd', loc:'Bangalore', type:'PT', expiry: null, limit:null, current:30, folder:'No', remarks:'EC Certificate pending' },
  { company:'House of Ramapuram', loc:'Bangalore', type:'PT', expiry: null, limit:null, current:null, folder:'Yes', remarks:'EC + RC' },
  { company:'Terralife', loc:'Bangalore', type:'PT', expiry: null, limit:null, current:15, folder:'No', remarks:'EC + RC pending' },
  { company:'Earth Reserve Pvt Ltd', loc:'Bangalore', type:'PT', expiry: null, limit:null, current:null, folder:'Yes', remarks:'EC + RC' },
  { company:'Elkhill Estates', loc:'Hassan', type:'Factory', expiry: null, limit:null, current:null, folder:'Yes', remarks:'Factories Act' },
  { company:'Terralife', loc:'Bangalore', type:'Factory', expiry: null, limit:null, current:null, folder:'Yes', remarks:'Factories Act' },
];

// Builds the year-scoped docs (monthly/quarterly/clra/halfyearly/yearly),
// each tagged fields.fiscalYear = fiscalYear, dates shifted by yearOffset
// years relative to the original FY2025-26 dataset.
// sortOrder is assigned here (index * 10, gaps left for later manual
// inserts-between) rather than inside each generator, so every record type
// gets a sane default drag-reorder position from a single place.
function buildYearScopedDocs(yearOffset, fiscalYear) {
  const docs = [];
  buildMonthlyData(yearOffset).forEach((f, i) => docs.push({ type: 'monthly', fields: { ...f, date: ts(f.date), complianceMonth: ts(f.complianceMonth), fiscalYear, sortOrder: i * 10 } }));
  buildQuarterlyData(yearOffset).forEach((f, i) => docs.push({ type: 'quarterly', fields: { ...f, due: ts(f.due), fiscalYear, sortOrder: i * 10 } }));
  buildClraData(yearOffset).forEach((f, i) => docs.push({ type: 'clra', fields: { ...f, due: ts(f.due), fiscalYear, sortOrder: i * 10 } }));
  buildHalfYearlyEsic(yearOffset).forEach((f, i) => docs.push({ type: 'halfyearly_esic', fields: { ...f, due: ts(f.due), fiscalYear, sortOrder: i * 10 } }));
  buildHalfYearlyPt(yearOffset).forEach((f, i) => docs.push({ type: 'halfyearly_pt', fields: { ...f, due: ts(f.due), fiscalYear, sortOrder: i * 10 } }));
  buildYearlyData(yearOffset).forEach((f, i) => docs.push({ type: 'yearly', fields: { ...f, dateObj: ts(f.dateObj), fiscalYear, sortOrder: i * 10 } }));
  return docs;
}

function buildLicenseDocs() {
  return licenseData.map((f, i) => ({ type: 'license', fields: { ...f, expiry: ts(f.expiry), sortOrder: i * 10 } }));
}

async function commitDocs(docs) {
  const CHUNK = 400;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = writeBatch(db);
    docs.slice(i, i + CHUNK).forEach(d => {
      const ref = doc(collection(db, "records"));
      batch.set(ref, {
        type: d.type, fields: d.fields, done: false,
        createdAt: serverTimestamp(), createdBy: currentUser?.name || "Unknown",
        updatedAt: serverTimestamp(), updatedBy: currentUser?.name || "Unknown"
      });
    });
    await batch.commit();
  }
}

// First-ever import: FY2025-26 recurring calendar + the license tracker
// (licenses are shared across all fiscal years, so they only get created
// here, never re-created by seedNextFiscalYear).
export async function seedInitialData() {
  if (!isAdmin()) throw new Error("Only the Administrator can run the initial data import.");
  const existing = await getDocs(query(collection(db, "records"), limit(1)));
  if (!existing.empty) throw new Error("Records already exist — the initial import has already been run.");

  const docs = [...buildYearScopedDocs(0, '2025-26'), ...buildLicenseDocs()];
  await commitDocs(docs);

  await logAction({
    action: "Create", recordType: "bulk-import", recordId: "seed-2025-26", recordSummary: `Initial data import (FY 2025-26) — ${docs.length} records`,
    previousValue: null, newValue: { count: docs.length }
  });
  return docs.length;
}

// Adds the next fiscal year's recurring calendar (dates shifted forward one
// year from the FY2025-26 pattern), without touching licenses — those
// already exist from seedInitialData and aren't year-specific.
export async function seedNextFiscalYear() {
  if (!isAdmin()) throw new Error("Only the Administrator can run this import.");
  const fiscalYear = '2026-27';
  const existing = await getDocs(query(collection(db, "records"), where("fields.fiscalYear", "==", fiscalYear), limit(1)));
  if (!existing.empty) throw new Error(`FY ${fiscalYear} records already exist — this import has already been run.`);

  const docs = buildYearScopedDocs(1, fiscalYear);
  await commitDocs(docs);

  await logAction({
    action: "Create", recordType: "bulk-import", recordId: "seed-2026-27", recordSummary: `FY 2026-27 data import — ${docs.length} records`,
    previousValue: null, newValue: { count: docs.length }
  });
  return docs.length;
}

// One-off correction for PF/ESI/PT monthly records seeded before
// Compliance Month was decoupled from the statutory due date (they used
// to share one date, in the same month, which was wrong — the real due
// date is in the FOLLOWING month). Uses the client SDK under the signed-in
// admin's own account, so no service-account key or Admin SDK script is
// needed. Idempotent: any record that already has fields.complianceMonth
// (freshly seeded ones already do) is left untouched, so it's safe to run
// more than once and covers every fiscal year already in the database in
// one pass. LWF and any manually-added monthly entries are left alone —
// only PF/ESI/PT are affected by the compliance-month/due-date split.
export async function migrateMonthlyComplianceDates() {
  if (!isAdmin()) throw new Error("Only the Administrator can run this migration.");
  const snap = await getDocs(query(collection(db, "records"), where("type", "==", "monthly")));
  const toFix = [];
  snap.forEach(docSnap => {
    const f = docSnap.data().fields || {};
    if (f.complianceMonth) return; // already migrated / freshly seeded correctly
    if (!['PF', 'ESI', 'PT'].includes(f.cat)) return; // leave LWF / ad-hoc entries alone
    const oldDate = f.date && f.date.toDate ? f.date.toDate() : null;
    if (!oldDate) return;
    const complianceMonth = new Date(oldDate.getFullYear(), oldDate.getMonth(), 1);
    const dueDay = f.cat === 'PT' ? 20 : 15;
    const newDate = new Date(oldDate.getFullYear(), oldDate.getMonth() + 1, dueDay);
    toFix.push({ id: docSnap.id, complianceMonth, newDate });
  });

  const CHUNK = 400;
  for (let i = 0; i < toFix.length; i += CHUNK) {
    const batch = writeBatch(db);
    toFix.slice(i, i + CHUNK).forEach(r => {
      batch.update(doc(db, "records", r.id), {
        "fields.complianceMonth": ts(r.complianceMonth),
        "fields.date": ts(r.newDate),
        updatedAt: serverTimestamp(), updatedBy: currentUser?.name || "Unknown"
      });
    });
    await batch.commit();
  }

  await logAction({
    action: "Edit", recordType: "monthly", recordId: "migrate-compliance-dates",
    recordSummary: `Corrected Compliance Month / Due Date for ${toFix.length} PF/ESI/PT monthly record(s)`,
    previousValue: null, newValue: { count: toFix.length }
  });
  return toFix.length;
}
