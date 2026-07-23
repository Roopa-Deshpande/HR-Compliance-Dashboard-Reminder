// Scheduled email reminder digest — run daily by GitHub Actions
// (.github/workflows/email-reminders.yml). Not part of the web app itself;
// this is a small Node script that runs outside the browser, because a
// static site can't send email or wake itself up on a timer.
//
// What it does:
//   1. Reads every not-done compliance record from Firestore.
//   2. Splits them into "overdue" and "due soon" (within REMINDER_WINDOW_DAYS).
//   3. Reads license expiries separately (expired / expiring within 180 days,
//      matching the same threshold used in the dashboard UI).
//   4. If there's anything to report, emails a digest to every active user.
//      Because this runs daily and simply re-queries current state, an
//      overdue item that's still not marked done keeps appearing in the
//      digest every day until someone completes it — that's the
//      "recurring reminder until done" behavior, with no extra bookkeeping.
//
// Required environment variables (set as GitHub Actions secrets):
//   FIREBASE_SERVICE_ACCOUNT_BASE64  — base64-encoded Firebase service
//                                      account JSON key (Project Settings →
//                                      Service Accounts → Generate new key)
//   GMAIL_USER                       — the Gmail address sending the mail
//   GMAIL_APP_PASSWORD               — a Google App Password for that account
//
// Reminder criteria — set as plain (non-secret) env vars in the workflow's
// `env:` block, no code changes needed to adjust:
//   REMINDER_WINDOW_DAYS         — how many days before a due date counts as
//                                  "due soon" (default 7)
//   LICENSE_EXPIRY_WINDOW_DAYS   — how many days before a license expiry
//                                  counts as "expiring soon" (default 180,
//                                  matching the dashboard's own highlight rule)

const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const REMINDER_WINDOW_DAYS = parseInt(process.env.REMINDER_WINDOW_DAYS || "7", 10);
const LICENSE_EXPIRY_WINDOW_DAYS = parseInt(process.env.LICENSE_EXPIRY_WINDOW_DAYS || "180", 10);
const DASHBOARD_URL = "https://hr-compliance-dashboard-26-27.web.app";

function initFirebase() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable.");
  const serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin.firestore();
}

function daysBetween(a, b) {
  const d1 = new Date(a); d1.setHours(0, 0, 0, 0);
  const d2 = new Date(b); d2.setHours(0, 0, 0, 0);
  return Math.round((d1 - d2) / 86400000);
}

function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  return new Date(ts);
}

function fmtDate(d) {
  return d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "–";
}

// Per record `type`, which field holds the due date and how "done" is decided.
const TYPE_CONFIG = {
  monthly: { dueField: "date", isDone: (doc) => !!doc.done, label: (f) => f.desc },
  quarterly: { dueField: "due", isDone: (doc) => !!doc.fields.submitted || !!doc.done, label: (f) => `${f.loc || ""} ER-1 Return`.trim() },
  clra: { dueField: "due", isDone: (doc) => !!doc.done, label: (f) => `${f.loc || ""} CLRA Return`.trim() },
  halfyearly_esic: { dueField: "due", isDone: (doc) => doc.fields.blr === "Done" || !!doc.done, label: () => "ESIC Half-Yearly Return" },
  halfyearly_pt: { dueField: "due", isDone: (doc) => doc.fields.status === "Done" || !!doc.done, label: (f) => `Professional Tax – ${f.loc || ""}`.trim() },
  yearly: { dueField: "dateObj", isDone: (doc) => !!doc.done, label: (f) => f.name },
};

async function collectDueItems(db) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const overdue = [];
  const dueSoon = [];

  for (const [type, cfg] of Object.entries(TYPE_CONFIG)) {
    const snap = await db.collection("records").where("type", "==", type).get();
    snap.forEach((docSnap) => {
      const doc = docSnap.data();
      const fields = doc.fields || {};
      if (cfg.isDone(doc)) return;
      const due = toDate(fields[cfg.dueField]);
      if (!due) return;
      const diff = daysBetween(due, today);
      const entry = { type, due, label: cfg.label(fields) || "(untitled)", loc: fields.loc || "" };
      if (diff < 0) overdue.push(entry);
      else if (diff <= REMINDER_WINDOW_DAYS) dueSoon.push(entry);
    });
  }

  overdue.sort((a, b) => a.due - b.due);
  dueSoon.sort((a, b) => a.due - b.due);
  return { overdue, dueSoon };
}

async function collectLicenseAlerts(db) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expired = [];
  const expiringSoon = [];
  const snap = await db.collection("records").where("type", "==", "license").get();
  snap.forEach((docSnap) => {
    const fields = docSnap.data().fields || {};
    const expiry = toDate(fields.expiry);
    if (!expiry) return;
    const diff = daysBetween(expiry, today);
    const entry = { company: fields.company, loc: fields.loc, type: fields.type, expiry };
    if (diff < 0) expired.push(entry);
    else if (diff <= LICENSE_EXPIRY_WINDOW_DAYS) expiringSoon.push(entry);
  });
  expired.sort((a, b) => a.expiry - b.expiry);
  expiringSoon.sort((a, b) => a.expiry - b.expiry);
  return { expired, expiringSoon };
}

async function getActiveUserEmails(db) {
  const snap = await db.collection("users").get();
  const emails = [];
  snap.forEach((docSnap) => {
    const u = docSnap.data();
    if (u.active !== false && u.email) emails.push(u.email);
  });
  return emails;
}

function renderSection(title, items, colOrder = ["due", "label", "loc"]) {
  if (!items.length) return "";
  const rows = items.map((i) => {
    if (i.expiry) {
      return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${fmtDate(i.expiry)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${i.company} (${i.type})</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${i.loc || ""}</td></tr>`;
    }
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${fmtDate(i.due)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${i.label}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${i.loc}</td></tr>`;
  }).join("");
  return `
    <h3 style="margin:20px 0 8px;color:#1B2B4B;font-family:sans-serif">${title} (${items.length})</h3>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px">
      <thead><tr style="background:#1B2B4B;color:#fff"><th style="padding:6px 10px;text-align:left">Date</th><th style="padding:6px 10px;text-align:left">Item</th><th style="padding:6px 10px;text-align:left">Location</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function main() {
  const db = initFirebase();
  const { overdue, dueSoon } = await collectDueItems(db);
  const { expired, expiringSoon } = await collectLicenseAlerts(db);

  const totalAlerts = overdue.length + dueSoon.length + expired.length + expiringSoon.length;
  if (totalAlerts === 0) {
    console.log("No due-soon, overdue, or expiring items today — no email sent.");
    return;
  }

  const recipients = await getActiveUserEmails(db);
  if (!recipients.length) {
    console.log("No active users found to notify.");
    return;
  }

  const html = `
    <div style="font-family:sans-serif;color:#1B2B4B">
      <h2 style="font-family:sans-serif">HR Compliance Dashboard — Daily Reminder</h2>
      <p style="font-family:sans-serif;font-size:13px;color:#555">
        ${overdue.length} overdue, ${dueSoon.length} due within ${REMINDER_WINDOW_DAYS} days,
        ${expired.length} expired license(s), ${expiringSoon.length} license(s) expiring soon.
      </p>
      ${renderSection("Overdue", overdue)}
      ${renderSection(`Due within ${REMINDER_WINDOW_DAYS} days`, dueSoon)}
      ${renderSection("Expired Licenses", expired)}
      ${renderSection("Licenses Expiring Soon", expiringSoon)}
      <p style="margin-top:20px;font-family:sans-serif;font-size:13px">
        <a href="${DASHBOARD_URL}" style="color:#C9A84C">Open the dashboard</a> to review or mark items done.
        This reminder repeats daily for anything still overdue or not yet marked done.
      </p>
    </div>`;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: `HR Compliance Dashboard <${process.env.GMAIL_USER}>`,
    to: process.env.GMAIL_USER,
    bcc: recipients,
    subject: `HR Compliance: ${overdue.length} overdue, ${dueSoon.length} due soon`,
    html,
  });

  console.log(`Sent digest to ${recipients.length} recipient(s): ${overdue.length} overdue, ${dueSoon.length} due soon, ${expired.length} expired licenses, ${expiringSoon.length} expiring licenses.`);
}

main().catch((err) => {
  console.error("Reminder script failed:", err);
  process.exit(1);
});
