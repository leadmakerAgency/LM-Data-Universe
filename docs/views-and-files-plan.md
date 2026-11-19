# Plan: Board, Timeline and Gallery views, built around clients, deals and their files

Status (19 Nov 2026): steps 1 to 9 are built and the migration
`20261120100000_views_and_files.sql` is applied to the live database. Checked
by type check, lint, 254 unit tests, the SQL tests and a production build;
**not yet looked at in a browser while signed in.** Decisions taken with the
recommended defaults: every file version is kept, datasets are tables in the
same document, finish-to-start dependencies only. Not built: download-all as
a zip, undoing a whole import in one step, editing stacks from the board,
creating bars by dragging on empty space, baseline / critical path / lag
(README → "Board, Timeline, Gallery and files" has the current description).

Written 18 Nov 2026 from the code and from
how Airtable, Baserow, Teable, monday.com, Attio and data-room tools handle
the same things.

## 1. The idea

LM Data Universe is where an agency or a business keeps its data: the CSV
files and other files it receives, and the records they belong to. So the
three views are not just three more ways to look at a table. They are the
front of a simple chain:

    Client  →  Deals  →  Tasks / deliverables
       \         \            \
        files     files        files          (CSV, Excel, PDF, images, anything)
                    \
                     datasets                 (a CSV turned into a table you can chart and filter)

- **Board** answers "where does each deal stand?"
- **Timeline** answers "what happens when, and what is blocking what?"
- **Gallery** answers "show me the things themselves": creatives, products, and the files.
- Behind all three: **every record is a small room** with its fields, its related
  records, its files and its history, and **every file knows** which client and deal
  it belongs to, which version it is, and which table its rows went into.

That last part is what the app is missing most today, so the plan has two
halves: the three views (sections 4 to 6) and the files and record work that
makes them useful for this purpose (sections 2 and 3).

## 2. Where the app stands

| Piece | Today | Gap |
| --- | --- | --- |
| Widgets | table, card, card list, chart, summary, form, calendar, custom | no board, timeline or gallery |
| Linking widgets | same record, by reference (both directions), summary group | works; the new views plug into it |
| Files | Attachments column: upload, image preview, download; up to 50 MB; metadata in `doc_attachments` | a file is only an id in a cell: no versions, no notes, no "all files of this client", no preview of CSV / Excel / PDF |
| CSV / Excel | import dialog: file, URL, Google Sheets; new or existing table; update by key with a preview | can't import a file that is already attached; no record of which file a table's rows came from; no re-import when a new version arrives |
| Record card | popup with the record's fields | no related records, files, comments or history in one place |
| Drag and drop | calendar events, rows, columns, widgets (hand-written mouse handlers) | nothing reusable; no keyboard alternative |

Database impact of the three views themselves is tiny: `doc_widgets.type`
accepts three more values and everything else lives in the widget's `options`
(jsonb), like the calendar. The files work adds a few columns and one table.

## 3. Foundations (built first, used by all three views)

### 3.1 One record tile
A single `RecordTile` component draws a record as a card: title, optional
cover, chosen fields (only those with a value, labels optional), colour stripe,
and small counters (files, open comments, overdue date). Board, Gallery, the
Timeline's hover card and the existing Card List all use it, so a card looks
the same everywhere and conditional row styles apply to it.

### 3.2 One drag helper, with a non-drag way to do everything
A pointer-based drag hook (mouse and touch) replaces per-widget handlers for
the new views. Every drag has an equivalent without dragging (a "Move to…"
menu on the card, keyboard arrows on a focused card), which WCAG 2.5.7 asks
for and which also makes the views usable on a phone.

### 3.3 Files become first-class
- **Viewer** for every file: images (lightbox), PDF (browser viewer), text, and
  **CSV / TSV / Excel as a grid** (first 500 rows, sheet picker, column types and
  empty / duplicate counts per column), using the importer the app already has.
- **Versions:** "Upload a new version" on a file keeps the old ones (`version`,
  `replaces`, a short change note, who and when). Download or restore any version.
- **Know what it is:** kind (table, image, PDF, document, other), rows × columns
  for tabular files, a content hash so uploading the same file twice is noticed.
- **Thumbnails** made in the browser at upload (a small WebP next to the file),
  so boards and galleries with hundreds of images stay fast and don't depend on
  the Supabase plan's image service.
- **Drop anywhere:** drop files on a card, a tile, a record page or a cell.

### 3.4 From file to data, with a paper trail
- **"Import into a table…"** on any attached CSV / Excel file opens the existing
  import dialog with that file (new table, or map into an existing one, update
  by key, preview first).
- Each import is recorded in a new `doc_imports` table: file and version, target
  table, mapping, rows added / updated, who, when, and the action it produced.
  So a table can show "from `leads-march.csv` v3, 1,204 rows, 12 Mar" and an
  import can be **undone as one step**.
- **New version → "Update the data":** when a new version of an imported file
  arrives, offer to re-run the same mapping and show what would change (added,
  changed, missing rows) before applying.
- **Datasets (idea):** "Keep as dataset" turns a CSV into its own table and adds
  a row to a `Datasets` table linked to the client or deal, so each client page
  can list its datasets with row counts and last refresh, and charts or summaries
  can be built on them.

### 3.5 The record page ("deal room")
The record popup grows tabs. It also opens from a link (`?record=`, built with
the email work) and from every card in the new views.

- **Details:** the fields (as now).
- **Related:** records in other tables that point here, per table (a client's
  deals, a deal's tasks), with "add" for each; click to go there.
- **Files:** every file on this record **and on its related records**, grouped by
  where it lives, with type filter, search, versions, and download-all (zip).
- **Comments:** the record's cell comments in one thread list.
- **Activity:** who changed what on this record (owners, as the activity log is
  today), including imports and file versions.

### 3.6 An "All files" page per document
Every file in the document in one list: name, kind, size, version, the record
and column holding it, the client / deal it traces back to, imported or not.
Filters, search, bulk download. This is the answer to "where is that CSV?".

## 4. Board (Kanban)

**What it is:** records as cards in stacks; drag a card to change its value.

- **Stack by** a Choice column (stacks are the choices, in order, in their
  colours), a Reference column (one stack per client, owner, …) or a Toggle.
- **Dragging** a card to another stack changes that cell: one undoable step, and
  it triggers automations (so "moved to Won → email the client" works with the
  email work already done). Dragging up or down reorders within the stack.
  Access rules are respected: if a person may not change the column, cards
  don't drag.
- **Swimlanes:** a second grouping across the board (deals by stage, one lane
  per client). Airtable's board can't do this.
- **Stack header:** count and a total or average of a number column (pipeline
  value per stage); optional work-in-progress limit that turns the header amber
  when exceeded.
- **Stacks:** collapse (per person), hide a stack, hide empty ones, and a "No
  value" stack that can be hidden, a long-standing complaint about Airtable.
  Add, rename and reorder stacks from the board (edits the column's choices).
- **Cards:** the tile from 3.1, with cover image, file counter and overdue
  highlight; "+" at the bottom of a stack adds a record already in that stack
  (and linked to the selected client, when the board is linked).
- **Stage rules (idea):** a condition per stack that must hold before a card may
  enter it, e.g. *Won* needs an amount and a signed contract file. Written in the
  formula language the app already has.
- **Time in stage (idea):** one click adds "stage changed on" stamps (trigger
  formulas, already supported) and shows "12 days here" on the card.
- **Large boards:** each stack is virtualized, so thousands of cards scroll.

Options (all in `options`): `boardCol`, `boardLane`, `boardSum`, `boardWip`,
`boardHidden`, `boardRules`, plus the shared tile options.

## 5. Timeline (Gantt)

**What it is:** records as bars across time.

- **Bars** from a start and an end date column (Date or DateTime); a record with
  one date is a milestone (a diamond). Dates use the document's time zone.
- **Zoom:** day, week, month, quarter, year; today line; weekends shaded; jump to today.
- **Rows:** one row per record with a few columns on the left (Gantt), or packed
  lanes per group (Timeline). Group by client, owner or stage; collapse groups.
- **Editing:** drag a bar to move it, drag an end to resize, drag on empty space
  to create; each is one undoable step.
- **Dependencies:** a Reference List column to the same table ("Blocked by").
  Arrows from the end of one bar to the start of the next (finish-to-start, the
  one type every tool supports). Draw one by dragging from a bar's end to another
  bar. A dependency that is broken (the next task starts before the previous one
  ends) is drawn in red.
- **Keep the plan together:** when a bar moves later, offer "also move the 4
  tasks that depend on it"; applied as one step.
- **More on the bar:** progress fill from a percent column, colour by a column,
  file counter; hover shows the tile.
- **Later:** baseline (planned vs actual bars), critical path, lag days.
- Reuses the calendar's date and time-zone code; rows are virtualized; arrows are
  one SVG layer.

Options: `tlStart`, `tlEnd`, `tlTitle`, `tlGroup`, `tlColor`, `tlDeps`,
`tlProgress`, `tlZoom`, `tlMode`.

## 6. Gallery

**What it is:** records as a grid of tiles with a cover.

- **Cover** from an Attachments column: the first image (thumbnail from 3.3). For
  other files a typed tile: a CSV shows a small table sketch with "1,204 × 9",
  a PDF or document shows its kind and size.
- **Layout:** small, medium or large tiles; crop or fit; fields under the cover;
  group into sections by a column (per client, per campaign).
- **Use:** click opens the record page; image lightbox with next / previous; drop
  files on a tile to attach; select several tiles to download or to set a field.
- **File mode:** one tile per *file* instead of per record, so "all files of this
  client" or an asset library works even when a record holds many files.

Options: `galCover`, `galFit`, `galSize`, `galGroup`, `galMode`.

## 7. How it comes together for an agency

A ready-made **"Client hub"** template, and the pages it gives:

- **Pipeline:** Board of deals by stage with value totals, swimlanes by client;
  beside it the selected deal's record page (fields, tasks, files).
- **Client:** pick a client → their deals, tasks, datasets and every file.
- **Delivery plan:** Timeline of tasks grouped by client, with dependencies.
- **Assets:** Gallery of creatives by campaign.
- **Files:** the All files page.

Tables: Clients, Contacts, Deals, Tasks, Datasets (and whatever CSVs become).

## 8. Database changes

All in schema `public`, additive, one migration per step (the email app's
`email_app` schema is not touched).

| Object | Change |
| --- | --- |
| `doc_widgets.type` | allow `board`, `timeline`, `gallery` |
| `doc_attachments` | `version`, `replaces`, `note`, `kind`, `sha256`, `table_info` (rows, columns, headers), `thumb_path` |
| `doc_imports` (new) | file, version, table, mapping, counts, action id, who, when; read through an RPC, private otherwise |
| copy / backup / restore functions | carry the new columns; widget options are already copied as they are |
| Storage | thumbnails under the same `attachments/{doc}/…` paths, so the existing policies cover them |

Access rules: the views read through the same filtered path as every widget;
files keep following the visibility of their cell; the record page's Related and
Files tabs only list what the person may read.

## 9. Order and size

| Step | What | Sessions |
| --- | --- | --- |
| 1 | Foundations: widget types, record tile, drag helper | 1 |
| 2 | Board (stacks, drag, totals, hide / collapse, add card) | 1.5 |
| 3 | Gallery, thumbnails, lightbox | 1 |
| 4 | File viewer (CSV / Excel / PDF), versions, All files page | 1.5 |
| 5 | Import from a file, import history, update from a new version | 1 |
| 6 | Record page with Related, Files, Comments, Activity | 1.5 |
| 7 | Timeline: bars, zoom, groups, editing | 1.5 |
| 8 | Timeline dependencies and "move what depends on it" | 1 |
| 9 | Board swimlanes, stage rules, time in stage; Client hub template; tests and docs | 1.5 |

About 11 to 12 sessions. Steps 1 to 3 give visible results fastest; steps 4 to
6 are what makes it a data-handling tool rather than a project board.

## 10. Risks

| Risk | Handling |
| --- | --- |
| Storage grows with kept versions and thumbnails | counted against the plan's attachment limit; owners can prune old versions; thumbnails are a few KB |
| Large CSVs in the browser viewer | preview the first 500 rows only; import stays chunked as today |
| Many datasets push a document past its record limit | the limit is per document and already enforced; the dialog says how many rows an import adds before it runs |
| Drag on touch screens and with a keyboard | the non-drag path is built first (3.2) |
| Auto-moving dependent tasks surprises people | always asked, never silent; one undo step |

## 11. Decisions needed

1. **File versions:** keep every version (recommended), or only the last few?
2. **Datasets:** each kept CSV becomes a table in the same document (simple, one
   place), or a separate document per client (more room, less linking)?
3. **Order:** views first (steps 1 to 3, then 7 and 8) or files first (4 to 6)?
4. **Stage rules and time-in-stage** on the board: wanted in the first version or later?
5. **Dependencies:** finish-to-start only is enough to begin with?
