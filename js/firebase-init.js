// Central Firebase initialization — every other module imports from here
// so the app is only initialized once.
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Session-only persistence: closing the browser tab ends the session
// (works together with the inactivity timeout in auth.js).
setPersistence(auth, browserSessionPersistence);

// Creates a throwaway secondary Firebase App instance so the admin can
// create a new user account (which normally signs the caller in as that
// new user) WITHOUT disturbing the admin's own active session. The
// secondary app + its auth session are torn down right after use.
export async function withSecondaryAuth(fn) {
  const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
  const { getAuth: getSecondaryAuth } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
  const secondaryAuth = getSecondaryAuth(secondaryApp);
  try {
    return await fn(secondaryAuth);
  } finally {
    try { await secondaryAuth.signOut(); } catch (e) { /* ignore */ }
    await deleteApp(secondaryApp);
  }
}
