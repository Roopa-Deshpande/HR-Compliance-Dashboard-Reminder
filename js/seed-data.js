// One-time import of the original Excel-derived compliance data into
// Firestore. Only an Administrator can run this (button lives in the
// Admin panel), and it refuses to run if records already exist so it
// can never silently duplicate data.
import {
  collection, getDocs, query, limit, writeBatch, doc, serverTimestamp, Timestamp
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

function buildMonthlyData() {
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
    const yr = m > 11 ? 2026 : 2025;
    const mo = m % 12;
    pfEntities.forEach(e => data.push({ date: new Date(yr, mo, 14), desc: `PF Challan Payment – ${months[mo]} (${e.name})`, cat: 'PF', loc: e.loc, reminderDays: 7, notes: '' }));
    esicEntities.forEach(e => data.push({ date: new Date(yr, mo, 15), desc: `ESI Challan Payment – ${months[mo]} (${e.name})`, cat: 'ESI', loc: e.loc, reminderDays: 7, notes: '' }));
    ptEntities.forEach(e => data.push({ date: new Date(yr, mo, 20), desc: `Professional Tax Return – ${months[mo]} (${e.name})`, cat: 'PT', loc: e.loc, reminderDays: 7, notes: '' }));
    if (mo === 0) data.push({ date: new Date(yr, 0, 15), desc: `Labour Welfare Fund – Payment & Return (Karnataka)`, cat: 'LWF', loc: LOCS.ALL, reminderDays: 7, notes: '' });
  }
  return data;
}

const quarterlyData = [
  { loc:'Bangalore', from:'01 Apr 2025', to:'30 Jun 2025', due: new Date(2025,6,30), submitted:'29-Jul-2025', note:'25+ employees' },
  { loc:'Bangalore', from:'01 Jul 2025', to:'30 Sep 2025', due: new Date(2025,9,30), submitted:'31-Oct-2025', note:'' },
  { loc:'Bangalore', from:'01 Oct 2025', to:'31 Dec 2025', due: new Date(2026,0,30), submitted:'30-Jan-2026', note:'' },
  { loc:'Bangalore', from:'01 Jan 2026', to:'31 Mar 2026', due: new Date(2026,3,30), submitted:'', note:'' },
  { loc:'Coorg', from:'01 Apr 2025', to:'30 Jun 2025', due: new Date(2025,6,30), submitted:'', note:'' },
  { loc:'Coorg', from:'01 Jul 2025', to:'30 Sep 2025', due: new Date(2025,9,30), submitted:'', note:'' },
  { loc:'Coorg', from:'01 Oct 2025', to:'31 Dec 2025', due: new Date(2026,0,30), submitted:'', note:'' },
  { loc:'Coorg', from:'01 Jan 2026', to:'31 Mar 2026', due: new Date(2026,3,30), submitted:'', note:'' },
  { loc:'Kabini', from:'01 Apr 2025', to:'30 Jun 2025', due: new Date(2025,6,30), submitted:'', note:'' },
  { loc:'Kabini', from:'01 Jul 2025', to:'30 Sep 2025', due: new Date(2025,9,30), submitted:'', note:'' },
  { loc:'Kabini', from:'01 Oct 2025', to:'31 Dec 2025', due: new Date(2026,0,30), submitted:'', note:'' },
  { loc:'Kabini', from:'01 Jan 2026', to:'31 Mar 2026', due: new Date(2026,3,30), submitted:'', note:'' },
  { loc:'Hampi', from:'01 Apr 2025', to:'30 Jun 2025', due: new Date(2025,6,30), submitted:'', note:'' },
  { loc:'Hampi', from:'01 Jul 2025', to:'30 Sep 2025', due: new Date(2025,9,30), submitted:'', note:'' },
  { loc:'Hampi', from:'01 Oct 2025', to:'31 Dec 2025', due: new Date(2026,0,30), submitted:'', note:'' },
  { loc:'Hampi', from:'01 Jan 2026', to:'31 Mar 2026', due: new Date(2026,3,30), submitted:'', note:'' },
  { loc:'Earthitects BLR', from:'01 Apr 2025', to:'30 Jun 2025', due: new Date(2025,6,30), submitted:'', note:'' },
  { loc:'Earthitects BLR', from:'01 Jul 2025', to:'30 Sep 2025', due: new Date(2025,9,30), submitted:'', note:'' },
  { loc:'Earthitects BLR', from:'01 Oct 2025', to:'31 Dec 2025', due: new Date(2026,0,30), submitted:'', note:'' },
  { loc:'Earthitects BLR', from:'01 Jan 2026', to:'31 Mar 2026', due: new Date(2026,3,30), submitted:'', note:'' },
  { loc:'Earthitects Wayanad', from:'01 Apr 2025', to:'30 Jun 2025', due: new Date(2025,6,30), submitted:'', note:'' },
  { loc:'Earthitects Wayanad', from:'01 Jul 2025', to:'30 Sep 2025', due: new Date(2025,9,30), submitted:'', note:'' },
  { loc:'Earthitects Wayanad', from:'01 Oct 2025', to:'31 Dec 2025', due: new Date(2026,0,30), submitted:'', note:'' },
  { loc:'Earthitects Wayanad', from:'01 Jan 2026', to:'31 Mar 2026', due: new Date(2026,3,30), submitted:'', note:'' },
  { loc:'Terralife', from:'01 Apr 2025', to:'30 Jun 2025', due: new Date(2025,6,30), submitted:'', note:'' },
  { loc:'Terralife', from:'01 Jul 2025', to:'30 Sep 2025', due: new Date(2025,9,30), submitted:'', note:'' },
  { loc:'Terralife', from:'01 Oct 2025', to:'31 Dec 2025', due: new Date(2026,0,30), submitted:'', note:'' },
  { loc:'Terralife', from:'01 Jan 2026', to:'31 Mar 2026', due: new Date(2026,3,30), submitted:'', note:'' },
];

const clraData = [
  { loc:'Coorg', contractors:'SIS, G4S, PIC, Mandav (4 contracts)', workers:'SIS:16, G4S:3, PIC:2', period:'FY 2025-26', due: new Date(2026,0,31) },
  { loc:'Kabini', contractors:'SIS, G4S (2 contracts)', workers:'SIS:8, G4S:12', period:'FY 2025-26', due: new Date(2026,0,31) },
  { loc:'Hampi', contractors:'SIS, G4S, PIC (4 contracts)', workers:'SIS:7, G4S:9, PIC:1', period:'FY 2025-26', due: new Date(2026,0,31) },
  { loc:'Bangalore', contractors:'Ramapuram 2 contracts, 3 additional', workers:'3', period:'FY 2025-26', due: new Date(2026,0,31) },
];

const halfYearlyEsic = [
  { period:'Apr 2025 – Sep 2025', due: new Date(2025,10,11), blr:'Done', coorg:'Done', kabini:'Done', hampi:'Done', eblr:'Done', ewd:'', tl:'Done' },
  { period:'Oct 2025 – Mar 2026', due: new Date(2026,4,11), blr:'Done', coorg:'Done', kabini:'Done', hampi:'Done', eblr:'Done', ewd:'', tl:'Done' },
];
const halfYearlyPt = [
  { period:'Apr 2025 – Aug 2025', due: new Date(2025,7,31), loc:'Earthitects Wayanad', status:'Done' },
  { period:'Oct 2025 – Mar 2026', due: new Date(2026,2,31), loc:'Earthitects Wayanad', status:'' },
];

const yearlyData = [
  { name:'PT Annual Return (Form 5A)', act:'Prof. Tax Act', due:'30 May every year', mode:'Online', blr:'✓', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: new Date(2026,4,30) },
  { name:'Labour Form U (Annual Return)', act:'Contract Labour Act', due:'31 Jan every year', mode:'Online', blr:'✓', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: new Date(2026,0,31) },
  { name:'Bonus Return (Form D)', act:'Payment of Bonus Act', due:'31 Dec every year', mode:'Hard Copy to Labour Dept', blr:'', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: new Date(2025,11,31) },
  { name:'Holiday List (NFH / Form Q)', act:'Karnataka S&E Act / NI Act', due:'On or before 31 Dec', mode:'Display at premises', blr:'', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: new Date(2025,11,31) },
  { name:'POSH / She-Box Annual Return', act:'POSH Act, 2013', due:'31 Jan every year', mode:'She-Box Portal (Online)', blr:'', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: new Date(2026,0,31) },
  { name:'LWF Annual Return (Form D)', act:'Karnataka LWF Act', due:'15 Jan every year', mode:'Submission to LWF Board', blr:'', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: new Date(2026,0,15) },
  { name:'ESIC – Form 1A (Changes)', act:'ESIC Act, 1948', due:'On any change', mode:'ESIC Portal', blr:'', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: null },
  { name:'CLRA Annual Return (Form XXIV)', act:'CLRA, 1970', due:'31 Jan every year', mode:'Registering Officer', blr:'', coorg:'✓', kabini:'✓', hampi:'✓', ear:'', tl:'', others:'', dateObj: new Date(2026,0,31) },
  { name:'Gratuity Annual Return (Form R)', act:'Payment of Gratuity Act', due:'31 Jan every year', mode:'Controlling Authority', blr:'', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: new Date(2026,0,31) },
  { name:'Apprentice Act Return', act:'Apprentices Act, 1961', due:'As notified', mode:'RDAT / State Adviser', blr:'', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'TBD', dateObj: null },
  { name:'Equal Remuneration Return (Form D)', act:'Equal Remuneration Act', due:'31 Jan every year', mode:'Labour Inspector', blr:'', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: new Date(2026,0,31) },
  { name:'Minimum Wages Return (Form III)', act:'Minimum Wages Act, 1948', due:'31 Jan every year', mode:'Online / Inspector', blr:'', coorg:'', kabini:'', hampi:'', ear:'', tl:'', others:'', dateObj: new Date(2026,0,31) },
  { name:'Factory License Renewal', act:'Factories Act, 1948', due:'Before 31 Dec of expiry year', mode:'District Factory Inspector', blr:'N/A', coorg:'N/A', kabini:'N/A', hampi:'N/A', ear:'N/A', tl:'✓', others:'Elkhill ✓', dateObj: new Date(2025,11,31) },
];

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

function buildSeedDocs() {
  const docs = [];
  buildMonthlyData().forEach(f => docs.push({ type: 'monthly', fields: { ...f, date: ts(f.date) } }));
  quarterlyData.forEach(f => docs.push({ type: 'quarterly', fields: { ...f, due: ts(f.due) } }));
  clraData.forEach(f => docs.push({ type: 'clra', fields: { ...f, due: ts(f.due) } }));
  halfYearlyEsic.forEach(f => docs.push({ type: 'halfyearly_esic', fields: { ...f, due: ts(f.due) } }));
  halfYearlyPt.forEach(f => docs.push({ type: 'halfyearly_pt', fields: { ...f, due: ts(f.due) } }));
  yearlyData.forEach(f => docs.push({ type: 'yearly', fields: { ...f, dateObj: ts(f.dateObj) } }));
  licenseData.forEach(f => docs.push({ type: 'license', fields: { ...f, expiry: ts(f.expiry) } }));
  return docs;
}

export async function seedInitialData() {
  if (!isAdmin()) throw new Error("Only the Administrator can run the initial data import.");
  const existing = await getDocs(query(collection(db, "records"), limit(1)));
  if (!existing.empty) throw new Error("Records already exist — the initial import has already been run.");

  const docs = buildSeedDocs();
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

  await logAction({
    action: "Create", recordType: "bulk-import", recordId: "seed", recordSummary: `Initial data import — ${docs.length} records`,
    previousValue: null, newValue: { count: docs.length }
  });
  return docs.length;
}
