// Differences between two versions of a document (a snapshot, the current
// state, or a working copy and its original), as returned by doc_content /
// get_snapshot. Tables and columns are matched by id, falling back to their
// names (copies get new ids); records are matched by id within a table.

export interface DocContent {
  tables: { id: string; table_id: string; position: number }[];
  columns: { id: string; table_ref: string; col_id: string; label: string; type: string; is_formula: boolean; formula: string; options: Record<string, unknown> }[];
  rows: { id: number; table_ref: string; manual_sort: number; data: Record<string, unknown> }[];
  pages: { id: string; name: string }[];
  widgets: { id: string; page_id: string; type: string; title: string }[];
}

export interface CellChange {
  rowId: number;
  column: string;
  before: unknown;
  after: unknown;
}

export interface TableDiff {
  name: string;
  status: "added" | "removed" | "changed" | "same";
  columnsAdded: string[];
  columnsRemoved: string[];
  columnsChanged: { name: string; what: string[] }[];
  rowsAdded: number;
  rowsRemoved: number;
  rowsChanged: number;
  cells: CellChange[];
}

export interface DocDiff {
  tables: TableDiff[];
  pagesAdded: string[];
  pagesRemoved: string[];
  widgetsAdded: number;
  widgetsRemoved: number;
  identical: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Compares `before` and `after`. With `byName`, tables and columns are matched
 * by name and records by their position in the table (for a copy and its
 * original, whose ids differ).
 */
export function diffContents(before: DocContent, after: DocContent, opts: { byName?: boolean; maxCells?: number } = {}): DocDiff {
  const maxCells = opts.maxCells ?? 200;
  const tables: TableDiff[] = [];
  const keyT = (t: DocContent["tables"][number]) => (opts.byName ? t.table_id : t.id);
  const bTables = new Map(before.tables.map((t) => [keyT(t), t]));
  const aTables = new Map(after.tables.map((t) => [keyT(t), t]));
  const colsOf = (c: DocContent, tableId: string) => c.columns.filter((x) => x.table_ref === tableId);
  const rowsOf = (c: DocContent, tableId: string) => c.rows.filter((r) => r.table_ref === tableId).sort((x, y) => x.manual_sort - y.manual_sort || x.id - y.id);

  for (const [k, t] of aTables) {
    if (!bTables.has(k)) {
      tables.push({ name: t.table_id, status: "added", columnsAdded: colsOf(after, t.id).map((c) => c.label || c.col_id), columnsRemoved: [], columnsChanged: [], rowsAdded: rowsOf(after, t.id).length, rowsRemoved: 0, rowsChanged: 0, cells: [] });
    }
  }
  for (const [k, bt] of bTables) {
    const at = aTables.get(k);
    if (!at) {
      tables.push({ name: bt.table_id, status: "removed", columnsAdded: [], columnsRemoved: colsOf(before, bt.id).map((c) => c.label || c.col_id), columnsChanged: [], rowsAdded: 0, rowsRemoved: rowsOf(before, bt.id).length, rowsChanged: 0, cells: [] });
      continue;
    }
    const keyC = (c: DocContent["columns"][number]) => (opts.byName ? c.col_id : c.id);
    const bCols = new Map(colsOf(before, bt.id).map((c) => [keyC(c), c]));
    const aCols = new Map(colsOf(after, at.id).map((c) => [keyC(c), c]));
    const d: TableDiff = { name: at.table_id, status: "same", columnsAdded: [], columnsRemoved: [], columnsChanged: [], rowsAdded: 0, rowsRemoved: 0, rowsChanged: 0, cells: [] };
    if (bt.table_id !== at.table_id) d.columnsChanged.push({ name: "(table)", what: [`renamed from ${bt.table_id}`] });
    for (const [ck, c] of aCols) if (!bCols.has(ck)) d.columnsAdded.push(c.label || c.col_id);
    for (const [ck, c] of bCols) {
      const a = aCols.get(ck);
      if (!a) {
        d.columnsRemoved.push(c.label || c.col_id);
        continue;
      }
      const what: string[] = [];
      if (c.label !== a.label || c.col_id !== a.col_id) what.push(`renamed from “${c.label || c.col_id}”`);
      if (c.type !== a.type) what.push(`type ${c.type} → ${a.type}`);
      if (c.is_formula !== a.is_formula) what.push(a.is_formula ? "now a formula" : "now data");
      else if (c.formula !== a.formula) what.push(`formula: ${c.formula || "(none)"} → ${a.formula || "(none)"}`);
      if (!opts.byName && !same(c.options, a.options)) what.push("settings changed");
      if (what.length) d.columnsChanged.push({ name: a.label || a.col_id, what });
    }
    // Records: by id, or by position for copies.
    const bRows = rowsOf(before, bt.id);
    const aRows = rowsOf(after, at.id);
    const pairs: [DocContent["rows"][number] | undefined, DocContent["rows"][number] | undefined][] = [];
    if (opts.byName) {
      for (let i = 0; i < Math.max(bRows.length, aRows.length); i++) pairs.push([bRows[i], aRows[i]]);
    } else {
      const aById = new Map(aRows.map((r) => [r.id, r]));
      const bIds = new Set(bRows.map((r) => r.id));
      for (const r of bRows) pairs.push([r, aById.get(r.id)]);
      for (const r of aRows) if (!bIds.has(r.id)) pairs.push([undefined, r]);
    }
    for (const [b, a] of pairs) {
      if (!b) d.rowsAdded++;
      else if (!a) d.rowsRemoved++;
      else {
        let changed = false;
        for (const [ck, bc] of bCols) {
          const ac = aCols.get(ck);
          if (!ac || bc.is_formula || ac.is_formula) continue;
          const bv = b.data[bc.id];
          const av = a.data[ac.id];
          // Reference ids differ between a copy and its original; compare only non-references there.
          if (opts.byName && (bc.type === "Ref" || bc.type === "RefList")) continue;
          if (!same(bv, av)) {
            changed = true;
            if (d.cells.length < maxCells) d.cells.push({ rowId: a.id, column: ac.label || ac.col_id, before: bv, after: av });
          }
        }
        if (changed) d.rowsChanged++;
      }
    }
    if (d.columnsAdded.length || d.columnsRemoved.length || d.columnsChanged.length || d.rowsAdded || d.rowsRemoved || d.rowsChanged) d.status = "changed";
    tables.push(d);
  }

  const keyP = (p: DocContent["pages"][number]) => (opts.byName ? p.name : p.id);
  const bPages = new Set(before.pages.map(keyP));
  const aPages = new Set(after.pages.map(keyP));
  const pagesAdded = after.pages.filter((p) => !bPages.has(keyP(p))).map((p) => p.name);
  const pagesRemoved = before.pages.filter((p) => !aPages.has(keyP(p))).map((p) => p.name);
  const bW = new Set(before.widgets.map((w) => (opts.byName ? `${w.type}:${w.title}` : w.id)));
  const aW = new Set(after.widgets.map((w) => (opts.byName ? `${w.type}:${w.title}` : w.id)));
  const widgetsAdded = [...aW].filter((k) => !bW.has(k)).length;
  const widgetsRemoved = [...bW].filter((k) => !aW.has(k)).length;
  const identical = tables.every((t) => t.status === "same") && !pagesAdded.length && !pagesRemoved.length && !widgetsAdded && !widgetsRemoved;
  tables.sort((x, y) => (x.status === "same" ? 1 : 0) - (y.status === "same" ? 1 : 0));
  return { tables, pagesAdded, pagesRemoved, widgetsAdded, widgetsRemoved, identical };
}

/** Short text for a stored value in a diff or the activity feed. */
export function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (Array.isArray(v)) return v.length ? v.map((x) => showValue(x)).join(", ") : "(empty)";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
