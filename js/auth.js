import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  sendPasswordResetEmail, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";
import { SESSION_TIMEOUT_MINUTES } from "./firebase-config.js";

// Current signed-in user's profile (from Firestore users/{uid}), kept in
// sync by watchAuth(). null when signed out.
export let currentUser = null; // { uid, name, email, role, active }

// ── First-run bootstrap ──────────────────────────────────────────
// Before any admin exists, the app must let *someone* create the very
// first Administrator account. We gate this on a single marker document,
// meta/setup. Firestore rules only allow that document (and a matching
// role:'admin' users/{uid} doc) to be created once, by whoever gets there
// first with a signed-in Firebase Auth account — see firestore.rules.
export async function needsBootstrap() {
  const setupDoc = await getDoc(doc(db, "meta", "setup"));
  return !setupDoc.exists();
}

export async function createFirstAdmin(name, email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;
  await setDoc(doc(db, "users", uid), {
    name, email, role: "admin", active: true,
    createdAt: serverTimestamp(), createdBy: uid
  });
  await setDoc(doc(db, "meta", "setup"), {
    initialized: true, initializedBy: uid, initializedAt: serverTimestamp()
  });
  return uid;
}

// ── Normal login/logout ──────────────────────────────────────────
export async function login(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function logout() {
  await signOut(auth);
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

// Loads the Firestore profile for a signed-in Firebase Auth user.
// Returns null (and signs the user out) if there is no profile doc or
// the account has been deactivated by an admin.
async function loadProfile(fbUser) {
  const snap = await getDoc(doc(db, "users", fbUser.uid));
  if (!snap.exists() || snap.data().active === false) {
    await signOut(auth);
    return null;
  }
  return { uid: fbUser.uid, ...snap.data() };
}

// Subscribes to Firebase auth state; calls back with the loaded profile
// (or null when signed out / invalid account).
export function watchAuth(callback) {
  return onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) { currentUser = null; callback(null); return; }
    const profile = await loadProfile(fbUser);
    currentUser = profile;
    callback(profile);
  });
}

export function isAdmin() {
  return currentUser?.role === "admin";
}

// ── Inactivity session timeout ───────────────────────────────────
let inactivityTimer = null;
export function startSessionTimeoutWatch(onTimeout) {
  const resetTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(async () => {
      await logout();
      onTimeout();
    }, SESSION_TIMEOUT_MINUTES * 60 * 1000);
  };
  ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach(evt =>
    document.addEventListener(evt, resetTimer, { passive: true })
  );
  resetTimer();
}

export function stopSessionTimeoutWatch() {
  clearTimeout(inactivityTimer);
}
