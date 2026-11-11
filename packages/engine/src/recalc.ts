// Server-side recalculation: turns logged actions into a change set, computes
// the affected formula columns, and produces the `doc_rows.computed` values
// that changed. Pure: the caller loads the document and writes the result.
import { affectedFormulas, type ChangeSet } from "./deps";
import { Engine, type DocData } from "./engine";
import { FormulaError, RecordRef, RecordSet, dateToIso, isDate } from "./values";
import type { DocColumn } from "./types";

/** JSON shape stored for a formula error. */
export interface EncodedError {
  error: string;
  message: string;
}

export type EncodedValue = string | number | boolean | null | EncodedError | EncodedValue[];

/** Runtime formula value → JSON for `computed` (same shapes as stored data). */
export function encodeValue(col: Pick<DocColumn, "type">, v: unknown): EncodedValue {
  if (v instanceof FormulaError) return { error: v.code, message: v.message };
  if (v === null || v === undefined) return null;
  if (isDate(v)) return col.type === "Date" ? dateToIso(v) : v.toISOString();
  if (v instanceof RecordRef) return v.rowId || null;
  if (v instanceof RecordSet) return v.ids;
  if (Array.isArray(v)) return v.map((x) => encodeValue({ type: "Any" }, x));
  if (typeof v === "number") return Number.isFinite(v) ? v : { error: "#NUM!", message: "Not a finite number" };
  if (typeof v === "string" || typeof v === "boolean") return v;
  return { error: "#TypeError", message: "This value can't be stored" };
}

/** A logged action bundle as read from doc_actions. */
export interface LoggedOp {
  op: string;
  entity?: string;
  table?: string;
  records?: { values?: Record<string, unknown>; manual_sort?: number }[];
}

/** What a list of logged actions changed. Unknown ops are treated as schema changes. */
export function changeSetFromActions(bundles: LoggedOp[][]): ChangeSet {
  const change: ChangeSet = { cols: new Set(), tables: new Set(), all: false };
  for (const ops of bundles) {
    for (const op of ops) {
      switch (op.op) {
        case "AddRecords":
        case "RemoveRecords":
          if (op.table) change.tables.add(op.table);
          break;
        case "UpdateRecords":
          for (const r of op.records ?? []) {
            for (const k of Object.keys(r.values ?? {})) change.cols.add(k);
            // Row order decides lookup order, so a moved row affects lookups.
            if (typeof r.manual_sort === "number" && op.table) change.tables.add(op.table);
          }
          break;
        case "Add":
        case "Update":
        case "Remove":
          if (op.entity === "table" || op.entity === "column") change.all = true;
          break;
        default:
          change.all = true;
      }
    }
  }
  return change;
}

export interface ComputedRow {
  id: number;
  computed: Record<string, EncodedValue>;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Recomputes the formula columns affected by `change` and returns the rows
 * whose `computed` object differs from `current`. Keys of columns that are no
 * longer formulas are dropped.
 */
export function recompute(
  data: DocData,
  current: Map<number, Record<string, unknown>>,
  change: ChangeSet,
): { updates: ComputedRow[]; recomputed: string[] } {
  const affected = affectedFormulas({ tables: data.tables.values(), columns: data.columns.values() }, change);
  const formulaIds = new Set([...data.columns.values()].filter((c) => c.is_formula).map((c) => c.id));
  const engine = new Engine(data);
  const updates: ComputedRow[] = [];
  for (const [tableRef, rows] of data.rows) {
    const cols = (data.colsByTable.get(tableRef) ?? []).filter((c) => affected.has(c.id));
    for (const rowId of rows.keys()) {
      const before = current.get(rowId) ?? {};
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(before)) if (formulaIds.has(k)) next[k] = v;
      for (const c of cols) next[c.id] = encodeValue(c, engine.safeValue(c, rowId));
      if (!sameJson(before, next)) updates.push({ id: rowId, computed: next as Record<string, EncodedValue> });
    }
  }
  return { updates, recomputed: [...affected] };
}
