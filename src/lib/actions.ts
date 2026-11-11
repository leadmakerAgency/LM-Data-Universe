// Document actions: the only way content changes. The browser sends bundles of
// these to the `apply_actions` RPC, which applies them atomically, checks the
// caller's role and logs each bundle with its inverse (for undo/redo, history,
// webhooks…). The same operations are applied locally, either optimistically
// before the write or from the `applied` list the server sends back.
import type { CellValue, DocColumn, DocPage, DocRow, DocTable, DocWidget } from "./types";

export type Entity = "table" | "column" | "page" | "widget";

export type DocAction =
  | { op: "AddRecords"; table: string; records: { id?: number; manual_sort?: number; data: Record<string, CellValue> }[] }
  | { op: "UpdateRecords"; table: string; records: { id: number; values: Record<string, CellValue>; manual_sort?: number }[] }
  | { op: "RemoveRecords"; table: string; ids: number[] }
  | { op: "Add"; entity: Entity; row: Record<string, unknown> }
  | { op: "Update"; entity: Entity; id: string; patch: Record<string, unknown> }
  | { op: "Remove"; entity: Entity; id: string };

/** What apply_actions / undo_action / redo_action return. */
export interface ApplyResult {
  action_id: number;
  /** One entry per action: new row ids for AddRecords, the new uuid for Add, else null. */
  results: unknown[];
  /** The actions as applied (new rows carry their ids), in order. */
  applied: DocAction[];
  can_undo?: boolean;
  can_redo?: boolean;
}

export interface LocalDoc {
  tables: Map<string, DocTable>;
  columns: Map<string, DocColumn>;
  rows: Map<string, Map<number, DocRow>>;
  pages: DocPage[];
  widgets: Map<string, DocWidget>;
}

export function newId(): string {
  return crypto.randomUUID();
}

const byPosition = <T extends { position: number }>(list: T[]) => [...list].sort((a, b) => a.position - b.position);

function pick<T>(row: Record<string, unknown>, keys: (keyof T)[]): T {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in row) out[k as string] = row[k as string];
  return out as T;
}

const TABLE_KEYS: (keyof DocTable)[] = ["id", "doc_id", "table_id", "position"];
const COLUMN_KEYS: (keyof DocColumn)[] = ["id", "doc_id", "table_ref", "col_id", "label", "type", "is_formula", "formula", "options", "position"];
const PAGE_KEYS: (keyof DocPage)[] = ["id", "doc_id", "name", "position", "layout"];
const WIDGET_KEYS: (keyof DocWidget)[] = [
  "id", "doc_id", "page_id", "table_ref", "type", "title", "position", "width", "height", "options", "link_source", "link_col",
];

/** Applies actions to a copy of the local document; untouched maps are shared. */
export function applyActionsLocal(doc: LocalDoc, actions: DocAction[]): LocalDoc {
  let { tables, columns, rows, pages, widgets } = doc;
  const copied = new Set<string>();
  const touch = (what: "tables" | "columns" | "rows" | "widgets") => {
    if (copied.has(what)) return;
    copied.add(what);
    if (what === "tables") tables = new Map(tables);
    if (what === "columns") columns = new Map(columns);
    if (what === "rows") rows = new Map(rows);
    if (what === "widgets") widgets = new Map(widgets);
  };
  const touchedTables = new Set<string>();
  const tableRows = (tableRef: string) => {
    touch("rows");
    if (!touchedTables.has(tableRef)) {
      touchedTables.add(tableRef);
      rows.set(tableRef, new Map(rows.get(tableRef) ?? []));
    }
    return rows.get(tableRef)!;
  };
  const unlinkWidgets = (pred: (w: DocWidget) => Partial<DocWidget> | null) => {
    for (const [id, w] of widgets) {
      const patch = pred(w);
      if (patch) {
        touch("widgets");
        widgets.set(id, { ...w, ...patch });
      }
    }
  };
  const removeWidget = (id: string) => {
    touch("widgets");
    widgets.delete(id);
    unlinkWidgets((w) => (w.link_source === id ? { link_source: null, link_col: null } : null));
  };

  for (const a of actions) {
    switch (a.op) {
      case "AddRecords": {
        const map = tableRows(a.table);
        let sort = Math.max(0, ...[...map.values()].map((r) => r.manual_sort));
        for (const r of a.records) {
          if (typeof r.id !== "number") continue; // id only known after the server inserts it
          const manual_sort = typeof r.manual_sort === "number" ? r.manual_sort : ++sort;
          map.set(r.id, { id: r.id, table_ref: a.table, manual_sort, data: r.data ?? {} });
        }
        break;
      }
      case "UpdateRecords": {
        const map = tableRows(a.table);
        for (const r of a.records) {
          const row = map.get(r.id);
          if (!row) continue;
          map.set(r.id, {
            ...row,
            data: { ...row.data, ...r.values },
            manual_sort: typeof r.manual_sort === "number" ? r.manual_sort : row.manual_sort,
          });
        }
        break;
      }
      case "RemoveRecords": {
        const map = tableRows(a.table);
        for (const id of a.ids) map.delete(id);
        break;
      }
      case "Add": {
        const row = a.row;
        if (a.entity === "table") {
          touch("tables");
          const t = pick<DocTable>(row, TABLE_KEYS);
          tables.set(t.id, t);
          if (!rows.has(t.id)) {
            touch("rows");
            rows.set(t.id, new Map());
          }
        } else if (a.entity === "column") {
          touch("columns");
          const c = pick<DocColumn>(row, COLUMN_KEYS);
          columns.set(c.id, { ...c, options: c.options ?? {} });
        } else if (a.entity === "page") {
          const p = pick<DocPage>(row, PAGE_KEYS);
          pages = byPosition([...pages.filter((x) => x.id !== p.id), p]);
        } else {
          touch("widgets");
          const w = pick<DocWidget>(row, WIDGET_KEYS);
          widgets.set(w.id, { ...w, options: w.options ?? {} });
        }
        break;
      }
      case "Update": {
        if (a.entity === "table") {
          const t = tables.get(a.id);
          if (t) {
            touch("tables");
            tables.set(a.id, { ...t, ...(a.patch as Partial<DocTable>) });
          }
        } else if (a.entity === "column") {
          const c = columns.get(a.id);
          if (c) {
            touch("columns");
            columns.set(a.id, { ...c, ...(a.patch as Partial<DocColumn>) });
          }
        } else if (a.entity === "page") {
          pages = byPosition(pages.map((p) => (p.id === a.id ? { ...p, ...(a.patch as Partial<DocPage>) } : p)));
        } else {
          const w = widgets.get(a.id);
          if (w) {
            touch("widgets");
            widgets.set(a.id, { ...w, ...(a.patch as Partial<DocWidget>) });
          }
        }
        break;
      }
      case "Remove": {
        if (a.entity === "table") {
          touch("tables");
          touch("columns");
          touch("rows");
          tables.delete(a.id);
          rows.delete(a.id);
          for (const [id, c] of columns) if (c.table_ref === a.id) columns.delete(id);
          for (const w of [...widgets.values()]) if (w.table_ref === a.id) removeWidget(w.id);
        } else if (a.entity === "column") {
          touch("columns");
          columns.delete(a.id);
          unlinkWidgets((w) => (w.link_col === a.id ? { link_col: null } : null));
        } else if (a.entity === "page") {
          pages = pages.filter((p) => p.id !== a.id);
          for (const w of [...widgets.values()]) if (w.page_id === a.id) removeWidget(w.id);
        } else {
          removeWidget(a.id);
        }
        break;
      }
    }
  }
  return { tables, columns, rows, pages, widgets };
}

/** Groups cell changes into one UpdateRecords action per table. */
export function cellUpdates(changes: { tableRef: string; rowId: number; colId: string; value: CellValue }[]): DocAction[] {
  const byTable = new Map<string, Map<number, Record<string, CellValue>>>();
  for (const c of changes) {
    const t = byTable.get(c.tableRef) ?? new Map<number, Record<string, CellValue>>();
    const values = t.get(c.rowId) ?? {};
    values[c.colId] = c.value;
    t.set(c.rowId, values);
    byTable.set(c.tableRef, t);
  }
  return [...byTable].map(([table, m]) => ({
    op: "UpdateRecords" as const,
    table,
    records: [...m].map(([id, values]) => ({ id, values })),
  }));
}
