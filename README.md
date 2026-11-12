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

## Grid shortcuts

- `Ctrl+D` fill down (top row of the selection into the rows below; one row copies the row above)
- `Ctrl+;` insert today's date, `Ctrl+Shift+;` the current time
- `Enter` or `Space` on an Attachments cell opens its files
- Column menu → Freeze / Unfreeze keeps the leftmost columns in view (`frozen` in widget options)
- `Ctrl+Alt+M` comments on the cell; `Space` opens the record card; `Ctrl+F` finds across the page's tables (Enter / Shift+Enter)
- Drag a column header or a row number to reorder; double-click a column edge to fit it
- Sorting and filtering are unsaved (per viewer) until **Save** in the widget header

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
