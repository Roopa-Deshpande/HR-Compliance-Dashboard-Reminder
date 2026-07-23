// Audit trail: every create/edit/delete across the app is written here.
// Standard users can read the log but never delete entries; only the
// Administrator can (enforced both here in the UI and, authoritatively,
// in firestore.rules).
import {
  collection, addDoc, deleteDoc, doc, onSnapshot, query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { currentUser, isAdmin } from "./auth.js";

const AUDIT = collection(db, "auditLog");

export async function logAction({ action, recordType, recordId, recordSummary, previousValue, newValue }) {
  await addDoc(AUDIT, {
    userName: currentUser?.name || "Unknown",
    userEmail: currentUser?.email || "Unknown",
    timestamp: serverTimestamp(),
    recordType, recordId,
    recordSummary: recordSummary || "",
    action,
    previousValue: previousValue ? JSON.stringify(previousValue) : null,
    newValue: newValue ? JSON.stringify(newValue) : null
  });
}

// Realtime subscription to the most recent N audit entries.
export function subscribeAuditLog(callback, max = 500) {
  const q = query(AUDIT, orderBy("timestamp", "desc"), limit(max));
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    callback(rows);
  });
}

export async function deleteAuditEntry(id) {
  if (!isAdmin()) throw new Error("Only the Administrator can delete audit log entries.");
  await deleteDoc(doc(db, "auditLog", id));
}
