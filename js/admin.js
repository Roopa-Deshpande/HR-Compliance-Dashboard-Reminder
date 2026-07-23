// Administrator-only user management. Creating a user with Firebase Auth's
// client SDK normally signs the *caller* in as the newly created account —
// to avoid kicking the admin out of their own session, new accounts are
// created through a throwaway secondary app instance (withSecondaryAuth).
import {
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, setDoc, updateDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { withSecondaryAuth } from "./firebase-init.js";
import { currentUser, isAdmin } from "./auth.js";
import { logAction } from "./audit.js";

const USERS = collection(db, "users");

export function subscribeUsers(callback) {
  return onSnapshot(USERS, (snap) => {
    const rows = [];
    snap.forEach(d => rows.push({ uid: d.id, ...d.data() }));
    callback(rows);
  });
}

export async function createUser(name, email, password, role) {
  if (!isAdmin()) throw new Error("Only the Administrator can create users.");
  const uid = await withSecondaryAuth(async (secondaryAuth) => {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    return cred.user.uid;
  });
  await setDoc(doc(db, "users", uid), {
    name, email, role, active: true,
    createdAt: serverTimestamp(), createdBy: currentUser?.name || "Unknown"
  });
  await logAction({ action: "Create", recordType: "user", recordId: uid, recordSummary: `${name} (${email}) — ${role}`, previousValue: null, newValue: { name, email, role } });
  return uid;
}

export async function setUserRole(uid, role, prevRole) {
  if (!isAdmin()) throw new Error("Only the Administrator can change roles.");
  await updateDoc(doc(db, "users", uid), { role });
  await logAction({ action: "Edit", recordType: "user", recordId: uid, recordSummary: `role changed`, previousValue: { role: prevRole }, newValue: { role } });
}

export async function setUserActive(uid, active) {
  if (!isAdmin()) throw new Error("Only the Administrator can activate/deactivate users.");
  await updateDoc(doc(db, "users", uid), { active });
  await logAction({ action: "Edit", recordType: "user", recordId: uid, recordSummary: active ? "account reactivated" : "account deactivated", previousValue: { active: !active }, newValue: { active } });
}
