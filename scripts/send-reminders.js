// Scheduled email reminder — run daily by GitHub Actions
// (.github/workflows/email-reminders.yml). Not part of the web app itself;
// this is a small Node script that runs outside the browser, because a
// static site can't send email or wake itself up on a timer.
//
// Email pattern (exact-day triggers, not a rolling window):
//   - REMINDER_BEFORE_DAYS   days before the due date  → reminder to REMINDER_RECIPIENT
//   - REMINDER_AFTER_DAYS    days after the due date    → reminder to REMINDER_RECIPIENT
//   - ESCALATION_AFTER_DAYS  days after the due date, if still not done →
//     escalation to REMINDER_RECIPIENT + ESCALATION_RECIPIENT
// Each fires once per item, on the specific day the gap matches — since
// this runs once a day, that's naturally "send once," no bookkeeping
// needed. If the workflow doesn't run on the exact matching day for some
// reason, that particular trigger is simply missed for that item.
// The same three trigger points apply to license expiries too (treating
// "expiry date" the same way as "due date").
//
// Required environment variables (set as GitHub Actions secrets):
//   FIREBASE_SERVICE_ACCOUNT_BASE64  — base64-encoded Firebase service
//                                      account JSON key (Project Settings →
//                                      Service Accounts → Generate new key)
//   GMAIL_USER                       — the Gmail address sending the mail
//   GMAIL_APP_PASSWORD               — a Google App Password for that account
//
// Criteria — plain (non-secret) env vars in the workflow's `env:` block,
// no code changes needed to adjust:
//   REMINDER_RECIPIENT     — default vinod.k@evolveback.com
//   ESCALATION_RECIPIENT   — default nishant.m@evolveback.com
//   REMINDER_BEFORE_DAYS   — default 7
//   REMINDER_AFTER_DAYS    — default 1
//   ESCALATION_AFTER_DAYS  — default 5

const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const REMINDER_RECIPIENT = process.env.REMINDER_RECIPIENT || "vinod.k@evolveback.com";
const ESCALATION_RECIPIENT = process.env.ESCALATION_RECIPIENT || "nishant.m@evolveback.com";
const REMINDER_BEFORE_DAYS = parseInt(process.env.REMINDER_BEFORE_DAYS || "7", 10);
const REMINDER_AFTER_DAYS = parseInt(process.env.REMINDER_AFTER_DAYS || "1", 10);
const ESCALATION_AFTER_DAYS = parseInt(process.env.ESCALATION_AFTER_DAYS || "5", 10);
const DASHBOARD_URL = "https://hr-compliance-dashboard-25-26.web.app";

function initFirebase() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable.");
  const serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin.firestore();
}

// Positive = due date is in the future; negative = due date has passed.
function daysUntil(due, today) {
  const d1 = new Date(due); d1.setHours(0, 0, 0, 0);
  const d2 = new Date(today); d2.setHours(0, 0, 0, 0);
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

// Buckets an item into one of the three trigger points based on how many
// days its due date is from today, or null if it doesn't match any.
function classify(diff) {
  if (diff === REMINDER_BEFORE_DAYS) return "dueSoon";
  if (diff === -REMINDER_AFTER_DAYS) return "overdue";
  if (diff === -ESCALATION_AFTER_DAYS) return "escalation";
  return null;
}

async function collectDueItems(db) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets = { dueSoon: [], overdue: [], escalation: [] };

  for (const [type, cfg] of Object.entries(TYPE_CONFIG)) {
    const snap = await db.collection("records").where("type", "==", type).get();
    snap.forEach((docSnap) => {
      const doc = docSnap.data();
      const fields = doc.fields || {};
      if (cfg.isDone(doc)) return;
      const due = toDate(fields[cfg.dueField]);
      if (!due) return;
      const bucket = classify(daysUntil(due, today));
      if (!bucket) return;
      buckets[bucket].push({ type, due, label: cfg.label(fields) || "(untitled)", loc: fields.loc || "" });
    });
  }
  Object.values(buckets).forEach((list) => list.sort((a, b) => a.due - b.due));
  return buckets;
}

async function collectLicenseAlerts(db) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets = { dueSoon: [], overdue: [], escalation: [] };
  const snap = await db.collection("records").where("type", "==", "license").get();
  snap.forEach((docSnap) => {
    const fields = docSnap.data().fields || {};
    const expiry = toDate(fields.expiry);
    if (!expiry) return;
    const bucket = classify(daysUntil(expiry, today));
    if (!bucket) return;
    buckets[bucket].push({ company: fields.company, loc: fields.loc, type: fields.type, expiry });
  });
  Object.values(buckets).forEach((list) => list.sort((a, b) => a.expiry - b.expiry));
  return buckets;
}

function renderSection(title, items) {
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

function footerHtml() {
  return `<p style="margin-top:20px;font-family:sans-serif;font-size:13px">
    <a href="${DASHBOARD_URL}" style="color:#C9A84C">Open the dashboard</a> to review or mark items done.
  </p>`;
}

async function sendMail(transporter, { to, subject, html }) {
  await transporter.sendMail({
    from: `HR Compliance Dashboard <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  });
}

async function main() {
  const db = initFirebase();
  const items = await collectDueItems(db);
  const licenses = await collectLicenseAlerts(db);

  const dueSoon = [...items.dueSoon, ...licenses.dueSoon];
  const overdue = [...items.overdue, ...licenses.overdue];
  const escalation = [...items.escalation, ...licenses.escalation];

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  let sentCount = 0;

  if (dueSoon.length || overdue.length) {
    const html = `
      <div style="font-family:sans-serif;color:#1B2B4B">
        <h2 style="font-family:sans-serif">HR Compliance Dashboard — Reminder</h2>
        <p style="font-family:sans-serif;font-size:13px;color:#555">
          ${dueSoon.length} item(s) due in ${REMINDER_BEFORE_DAYS} days, ${overdue.length} item(s) ${REMINDER_AFTER_DAYS} day(s) overdue.
        </p>
        ${renderSection(`Due in ${REMINDER_BEFORE_DAYS} days`, dueSoon)}
        ${renderSection(`${REMINDER_AFTER_DAYS} day(s) overdue`, overdue)}
        ${footerHtml()}
      </div>`;
    await sendMail(transporter, {
      to: REMINDER_RECIPIENT,
      subject: `HR Compliance Reminder: ${dueSoon.length} due soon, ${overdue.length} overdue`,
      html,
    });
    sentCount++;
    console.log(`Reminder email sent to ${REMINDER_RECIPIENT}: ${dueSoon.length} due soon, ${overdue.length} overdue.`);
  }

  if (escalation.length) {
    const html = `
      <div style="font-family:sans-serif;color:#1B2B4B">
        <h2 style="font-family:sans-serif;color:#DC2626">HR Compliance Dashboard — ESCALATION</h2>
        <p style="font-family:sans-serif;font-size:13px;color:#555">
          The following item(s) are still not marked complete, ${ESCALATION_AFTER_DAYS} days after their due date.
        </p>
        ${renderSection("Escalation", escalation)}
        ${footerHtml()}
      </div>`;
    await sendMail(transporter, {
      to: [REMINDER_RECIPIENT, ESCALATION_RECIPIENT].join(","),
      subject: `HR Compliance ESCALATION: ${escalation.length} item(s) ${ESCALATION_AFTER_DAYS} days overdue`,
      html,
    });
    sentCount++;
    console.log(`Escalation email sent to ${REMINDER_RECIPIENT}, ${ESCALATION_RECIPIENT}: ${escalation.length} item(s).`);
  }

  if (!sentCount) {
    console.log("Nothing matched today's trigger points (due in " + REMINDER_BEFORE_DAYS + " days / " + REMINDER_AFTER_DAYS + " day overdue / " + ESCALATION_AFTER_DAYS + " days overdue) — no email sent.");
  }
}

main().catch((err) => {
  console.error("Reminder script failed:", err);
  process.exit(1);
});
