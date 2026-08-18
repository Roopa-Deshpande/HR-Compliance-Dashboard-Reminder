// Generic realtime data layer for all compliance records (monthly,
// quarterly, clra, halfyearly_esic, halfyearly_pt, yearly, license).
// Every record lives in one Firestore collection, `records`, distinguished
// by a `type` field, so new record types can be added later without a
// schema change (satisfies "support future addition of rows/columns").
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, serverTimestamp, Timestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { currentUser } from "./auth.js";
import { logAction } from "./audit.js";

const RECORDS = collection(db, "records");

export function toTimestamp(jsDate) {
  return jsDate ? Timestamp.fromDate(jsDate) : null;
}
export function toDate(ts) {
  return ts && ts.toDate ? ts.toDate() : (ts || null);
}

// Subscribes to all records of a given type in realtime. Callback receives
// an array of { id, ...docData } sorted by insertion order (client-sorted
// by callers as needed, e.g. by date).
export function subscribeRecords(type, callback) {
  const q = query(RECORDS, where("type", "==", type));
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    callback(rows);
  });
}

export async function addRecord(type, fields, summary) {
  const payload = {
    type, fields, done: false,
    createdAt: serverTimestamp(), createdBy: currentUser?.name || "Unknown",
    updatedAt: serverTimestamp(), updatedBy: currentUser?.name || "Unknown"
  };
  const ref = await addDoc(RECORDS, payload);
  await logAction({ action: "Create", recordType: type, recordId: ref.id, recordSummary: summary, previousValue: null, newValue: fields });
  return ref.id;
}

export async function updateRecord(id, type, prevFields, newFields, summary) {
  await updateDoc(doc(db, "records", id), {
    fields: newFields, updatedAt: serverTimestamp(), updatedBy: currentUser?.name || "Unknown"
  });
  await logAction({ action: "Edit", recordType: type, recordId: id, recordSummary: summary, previousValue: prevFields, newValue: newFields });
}

// extraFields (optional): a flat object of `fields.*` sub-keys to merge in
// alongside the done flip — e.g. { completedDelayed: true, completedDate,
// escalationPending: true } from the delay-confirmation flow. Dates in it
// are auto-converted to Firestore Timestamps. Existing 5-arg callers are
// unaffected.
export async function toggleRecordDone(id, type, fields, doneVal, summary, extraFields) {
  const updates = { done: doneVal, updatedAt: serverTimestamp(), updatedBy: currentUser?.name || "Unknown" };
  if (extraFields) {
    Object.entries(extraFields).forEach(([k, v]) => {
      updates[`fields.${k}`] = (v instanceof Date) ? Timestamp.fromDate(v) : v;
    });
  }
  await updateDoc(doc(db, "records", id), updates);
  await logAction({
    action: "Edit", recordType: type, recordId: id, recordSummary: summary,
    previousValue: { done: !doneVal }, newValue: { done: doneVal, ...(extraFields || {}) }
  });
}

export async function deleteRecord(id, type, fields, summary) {
  await deleteDoc(doc(db, "records", id));
  await logAction({ action: "Delete", recordType: type, recordId: id, recordSummary: summary, previousValue: fields, newValue: null });
}

// Persists a new row order for a set of records (drag-and-drop reordering).
// `updates` is [{id, sortOrder}]; writes `fields.sortOrder` for each via a
// batch so a drag-drop of many rows is one atomic write, and logs a single
// summary audit entry rather than one per row.
export async function reorderRecords(type, updates, summary) {
  const CHUNK = 400;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = writeBatch(db);
    updates.slice(i, i + CHUNK).forEach(u => {
      batch.update(doc(db, "records", u.id), {
        "fields.sortOrder": u.sortOrder, updatedAt: serverTimestamp(), updatedBy: currentUser?.name || "Unknown"
      });
    });
    await batch.commit();
  }
  await logAction({
    action: "Edit", recordType: type, recordId: "reorder", recordSummary: summary || `Reordered ${updates.length} row(s)`,
    previousValue: null, newValue: { count: updates.length }
  });
}
