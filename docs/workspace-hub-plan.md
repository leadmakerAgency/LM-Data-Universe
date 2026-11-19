# Plan: Clients, Pipeline, Planning and Files as permanent parts of every workspace

Status (19 Nov 2026): steps 1 to 5 and most of 7 are built; the migration is applied to the live project.
Not built yet: bulk actions, keyboard shortcuts, renaming / reordering / hiding sections in the app,
moving data from old Client hub documents, the mobile layout and the first-visit tour. Decisions taken
with the recommended answers.

Written 19 Nov 2026 from the code, the
feedback that Board / Timeline / Gallery are hard to find, and how Attio,
HubSpot, monday.com and ClickUp organise the same work.

## 1. The problem

Today Board, Timeline and Gallery are widget types inside a document. To see
one you either build it yourself (open a document, Add widget, pick a table,
set options) or start the "Client hub" template. Both are hidden from the
place people start: the home screen, which only lists workspaces and documents.
And every document is its own island, so "all deals of all clients" or "this
client's files" has no single home.

What people expect (and what the tools they compare us with do):

- **Attio** puts its record types (Companies, People, Deals…) straight in the
  sidebar; each opens a table or kanban view of all records of that type, with
  saved views, and every record has its own page with related data.
- **HubSpot** opens Deals as a pipeline board or a table, with saved view tabs
  ("My deals", "Closing this month"), quick filters and owner filters.
- **monday.com / ClickUp** agencies either keep one board for all clients or one
  per client, and add a roll-up dashboard on top; with more than about 20
  clients, one shared structure with a client field scales better.

So: the views belong in the left sidebar, always there, opened by purpose
(pipeline, planning, files), working across all clients and narrowed to one
client in a click.

## 2. The idea: a hub in every workspace

Every workspace (Leadmaker, Home, a team's workspaces) gets a **hub**: a set of
standard record types that are always there, with fixed places in the sidebar.

```
LM Data Universe
[ Leadmaker ▾ ]            ← workspace switcher
  Overview                 ← dashboard: pipeline value, due this week, new files
  Clients                  ← every client; click one for its page
  Pipeline                 ← Board of deals (also Table)
  Planning                 ← Timeline of tasks (also Board, Table, Calendar)
  Files & assets           ← Gallery of every file (also Table)
  + Add a section          ← your own: Campaigns, Invoices, Requests…
  ─────────
  Documents                ← the spreadsheets you have today
  Shared with me · Templates · Trash
```

Each section is a page with the same frame:

```
Pipeline                                  [Board | Table | Timeline]  [+ Deal]
[All deals] [My deals] [Closing this month] [+ view]          ← saved views
Client: [All clients ▾]  Owner: [Anyone ▾]  Stage …  Search…  Group: [Client ▾]
┌ Lead ───────┐┌ Proposal ───┐┌ Negotiation ┐┌ Won ────────┐
│ card        ││ card        ││ card        ││ card        │
```

Nothing to set up: a new workspace opens with these sections ready, empty, with
sensible columns (stages, dates, owner, files) that can be changed later.

### How it is built: a hidden document per workspace

The hub is an ordinary document of the workspace, marked `kind = 'hub'`,
created automatically the first time a section is opened, and hidden from the
document list. Its tables are Clients, Contacts, Deals, Tasks and Files.

This reuses everything that already works and is tested: the formula engine,
`apply_actions` (undo, history, activity), realtime, access rules, automations
and email, imports, the API, webhooks, the Board / Timeline / Gallery widgets,
the record page with Related and Files tabs. A section page is a document page
shown in a different frame. No second data model, no copying.

Rejected alternatives:

- **One board across many documents** (each client its own document): every
  document has its own columns, so a shared board can't know which column is
  "stage" or "value"; access rules, undo and realtime would all need a
  cross-document layer. Large and fragile.
- **Making the Client hub template more visible:** still one document someone
  has to create and find, still one per workspace by convention only.

## 3. Handling many clients

This is where most of the value is. On every section page:

1. **Client filter** at the top: All clients · one client (searchable list with
   counts) · My clients (account owner is me) · Recent. It is in the address
   (`?client=12`), so a link opens the same narrowed view, and it stays selected
   while moving between Pipeline, Planning and Files, so "everything for Acme"
   is one choice.
2. **Client rail** (optional, toggled): a narrow list of clients on the left of
   the section with a count each (open deals, overdue tasks, new files), like
   mail folders. Click to filter.
3. **Group by client:** swimlanes on the board, groups on the timeline,
   sections in the gallery, all one choice in the toolbar.
4. **Saved views** as tabs: shared ones for the team (edited by editors) and
   personal ones ("Mine, closing this month"). Each remembers view type,
   filters, sort, grouping and fields.
5. **Quick filters** next to the client filter: owner, stage / status, due
   (overdue, this week, next 30 days), has files, plus the filter popover we have.
6. **Bulk actions:** select several cards or rows → change stage, owner or due
   date, move to another client, delete. One undo step.
7. **Client page** (`/w/<workspace>/clients/<id>`): header with the client's key
   facts and health (open value, overdue tasks, last activity, files), then tabs:
   Overview · Deals (board) · Tasks (timeline) · Files (gallery) · Contacts ·
   Documents · Activity. Every tab is the section view, pre-filtered.
8. **Add with the client already set:** "+ Deal" while a client is selected
   creates the deal for that client; drop a file on a client and it lands in
   Files linked to that client.
9. **Client health on the Clients page:** open pipeline value, deals won this
   year, overdue tasks, days since last activity, file count, as formula columns
   of the Clients table, sortable and filterable like any column.

## 4. Each section in detail

| Section | Table | Default view | Other views | Key columns (editable) |
| --- | --- | --- | --- | --- |
| Overview | — | dashboard | — | — |
| Clients | Clients | Table | Gallery (logos), Board (by status) | Client, Status, Account owner, Industry, Logo, health formulas |
| Pipeline | Deals | Board by Stage, total of Value | Table, Timeline (close dates) | Deal, Client, Stage, Value, Probability, Close date, Owner, Files |
| Planning | Tasks | Timeline with dependencies, grouped by client | Board by Status, Table, Calendar | Task, Client, Deal, Status, Start, Due, Waits for, Progress, Assignee, Files |
| Files & assets | Files | Gallery, one tile per file | Table | Name, Client, Deal, Kind, File, Received, Imported to |
| Your own section | any new table | your choice | any | starts with Name, Client, Status, Date, File |

- **Overview** shows tiles (open pipeline value, won this month, deals by stage,
  tasks due this week, overdue tasks, files added this week, clients without
  activity for 30 days), each clicking through to the filtered section.
- **Files & assets**: dropping a CSV here asks which client (and deal) it
  belongs to; the existing viewer, versions, "Import into a table" and import
  history all work as now. "Keep as dataset" (from the earlier plan) lands here.
- **Your own section**: "+ Add a section" asks a name, an icon and a purpose
  (pipeline-style board, plan-style timeline, library-style gallery, list), and
  creates a table already linked to Clients. Sections can be renamed, reordered
  and hidden; the standard ones can be hidden but not deleted.

## 5. Documents and the hub

Documents stay for free-form work and one-off data. They join the hub in two ways:

- A document can belong to a client (`documents.hub_client`): set from the
  document menu or when creating it from a client page. The client page lists
  its documents; the document header shows a client chip linking back.
- Any document table can be shown in a section ("Show in sidebar") later; not in
  the first version.

The Client hub template is removed from Templates (the hub replaces it).
Documents already made from it get a one-time "Move into the workspace hub"
action that copies their clients, deals, tasks and files in.

## 6. Navigation and screens

- **One app frame** for home and documents: the left sidebar above is always
  there; inside a document its pages appear under the document's name in the
  sidebar, with the workspace sections still one click away.
- **Routes:** `/w/<ws>` (Overview), `/w/<ws>/<section>?view=&client=`,
  `/w/<ws>/clients/<row>`, `/w/<ws>/documents`, and `/doc/<id>` as today.
  `/` opens the last workspace's Overview.
- **Workspace switcher** at the top of the sidebar replaces the workspace list
  (it grows long with teams); "Shared with me", "Templates" and "Trash" move to
  the bottom.
- **Record pages** open as a side panel from any section (keeping the list in
  view), full page from a link.
- **Mobile:** the sidebar collapses into a menu; boards scroll sideways one
  stack at a time; the record panel becomes full screen.
- **Keyboard:** `G` then `P` / `L` / `F` / `C` jumps to Pipeline, Planning, Files,
  Clients; `/` focuses search; `N` adds a record in the current section.

## 7. Database changes (schema public only; the email app is not touched)

| Object | Change |
| --- | --- |
| `documents.kind` | `'document'` (default) or `'hub'`; one hub per workspace (unique index); hubs can't be trashed, moved, copied as templates or deleted on their own |
| `documents.hub_client` | optional client row of the workspace's hub (checked by trigger) |
| `ensure_hub(workspace)` RPC | creates the hub with its tables, pages and default views if missing; returns its id; workspace editors and owners |
| `hub_sections` in the hub's `documents.settings` | order, names, icons, hidden sections, custom sections → table and page |
| `user_views` (new) | personal saved views: user, document, page, name, options; private to the user |
| Shared saved views | widgets on the section's page in the hub (already undoable and realtime), named with `options.viewName` |
| Document list queries | exclude `kind = 'hub'`; limits don't count hubs as documents (records still count) |
| Copy / backup / restore | a hub backs up like any document; restore creates a regular document |

Access: a hub follows the workspace's roles (members, team roles), exactly like
other documents in it; access rules can be added to it as to any document.

## 8. Build steps

| Step | What | Sessions |
| --- | --- | --- |
| 1 | Database: `kind`, `hub_client`, `ensure_hub` with the standard tables and default views, `user_views`; tests | 1 |
| 2 | App frame: new sidebar with workspace switcher and sections, routes, `/` → Overview; documents keep working | 1.5 |
| 3 | Section page: toolbar (view switcher, saved view tabs, client and quick filters, group by, search, add), Pipeline, Planning, Files, Clients | 2 |
| 4 | Client page with tabs and health; client rail; client chip on documents | 1.5 |
| 5 | Overview dashboard | 1 |
| 6 | Bulk actions, record side panel, keyboard shortcuts | 1 |
| 7 | Custom sections; move from Client hub documents; remove the template | 1 |
| 8 | Mobile layout, tests, docs | 1 |

About 10 sessions. Steps 1 to 3 already give the sidebar with working Pipeline,
Planning and Files across all clients.

## 9. Risks

| Risk | Handling |
| --- | --- |
| A hub with many records loads slowly (the app loads a document's records into the browser) | fine to tens of thousands of records; past that the planned server-side paging (Phase 6 of the roadmap) is needed; the Overview reads counts from the server |
| Two people open a new workspace at once and two hubs are made | `ensure_hub` locks the workspace row; one hub per workspace is enforced by a unique index |
| People edit the hub's columns and break a section (delete "Stage") | sections fall back to asking which column to use, as the widgets do today; standard columns warn before deletion |
| Changing the home screen confuses current users | documents keep the same place under "Documents"; the first visit shows a short tour of the sidebar |

## 10. Decisions needed

1. **Section names:** Clients, Pipeline, Planning, Files & assets (or Deals, Projects, Library…)?
2. **Contacts:** a section of its own, or only inside the client page?
3. **Personal "Home" workspace:** gets a hub too (recommended, it's lazy), or only team / shared workspaces?
4. **Default stages:** Lead → Proposal → Negotiation → Won / Lost, and task statuses To do → In progress → Review → Done?
5. **Client hub template:** remove it once the hub exists (recommended)?

Sources:
[Attio: understanding records](https://attio.com/help/reference/attio-101/attios-data-model/understanding-records) ·
[Attio: kanban views](https://attio.com/help/reference/managing-your-data/views/create-and-manage-kanban-views.md) ·
[HubSpot: saved views](https://knowledge.hubspot.com/records/create-and-manage-saved-views) ·
[HubSpot: board view](https://knowledge.hubspot.com/records/use-the-updated-board-view) ·
[monday.com community: tracking client projects](https://community.monday.com/t/what-s-the-best-way-to-track-client-projects-and-deadlines/107988) ·
[ClickUp workspace structure](https://willhelliwell.substack.com/p/how-to-structure-your-clickup-workspace)
