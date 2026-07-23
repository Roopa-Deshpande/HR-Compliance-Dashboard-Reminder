// ═══════════════════════════════════════════════════════════════
// FIREBASE CONFIGURATION — FILL THIS IN BEFORE DEPLOYING
// ═══════════════════════════════════════════════════════════════
// Where to get these values:
//   Firebase Console → (your project) → ⚙️ Project Settings →
//   scroll to "Your apps" → Web app → SDK setup and configuration → "Config"
//
// These values are safe to be public (they identify your project, they are
// NOT secret keys). Real access control is enforced by firestore.rules and
// Firebase Authentication, not by hiding this object.
// See DEPLOYMENT.md for full setup steps.
// ═══════════════════════════════════════════════════════════════

export const firebaseConfig = {
  apiKey: "AIzaSyCDoAWXCj6FK46zdJ9NNfA3J9Veift0YHw",
  authDomain: "hr-compliance-dashboard-26-27.firebaseapp.com",
  projectId: "hr-compliance-dashboard-26-27",
  storageBucket: "hr-compliance-dashboard-26-27.firebasestorage.app",
  messagingSenderId: "945500736149",
  appId: "1:945500736149:web:3dd47154cba6e46e32699c",
  measurementId: "G-MXJCDZXEPQ"
};

// Session timeout, in minutes, before an inactive user is auto-logged-out.
export const SESSION_TIMEOUT_MINUTES = 30;
