// Trigger formulas: data columns whose formula runs once, when a record is
// added and/or when chosen columns of the record change, and whose result is
// stored as ordinary data (timestamps, "created by", cleaned-up values).
//
// A trigger column is a data column (is_formula = false) with a formula and
// options.trigger = { onNew?: boolean, onChange?: "any" | string[] (column ids) }.
// The computed values are added to the same action bundle, so they are saved,
// logged and undone together with the change that caused them.
import { Engine, type DocData, type FormulaUser } from "./engine";
import { encodeValue } from "./recalc";
import type { CellValue, DocColumn, DocRow } from "./types";
import { FormulaError, isEmptyValue } from "./values";

export interface TriggerSpec {
  onNew?: boolean;
  onChange?: "any" | string[];
}

/** The record actions triggers react to; other actions pass through unchanged. */
export type TriggerAction =
  | { op: "AddRecords"; table: string; records: { id?: number; manual_sort?: number; data: Record<string, CellValue> }[] }
  | { op: "UpdateRecords"; table: string; records: { id: number; values: Record<string, CellValue>; manual_sort?: number }[] }
  | { op: string; [k: string]: unknown };

export function triggerOf(c: DocColumn): TriggerSpec | null {
  const t = c.options.trigger;
  if (c.is_formula || !c.formula.trim() || !t) return null;
  const onChange = t.onChange === "any" || (Array.isArray(t.onChange) && t.onChange.length) ? t.onChange : undefined;
  if (!t.onNew && !onChange) return null;
  return { onNew: !!t.onNew, onChange };
}

function fires(spec: TriggerSpec, col: DocColumn, changed: string[]): boolean {
  if (!spec.onChange) return false;
  if (spec.onChange === "any") return changed.some((id) => id !== col.id);
  const watched = spec.onChange;
  return changed.some((id) => watched.includes(id));
}

/** Stored form of a trigger result; errors store nothing. */
function storeValue(col: DocColumn, v: unknown): CellValue | undefined {
  if (v instanceof FormulaError) return undefined;
  const enc = encodeValue(col, v);
  if (enc && typeof enc === "object" && !Array.isArray(enc)) return undefined;
  return enc as CellValue;
}

/**
 * Returns `actions` with trigger values added. `data` is the document before
 * the actions. Records added without an id get temporary negative ids while
 * their triggers are evaluated.
 */
export function applyTriggers<A extends TriggerAction>(data: DocData, actions: A[], user: FormulaUser | null = null): A[] {
  const triggers = new Map<string, { col: DocColumn; spec: TriggerSpec }[]>();
  for (const c of data.columns.values()) {
    const spec = triggerOf(c);
    if (!spec) continue;
    const list = triggers.get(c.table_ref) ?? [];
    list.push({ col: c, spec });
    triggers.set(c.table_ref, list);
  }
  if (!triggers.size) return actions;
  for (const list of triggers.values()) list.sort((a, b) => a.col.position - b.col.position);

  // A working copy of the rows, updated as actions are applied.
  const rows = new Map(data.rows);
  const copied = new Set<string>();
  const tableRows = (t: string) => {
    if (!copied.has(t)) {
      copied.add(t);
      rows.set(t, new Map(rows.get(t) ?? []));
    }
    return rows.get(t)!;
  };
  const work: DocData = { ...data, rows };
  let tempId = -1;

  const evaluate = (col: DocColumn, rowId: number) =>
    new Engine(work, { user }).evaluate(col.formula, col.table_ref, rowId);

  return actions.map((a) => {
    if (a.op === "AddRecords") {
      const act = a as Extract<TriggerAction, { op: "AddRecords" }>;
      const list = triggers.get(act.table)?.filter((t) => t.spec.onNew);
      const map = tableRows(act.table);
      const records = act.records.map((r) => {
        const id = typeof r.id === "number" ? r.id : tempId--;
        const row: DocRow = { id, table_ref: act.table, manual_sort: r.manual_sort ?? 0, data: { ...(r.data ?? {}) } };
        map.set(id, row);
        if (!list?.length) return r;
        for (const { col } of list) {
          if (!isEmptyValue(row.data[col.id])) continue; // an explicit value wins
          const v = storeValue(col, evaluate(col, id));
          if (v !== undefined && v !== null) row.data = { ...row.data, [col.id]: v };
        }
        map.set(id, { ...row });
        return { ...r, data: row.data };
      });
      return { ...act, records } as unknown as A;
    }
    if (a.op === "UpdateRecords") {
      const act = a as Extract<TriggerAction, { op: "UpdateRecords" }>;
      const list = triggers.get(act.table)?.filter((t) => t.spec.onChange);
      const map = tableRows(act.table);
      const records = act.records.map((r) => {
        const old = map.get(r.id);
        if (!old) return r;
        let data = { ...old.data, ...r.values };
        map.set(r.id, { ...old, data });
        if (!list?.length) return r;
        const changed = Object.keys(r.values);
        const values = { ...r.values };
        for (const { col, spec } of list) {
          if (col.id in r.values || !fires(spec, col, changed)) continue;
          const v = storeValue(col, evaluate(col, r.id));
          if (v === undefined) continue;
          values[col.id] = v;
          data = { ...data, [col.id]: v };
          map.set(r.id, { ...old, data });
        }
        return { ...r, values };
      });
      return { ...act, records } as unknown as A;
    }
    return a;
  });
}

/**
 * Server side (formula worker): trigger values for actions that were applied
 * without the app (public forms, the API). `data` is the document after the
 * actions; returns UpdateRecords actions with the values to store.
 */
export function triggerUpdatesForApplied(
  data: DocData,
  bundles: { op: string; table?: string; records?: { id?: number; data?: Record<string, unknown>; values?: Record<string, unknown> }[] }[][],
  user: FormulaUser | null = null,
): { op: "UpdateRecords"; table: string; records: { id: number; values: Record<string, CellValue> }[] }[] {
  const triggers = new Map<string, { col: DocColumn; spec: TriggerSpec }[]>();
  for (const c of data.columns.values()) {
    const spec = triggerOf(c);
    if (spec) triggers.set(c.table_ref, [...(triggers.get(c.table_ref) ?? []), { col: c, spec }]);
  }
  if (!triggers.size) return [];
  const engine = new Engine(data, { user });
  const out = new Map<string, Map<number, Record<string, CellValue>>>();
  const put = (table: string, id: number, col: DocColumn) => {
    const row = data.rows.get(table)?.get(id);
    if (!row) return;
    const v = storeValue(col, engine.evaluate(col.formula, table, id));
    if (v === undefined) return;
    const t = out.get(table) ?? new Map();
    t.set(id, { ...(t.get(id) ?? {}), [col.id]: v });
    out.set(table, t);
  };
  for (const ops of bundles) {
    for (const op of ops) {
      const list = op.table ? triggers.get(op.table) : undefined;
      if (!list || !op.table) continue;
      for (const r of op.records ?? []) {
        if (typeof r.id !== "number") continue;
        if (op.op === "AddRecords") {
          for (const { col, spec } of list) if (spec.onNew && isEmptyValue(r.data?.[col.id])) put(op.table, r.id, col);
        } else if (op.op === "UpdateRecords") {
          const changed = Object.keys(r.values ?? {});
          for (const { col, spec } of list) if (!changed.includes(col.id) && fires(spec, col, changed)) put(op.table, r.id, col);
        }
      }
    }
  }
  return [...out].map(([table, rows]) => ({ op: "UpdateRecords" as const, table, records: [...rows].map(([id, values]) => ({ id, values })) }));
}
