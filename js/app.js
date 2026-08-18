import {
  needsBootstrap, createFirstAdmin, login, logout, resetPassword,
  watchAuth, startSessionTimeoutWatch, isAdmin, currentUser
} from "./auth.js";
import * as dash from "./dashboard.js";
import { seedInitialData, seedNextFiscalYear } from "./seed-data.js";

let activeUnsubs = [];
// True while the "create administrator" screen should be the one showing
// for a signed-out visitor, instead of the normal login screen. Firebase's
// onAuthStateChanged always fires once with no user on page load, and that
// must NOT clobber the setup screen while no admin exists yet.
let inBootstrapMode = false;

function show(id) { document.getElementById(id).style.display = ''; }
function hide(id) { document.getElementById(id).style.display = 'none'; }
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

async function boot() {
  setText('todayBadge', new Date().toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'long', year:'numeric' }));

  try {
    inBootstrapMode = await needsBootstrap();
    if (inBootstrapMode) {
      hide('loginScreen'); hide('appShell');
      show('setupScreen');
    } else {
      hide('setupScreen');
      show('loginScreen');
    }
  } catch (err) {
    // Firestore unreachable — usually means js/firebase-config.js still has
    // placeholder values, or there's no network connection. Fail loud
    // instead of leaving a blank page.
    inBootstrapMode = false;
    hide('setupScreen'); hide('appShell');
    show('loginScreen');
    document.getElementById('loginError').textContent =
      'Could not connect to the database. If you are setting this app up for the first time, check that js/firebase-config.js has been filled in with your real Firebase project values (see DEPLOYMENT.md).';
    console.error('Firestore connection failed during boot:', err);
  }

  watchAuth((profile) => {
    activeUnsubs.forEach(u => u());
    activeUnsubs = [];
    if (profile) {
      inBootstrapMode = false;
      hide('loginScreen'); hide('setupScreen'); show('appShell');
      setText('userBadgeName', profile.name);
      setText('userBadgeRole', profile.role === 'admin' ? 'Administrator' : 'Standard User');
      setText('userBadgeAvatar', (profile.name || '?').trim().charAt(0).toUpperCase());
      document.querySelectorAll('.admin-only').forEach(el => el.style.display = profile.role === 'admin' ? '' : 'none');
      activeUnsubs = dash.initDashboard();
      startSessionTimeoutWatch(() => {
        hide('appShell');
        show('loginScreen');
        document.getElementById('loginError').textContent = 'You were signed out after 30 minutes of inactivity.';
      });
    } else {
      hide('appShell');
      // While no admin exists yet, leave the setup screen as-is — don't
      // let the routine "signed out" path override it with the login screen.
      if (!inBootstrapMode) show('loginScreen');
    }
  });
}

// ── Setup (first admin) screen ──────────────────────────────────
document.getElementById('setupForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('setup-name').value.trim();
  const email = document.getElementById('setup-email').value.trim();
  const password = document.getElementById('setup-password').value;
  const errEl = document.getElementById('setupError');
  errEl.textContent = '';
  if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  try {
    await createFirstAdmin(name, email, password);
  } catch (err) {
    errEl.textContent = err.message.replace('Firebase: ', '');
  }
});

// ── Login screen ─────────────────────────────────────────────────
document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    await login(email, password);
  } catch (err) {
    if (err.code === 'auth/network-request-failed' || err.code === 'auth/invalid-api-key') {
      errEl.textContent = 'Could not reach the server. Check your internet connection or the Firebase configuration.';
    } else {
      errEl.textContent = 'Incorrect email or password.';
    }
  }
});
document.getElementById('forgotPasswordLink')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  if (!email) { alert('Enter your email above first, then click "Forgot password?"'); return; }
  try { await resetPassword(email); alert('Password reset email sent to ' + email); }
  catch (err) { alert('Could not send reset email: ' + err.message); }
});

// ── Logout ────────────────────────────────────────────────────────
window.appLogout = async () => { await logout(); };

// ── Admin: run initial data import ──────────────────────────────
window.appRunSeed = async () => {
  if (!confirm('Import the original Excel-based FY 2025-26 dataset into the shared database? This can only be run once.')) return;
  try {
    const n = await seedInitialData();
    alert(`Imported ${n} records.`);
  } catch (e) { alert(e.message); }
};
window.appRunSeedNextYear = async () => {
  if (!confirm('Import the FY 2026-27 compliance calendar (dates shifted one year forward from FY 2025-26)? This can only be run once.')) return;
  try {
    const n = await seedNextFiscalYear();
    alert(`Imported ${n} records for FY 2026-27.`);
  } catch (e) { alert(e.message); }
};

// ── Expose dashboard functions for inline HTML handlers ──────────
window.switchTab = dash.switchTab;
window.filterCat = dash.filterCat;
window.filterLic = dash.filterLic;
window.appFilterLoc = dash.filterLoc;
window.openAddModal = dash.openAddModal;
window.openAddLicModal = dash.openAddLicModal;
window.closeModal = dash.closeModal;
window.saveNewEntry = dash.saveNewEntry;
window.saveNewLicense = dash.saveNewLicense;
window.toggleSharePanel = dash.toggleSharePanel;
window.exportCSV = dash.exportCSV;
window.appEditRecord = dash.editRecord;
window.appSetSortMode = dash.setSortMode;
window.appToggleComplete = dash.toggleComplete;
window.appConfirmCompletion = dash.confirmCompletion;
window.appCancelCompletion = dash.cancelCompletion;
window.appDeleteRecord = dash.deleteEntry;
window.appDeleteAudit = dash.deleteAuditEntryUI;
window.createUserFromForm = dash.createUserFromForm;
window.appSetUserRole = dash.setUserRoleUI;
window.appSetUserActive = dash.setUserActiveUI;
window.appStartUserEdit = dash.startUserEdit;
window.appCancelUserEdit = dash.cancelUserEdit;
window.appSaveUserEdit = dash.saveUserEdit;
window.appDeleteUser = dash.deleteUserUI;
window.appJumpToSearchResult = dash.jumpToSearchResult;
window.clearGlobalSearch = dash.clearGlobalSearch;
window.switchFiscalYear = dash.switchFiscalYear;

// ── Global search wiring ──────────────────────────────────────────
const searchInput = document.getElementById('globalSearchInput');
if (searchInput) {
  searchInput.addEventListener('input', (e) => dash.handleGlobalSearch(e.target.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dash.clearGlobalSearch();
  });
}
document.addEventListener('click', (e) => {
  const wrap = document.querySelector('.global-search-wrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('globalSearchResults')?.classList.remove('show');
  }
});

boot();
