# Deployment Guide — HR Compliance Dashboard

This app is a static site (HTML/CSS/JS, no build step) that talks directly
to a **Firebase** project for login, the shared database, real-time sync,
and hosting. Everything — including the live URL — runs on Firebase's free
Spark plan.

**Live URL: https://hr-compliance-dashboard-26-27.web.app**

GitHub is optional here — useful for version history / collaboration on
the source code, but not required to serve the app.

---

## Part 1 — Create the Firebase project

1. Go to https://console.firebase.google.com and click **Add project**.
   Name it e.g. `evolveback-hr-compliance`. Google Analytics is not needed
   — you can turn it off.
2. Once created, click the **Web** icon (`</>`) to register a web app.
   Give it any nickname (e.g. "HR Dashboard").
3. Firebase shows you a `firebaseConfig` object. Copy the whole thing —
   it goes into [`js/firebase-config.js`](js/firebase-config.js) (already
   done for this project).

### Enable Authentication
1. In the left sidebar: **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password** (the first option
   in the list). Leave "Email link" off.

### Enable Firestore (the database)
1. In the left sidebar: **Build → Firestore Database → Create database**.
2. Choose **Production mode** (not test mode).
3. Pick a location close to your users (e.g. `asia-south1` (Mumbai) for
   India). This cannot be changed later, but it doesn't otherwise matter.

### Set the security rules
1. Still in Firestore, click the **Rules** tab.
2. Delete the default contents and paste in the entire contents of
   [`firestore.rules`](firestore.rules) from this project.
3. Click **Publish**. These rules are what actually enforce "Standard
   Users can't delete the audit log," "only the Administrator manages
   users," etc. — they run on Google's servers, not in the browser, so
   they can't be bypassed from the client.

---

## Part 2 — Deploy to Firebase Hosting

This project already includes `firebase.json` and `.firebaserc`, pointing
at project `hr-compliance-dashboard-26-27`. To deploy (or redeploy after
any code change):

```bash
npx firebase-tools deploy --only hosting --project hr-compliance-dashboard-26-27
```

The first time you run this on a new machine, it will prompt you to log
in with the Google account that owns the Firebase project (`firebase
login`) — that's a one-time browser sign-in, not something anyone else
can do on your behalf.

**Note:** always pass `--project hr-compliance-dashboard-26-27` explicitly
(as above), rather than relying on the Firebase CLI's cached "last used
project" — on a machine that's been used for other Firebase projects
before, that cache can silently point a deploy at the wrong project.

Firebase prints the live URL when it finishes:
**https://hr-compliance-dashboard-26-27.web.app**

Firestore security rules deploy the same way, whenever `firestore.rules`
changes:
```bash
npx firebase-tools deploy --only firestore:rules --project hr-compliance-dashboard-26-27
```

*(Optional: `.github/workflows/deploy.yml` is still included if you'd
rather also mirror the site to GitHub Pages, but it isn't required —
Firebase Hosting is the live URL above.)*

---

## Part 3 — Connect the code to your Firebase project

Already done for this project — [`js/firebase-config.js`](js/firebase-config.js)
has the real `firebaseConfig` values from Part 1. If you ever move this to
a different Firebase project, update that file (and `.firebaserc`) and
redeploy.

---

## Part 4 — First login (create Roopa's Administrator account)

1. Open **https://hr-compliance-dashboard-26-27.web.app**.
2. Because no administrator exists yet, you'll see **"Welcome — First-Time
   Setup."** This screen only ever appears once, for whoever gets there
   first — so make sure Roopa is the one who fills it in.
3. Roopa enters her name, work email, and a password, and clicks
   **Create Administrator Account**. She is now signed in as the Super
   Administrator.
4. From here on, everyone else sees the normal **Sign In** screen —
   there is no public sign-up. New accounts are created only by Roopa
   (or another admin) from the **Admin** tab.

## Part 5 — Load the original data & add the team

1. In the **Admin** tab, click **Import Initial Dataset** once — this
   loads the original Excel-derived compliance calendar (monthly PF/ESI/PT
   dues, quarterly/half-yearly/yearly returns, and the license tracker)
   into the shared database. It refuses to run twice.
2. In the same tab, use **Add User** to create an account for each
   teammate: name, email, a temporary password, and role (Standard User
   or Administrator). Share the temporary password with them securely
   (not over plain email/chat if you can avoid it) and ask them to treat
   it as temporary — see the note on password resets below.
3. Everyone now signs in at the same URL. Any change one person makes
   (checking an item done, adding an entry, editing a license) appears
   instantly for everyone else — that's Firestore's real-time sync, no
   refresh needed.

---

## Part 6 — Daily email reminders

A static site can't send email or wake itself up on a schedule, so this
runs as a small Node script (`scripts/send-reminders.js`) on a **GitHub
Actions cron job** (`.github/workflows/email-reminders.yml`), once a day.
It emails every active user a digest of anything overdue or due within 7
days — and because it just re-checks current state each run, an overdue
item keeps showing up in the digest every day until someone marks it
done. This step needs the code to actually live in a GitHub repo (it
doesn't yet) — **send me the repo URL and I'll push it**, then walk
through the two secrets below with you.

### 1. Create a Firebase service account key
This lets the script read Firestore without a user being logged in.
1. Firebase Console → ⚙️ Project Settings → **Service Accounts** tab.
2. Click **Generate new private key** — downloads a `.json` file. Treat
   this like a password; it grants full admin access to your Firebase
   project. Don't commit it to the repo.
3. Base64-encode it and copy the output (you'll paste it into a GitHub
   secret, not into any file in the repo):
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\key.json")) | Set-Clipboard`
   - Mac/Linux: `base64 -i path/to/key.json | pbcopy` (or `| xclip` on Linux)

### 2. Create a Gmail App Password for the sending account
1. The Google Account that will send these emails needs 2-Step
   Verification turned on (Google Account → Security).
2. Google Account → Security → **App passwords** → create one (name it
   e.g. "HR Compliance Reminders") → copy the 16-character password.

### 3. Add both as GitHub Actions secrets
In the repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add three:
| Secret name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | the base64 string from step 1 |
| `GMAIL_USER` | the Gmail address from step 2 |
| `GMAIL_APP_PASSWORD` | the 16-character app password from step 2 |

### 4. Test it
**Actions** tab → **Daily Compliance Email Reminders** → **Run workflow**
(the `workflow_dispatch` trigger lets you run it on demand instead of
waiting for 7am). Check the run's logs — it prints how many
overdue/due-soon/expiring items it found and how many people it emailed,
or says explicitly if there was nothing to report or no active users.

After that it runs automatically every day at 7:00 AM IST
(`30 1 * * *` UTC in the workflow file — change that cron expression if
you want a different time).

---

## What's enforced, and how

| Requirement | How it's implemented |
|---|---|
| Real-time multi-user sync | Firestore `onSnapshot` listeners — every browser tab gets pushed updates instantly. |
| Login / unique credentials | Firebase Authentication (email + password), one account per person. |
| Admin vs Standard User | A `role` field on each user's Firestore profile, enforced in `firestore.rules` (server-side) and reflected in the UI. |
| Audit trail | Every create/edit/delete writes an `auditLog` entry (who, when, what changed, old → new value) — see the **Activity Log** tab. |
| Only admin deletes audit log | Enforced in `firestore.rules` (`allow delete: if isAdmin()` on `auditLog`), not just hidden in the UI. |
| Session timeout | 30 minutes of inactivity signs the user out automatically (`SESSION_TIMEOUT_MINUTES` in `js/firebase-config.js`). |
| Data encryption | Firestore encrypts all data at rest and in transit (TLS) by default — this is inherent to Firebase, not something the app configures. |
| Email reminders before/after due date | Daily GitHub Actions cron job (`scripts/send-reminders.js`) — see Part 6. Fires at exact points relative to each item's due date: 7 days before, 1 day after, and a 5-days-after escalation if still incomplete. Reminders go to `REMINDER_RECIPIENT` (default vinod.k@evolveback.com); escalations additionally go to `ESCALATION_RECIPIENT` (default nishant.m@evolveback.com). |

## Known limitations (free-tier trade-offs)

- **The email digest goes to every active user, not a specific
  "assignee."** The data model doesn't track a per-item owner (the
  original spreadsheet didn't either), so everyone with an account gets
  the same daily digest rather than only the person responsible for a
  given filing. If you want per-item ownership later, that's a real
  schema change (an "assigned to" field on each record) — say so and it
  can be added.
- **"Deleting" a user account deactivates it** (`active: false`, which
  blocks login immediately) rather than permanently erasing the Firebase
  Auth account. Permanently deleting Auth accounts from the client isn't
  possible without a paid Firebase plan (Cloud Functions require the
  Blaze plan); deactivation achieves the same practical outcome —the
  person can no longer sign in — without incurring any cost.
- **Password resets** are self-service ("Forgot password?" on the login
  screen sends a reset email via Firebase) — there's no in-app "force
  password change" step after first login, so ask new users to reset
  their password themselves the first time if you want them off the
  temporary one.

## Costs

At the scale of one HR team (a handful of admins/users, a few hundred
compliance records), this stays entirely within Firebase's free **Spark**
plan (50K reads / 20K writes / 1GB storage per day) and GitHub's free
Pages hosting. There is nothing to pay for unless usage grows far beyond
that.
