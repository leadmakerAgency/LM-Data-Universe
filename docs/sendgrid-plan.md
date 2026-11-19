# Plan: email through SendGrid (automations, invites, mentions, sign-in mail)

Status (18 Nov 2026): steps 0, 3, 4, 5 and 6 are built, tested and deployed
(migration `20261119100000_mail.sql`; functions `deliver`, `notify`,
`sendgrid-events`). Steps 1 and 2 wait for the SendGrid account details: the
sending domain, the API key and the app's address (README → "Email" has the
exact commands). Not built: attaching files from an Attachments column, and
per-document "turn email off" for administrators.

Written from the code, the live Supabase project (`bcvcfqyymwypwclsdeog`) and
current SendGrid / Supabase docs.

## 1. Where things stand today

The email path is written end to end, but it has never sent a message.

| Piece | State |
| --- | --- |
| Automation editor (Integrations → Automations) | Works: saves name, table, trigger, watched columns, condition, up to 5 email/webhook actions |
| Queueing (`tg_integrations` on `doc_actions` → `job_queue`) | Works |
| Tag filling (`_fill_template` in the database) | Works for `{{ColId}}`, `{{Column label}}`, `{{id}}`; `{{link}}` is filled by the sender |
| `deliver` Edge Function (automation emails + webhooks) | Deployed; calls SendGrid `POST /v3/mail/send` with plain text only |
| `notify` Edge Function (invites, "shared with you", @mentions) | Deployed; text + HTML |
| **Secrets `SENDGRID_API_KEY`, `NOTIFY_FROM`, `APP_URL`** | **Not set.** `notify` has answered `503 … not set` 359 times; 2 invite emails are waiting unsent |
| Supabase Auth mail (confirm sign-up, reset password) | Supabase's built-in sender, limited to a couple of emails an hour |
| Delivery feedback (bounced, blocked, spam) | None. A job is "done" as soon as SendGrid accepts it |
| Sending limits | None. Any document owner can send to any address, 10 recipients per email |

So "not wired" is accurate in one sense: the last step (a SendGrid account,
an authenticated sender and three secrets) is missing, and nothing in the app
tells an owner that. Everything below either closes that step or fixes what
would be wrong the day after it is closed.

## 2. Decisions to make first

1. **Sending domain and address.** One authenticated domain for the whole app
   (recommended), e.g. `notifications@mail.<your-domain>`. SendGrid rejects
   any `from` that is not a verified sender identity, so per-customer `from`
   addresses are not possible without authenticating each customer's domain.
   Owners instead choose a **From name** and a **Reply-To** per automation.
2. **The app's public address** (`APP_URL`), used for `{{link}}` and the
   buttons in invite emails. Needed before any email is useful.
3. **SendGrid plan.** The free tier is reported as 100 emails a day (check the
   pricing page). The limits in section 6 assume a paid plan can replace it.
4. **A separate SendGrid API key for this app**, restricted to *Mail Send*
   (plus read access to suppressions if we build 5.4), not shared with the
   email app.

## 3. Sharing the Supabase project with the email app

The other app lives in its own schema, `email_app`, with its own migrations
(`email_app_001…010` in the shared migration history). This app lives in
`public`. Rules, to be written into the project (step 0 of the build):

- **Never touch** schema `email_app`, anything named `email_app_*`, or cron
  jobs that don't start with `lmdu-`.
- **Our names:** tables and functions in `public`; cron jobs `lmdu-*`; Edge
  Functions `doc-worker`, `deliver`, `notify` (+ `sendgrid-events`); bucket
  `attachments`; Vault secrets `doc_worker_url`, `doc_worker_secret`.
- **Edge Function secrets are project-wide**, so a plain `SENDGRID_API_KEY`
  could collide with the other app. Ours become `LMDU_SENDGRID_API_KEY`,
  `LMDU_MAIL_FROM`, `LMDU_APP_URL`, `LMDU_SENDGRID_WEBHOOK_KEY` (the old
  names stay as a fallback).
- **Migrations:** apply one file at a time (dashboard, MCP `apply_migration`,
  or `supabase db query`). Never `supabase db push`, `db reset` or
  `migration repair` against this project: the local folder doesn't contain
  the email app's migrations, and those commands act on the whole history.
- **Extensions** (`pg_cron`, `pg_net`, `pgcrypto`, Vault) are shared: don't
  drop or downgrade them.
- **SendGrid:** every message we send carries the category `lmdu`, so the
  two apps' statistics and events can be told apart even on one account.

Where the notes go: `comment on schema public` and comments on our cron
jobs' functions in a migration, a "Shared Supabase project" section in the
README, and this file.

## 4. Build steps

### Step 0 — Isolation notes (small)
Migration with the comments above; README section. No behaviour change.

### Step 1 — Make it send (the actual wiring)
*You do, I can't:* create the SendGrid key, authenticate the domain (SendGrid
gives CNAME records for SPF/DKIM; add a DMARC record), then run
`npx supabase secrets set LMDU_SENDGRID_API_KEY=… LMDU_MAIL_FROM="LM Data Universe <notifications@…>" LMDU_APP_URL=https://…`.
*I do:* read the new secret names in `deliver` and `notify`; redeploy both.
*Check:* the 2 waiting invites go out within a minute; "Send test" on an
automation arrives.

### Step 2 — Supabase Auth mail through SendGrid
Dashboard → Authentication → SMTP: host `smtp.sendgrid.net`, port 587, user
`apikey`, password = the API key, sender = the same address. Then raise the
email rate limit under Authentication → Rate Limits (it stays low by default
even with custom SMTP). This is a dashboard setting you enter; I'll give the
exact values and restyle the confirmation / reset templates as text.

### Step 3 — Email settings and status in the app (front end + database)
- New RPC `email_status()` → `{configured, from, app_url}` so the UI can say
  whether email works. The Edge Functions report it into a one-row table
  `mail_config` (address and app URL only; the key never leaves the secrets).
- Integrations page: a banner when email isn't configured ("Emails are queued
  but can't be sent yet"), instead of the current silent failure in the
  delivery log.
- Admin panel: a Mail card — configured or not, sent / failed / bounced in the
  last 7 days, a "Send me a test email" button.

### Step 4 — The email editor and tags (front end + database)
Today the tags under the message are plain text: only the first 12 columns,
not clickable, and a mistyped tag is sent to the customer as `{{Nmae}}`.

- **Tag picker:** every column, searchable, click to insert at the cursor in
  To, Subject or Message. Shows the label, inserts `{{col_id}}`.
- **Validation on save** (client and `save_automation`): unknown tags are
  refused with the name of the tag; `To` must contain an address or a tag.
- **Tags follow renames:** when a column's id changes, rewrite `{{old}}` in
  the document's automations (same place formulas are rewritten).
- **More tags:** `{{record_link}}` (opens that record, not just the document),
  `{{doc}}`, `{{table}}`, `{{changed_by}}`, and `{{Ref.Field}}` through a
  reference column.
- **Formatting as the grid shows it:** dates, currency and percentages use
  the column's format and the document's locale/time zone (today a currency
  cell is sent as a bare number). Done in `_value_text`.
- **Empty values:** `{{Name|there}}` fallback syntax.
- **Preview:** a panel showing the filled email for a chosen record, from a
  new RPC `preview_automation` that runs the same `_fill_template`.
- **New fields per email action:** From name, Reply-To, CC, BCC.
- **HTML email:** the message is written as Markdown (bold, links, lists);
  `deliver` sends `text/plain` + `text/html`. Tag values are HTML-escaped so a
  cell can't inject markup. Footer names the document and automation.
- **Attachments (optional, later):** attach files from an Attachments column.

### Step 5 — Delivery, feedback and limits (back end + Supabase)
1. **Tracking fields on every send:** `categories: ["lmdu", "automation"]`,
   `custom_args: {lmdu_job, lmdu_doc, lmdu_env}`; open/click tracking off for
   transactional mail.
2. **New Edge Function `sendgrid-events`** receiving SendGrid's Event Webhook.
   Verifies the ECDSA signature (`X-Twilio-Email-Event-Webhook-Signature` +
   `-Timestamp` headers over timestamp + raw body) with the public key in
   `LMDU_SENDGRID_WEBHOOK_KEY`; ignores events without our `lmdu_env`.
3. **New table `mail_events`** `(id, job_id, notification_id, doc_id, email,
   event, reason, at)` — RLS on, no policies, read through RPCs. `job_queue`
   gains `delivery` (`sent | delivered | bounced | blocked | spam`), shown in
   the delivery log next to each email.
4. **New table `mail_suppressions`** `(email, reason, at)`: filled by bounce
   and spam-report events; `jobs_claim` skips those addresses with a clear
   "address bounced on <date>" instead of sending again. Owners see and can
   clear entries for their document's recipients.
5. **Error handling by SendGrid status:** 400/401/403 (bad request, bad key,
   unverified sender) fail at once with a readable message and no retries;
   429 and 5xx retry with the existing backoff. A 401/403 also flips
   `mail_config.configured` so the banner from step 3 appears.
6. **Limits** (in `tg_integrations` / `jobs_claim`, counted in the existing
   `usage_counters`): emails per document per day by plan (e.g. Free 100,
   Pro 2,000), 10 recipients per email as now, at most 1 email per automation
   per record per minute (stops loops and bulk-paste floods: a 5,000-row paste
   becomes one digest or is refused with a message). Over-limit jobs are
   `skipped` with the reason.
7. **Audit:** automation created / changed / deleted already logged; add
   "email limit reached".

### Step 6 — Tests and docs
- `supabase/tests/mail.sql`: tag validation, rename rewrite, suppression
  skip, limits, RLS on the new tables, signature check rejected without key.
- Unit tests for the Markdown → HTML renderer and the tag parser.
- A `deliver` dry-run mode (`LMDU_MAIL_DRY_RUN=1`) that logs instead of
  sending, for the SQL tests and local work.
- README: setup, secrets, limits, how the event webhook is configured.

## 5. Database changes at a glance

| Object | Change |
| --- | --- |
| `mail_config` (new, one row) | From address, app URL, configured flag, last error |
| `mail_events` (new) | Delivery events from SendGrid |
| `mail_suppressions` (new) | Addresses that bounced or reported spam |
| `job_queue.delivery` (new column) | Final delivery state of an email |
| `doc_automations.actions` (jsonb) | Email actions gain `from_name`, `reply_to`, `cc`, `bcc`, `format` |
| `_fill_template`, `_value_text` | Formatting, fallbacks, new tags, HTML-safe output |
| `save_automation`, `jobs_claim`, `jobs_done` | Tag validation, suppressions, limits, error classes |
| `email_status`, `preview_automation`, `mail_log` (new RPCs) | For the UI |
| `plans` | `max_emails_per_day` |

All in `public`, all additive, one migration per step.

## 6. Risks

| Risk | Handling |
| --- | --- |
| Owners use automations to send bulk or unsolicited mail from our domain | Daily limits per plan, per-record throttle, suppression list, category stats per document, admin can turn a document's email off |
| A column value contains HTML or a script | Values are escaped before going into the HTML part |
| The key or sender is wrong | Non-retryable errors surface in the banner and admin card within a minute |
| Event webhook is spoofed | Signature verification; unsigned requests are refused |
| Changes disturb the email app | Step 0 rules; nothing outside `public` and `lmdu-*` is touched |
| Free-tier cap (about 100 a day) hit silently | 429 handling + admin card shows it |

## 7. Order and size

Steps 0–2 are small and unblock everything (about half a session, mostly
waiting on DNS). Step 3 half a session, step 4 one to one and a half, step 5
one and a half, step 6 half. Roughly 4–5 sessions in all.

## 8. What I need from you

1. The sending domain and From address.
2. The app's public URL.
3. Confirmation that a separate SendGrid API key for this app is fine, and
   which plan the account is on.
4. Whether to build steps 4 and 5 in full, or stop after step 3 first.
