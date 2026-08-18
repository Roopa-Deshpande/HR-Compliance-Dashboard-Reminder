// ONE-OFF migration: converts the live `halfyearly_esic` and `yearly`
// records from their original wide format (one doc per filing, a column
// per location) into the long format every other sheet already uses (one
// doc per location), and backfills fields.sortOrder onto every existing
// record so the new drag-to-reorder feature starts from a sane order.
//
// Safe to re-run: any doc that already looks long-format (has fields.loc)
// is left untouched, so running this twice is a no-op the second time.
//
// USAGE:
//   node migrate-longformat.js --key=<path-to-service-account.json>          (dry run — reads & prints a plan, writes nothing)
//   node migrate-longformat.js --key=<path-to-service-account.json> --commit  (actually writes)
//
// A full JSON backup of the `records` collection is written to
// scripts/backup-records-<timestamp>.json on every run (dry or commit),
// before anything else happens.
//
// Follows the project's established secret-handling pattern: download the
// service-account key to a local path, pass it via --key, delete the file
// immediately after this script finishes running.

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const args = process.argv.slice(2);
const keyArg = args.find(a => a.startsWith("--key="));
const commit = args.includes("--commit");
if (!keyArg) {
  console.error("Usage: node migrate-longformat.js --key=<path-to-service-account.json> [--commit]");
  process.exit(1);
}
const keyPath = keyArg.slice("--key=".length);

const LOCS = {
  BLR: 'Bangalore (BLR)', COORG: 'Coorg', KABINI: 'Kabini', HAMPI: 'Hampi',
  EBLR: 'Earthitects BLR', EWD: 'Earthitects Wayanad', TL: 'Terralife',
};

// Mirrors seed-data.js's YEARLY_LOC_LABELS exactly — keep both in sync.
const YEARLY_LOC_LABELS = { blr: LOCS.BLR, coorg: LOCS.COORG, kabini: LOCS.KABINI, hampi: LOCS.HAMPI, ear: LOCS.EBLR, tl: LOCS.TL };

// Mirrors seed-data.js's expandYearlyRow, reconstructed from the raw
// 'others' string the live wide docs actually have (seed-data.js instead
// carries a clean {extraLoc, notes} split since it authors the data
// directly — this function re-derives that same split from live data).
// The live docs don't carry an explicit yearOffset, so `done` here just
// carries over whatever the original wide column already said.
function expandYearlyRow(base, wide) {
  const keys = ['blr','coorg','kabini','hampi','ear','tl'];
  const othersRaw = (wide.others || '').trim();
  // Only a trailing ✓ makes 'others' a genuine extra-location signal (the
  // one real case: "Elkhill ✓" on Factory License Renewal). Anything else
  // (e.g. "TBD" on Apprentice Act Return) is just a note, not a location.
  const othersMatch = /^([A-Za-z ]+?)\s*✓$/.exec(othersRaw);
  const anySignal = keys.some(k => wide[k] === '✓') || !!othersMatch;
  if (!anySignal) return [{ ...base, loc: 'All Locations', done: false, notes: (othersRaw && !othersMatch) ? othersRaw : '' }];
  const rows = keys.filter(k => wide[k] !== 'N/A').map(k => (
    { ...base, loc: YEARLY_LOC_LABELS[k], done: wide[k] === '✓', notes: '' }
  ));
  if (othersMatch) rows.push({ ...base, loc: othersMatch[1].trim(), done: true, notes: '' });
  return rows;
}

function esicLongRows(period, due, fiscalYear) {
  return Object.entries(LOCS).map(([, loc]) => ({ loc, period, due, fiscalYear }));
}

async function main() {
  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log(commit ? "Running in COMMIT mode — this WILL write to production." : "Running in DRY-RUN mode — nothing will be written. Pass --commit to apply.");

  // ── 1. Backup everything first, always ──────────────────────────
  const snap = await db.collection("records").get();
  const allDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(__dirname, `backup-records-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(allDocs, null, 2));
  console.log(`Backed up ${allDocs.length} records to ${backupPath}`);

  // ── 2. Transform halfyearly_esic + yearly wide docs to long format ──
  const newDocs = [];
  const deleteIds = [];
  let esicSkipped = 0, yearlySkipped = 0;

  snap.docs.forEach(docSnap => {
    const data = docSnap.data();
    const f = data.fields || {};
    if (data.type === "halfyearly_esic") {
      if (f.loc) { esicSkipped++; return; } // already long-format
      const rows = esicLongRows(f.period, f.due, f.fiscalYear);
      rows.forEach(r => newDocs.push({ type: "halfyearly_esic", fields: { ...r, status: '' } }));
      deleteIds.push(docSnap.id);
    } else if (data.type === "yearly") {
      if (f.loc) { yearlySkipped++; return; } // already long-format
      const base = { name: f.name, act: f.act, due: f.due, mode: f.mode, dateObj: f.dateObj, fiscalYear: f.fiscalYear };
      const wide = { blr: f.blr, coorg: f.coorg, kabini: f.kabini, hampi: f.hampi, ear: f.ear, tl: f.tl, others: f.others };
      expandYearlyRow(base, wide).forEach(r => newDocs.push({ type: "yearly", fields: r }));
      deleteIds.push(docSnap.id);
    }
  });

  console.log(`\nHalf-Yearly ESIC: ${deleteIds.filter(id => allDocs.find(d=>d.id===id)?.type==='halfyearly_esic').length} wide docs found, ${esicSkipped} already long-format (skipped).`);
  console.log(`Yearly: ${deleteIds.filter(id => allDocs.find(d=>d.id===id)?.type==='yearly').length} wide docs found, ${yearlySkipped} already long-format (skipped).`);
  console.log(`\n→ Will create ${newDocs.length} new long-format docs, delete ${deleteIds.length} old wide docs.\n`);

  // Print the full per-filing-type location breakdown for yearly so it can
  // be eyeballed before committing — this is the one part of the migration
  // with genuine business-domain ambiguity (see seed-data.js comments).
  const yearlyByName = {};
  newDocs.filter(d => d.type === 'yearly').forEach(d => {
    (yearlyByName[d.fields.name] ||= []).push(`${d.fields.loc}${d.fields.done ? ' (done)' : ''}`);
  });
  console.log("Yearly filing → location breakdown (review this before --commit):");
  Object.entries(yearlyByName).forEach(([name, locs]) => console.log(`  ${name}: ${locs.join(', ')}`));

  // ── 3. Backfill sortOrder on every other existing record type ──────
  const sortOrderUpdates = [];
  const byType = {};
  allDocs.forEach(d => { if (d.fields?.sortOrder === undefined) (byType[d.type] ||= []).push(d); });
  const dateFieldByType = { monthly: 'date', quarterly: 'due', clra: 'due', halfyearly_pt: 'due', license: 'expiry' };
  Object.entries(byType).forEach(([type, docs]) => {
    if (type === 'halfyearly_esic' || type === 'yearly') return; // handled above via newDocs, not in-place
    const dateField = dateFieldByType[type];
    const withDate = docs.map(d => {
      const raw = dateField ? d.fields?.[dateField] : null;
      const ms = raw?.toDate ? raw.toDate().getTime() : (raw ? new Date(raw).getTime() : Infinity);
      return { id: d.id, ms: isNaN(ms) ? Infinity : ms };
    }).sort((a, b) => a.ms - b.ms);
    withDate.forEach((d, i) => sortOrderUpdates.push({ id: d.id, sortOrder: i * 10 }));
  });
  console.log(`\n→ Will backfill sortOrder on ${sortOrderUpdates.length} existing docs (monthly/quarterly/clra/halfyearly_pt/license).`);

  if (!commit) {
    console.log("\nDry run complete. Re-run with --commit to apply these changes.");
    return;
  }

  // ── 4. Apply ─────────────────────────────────────────────────────
  const CHUNK = 400;
  for (let i = 0; i < newDocs.length; i += CHUNK) {
    const batch = db.batch();
    newDocs.slice(i, i + CHUNK).forEach(d => {
      const ref = db.collection("records").doc();
      batch.set(ref, { type: d.type, fields: d.fields, done: false, createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: "Migration Script", updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: "Migration Script" });
    });
    await batch.commit();
  }
  for (let i = 0; i < deleteIds.length; i += CHUNK) {
    const batch = db.batch();
    deleteIds.slice(i, i + CHUNK).forEach(id => batch.delete(db.collection("records").doc(id)));
    await batch.commit();
  }
  for (let i = 0; i < sortOrderUpdates.length; i += CHUNK) {
    const batch = db.batch();
    sortOrderUpdates.slice(i, i + CHUNK).forEach(u => batch.update(db.collection("records").doc(u.id), { "fields.sortOrder": u.sortOrder }));
    await batch.commit();
  }

  await db.collection("auditLog").add({
    action: "Edit", recordType: "bulk-migration", recordId: "migrate-longformat",
    recordSummary: `Long-format migration — ${newDocs.length} docs created, ${deleteIds.length} deleted, ${sortOrderUpdates.length} sortOrder-backfilled`,
    previousValue: null, newValue: { created: newDocs.length, deleted: deleteIds.length, sortOrderBackfilled: sortOrderUpdates.length },
    userName: "Migration Script", userEmail: "-", timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`\nDone. Created ${newDocs.length}, deleted ${deleteIds.length}, backfilled sortOrder on ${sortOrderUpdates.length}.`);
  console.log(`Backup is at ${backupPath} — keep it until you've spot-checked the live app.`);
}

main().catch(err => { console.error("Migration failed:", err); process.exit(1); });
