// Renaming a column rewrites every formula that refers to it, in any table:
//
//   $Old                          in the column's own table
//   $Customer.Old / rec.Ref.Old   through references to its table
//   Orders.lookupRecords(Old=…)   lookup keys, sort_by / order_by / group_by names
//   [r.Old for r in Orders.all]   records in loops and comprehensions
//
// The dependency analyzer already works out which table each name belongs to;
// here it reports where those names are in the text. References it can't
// place (inside f-strings, or on values whose table isn't known statically)
// are left alone.
import { DependencyAnalyzer } from "./deps";
import { parseFormula, renameColumnInFormula } from "./parser";
import type { DocColumn } from "./types";

export function renameColumnRefs(
  formula: string,
  tableRef: string,
  target: Pick<DocColumn, "id" | "table_ref" | "col_id">,
  newId: string,
  analyzer: DependencyAnalyzer,
): string {
  if (!formula.trim() || newId === target.col_id) return formula;
  try {
    parseFormula(formula);
  } catch {
    // Not parseable (being typed, or broken): the plain $Old rewrite for the column's own table.
    return tableRef === target.table_ref ? renameColumnInFormula(formula, target.col_id, newId) : formula;
  }
  const old = target.col_id;
  const starts = new Set<number>();
  const before = analyzer.onColumn;
  analyzer.onColumn = (col, start) => {
    if (col.id !== target.id || start === undefined || !Number.isFinite(start)) return;
    // Only where the text really is the old name, as a whole word.
    if (formula.slice(start, start + old.length) !== old || /[A-Za-z0-9_]/.test(formula[start + old.length] ?? "")) return;
    starts.add(start);
  };
  try {
    analyzer.analyze({ table_ref: tableRef, formula });
  } finally {
    analyzer.onColumn = before;
  }
  let out = formula;
  for (const start of [...starts].sort((a, b) => b - a)) out = out.slice(0, start) + newId + out.slice(start + old.length);
  return out;
}
