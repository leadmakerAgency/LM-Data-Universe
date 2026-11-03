// State of the open document: schema, rows, pages and widgets, kept in sync
// with Supabase. Edits are applied locally first, then written; realtime
// events from other collaborators are merged in as they arrive.
import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, fetchAll, errorMessage } from "@/lib/supabase";
import { Engine } from "@/lib/formula/engine";
import { renameColumnInFormula, renameTableInFormula } from "@/lib/formula/parser";
import { FormulaError } from "@/lib/formula/values";
import { convertValue, displayValue, parseInput, type DisplayContext, type ParseContext } from "@/lib/format";
import { labelToIdent, nextColumnLetter, uniqueIdent } from "@/lib/ids";
import { toast } from "./toasts";
import type {
  CellValue,
  ColumnType,
  DocColumn,
  DocPage,
  DocRow,
  DocTable,
  DocWidget,
  DocumentRec,
  FormShare,
  Role,
  WidgetType,
} from "@/lib/types";

const ROW_FIELDS = "id,table_ref,manual_sort,data";

export interface CellChange {
  tableRef: string;
  rowId: number;
  colId: string;
  value: CellValue;
}

type UndoOp =
  | { k: "cells"; changes: { tableRef: string; rowId: number; colId: string; before: CellValue; after: CellValue }[] }
  | { k: "addRows"; tableRef: string; rows: DocRow[] }
  | { k: "deleteRows"; tableRef: string; rows: DocRow[] }
  | { k: "column"; before: DocColumn; after: DocColumn };

export interface NewWidgetSpec {
  type: WidgetType;
  tableRef: string | "new";
  title?: string;
  linkSource?: string | null;
  linkCol?: string | null;
  width?: number;
}

interface DocState {
  docId: string | null;
  doc: DocumentRec | null;
  role: Role | null;
  loading: boolean;
  error: string | null;
  tables: Map<string, DocTable>;
  columns: Map<string, DocColumn>;
  rows: Map<string, Map<number, DocRow>>;
  pages: DocPage[];
  widgets: Map<string, DocWidget>;
  formShares: Map<string, FormShare>;
  version: number;
  cursors: Record<string, number | null>;
  undoStack: UndoOp[][];
  redoStack: UndoOp[][];

  load(docId: string): Promise<void>;
  unload(): void;
  canEdit(): boolean;

  setCells(changes: CellChange[], opts?: { undoable?: boolean }): Promise<void>;
  addRows(tableRef: string, rows: { data: Record<string, CellValue>; manual_sort?: number }[], opts?: { undoable?: boolean }): Promise<DocRow[]>;
  deleteRows(tableRef: string, ids: number[], opts?: { undoable?: boolean }): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;

  addTable(name?: string, columns?: { label: string; type?: ColumnType }[]): Promise<DocTable | null>;
  renameTable(tableRef: string, name: string): Promise<boolean>;
  deleteTable(tableRef: string): Promise<void>;

  addColumn(tableRef: string, init?: Partial<DocColumn>, position?: number): Promise<DocColumn | null>;
  updateColumn(colId: string, patch: Partial<DocColumn>, opts?: { undoable?: boolean }): Promise<boolean>;
  deleteColumn(colId: string): Promise<void>;

  renameDoc(name: string): Promise<void>;
  addPage(name: string, widget: NewWidgetSpec): Promise<DocPage | null>;
  renamePage(pageId: string, name: string): Promise<void>;
  movePage(pageId: string, delta: number): Promise<void>;
  deletePage(pageId: string): Promise<void>;
  addWidget(pageId: string, spec: NewWidgetSpec): Promise<DocWidget | null>;
  updateWidget(id: string, patch: Partial<DocWidget>): Promise<void>;
  deleteWidget(id: string): Promise<void>;
  setCursor(widgetId: string, rowId: number | null): void;

  setFormShare(widgetId: string, active: boolean): Promise<FormShare | null>;
}

let channel: RealtimeChannel | null = null;
// Rows with writes in flight: realtime echoes for them are ignored until the
// write returns the canonical row.
const pendingRows = new Map<number, number>();

function sortedPages(pages: DocPage[]) {
  return [...pages].sort((a, b) => a.position - b.position);
}

function cloneRows(rows: Map<string, Map<number, DocRow>>, tableRef: string) {
  const next = new Map(rows);
  next.set(tableRef, new Map(rows.get(tableRef) ?? []));
  return next;
}

// ---- derived data, recomputed once per version
let derivedVersion = -1;
let derivedDoc: string | null = null;
let derived: {
  colsByTable: Map<string, DocColumn[]>;
  engine: Engine;
  refIndex: Map<string, Map<string, number>>;
} | null = null;

export function getDerived() {
  const s = useDoc.getState();
  if (!derived || derivedVersion !== s.version || derivedDoc !== s.docId) {
    const colsByTable = new Map<string, DocColumn[]>();
    for (const t of s.tables.values()) colsByTable.set(t.id, []);
    for (const c of s.columns.values()) {
      const list = colsByTable.get(c.table_ref);
      if (list) list.push(c);
    }
    for (const list of colsByTable.values()) list.sort((a, b) => a.position - b.position);
    const engine = new Engine({ tables: s.tables, columns: s.columns, colsByTable, rows: s.rows });
    derived = { colsByTable, engine, refIndex: new Map() };
    derivedVersion = s.version;
    derivedDoc = s.docId;
  }
  return derived;
}

export function displayCtx(): DisplayContext & ParseContext {
  const d = getDerived();
  return {
    engine: d.engine,
    colsByTable: d.colsByTable,
    resolveRef(col, text) {
      const target = col.options.refTable;
      if (!target) return null;
      const cols = d.colsByTable.get(target) ?? [];
      const display = cols.find((c) => c.id === col.options.visibleCol) ?? cols[0];
      if (!display) return null;
      const key = `${target}|${display.id}`;
      let index = d.refIndex.get(key);
      if (!index) {
        index = new Map();
        for (const id of d.engine.rowIds(target)) {
          const v = d.engine.safeValue(display, id);
          if (v instanceof FormulaError) continue;
          const shown = displayValue(this, display, v).trim().toLowerCase();
          if (shown && !index.has(shown)) index.set(shown, id);
        }
        d.refIndex.set(key, index);
      }
      return index.get(text.trim().toLowerCase()) ?? null;
    },
  };
}

export function tableColumns(tableRef: string | null | undefined): DocColumn[] {
  if (!tableRef) return [];
  return getDerived().colsByTable.get(tableRef) ?? [];
}

export const useDoc = create<DocState>((set, get) => {
  const fail = (e: unknown, what: string) => {
    toast.error(`${what}: ${errorMessage(e)}`);
  };

  const pushUndo = (ops: UndoOp[]) => {
    const undoStack = [...get().undoStack, ops].slice(-100);
    set({ undoStack, redoStack: [] });
  };

  const applyRowLocal = (row: DocRow) => {
    const rows = cloneRows(get().rows, row.table_ref);
    rows.get(row.table_ref)!.set(row.id, { id: row.id, table_ref: row.table_ref, manual_sort: row.manual_sort, data: row.data ?? {} });
    set({ rows, version: get().version + 1 });
  };

  const removeRowLocal = (id: number) => {
    for (const [tableRef, map] of get().rows) {
      if (map.has(id)) {
        const rows = cloneRows(get().rows, tableRef);
        rows.get(tableRef)!.delete(id);
        set({ rows, version: get().version + 1 });
        return;
      }
    }
  };

  /** Rewrites formulas across the document, e.g. after a rename. */
  const rewriteFormulas = async (rewrite: (c: DocColumn) => string) => {
    for (const c of get().columns.values()) {
      if (!c.formula) continue;
      const next = rewrite(c);
      if (next !== c.formula) await get().updateColumn(c.id, { formula: next }, { undoable: false });
    }
  };

  const subscribe = (docId: string) => {
    channel?.unsubscribe();
    const filter = `doc_id=eq.${docId}`;
    const ch = supabase().channel(`doc-${docId}`);
    const tablesToWatch = ["doc_rows", "doc_columns", "doc_tables", "doc_pages", "doc_widgets"] as const;
    for (const table of tablesToWatch) {
      ch.on("postgres_changes", { event: "INSERT", schema: "public", table, filter }, (p) => onChange(table, "INSERT", p.new));
      ch.on("postgres_changes", { event: "UPDATE", schema: "public", table, filter }, (p) => onChange(table, "UPDATE", p.new));
      // Delete events cannot be filtered; unknown ids are simply ignored.
      ch.on("postgres_changes", { event: "DELETE", schema: "public", table }, (p) => onChange(table, "DELETE", p.old));
    }
    ch.subscribe();
    channel = ch;
  };

  const onChange = (table: string, event: string, rec: Record<string, unknown>) => {
    const s = get();
    if (!s.docId) return;
    if (event !== "DELETE" && rec.doc_id !== s.docId) return;
    switch (table) {
      case "doc_rows": {
        const id = Number(rec.id);
        if (pendingRows.has(id)) return;
        if (event === "DELETE") removeRowLocal(id);
        else applyRowLocal(rec as unknown as DocRow);
        break;
      }
      case "doc_columns": {
        const columns = new Map(s.columns);
        if (event === "DELETE") {
          if (!columns.delete(String(rec.id))) return;
        } else columns.set(String(rec.id), rec as unknown as DocColumn);
        set({ columns, version: s.version + 1 });
        break;
      }
      case "doc_tables": {
        const tables = new Map(s.tables);
        if (event === "DELETE") {
          if (!tables.delete(String(rec.id))) return;
        } else tables.set(String(rec.id), rec as unknown as DocTable);
        set({ tables, version: s.version + 1 });
        break;
      }
      case "doc_pages": {
        let pages = s.pages.filter((p) => p.id !== rec.id);
        if (event === "DELETE" && pages.length === s.pages.length) return;
        if (event !== "DELETE") pages = sortedPages([...pages, rec as unknown as DocPage]);
        set({ pages, version: s.version + 1 });
        break;
      }
      case "doc_widgets": {
        const widgets = new Map(s.widgets);
        if (event === "DELETE") {
          if (!widgets.delete(String(rec.id))) return;
        } else widgets.set(String(rec.id), rec as unknown as DocWidget);
        set({ widgets, version: s.version + 1 });
        break;
      }
    }
  };

  const writeCells = async (changes: CellChange[]) => {
    const byRow = new Map<number, Record<string, CellValue>>();
    for (const c of changes) {
      const values = byRow.get(c.rowId) ?? {};
      values[c.colId] = c.value;
      byRow.set(c.rowId, values);
    }
    const ids = [...byRow.keys()];
    ids.forEach((id) => pendingRows.set(id, (pendingRows.get(id) ?? 0) + 1));
    try {
      const updates = ids.map((id) => ({ id, values: byRow.get(id) }));
      for (let i = 0; i < updates.length; i += 500) {
        const { data, error } = await supabase().rpc("update_row_cells", { p_updates: updates.slice(i, i + 500) });
        if (error) throw error;
        for (const row of (data ?? []) as DocRow[]) {
          if (pendingRows.get(row.id) === 1) applyRowLocal(row);
        }
      }
    } finally {
      ids.forEach((id) => {
        const n = (pendingRows.get(id) ?? 1) - 1;
        if (n <= 0) pendingRows.delete(id);
        else pendingRows.set(id, n);
      });
    }
  };

  const insertRows = async (tableRef: string, rows: Partial<DocRow>[]) => {
    const docId = get().docId!;
    const out: DocRow[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, doc_id: docId, table_ref: tableRef }));
      const { data, error } = await supabase().from("doc_rows").insert(chunk).select(ROW_FIELDS);
      if (error) throw error;
      out.push(...((data ?? []) as DocRow[]));
    }
    const next = cloneRows(get().rows, tableRef);
    for (const r of out) next.get(tableRef)!.set(r.id, r);
    set({ rows: next, version: get().version + 1 });
    return out;
  };

  const removeRows = async (tableRef: string, ids: number[]) => {
    const next = cloneRows(get().rows, tableRef);
    ids.forEach((id) => next.get(tableRef)!.delete(id));
    set({ rows: next, version: get().version + 1 });
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await supabase().from("doc_rows").delete().in("id", ids.slice(i, i + 500));
      if (error) throw error;
    }
  };

  const applyOps = async (ops: UndoOp[], direction: "undo" | "redo") => {
    const list = direction === "undo" ? [...ops].reverse() : ops;
    for (const op of list) {
      switch (op.k) {
        case "cells": {
          const changes = op.changes.map((c) => ({
            tableRef: c.tableRef,
            rowId: c.rowId,
            colId: c.colId,
            value: direction === "undo" ? c.before : c.after,
          }));
          await get().setCells(changes, { undoable: false });
          break;
        }
        case "addRows":
          if (direction === "undo") await removeRows(op.tableRef, op.rows.map((r) => r.id));
          else await insertRows(op.tableRef, op.rows.map((r) => ({ id: r.id, manual_sort: r.manual_sort, data: r.data })));
          break;
        case "deleteRows":
          if (direction === "undo") await insertRows(op.tableRef, op.rows.map((r) => ({ id: r.id, manual_sort: r.manual_sort, data: r.data })));
          else await removeRows(op.tableRef, op.rows.map((r) => r.id));
          break;
        case "column": {
          const target = direction === "undo" ? op.before : op.after;
          const { id, doc_id, table_ref, ...patch } = target;
          void doc_id;
          void table_ref;
          await get().updateColumn(id, patch, { undoable: false });
          break;
        }
      }
    }
  };

  return {
    docId: null,
    doc: null,
    role: null,
    loading: false,
    error: null,
    tables: new Map(),
    columns: new Map(),
    rows: new Map(),
    pages: [],
    widgets: new Map(),
    formShares: new Map(),
    version: 0,
    cursors: {},
    undoStack: [],
    redoStack: [],

    async load(docId) {
      set({ loading: true, error: null, docId, undoStack: [], redoStack: [], cursors: {} });
      try {
        const sb = supabase();
        const [docRes, roleRes, tablesRes, colsRes, pagesRes, widgetsRes, sharesRes] = await Promise.all([
          sb.from("documents").select("*").eq("id", docId).maybeSingle(),
          sb.rpc("doc_role", { p_doc: docId }),
          sb.from("doc_tables").select("*").eq("doc_id", docId),
          sb.from("doc_columns").select("*").eq("doc_id", docId),
          sb.from("doc_pages").select("*").eq("doc_id", docId),
          sb.from("doc_widgets").select("*").eq("doc_id", docId),
          sb.from("form_shares").select("*").eq("doc_id", docId),
        ]);
        for (const r of [docRes, roleRes, tablesRes, colsRes, pagesRes, widgetsRes, sharesRes]) if (r.error) throw r.error;
        if (!docRes.data) throw new Error("This document doesn't exist or you don't have access to it.");
        const rowList = await fetchAll<DocRow>((from, to) =>
          sb.from("doc_rows").select(ROW_FIELDS).eq("doc_id", docId).order("id").range(from, to),
        );
        if (get().docId !== docId) return;
        const tables = new Map((tablesRes.data as DocTable[]).map((t) => [t.id, t]));
        const rows = new Map<string, Map<number, DocRow>>();
        for (const t of tables.keys()) rows.set(t, new Map());
        for (const r of rowList) rows.get(r.table_ref)?.set(r.id, r);
        set({
          doc: docRes.data as DocumentRec,
          role: roleRes.data as Role,
          tables,
          columns: new Map((colsRes.data as DocColumn[]).map((c) => [c.id, c])),
          rows,
          pages: sortedPages(pagesRes.data as DocPage[]),
          widgets: new Map((widgetsRes.data as DocWidget[]).map((w) => [w.id, w])),
          formShares: new Map((sharesRes.data as FormShare[]).map((f) => [f.widget_id, f])),
          loading: false,
          version: get().version + 1,
        });
        subscribe(docId);
      } catch (e) {
        set({ loading: false, error: errorMessage(e) });
      }
    },

    unload() {
      channel?.unsubscribe();
      channel = null;
      set({
        docId: null,
        doc: null,
        tables: new Map(),
        columns: new Map(),
        rows: new Map(),
        pages: [],
        widgets: new Map(),
        formShares: new Map(),
        version: get().version + 1,
      });
    },

    canEdit() {
      const r = get().role;
      return r === "owner" || r === "editor";
    },

    async setCells(changes, opts = {}) {
      if (!changes.length || !get().canEdit()) return;
      const s = get();
      const ops: UndoOp = { k: "cells", changes: [] };
      let rows = s.rows;
      const touched = new Set<string>();
      for (const c of changes) {
        if (!touched.has(c.tableRef)) {
          rows = cloneRows(rows, c.tableRef);
          touched.add(c.tableRef);
        }
        const row = rows.get(c.tableRef)?.get(c.rowId);
        if (!row) continue;
        const before = row.data[c.colId] ?? null;
        if (JSON.stringify(before) === JSON.stringify(c.value)) continue;
        ops.changes.push({ tableRef: c.tableRef, rowId: c.rowId, colId: c.colId, before, after: c.value });
        rows.get(c.tableRef)!.set(c.rowId, { ...row, data: { ...row.data, [c.colId]: c.value } });
      }
      if (!ops.changes.length) return;
      set({ rows, version: s.version + 1 });
      if (opts.undoable !== false) pushUndo([ops]);
      try {
        await writeCells(ops.changes.map((c) => ({ tableRef: c.tableRef, rowId: c.rowId, colId: c.colId, value: c.after })));
      } catch (e) {
        fail(e, "Could not save changes");
        void get().load(get().docId!);
      }
    },

    async addRows(tableRef, newRows, opts = {}) {
      if (!get().canEdit()) return [];
      const existing = [...(get().rows.get(tableRef)?.values() ?? [])];
      let maxSort = existing.reduce((m, r) => Math.max(m, r.manual_sort), 0);
      try {
        const created = await insertRows(
          tableRef,
          newRows.map((r) => ({ data: r.data, manual_sort: r.manual_sort ?? (maxSort += 1) })),
        );
        if (opts.undoable !== false) pushUndo([{ k: "addRows", tableRef, rows: created }]);
        return created;
      } catch (e) {
        fail(e, "Could not add rows");
        return [];
      }
    },

    async deleteRows(tableRef, ids, opts = {}) {
      if (!ids.length || !get().canEdit()) return;
      const map = get().rows.get(tableRef);
      const removed = ids.map((id) => map?.get(id)).filter((r): r is DocRow => !!r);
      try {
        await removeRows(tableRef, ids);
        if (opts.undoable !== false) pushUndo([{ k: "deleteRows", tableRef, rows: removed }]);
      } catch (e) {
        fail(e, "Could not delete rows");
        void get().load(get().docId!);
      }
    },

    async undo() {
      const stack = get().undoStack;
      const ops = stack[stack.length - 1];
      if (!ops) return;
      set({ undoStack: stack.slice(0, -1), redoStack: [...get().redoStack, ops] });
      try {
        await applyOps(ops, "undo");
      } catch (e) {
        fail(e, "Undo failed");
      }
    },

    async redo() {
      const stack = get().redoStack;
      const ops = stack[stack.length - 1];
      if (!ops) return;
      set({ redoStack: stack.slice(0, -1), undoStack: [...get().undoStack, ops] });
      try {
        await applyOps(ops, "redo");
      } catch (e) {
        fail(e, "Redo failed");
      }
    },

    async addTable(name, columns) {
      const s = get();
      if (!s.canEdit()) return null;
      const taken = [...s.tables.values()].map((t) => t.table_id);
      const tableId = uniqueIdent(name ? labelToIdent(name, { capitalize: true }) : "Table1", taken);
      const position = Math.max(0, ...[...s.tables.values()].map((t) => t.position)) + 1;
      try {
        const { data: table, error } = await supabase()
          .from("doc_tables")
          .insert({ doc_id: s.docId, table_id: tableId, position })
          .select()
          .single();
        if (error) throw error;
        const specs = columns ?? [{ label: "A" }, { label: "B" }, { label: "C" }];
        const usedIds: string[] = [];
        const colRows = specs.map((spec, i) => {
          const colId = uniqueIdent(labelToIdent(spec.label), usedIds);
          usedIds.push(colId);
          return { doc_id: s.docId, table_ref: table.id, col_id: colId, label: spec.label, type: spec.type ?? "Any", position: i + 1 };
        });
        const { data: cols, error: colErr } = await supabase().from("doc_columns").insert(colRows).select();
        if (colErr) throw colErr;
        const tables = new Map(get().tables).set(table.id, table as DocTable);
        const columnsMap = new Map(get().columns);
        for (const c of cols as DocColumn[]) columnsMap.set(c.id, c);
        const rows = new Map(get().rows).set(table.id, new Map());
        set({ tables, columns: columnsMap, rows, version: get().version + 1 });
        return table as DocTable;
      } catch (e) {
        fail(e, "Could not create table");
        return null;
      }
    },

    async renameTable(tableRef, name) {
      const s = get();
      const table = s.tables.get(tableRef);
      if (!table || !s.canEdit()) return false;
      const taken = [...s.tables.values()].filter((t) => t.id !== tableRef).map((t) => t.table_id);
      const newId = uniqueIdent(labelToIdent(name, { capitalize: true }), taken);
      if (newId === table.table_id) return true;
      const { error } = await supabase().from("doc_tables").update({ table_id: newId }).eq("id", tableRef);
      if (error) {
        fail(error, "Could not rename table");
        return false;
      }
      set({ tables: new Map(s.tables).set(tableRef, { ...table, table_id: newId }), version: s.version + 1 });
      await rewriteFormulas((c) => renameTableInFormula(c.formula, table.table_id, newId));
      return true;
    },

    async deleteTable(tableRef) {
      const s = get();
      if (!s.canEdit()) return;
      const { error } = await supabase().from("doc_tables").delete().eq("id", tableRef);
      if (error) return fail(error, "Could not delete table");
      const tables = new Map(s.tables);
      tables.delete(tableRef);
      const columns = new Map([...s.columns].filter(([, c]) => c.table_ref !== tableRef));
      const rows = new Map(s.rows);
      rows.delete(tableRef);
      const widgets = new Map([...s.widgets].filter(([, w]) => w.table_ref !== tableRef));
      set({ tables, columns, rows, widgets, version: s.version + 1, undoStack: [], redoStack: [] });
    },

    async addColumn(tableRef, init = {}, position) {
      const s = get();
      if (!s.canEdit()) return null;
      const existing = tableColumns(tableRef);
      const label = init.label ?? nextColumnLetter(existing.map((c) => c.label));
      const colId = uniqueIdent(init.col_id ?? labelToIdent(label), existing.map((c) => c.col_id));
      const pos = position ?? Math.max(0, ...existing.map((c) => c.position)) + 1;
      const { data, error } = await supabase()
        .from("doc_columns")
        .insert({
          doc_id: s.docId,
          table_ref: tableRef,
          col_id: colId,
          label,
          type: init.type ?? "Any",
          is_formula: init.is_formula ?? false,
          formula: init.formula ?? "",
          options: init.options ?? {},
          position: pos,
        })
        .select()
        .single();
      if (error) {
        fail(error, "Could not add column");
        return null;
      }
      set({ columns: new Map(get().columns).set(data.id, data as DocColumn), version: get().version + 1 });
      return data as DocColumn;
    },

    async updateColumn(colId, patch, opts = {}) {
      const s = get();
      const before = s.columns.get(colId);
      if (!before || !s.canEdit()) return false;
      const next: DocColumn = { ...before, ...patch, options: { ...before.options, ...(patch.options ?? {}) } };
      if (patch.options && Object.keys(patch.options).length === 0) next.options = {};
      // Keep identifiers valid and unique within the table.
      if (patch.col_id !== undefined && patch.col_id !== before.col_id) {
        const siblings = tableColumns(before.table_ref).filter((c) => c.id !== colId).map((c) => c.col_id);
        next.col_id = uniqueIdent(labelToIdent(patch.col_id), siblings);
      }
      // Converting stored values when a data column changes type.
      const typeChanged = next.type !== before.type && !next.is_formula && !before.is_formula;
      let conversions: CellChange[] = [];
      if (typeChanged) {
        const ctx = displayCtx();
        for (const row of s.rows.get(before.table_ref)?.values() ?? []) {
          const raw = row.data[colId];
          if (raw === undefined || raw === null) continue;
          const converted = convertValue(raw, before, next, ctx, ctx.engine.safeValue(before, row.id));
          if (JSON.stringify(converted) !== JSON.stringify(raw)) {
            conversions.push({ tableRef: before.table_ref, rowId: row.id, colId, value: converted });
          }
        }
      }
      // Turning a formula column into data keeps its current values.
      if (before.is_formula && next.is_formula === false) {
        const engine = getDerived().engine;
        conversions = [];
        for (const row of s.rows.get(before.table_ref)?.values() ?? []) {
          const v = engine.safeValue(before, row.id);
          if (v instanceof FormulaError) continue;
          const text = displayValue(displayCtx(), before, v);
          conversions.push({ tableRef: before.table_ref, rowId: row.id, colId, value: parseInput(next, text, displayCtx()) });
        }
      }
      set({ columns: new Map(s.columns).set(colId, next), version: s.version + 1 });
      const { id, doc_id, table_ref, ...dbPatch } = next;
      void id;
      void doc_id;
      void table_ref;
      const { error } = await supabase().from("doc_columns").update(dbPatch).eq("id", colId);
      if (error) {
        fail(error, "Could not update column");
        set({ columns: new Map(get().columns).set(colId, before), version: get().version + 1 });
        return false;
      }
      if (conversions.length) await get().setCells(conversions, { undoable: false });
      if (next.col_id !== before.col_id) {
        await rewriteFormulas((c) =>
          c.table_ref === before.table_ref ? renameColumnInFormula(c.formula, before.col_id, next.col_id) : c.formula,
        );
      }
      if (opts.undoable !== false && !typeChanged && !(before.is_formula && !next.is_formula)) {
        pushUndo([{ k: "column", before, after: next }]);
      }
      return true;
    },

    async deleteColumn(colId) {
      const s = get();
      const col = s.columns.get(colId);
      if (!col || !s.canEdit()) return;
      const { error } = await supabase().from("doc_columns").delete().eq("id", colId);
      if (error) return fail(error, "Could not delete column");
      const columns = new Map(s.columns);
      columns.delete(colId);
      set({ columns, version: s.version + 1, undoStack: [], redoStack: [] });
    },

    async renameDoc(name) {
      const s = get();
      if (!s.doc || !name.trim()) return;
      const { error } = await supabase().from("documents").update({ name: name.trim() }).eq("id", s.doc.id);
      if (error) return fail(error, "Could not rename document");
      set({ doc: { ...s.doc, name: name.trim() } });
    },

    async addPage(name, widget) {
      const s = get();
      if (!s.canEdit()) return null;
      const position = Math.max(0, ...s.pages.map((p) => p.position)) + 1;
      const { data, error } = await supabase()
        .from("doc_pages")
        .insert({ doc_id: s.docId, name: name.trim() || "Untitled", position })
        .select()
        .single();
      if (error) {
        fail(error, "Could not add page");
        return null;
      }
      set({ pages: sortedPages([...get().pages.filter((p) => p.id !== data.id), data as DocPage]), version: get().version + 1 });
      await get().addWidget(data.id, widget);
      return data as DocPage;
    },

    async renamePage(pageId, name) {
      if (!name.trim()) return;
      const { error } = await supabase().from("doc_pages").update({ name: name.trim() }).eq("id", pageId);
      if (error) return fail(error, "Could not rename page");
      set({ pages: get().pages.map((p) => (p.id === pageId ? { ...p, name: name.trim() } : p)), version: get().version + 1 });
    },

    async movePage(pageId, delta) {
      const pages = get().pages;
      const i = pages.findIndex((p) => p.id === pageId);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= pages.length) return;
      const a = pages[i];
      const b = pages[j];
      const swapped = pages.map((p) => (p.id === a.id ? { ...p, position: b.position } : p.id === b.id ? { ...p, position: a.position } : p));
      set({ pages: sortedPages(swapped), version: get().version + 1 });
      await Promise.all([
        supabase().from("doc_pages").update({ position: b.position }).eq("id", a.id),
        supabase().from("doc_pages").update({ position: a.position }).eq("id", b.id),
      ]);
    },

    async deletePage(pageId) {
      const { error } = await supabase().from("doc_pages").delete().eq("id", pageId);
      if (error) return fail(error, "Could not delete page");
      const widgets = new Map([...get().widgets].filter(([, w]) => w.page_id !== pageId));
      set({ pages: get().pages.filter((p) => p.id !== pageId), widgets, version: get().version + 1 });
    },

    async addWidget(pageId, spec) {
      const s = get();
      if (!s.canEdit()) return null;
      let tableRef = spec.tableRef;
      if (tableRef === "new") {
        const t = await get().addTable();
        if (!t) return null;
        tableRef = t.id;
      }
      const onPage = [...get().widgets.values()].filter((w) => w.page_id === pageId);
      const position = Math.max(0, ...onPage.map((w) => w.position)) + 1;
      const cols = tableColumns(tableRef);
      const options: Record<string, unknown> = {};
      if (spec.type === "chart") {
        const numeric = cols.filter((c) => c.type === "Numeric" || c.type === "Int");
        options.chartType = "bar";
        options.xCol = cols.find((c) => !numeric.includes(c))?.id ?? cols[0]?.id ?? null;
        options.yCols = numeric.slice(0, 1).map((c) => c.id);
        options.aggregate = "sum";
      }
      if (spec.type === "summary") {
        options.groupBy = cols.filter((c) => c.type === "Choice" || c.type === "Ref" || c.type === "Text").slice(0, 1).map((c) => c.id);
      }
      if (spec.type === "form") {
        options.fields = cols.filter((c) => !c.is_formula && c.type !== "Ref" && c.type !== "RefList").map((c) => ({ col: c.id }));
        options.formTitle = s.tables.get(tableRef)?.table_id ?? "Form";
      }
      const width = spec.width ?? (onPage.length ? 6 : 12);
      const { data, error } = await supabase()
        .from("doc_widgets")
        .insert({
          doc_id: s.docId,
          page_id: pageId,
          table_ref: tableRef,
          type: spec.type,
          title: spec.title ?? "",
          position,
          width,
          height: spec.type === "card" ? 360 : 420,
          options,
          link_source: spec.linkSource ?? null,
          link_col: spec.linkCol ?? null,
        })
        .select()
        .single();
      if (error) {
        fail(error, "Could not add widget");
        return null;
      }
      set({ widgets: new Map(get().widgets).set(data.id, data as DocWidget), version: get().version + 1 });
      return data as DocWidget;
    },

    async updateWidget(id, patch) {
      const s = get();
      const before = s.widgets.get(id);
      if (!before) return;
      const next = { ...before, ...patch, options: { ...before.options, ...(patch.options ?? {}) } };
      set({ widgets: new Map(s.widgets).set(id, next), version: s.version + 1 });
      if (!s.canEdit()) return; // viewers can still sort/filter locally
      const { id: _id, doc_id, ...dbPatch } = next;
      void _id;
      void doc_id;
      const { error } = await supabase().from("doc_widgets").update(dbPatch).eq("id", id);
      if (error) fail(error, "Could not save widget");
    },

    async deleteWidget(id) {
      const { error } = await supabase().from("doc_widgets").delete().eq("id", id);
      if (error) return fail(error, "Could not remove widget");
      const widgets = new Map(get().widgets);
      widgets.delete(id);
      for (const [wid, w] of widgets) if (w.link_source === id) widgets.set(wid, { ...w, link_source: null, link_col: null });
      set({ widgets, version: get().version + 1 });
    },

    setCursor(widgetId, rowId) {
      if (get().cursors[widgetId] === rowId) return;
      set({ cursors: { ...get().cursors, [widgetId]: rowId } });
    },

    async setFormShare(widgetId, active) {
      const existing = get().formShares.get(widgetId);
      const res = existing
        ? await supabase().from("form_shares").update({ is_active: active }).eq("id", existing.id).select().single()
        : await supabase().from("form_shares").insert({ widget_id: widgetId, doc_id: get().docId, is_active: active }).select().single();
      if (res.error) {
        fail(res.error, "Could not update form sharing");
        return null;
      }
      set({ formShares: new Map(get().formShares).set(widgetId, res.data as FormShare) });
      return res.data as FormShare;
    },
  };
});
