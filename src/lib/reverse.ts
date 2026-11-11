// Two-way references: a Ref/RefList column and a column in the target table
// that lists the records pointing at each record. Each side names the other
// in options.reverseCol. Whichever side a change touches is the source; the
// other side is recomputed from it and the updates join the same bundle, so
// saving, undo and collaborators always see both sides together.
import { applyActionsLocal, type DocAction, type LocalDoc } from "./actions";
import type { CellValue, DocColumn, DocRow } from "./types";

interface Pair {
  primary: DocColumn;
  secondary: DocColumn;
}

export function reversePairs(columns: Map<string, DocColumn>): Pair[] {
  const out: Pair[] = [];
  for (const a of columns.values()) {
    if (a.is_formula || a.options.reverseSecondary || !a.options.reverseCol) continue;
    const b = columns.get(a.options.reverseCol);
    if (!b || b.is_formula || b.options.reverseCol !== a.id) continue;
    if ((a.type !== "Ref" && a.type !== "RefList") || (b.type !== "Ref" && b.type !== "RefList")) continue;
    out.push({ primary: a, secondary: b });
  }
  return out;
}

const refIds = (v: CellValue | undefined): number[] =>
  typeof v === "number" ? (v > 0 ? [v] : []) : Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && x > 0) : [];

const sameRefs = (a: CellValue | undefined, b: CellValue | undefined) => JSON.stringify(refIds(a)) === JSON.stringify(refIds(b));

/** Updates that make `to` agree with `from`, given the document's rows. */
function derive(from: DocColumn, to: DocColumn, rows: Map<string, Map<number, DocRow>>): DocAction | null {
  const fromRows = [...(rows.get(from.table_ref)?.values() ?? [])].sort((x, y) => x.manual_sort - y.manual_sort || x.id - y.id);
  const toRows = rows.get(to.table_ref);
  if (!toRows) return null;
  const lists = new Map<number, number[]>();
  for (const r of fromRows) {
    for (const t of refIds(r.data[from.id])) {
      if (!toRows.has(t)) continue;
      const l = lists.get(t) ?? [];
      l.push(r.id);
      lists.set(t, l);
    }
  }
  const records: { id: number; values: Record<string, CellValue> }[] = [];
  for (const row of toRows.values()) {
    const current = row.data[to.id];
    const wanted = lists.get(row.id) ?? [];
    // Keep the existing order for ids still present; append new ones.
    const kept = refIds(current).filter((id) => wanted.includes(id));
    const ordered = [...kept, ...wanted.filter((id) => !kept.includes(id))];
    const value: CellValue = to.type === "Ref" ? (ordered[0] ?? null) : ordered.length ? ordered : null;
    if (!sameRefs(current, value)) records.push({ id: row.id, values: { [to.id]: value } });
  }
  return records.length ? { op: "UpdateRecords", table: to.table_ref, records } : null;
}

function touches(actions: DocAction[], col: DocColumn): boolean {
  return actions.some((a) => {
    if (a.op === "UpdateRecords") return a.table === col.table_ref && a.records.some((r) => col.id in r.values);
    if (a.op === "AddRecords") return a.table === col.table_ref && a.records.some((r) => col.id in (r.data ?? {}));
    if (a.op === "RemoveRecords") return a.table === col.table_ref;
    return false;
  });
}

/** Extra actions keeping two-way references in sync after `actions`. */
export function reverseSync(doc: LocalDoc, actions: DocAction[]): DocAction[] {
  const pairs = reversePairs(doc.columns);
  if (!pairs.length) return [];
  const after = applyActionsLocal(doc, actions);
  const out: DocAction[] = [];
  for (const { primary, secondary } of pairs) {
    const a = touches(actions, primary);
    const b = touches(actions, secondary);
    if (!a && !b) continue;
    const fix = b && !a ? derive(secondary, primary, after.rows) : derive(primary, secondary, after.rows);
    if (fix) out.push(fix);
  }
  return out;
}

/** Actions that bring every two-way pair back in agreement (primary side wins). */
export function reverseRepair(doc: LocalDoc): DocAction[] {
  const out: DocAction[] = [];
  for (const { primary, secondary } of reversePairs(doc.columns)) {
    const fix = derive(primary, secondary, doc.rows);
    if (fix) out.push(fix);
  }
  return out;
}

/** Fills a newly created reverse column from the existing references. */
export function initialReverse(primary: DocColumn, secondary: DocColumn, rows: Map<string, Map<number, DocRow>>): DocAction | null {
  return derive(primary, secondary, rows);
}
