// Administrator-only user management. Creating a user with Firebase Auth's
// client SDK normally signs the *caller* in as the newly created account —
// to avoid kicking the admin out of their own session, new accounts are
// created through a throwaway secondary app instance (withSecondaryAuth).
import {
  createUserWithEmailAndPassword, updateEmail, EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, auth } from "./firebase-init.js";
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

// Editing name is always just a Firestore field. Editing email is only a
// real login-credential change when a user edits their OWN account — the
// Firebase client SDK has no way for an admin to change ANOTHER user's
// Auth email without a paid-plan Admin SDK backend. For another user's
// row, only the Firestore contact-email field is updated, and the caller
// is warned so nobody thinks a teammate's login changed when it didn't.
//
// getPassword: optional callback invoked (and awaited) ONLY if Firebase
// requires re-authentication before allowing an email change on your own
// account (it does, if your last sign-in wasn't recent). Should return the
// user's current password, or null/undefined to abort.
export async function updateUserProfile(uid, { name, email }, prevProfile, getPassword) {
  if (!isAdmin()) throw new Error("Only the Administrator can edit users.");
  const isSelf = uid === currentUser.uid;
  const emailChanged = email && email !== prevProfile.email;

  if (isSelf && emailChanged) {
    try {
      await updateEmail(auth.currentUser, email);
    } catch (e) {
      if (e.code === "auth/requires-recent-login" && typeof getPassword === "function") {
        const password = await getPassword();
        if (!password) throw new Error("Email change cancelled — current password is required to confirm it.");
        const cred = EmailAuthProvider.credential(prevProfile.email, password);
        await reauthenticateWithCredential(auth.currentUser, cred);
        await updateEmail(auth.currentUser, email);
      } else {
        throw e;
      }
    }
  }

  await updateDoc(doc(db, "users", uid), { name, email });
  await logAction({
    action: "Edit", recordType: "user", recordId: uid,
    recordSummary: isSelf || !emailChanged ? "profile updated" : "profile updated (contact email only — login email unchanged; teammate must change their own login email)",
    previousValue: { name: prevProfile.name, email: prevProfile.email },
    newValue: { name, email }
  });
}

// Removes a user's profile + role from Firestore, which immediately blocks
// all app access (firestore.rules requires a users/{uid} doc to read or
// write anything). The underlying Firebase Auth account itself can't be
// deleted from the client without a paid-plan Admin SDK backend, so it
// technically still exists — but with no profile doc, signing in leads
// nowhere: no data, no tabs, effectively fully locked out.
export async function deleteUserProfile(uid, prevProfile) {
  if (!isAdmin()) throw new Error("Only the Administrator can delete users.");
  if (uid === currentUser.uid) throw new Error("You cannot delete your own account while signed in as it.");
  await deleteDoc(doc(db, "users", uid));
  await logAction({
    action: "Delete", recordType: "user", recordId: uid,
    recordSummary: `${prevProfile.name} (${prevProfile.email}) removed`,
    previousValue: { name: prevProfile.name, email: prevProfile.email, role: prevProfile.role },
    newValue: null
  });
}
