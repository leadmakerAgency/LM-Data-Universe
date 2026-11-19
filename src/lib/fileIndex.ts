// Where every file of the open document lives: which record and column hold
// it, and which records that record points at (so "all files of this client"
// can be answered). Rebuilt when the document changes.
import { attachmentIds } from "./attachments";
import type { DocColumn } from "./types";
import { getDerived, tableColumns, useDoc } from "@/store/docStore";

export interface FileLocation {
  id: string;
  tableRef: string;
  rowId: number;
  colId: string;
}

let cacheVersion = -1;
let cacheDoc: string | null = null;
let cache: { list: FileLocation[]; byId: Map<string, FileLocation[]> } = { list: [], byId: new Map() };

/** Every file in a cell of the document, in table, record and cell order. */
export function fileLocations(): { list: FileLocation[]; byId: Map<string, FileLocation[]> } {
  const s = useDoc.getState();
  if (cacheVersion === s.version && cacheDoc === s.docId) return cache;
  const list: FileLocation[] = [];
  const byId = new Map<string, FileLocation[]>();
  const tables = [...s.tables.values()].sort((a, b) => a.position - b.position);
  for (const t of tables) {
    const cols = tableColumns(t.id).filter((c) => c.type === "Attachments" && !c.is_formula);
    if (!cols.length) continue;
    for (const rowId of getDerived().engine.rowIds(t.id)) {
      const row = s.rows.get(t.id)?.get(rowId);
      if (!row) continue;
      for (const c of cols) {
        for (const id of attachmentIds(row.data[c.id])) {
          const loc = { id, tableRef: t.id, rowId, colId: c.id };
          list.push(loc);
          const l = byId.get(id);
          if (l) l.push(loc);
          else byId.set(id, [loc]);
        }
      }
    }
  }
  cache = { list, byId };
  cacheVersion = s.version;
  cacheDoc = s.docId;
  return cache;
}

/** The first cell holding a file, if any. */
export function fileCell(id: string): FileLocation | undefined {
  return fileLocations().byId.get(id)?.[0];
}

export interface RelatedGroup {
  /** The table whose records point here, and the column they do it with. */
  tableRef: string;
  col: DocColumn;
  rowIds: number[];
}

/** Records in other tables (or this one) that point at a record through a Reference column. */
export function relatedRecords(tableRef: string, rowId: number): RelatedGroup[] {
  const s = useDoc.getState();
  const out: RelatedGroup[] = [];
  for (const col of s.columns.values()) {
    if ((col.type !== "Ref" && col.type !== "RefList") || col.is_formula || col.options.refTable !== tableRef) continue;
    const rows = s.rows.get(col.table_ref);
    if (!rows) continue;
    const rowIds: number[] = [];
    for (const id of getDerived().engine.rowIds(col.table_ref)) {
      const v = rows.get(id)?.data[col.id];
      if (v === rowId || (Array.isArray(v) && v.includes(rowId))) rowIds.push(id);
    }
    out.push({ tableRef: col.table_ref, col, rowIds });
  }
  const order = (t: string) => s.tables.get(t)?.position ?? 0;
  return out.sort((a, b) => order(a.tableRef) - order(b.tableRef) || a.col.position - b.col.position);
}

/** Records a record points at through its own Reference columns: [column, target table, record ids]. */
export function referencedRecords(tableRef: string, rowId: number): { col: DocColumn; tableRef: string; rowIds: number[] }[] {
  const s = useDoc.getState();
  const row = s.rows.get(tableRef)?.get(rowId);
  if (!row) return [];
  const out: { col: DocColumn; tableRef: string; rowIds: number[] }[] = [];
  for (const col of tableColumns(tableRef)) {
    const target = col.options.refTable;
    if ((col.type !== "Ref" && col.type !== "RefList") || col.is_formula || !target) continue;
    const v = row.data[col.id];
    const ids = (typeof v === "number" ? [v] : Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []).filter((id) => id > 0 && s.rows.get(target)?.has(id));
    if (ids.length) out.push({ col, tableRef: target, rowIds: ids });
  }
  return out;
}
