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

- `supabase/migrations/` – schema, row-level security, sharing and form RPCs (applied in order).
- `src/lib/formula/` – formula parser and engine (`$Col`, `$Ref.Col`, `Table.lookupRecords(...)`, Excel-style functions).
- `src/lib/format.ts` – per-type display formatting and input parsing.
- `src/store/docStore.ts` – open document state, Supabase writes, realtime sync, undo/redo.
- `src/lib/view.ts` – which rows a widget shows (linking, filters, sort, search).
- `src/components/doc/` – editor UI; `src/components/home/` – workspaces and documents.

## Checks

```bash
npx tsc --noEmit
npm run lint
npx tsx scripts/formula-check.ts
```
