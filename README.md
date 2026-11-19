# LM Data Universe

A relational spreadsheet app: documents with linked tables, typed columns,
formulas, pages of widgets (table, card, card list, chart, summary, form),
sharing, live collaboration and public forms. Backed by Supabase.

## Run locally

```bash
npm install
npm run dev
```

`.env.local` needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
In Supabase → Authentication → URL Configuration, add your local URL
(e.g. `http://localhost:3000/**`) to the redirect allow list so confirmation
and password-reset links come back to the app.

## Layout

- `supabase/migrations/` – schema, row-level security, sharing and form RPCs, the action log and the formula worker queue (applied in order).
- `supabase/functions/doc-worker/` – Edge Function that recomputes formulas on the server and writes `doc_rows.computed`.
- `supabase/functions/deliver/`, `notify/`, `sendgrid-events/`, `_shared/` – webhooks and email (see “Email”).
- `packages/engine/` – formula parser, evaluator, dependency analysis and server recalculation (`$Col`, `$Ref.Col`, `Table.lookupRecords(...)`, Excel-style functions). No React or Supabase imports; imported as `@engine/*`.
- `src/lib/actions.ts` – the action types every change is made of, and their local application.
- `src/lib/format.ts` – per-type display formatting and input parsing.
- `src/lib/attachments.ts` – Attachments columns: uploads to the private `attachments` bucket, metadata in `doc_attachments`, signed URLs. Files stay in storage when removed from a cell, so undo can restore them.
- `src/store/docStore.ts` – open document state, writes through `apply_actions`, realtime sync, server-side undo/redo.
- `src/lib/view.ts` – which rows a widget shows (linking, filters, sort, search).
- `src/components/doc/` – editor UI; `src/components/home/` – workspaces and documents.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run test:sql   # every migration + the SQL security tests in supabase/tests, in an in-memory Postgres
```

## Formulas

Formulas are Python-style. One line is an expression; several lines form a
small program with local variables, `if/elif/else`, `for` loops, `return`
(a final bare expression is returned), list comprehensions, `lambda`,
f-strings, tuples, slices and dicts. Over 150 functions (Excel-style and
Python builtins), sorted lookups (`lookupRecords(..., sort_by="-Date")`),
`PREVIOUS` / `NEXT` / `RANK`, `VLOOKUP` and the `user` object are available.
Comparisons chain as in Python (`1 < $Qty <= 10`), lists made in a formula can
be changed (`out.append(x)`, `sort`, `pop`…; lists read from cells are copies),
slices take a step (`items[::2]`), `"%s: %d" % (a, b)` formats text and
`TEXT(value, "#,##0.00")` / `TEXT(date, "d mmm yyyy")` follow Excel formats.
`try`, `import`, `while`, `def`, `class` and `with` aren't supported and say so.

Renaming a column rewrites the formulas that refer to it in every table
(`$Old`, `$Ref.Old`, `Table.lookupRecords(Old=…)`, `sort_by="Old"`), as well as
conditional-style and dropdown conditions (`packages/engine/src/rename.ts`).
References inside f-strings and on values whose table can't be known ahead of
time (e.g. a column of type Any) are left as they are.
The engine lives in `packages/engine` and is shared by the browser and the
`doc-worker` Edge Function.

Trigger formulas are data columns with a formula and
`options.trigger = { onNew, onChange: "any" | [column ids] }`; the app adds
their values to the same save, and the worker fills them for records that
arrive through public forms.

## Collaboration (Phase 2)

- **Sharing**: documents, workspaces and teams are shared by email; an email
  without an account becomes a pending invite, accepted once that address is
  confirmed. Public links (`/s/<token>`) give view or edit access, optionally
  without signing in; the app sends the token as the `x-share-token` header and
  `share_link_access()` turns it into access in `my_doc_ids` / `doc_role`.
  Link visitors who aren't signed in don't get live updates (reload to refresh).
- **Teams**: a team's roles apply to all of its workspaces and documents.
- **Comments**: per cell, with replies, @mentions (emailed) and resolve; `doc_comments`.
- **Presence**: avatars and coloured cell outlines over a Realtime Presence channel.
- **History**: the activity feed reads `doc_actions`; snapshots are taken hourly by
  `pg_cron` (`_auto_snapshots`, kept daily for 30 days then weekly) or by hand, and can
  be opened read-only (`?snapshot=<id>`), compared with the current version, or restored
  (owners; a snapshot of the current state is saved first; undo history is cleared).
- **Trash**: deleted documents are kept 30 days (`_purge_trash` runs nightly).
- **Copies**: "Save a copy" (optionally structure only, as a template) and "Work on a
  copy", which can be compared with and then replace the original (owners).
  Attachments aren't copied.
- **Email**: invites, "shared with you" and mentions queue in `notification_queue`;
  the `notify` Edge Function sends them through SendGrid every minute once these
  secrets are set: `SENDGRID_API_KEY`, `NOTIFY_FROM`, `APP_URL`.

## Access rules (Phase 3)

Owners open **Access rules** in the document sidebar to limit who reads, adds,
changes and deletes which records and columns. Conditions use the formula
language: `user.Email`, `user.Access` (owner / editor / viewer), `user.Name`,
`user.UserID`, `user.IsLoggedIn`, user attributes (`user.Person.Dept`, looked up
in a table by the person's email), `rec.Column` (following references:
`rec.Team.Name`), `newRec.Column` for the values being written, comparisons,
`in` / `not in`, `and` / `or` / `not` and `.lower()` / `.upper()` / `.strip()`.

- **Order**: a table's rules, then the default rules, top to bottom; the first
  rule whose condition is true decides. Column rules hide or lock cells on top.
  Rules only narrow what a role allows; they never give more.
- **Enforced in the database**: `packages/engine/src/acl.ts` turns the text into
  a condition tree (`doc_access_rules.condition_ast`); the database turns that
  tree into SQL itself, quoting values and checking column ids. A rule that
  can't be evaluated (e.g. its column was removed) fails closed.
- **Reads**: in a document with rules, `doc_rows` can't be selected directly
  (API and `postgres_changes` see nothing). The app reads through
  `read_rows()`, which filters records and strips hidden cells; columns hidden
  outright disappear from `doc_columns`. Changes arrive as a private Broadcast on
  `doc:<id>` carrying row ids only, which the app re-reads. Formula values come
  from the server (`computed`), since the browser no longer has every record.
- **Writes**: `apply_actions`, undo and redo check every record operation
  (`_acl_check_op`) before applying it, in the same transaction.
- **Unfiltered data stays with owners**: the activity log, snapshots, compare and
  copies. Comments and attachments follow the visibility of their cell.
- **Special rules**: whether editors may change tables and columns (off by
  default once there are rules, because a formula column could show any value),
  owner-only copies and downloads, and whether everyone may read the rules.
- **View as**: owners can open the document as another person sees it (read-only).
- The formula worker is not subject to the rules. Public form responses are
  checked as a signed-out person with edit rights (see below).

## Widgets and forms (Phase 4)

Migration `20261111100000_phase4_widgets_forms.sql`; tests in `supabase/tests/forms.sql`.

- **Form builder**: the form widget is edited in place (Build / Preview). Blocks are
  fields, headings, Markdown text and separators (`options.formItems`); fields have
  a label, help text, required flag, width (full, half, third) and, for choices and
  toggles, how they are shown. Every column type except formulas works, including
  reference pickers and file uploads. Optional redirect after submitting.
- **Public submissions** go through `submit_form`, which checks each value against its
  column type, applies rate limits (5 a minute and 100 a day per visitor, 500 an hour
  per form), drops honeypot submissions, logs everything in `form_submissions_log`
  (visitors only as a salted hash) and returns refusals instead of raising them.
  Trigger formulas then run in the formula worker as before. `form_stats` shows
  editors the week's responses and refusals.
- **Form uploads**: `form_upload_start` issues a one-time path in the `attachments`
  bucket that a signed-out visitor may upload to for an hour (10 MB a file, 10 a
  field); on submit the file becomes an ordinary attachment. Unused upload slots are
  cleaned up daily; files uploaded but never submitted stay in storage.
- **Access rules and forms**: reference choices are the records a signed-out viewer
  may read; a response must pass the create rules as a signed-out editor.
- **Calendar widget**: month, week and day views from a Date/DateTime start (and
  optional end) column; drag to move, drag the bottom edge to resize (DateTime),
  double-click to add or open; colour by a column; other widgets can link to it.
- **Charts**: scatter, split series, error bars, inverted Y axis, connect gaps or join
  points, markers; with "Each record" (or scatter) clicking a point selects its
  record, so charts can drive linked widgets.
- **Custom widgets**: a page in a sandboxed frame (no `allow-same-origin`) with an
  access level (none, read this table, full document) and column mapping. The page
  side is `public/widgets/lmdu-widget.js` (documented in the file). Built-ins in
  `public/widgets/`: Markdown/HTML viewer, map (Leaflet), invoice, print labels and
  a combo chart (Chart.js); they are handed to the frame inline (`srcdoc`). Full
  access writes only rows of the widget's own table, with the viewer's permissions.
- Not done: Cloudflare Turnstile; dropdown conditions don't apply on public forms.

## API, webhooks and automations (Phase 5)

Migration `20261111140000_phase5_integrations.sql`; tests in `supabase/tests/integrations.sql`;
Edge Function `supabase/functions/deliver`.

- **API keys** (account menu → API keys): `lmdu_` + 48 hex characters, shown once, stored
  as a SHA-256 hash. 600 calls a minute per key.
- **REST API** (`src/app/api/docs/...`, helpers in `src/lib/apiServer.ts`), with
  `Authorization: Bearer <key>`. Tables and columns are addressed by name:
  - `GET /api/docs/{doc}/tables`, `GET …/tables/{table}/columns`
  - `GET …/tables/{table}/records?filter={"Col":["v"]}&sort=Col,-Other&limit=100`
    → `{records: [{id, fields: {Col: value}}]}` (formula values included)
  - `POST …/records` `{records: [{fields}]}` · `PATCH …/records` `{records: [{id, fields}]}`
  - `PUT …/records` `{records: [{require, fields}]}` adds or updates (`?onmany=first|all|none`, `?noadd`, `?noupdate`)
  - `DELETE …/records?ids=1,2` or `POST …/records/delete` `[1, 2]`
  The route handlers only forward the key; the database's `api_*` functions resolve it
  to its owner (`_api_auth` sets the JWT subject for the call), so roles, access rules
  and the action log apply as in the app (source `api`). Errors map to 400/401/403/404/429.
- **Webhooks and automations** (document → Integrations, owners only). A trigger on
  `doc_actions` turns changes into `job_queue` rows: webhooks per table for added and/or
  changed records (optionally only when a "ready" column is true); automations on add
  and/or change of chosen columns, with a condition in the access-rule language
  (`rec.Status == "Won"`) and up to 5 actions: email (`{{Column}}`, `{{id}}`, `{{link}}`
  placeholders) or webhook. Records are read as the integration's creator may.
  Outgoing URLs must be https and not local or private addresses.
- **Delivery**: `_kick_jobs` wakes the `deliver` Edge Function through pg_net right after
  a change (and pg_cron every minute). Webhooks are signed: `X-LMDU-Signature: sha256=`
  HMAC-SHA256 of `"<X-LMDU-Timestamp>.<body>"`. Failures are retried with growing waits
  (30 s … 60 min; 8 attempts, emails 5). Emails go through SendGrid with the `notify`
  secrets (`SENDGRID_API_KEY`, `NOTIFY_FROM`, `APP_URL`).
- **Import** (document → Import / export → Import data…, or Raw data): CSV, TSV or Excel
  from a file, a web address or a Google Sheets link (shared "anyone with the link"), into
  a new table or an existing one. Columns are matched by name and can be remapped or
  created; "update matches on key columns" updates records whose key values match
  (ignoring case and spaces) and adds or skips the rest, with counts and a preview first.
  Logic in `src/lib/importer.ts`. Web addresses are fetched by `/api/import-url` for
  signed-in people only, over http(s), refusing local and private networks (checked after
  DNS lookup and on each redirect), 20 MB and 20 s at most (`src/lib/urlImport.ts`).
- **Export**: any table as CSV, TSV or Excel (Import / export menu or Raw data), the whole
  document as Excel, and a **backup file** (`doc_backup`: structure, records, pages,
  widgets, and for owners the access rules; no attached files). Home → Import a file
  restores a backup as a new document (`restore_backup`, new ids throughout).
  Migration `20261111170000_phase5_backup_restore.sql`; tests in `supabase/tests/forms_backup.sql`.
- **Embed codes** (Share → a view link without sign-in → the `</>` button): an `<iframe>`
  of `/s/<token>?embed=1` with optional `&nav=1` (page list) and `&page=<id>`. Embedded
  documents are read-only and show no toolbar, side panels or widget menus.

## Platform (Phase 6)

Migration `20261112100000_phase6_platform.sql`; tests in `supabase/tests/platform.sql`.

- **Document settings** (document menu → Document settings…, owners and editors; `set_doc_settings`):
  locale (number format, month names, how typed numbers are read), default currency for currency
  columns, and time zone. DateTime values are shown and entered in the document's zone, the
  calendar places events by it, and `TODAY()` is today there (`TODAY("Asia/Tokyo")` picks a zone
  explicitly). Changing the zone recalculates every formula; the worker uses UTC when none is set.
  Copies and backup files keep the settings. Zone maths lives in `packages/engine/src/zone.ts`.
- **Keyboard shortcuts**: `Ctrl+/` (or `?` with nothing focused) shows the shortcut sheet.
- **Plans and limits**: every account (a person's own workspaces, or a team) has a plan in `plans`
  (Free: 100 documents, 100,000 records per document, 2 GB of attachments; Pro: 1,000 / 500,000 / 50 GB;
  Unlimited). Triggers enforce them on every write path; documents in the trash don't count. Only
  administrators change plans. Account menu → Plan and usage (or a team's menu) shows usage.
- **Usage**: `doc_usage` keeps each document's record count and attachment bytes; `usage_counters`
  counts changes per document per day by source (app, API, form, automation) and API calls per person.
- **Audit log** (`audit_log`, kept a year): documents created, renamed, moved, trashed, restored and
  deleted; settings; sharing, invites and role changes on documents, workspaces and teams; public links;
  access rules; webhooks and automations; API keys; plans and administrators. Read through
  `audit_events()`: document owners download their document's log (Document settings), team owners
  their team's (team menu), administrators everything (admin panel), each as CSV.
- **Admin panel** (`/admin`): totals and activity, every account with plan, usage against limits
  and API calls, plan changes, administrators, and the audit log with filters. Make the first
  administrator in SQL:

  ```sql
  insert into public.app_admins (user_id) select id from public.profiles where email = 'you@example.com';
  ```

## Grid shortcuts

- `Ctrl+D` fill down (top row of the selection into the rows below; one row copies the row above)
- `Ctrl+;` insert today's date, `Ctrl+Shift+;` the current time
- `Enter` or `Space` on an Attachments cell opens its files
- Column menu → Freeze / Unfreeze keeps the leftmost columns in view (`frozen` in widget options)
- `Ctrl+Alt+M` comments on the cell; `Space` opens the record card; `Ctrl+F` finds across the page's tables (Enter / Shift+Enter)
- Drag a column header or a row number to reorder; double-click a column edge to fit it
- Sorting and filtering are unsaved (per viewer) until **Save** in the widget header

## Linking widgets

"Select by" in the widget options (or when adding a widget) offers, per widget on the page:
the same record (same table), the records in a summary group, the records that point at the
selected one through a Reference column of this table (`link_col`), and the other way round,
the record(s) the selected one points at through its own Reference column ("Orders → its
Customer", stored as `options.linkSourceCol`): a Reference moves the cursor there, a Reference
List shows just those records.

## Workspace sections (the hub)

Migration `20261121100000_workspace_hub.sql`; tests in `supabase/tests/workspace_hub.sql`; plan in `docs/workspace-hub-plan.md`.

Every workspace has a sidebar with **Overview, Clients, Pipeline, Planning, Files & assets** and any sections added with
"+ Add a section" (`/w/<workspace>/<section>`, `src/components/hub/`). They are pages of a hidden document per workspace
(`documents.kind = 'hub'`, made and filled the first time a section is opened by `ensure_hub` and `setUpHub` in
`src/lib/hub.ts`), so undo, history, realtime, access rules, automations, imports and the API all work on them. Hubs can't
be trashed, moved or deleted on their own, aren't listed as documents and don't count against the plan's document limit.

- **Views:** each section's views are tabs: shared ones are widgets on the section's page (editors change them), personal
  ones are rows of `user_views` (only their owner sees them, marked with a lock). The toolbar switches a view between Board,
  Table, Timeline, Gallery and Calendar; "View options" opens the usual widget panel.
- **Clients:** every section table has a Reference column to Clients. The client filter (`?client=<id>`, kept while moving
  between sections), the client list beside a section (with counts), and "Group by client" (lanes, groups, gallery
  sections) narrow or split any view; "+ Deal" etc. fill the selected client in. Opening a client anywhere goes to its page
  (`/w/<ws>/clients/<id>`): key facts, details, and a tab per section narrowed to the client, plus Contacts, Documents
  (documents linked with `documents.hub_client`, a new document for the client, link or unlink one) and Activity.
- **Overview:** open pipeline value, won this month, tasks due this week and overdue, files received this week, deals by stage,
  upcoming tasks; for one client when one is selected.
- `/` opens the last workspace's Overview; `/?ws=<id>` is its documents list; the Client hub template was removed.
- Not built yet: bulk actions on several cards, keyboard shortcuts for sections, renaming / reordering / hiding sections
  in the app, moving data from documents made with the old Client hub template, a mobile layout.

## Board, Timeline, Gallery and files

Migration `20261120100000_views_and_files.sql`; tests in `supabase/tests/views.sql` and
`src/lib/__tests__/views.test.ts`; plan and reasoning in `docs/views-and-files-plan.md`.
The idea: every record is a small room (fields, related records, files, history) and every
file knows which client and deal it belongs to, which version it is and where its rows went.

### The three views (widget types `board`, `timeline`, `gallery`)

All settings live in the widget's `options`. They take part in linking ("Select by"), filters,
sort, search, access rules and embeds like every other widget, and draw records with the same
tile (`RecordTile.tsx`: title, optional cover, chosen fields with a value, file counter, row styles).

- **Board** (`BoardWidget.tsx`, logic in `src/lib/board.ts`): stacks by a Choice, Reference or
  Toggle column; optional lanes by a second column. Dragging a card to another stack changes that
  cell and its position in one undoable step (so automations run: "moved to Won → email").
  Each card also has a "Move to…" menu, so nothing needs dragging. Stack headers show a count and
  a total of a number column; per stack a limit (header turns amber) and a condition a record must
  meet to enter (`$Value > 0 and len($Files) > 0`). Stacks collapse (per browser), can be hidden,
  empty ones can be hidden, including the "No value" stack. "Time in the stack" shows how long a
  card has been there, from a DateTime column stamped by a trigger formula (one click adds it).
  With a saved sort, cards keep that order and dragging only changes the stack.
- **Timeline** (`TimelineWidget.tsx`, maths in `src/lib/timeline.ts`): a bar per record from a
  start to an end date (a diamond without an end), zoom from days to years, groups, today line.
  Drag a bar to move it, its ends to resize (times of day are kept; dates are in the document's
  time zone). Dependencies are a Reference List column to the same table ("Waits for"): arrows
  from what is waited for, red when the order is broken; drag the dot at a bar's end onto another
  bar to add one (loops are refused). When a bar moves later, the app offers to move the bars
  waiting for it, through chains and only as far as needed, in the same undoable step.
  Finish-to-start only; no baseline or critical path yet.
- **Gallery** (`GalleryWidget.tsx`): tiles with a cover from an Attachments column (small, medium,
  large; crop or fit), sections by a column, drop files on a tile to attach them, click the cover
  for the file viewer. "One tile per file" turns it into a file or asset library.

### Files

- **Viewer** (`FileViewer.tsx`, opened from covers, the Files page, a record's Files tab or the
  open button in an Attachments cell): images, PDFs, text, and CSV / TSV / Excel as a grid (first
  500 rows) with a line per column: the type it looks like, how many different values, how many empty.
- **Versions**: "New version" uploads a file as the next version of the current one
  (`doc_attachments.version`, `replaces`, `note`); the cell then holds the new id (an ordinary,
  undoable cell change) and earlier versions stay downloadable.
- **Kept at upload**: a SHA-256 of the content, rows × columns and headers for spreadsheets
  (`table_info`, files up to 15 MB), and a 480 px WebP preview stored next to the file
  (`thumb_path`), so boards and galleries don't load full images.
- **Import into a table…** on any attached spreadsheet opens the import dialog with that file.
  Every import (from a file, a URL or an upload) is recorded in `doc_imports`: file and version,
  table, column mapping, key columns, records added and updated. When a new version of an
  imported file is opened, "Update <table> from this version…" repeats the mapping and shows
  what would change before anything is saved.
- **Files page** (sidebar → Files, `FilesView.tsx`): every file in the document with the record
  and column holding it, what that record belongs to (its client, its deal…), version, size and
  whether it was imported; search and filters.

### The record page

The record popup (`RecordCard.tsx`; also `/doc/<id>?record=<table>:<row>`) has tabs: **Details**;
**Related** (what it belongs to, and the records in other tables that point at it, with "Add");
**Files** (its own, with upload and drop, and those of its related records); **Comments**; and
**Activity** (changes to this record from the action log, for editors and owners, as far as the
log is visible to them).

### Client hub template

Home → New from template → **Client hub**: Clients, Deals, Tasks, Assets and Datasets, with a
Pipeline page (deal board with totals, the selected deal's tasks and datasets), a Clients page,
a Delivery plan (timeline with dependencies, task board with a lane per deal) and an Assets gallery.

### Not built yet

Download-all as a zip; undoing a whole import in one step (Ctrl+Z undoes it a thousand records
at a time); adding, renaming and reordering stacks from the board itself (edit the column's
choices); creating bars by dragging on empty space; baseline, critical path and lag days.

## Email

Migration `20261119100000_mail.sql`; tests in `supabase/tests/mail.sql` and
`src/lib/__tests__/mail.test.ts`; Edge Functions `deliver`, `notify`, `sendgrid-events`
with shared code in `supabase/functions/_shared/`. All email goes through SendGrid.

### Setting it up (once)

1. **SendGrid**: authenticate the sending domain (Settings → Sender Authentication; add the
   DNS records it shows, plus a DMARC record) and create an API key restricted to *Mail Send*.
2. **Secrets** on the Supabase project (they are project-wide, hence the prefix):

   ```bash
   npx supabase secrets set --project-ref bcvcfqyymwypwclsdeog \
     LMDU_SENDGRID_API_KEY=SG.xxxxx \
     LMDU_MAIL_FROM="LM Data Universe <notifications@mail.example.com>" \
     LMDU_APP_URL=https://data.example.com
   ```

   The older names (`SENDGRID_API_KEY`, `NOTIFY_FROM`, `APP_URL`) are still read.
   `LMDU_MAIL_DRY_RUN=1` logs emails instead of sending them.
3. **Delivery reports**: SendGrid → Settings → Mail Settings → Event Webhook → URL
   `https://bcvcfqyymwypwclsdeog.supabase.co/functions/v1/sendgrid-events`, events
   *Delivered, Deferred, Bounced, Dropped, Spam Reports*, turn on *Signed Event Webhook* and
   store its verification key: `npx supabase secrets set LMDU_SENDGRID_WEBHOOK_KEY=…`.
4. **Sign-up and password-reset mail** (Supabase Auth): Dashboard → Authentication → SMTP:
   host `smtp.sendgrid.net`, port `587`, user `apikey`, password = the API key, sender = the
   same address; then raise the email limit under Authentication → Rate Limits.
5. Check: Admin panel → **Email** → "Send me a test email".

### What is sent

- **Invites, "shared with you", @mentions and test emails**: `notification_queue` → `notify`.
- **Automation emails** (document → Integrations): `job_queue` → `deliver`. Written as
  Markdown (`**bold**`, `*italic*`, `[text](https://…)`, lists, `#` headings) and sent as plain
  text + HTML. Each email action has To, Subject, Message and optionally a sender name,
  Reply-To, CC and BCC. The From address is always the app's (`LMDU_MAIL_FROM`): SendGrid
  refuses senders that aren't verified.

### Tags

`{{ColId}}` or `{{Column label}}`, `{{Reference.Column}}` through a Reference column, and
`{{id}}`, `{{record_link}}` (opens the record: `/doc/<id>?record=<table>:<row>`), `{{link}}`,
`{{doc}}`, `{{table}}`, `{{automation}}`, `{{changed_by}}`. A fallback for empty values:
`{{Name|there}}`.

- The editor's picker inserts a tag at the cursor in the field last used; **Preview** fills the
  email from the newest record (`preview_automation`), exactly as it will be sent.
- Unknown tags are refused when saving, by the editor and by `save_automation`.
- Values are formatted as the grid shows them (dates in the column's format, date-times in
  the document's time zone, currency, percentages), filled by `_fill_template` in the database.
- Values can't add formatting, links or HTML of their own: Markdown characters in them are
  escaped by the database and everything is HTML-escaped by the renderer
  (`_shared/markdown.ts`).
- Renaming a column rewrites `{{Old}}` (and `{{Ref.Old}}`) in the document's automations
  (`tg_automation_tags`).

### Delivery, bounces and limits

- The delivery log shows where each email is: sent (accepted by SendGrid), reached the inbox,
  delayed, bounced, blocked or marked as spam (`job_queue.delivery`, from `mail_events`).
- A hard bounce or spam report puts the address in `mail_suppressions`; automations leave it
  out from then on and say so in the log. Administrators clear entries under Admin → Email.
- Errors that can't get better (refused request, wrong key, unverified sender) fail at once;
  rate limits and server errors are retried with growing waits.
- Limits: emails per document per day by plan (`plans.max_emails_per_day`: Free 100, Pro
  2,000, Unlimited none), the same email for the same record at most once a minute, 10
  recipients per email, and the older guards (2,000 automation deliveries a day per document,
  100 records per change). "Send test" is exempt.
- `mail_config` (one row, written by the functions) says whether email works; the Integrations
  page shows a banner when it doesn't, and Admin → Email shows the sender, the week's numbers
  and the last error.
- Every message carries the category `lmdu` and the custom argument `lmdu_env=lmdu`; events
  without it are ignored, so the other app's mail on the same SendGrid account is left alone.
  Delivery events are kept 90 days (`lmdu-mail-cleanup`).

## Shared Supabase project

This app and a separate email app run on the same Supabase project
(`bcvcfqyymwypwclsdeog`). They must not touch each other.

| | LM Data Universe (this app) | Email app |
| --- | --- | --- |
| Schema | `public` | `email_app` |
| Migrations | `supabase/migrations/` here | named `email_app_*`, kept in that app |
| Cron jobs | `lmdu-*` | its own |
| Edge Functions | `doc-worker`, `deliver`, `notify` | its own |
| Storage | bucket `attachments` | its own |
| Vault secrets | `doc_worker_url`, `doc_worker_secret` | its own |
| Edge Function secrets | prefixed `LMDU_` (older unprefixed names still read) | its own |

Rules:

- Never change schema `email_app` or anything named `email_app_*` from this app.
- Apply migrations **one file at a time** (the dashboard SQL editor or the Supabase
  MCP `apply_migration`). Never run `supabase db push`, `supabase db reset` or
  `supabase migration repair` against this project: the migration history holds both
  apps' migrations and this folder only has ours.
- Edge Function secrets are project-wide, so new ones get the `LMDU_` prefix.
- `pg_cron`, `pg_net`, `pgcrypto` and Vault are shared: don't drop or downgrade them.
- Deploying one of our Edge Functions (`supabase functions deploy <name>`) only
  replaces that function.

The same rules are stored in the database as the comment on schema `public`
(migration `20261118210000_shared_project_notes.sql`). The plan for email through
SendGrid is in `docs/sendgrid-plan.md`.

## How changes are saved

All content changes (rows, columns, tables, pages, widgets) go through one RPC,
`apply_actions(doc, actions)`. It checks the caller's role, applies the bundle
in one transaction and logs it with its inverse in `doc_actions`, which is what
undo/redo replay (so they survive reloads). Direct inserts/updates/deletes on
the content tables are revoked.

Each logged change that touches records or schema queues a recalculation in
`doc_recalc`; `pg_net` calls the `doc-worker` Edge Function, which recomputes
only the formula columns the change can affect and writes `doc_rows.computed`.
The browser still computes formulas itself for instant display.

## Formula worker

After changing anything in `packages/engine/`, rebuild the worker's copy and
redeploy the function:

```bash
npm run build:worker
supabase functions deploy doc-worker --no-verify-jwt
```

The worker's URL and shared secret live in Supabase Vault as `doc_worker_url`
and `doc_worker_secret` (see the `*_formula_worker.sql` migration). Run status
per document is in `doc_recalc` (`requested_id`, `done_id`, `last_error`).
