// Copying a summary out as an ordinary table (Grist's "detach"): one row per
// group with the group values, the count, the totals and any $group formulas,
// saved as data the user can then edit freely.
import { encodeValue } from "@engine/recalc";
import { FormulaError, RecordSet, toNumber } from "@engine/values";
import type { CellValue, ColumnType, DocWidget } from "./types";
import { summaryGroups } from "./view";
import { getDerived, tableColumns, useDoc } from "@/store/docStore";

export async function detachSummary(widget: DocWidget): Promise<string | null> {
  const st = useDoc.getState();
  const tableRef = widget.table_ref;
  if (!tableRef) return null;
  const source = st.tables.get(tableRef);
  const cols = tableColumns(tableRef);
  const groupBy = widget.options.groupBy ?? [];
  const groupCols = groupBy.map((id) => cols.find((c) => c.id === id)).filter((c) => !!c);
  const sumCols = cols.filter((c) => (c.type === "Numeric" || c.type === "Int") && !groupBy.includes(c.id));
  const formulas = widget.options.summaryFormulas ?? [];
  const { engine } = getDerived();
  const groups = summaryGroups(widget);

  const spec: { label: string; type: ColumnType }[] = [
    ...groupCols.map((c) => ({ label: c.label || c.col_id, type: c.type })),
    { label: "Count", type: "Int" },
    ...sumCols.map((c) => ({ label: `${c.label || c.col_id} total`, type: "Numeric" as ColumnType })),
    ...formulas.map((f) => ({ label: f.label || "Formula", type: "Any" as ColumnType })),
  ];
  const table = await st.addTable(`${source?.table_id ?? "Table"} summary`, spec);
  if (!table) return null;
  const created = tableColumns(table.id);
  // Keep reference / choice / number settings of the grouping columns.
  for (let i = 0; i < groupCols.length; i++) {
    const g = groupCols[i];
    if (Object.keys(g.options).length) await useDoc.getState().updateColumn(created[i].id, { options: { ...g.options, reverseCol: undefined, rules: undefined, trigger: undefined } }, { undoable: false });
  }
  const rows = groups.map((g) => {
    const data: Record<string, CellValue> = {};
    let k = 0;
    groupCols.forEach((c, i) => {
      data[created[k++].id] = encodeValue(c, g.values[i]) as CellValue;
    });
    data[created[k++].id] = g.rowIds.length;
    for (const c of sumCols) {
      data[created[k++].id] = g.rowIds.reduce((s, id) => {
        const v = engine.safeValue(c, id);
        return s + (v instanceof FormulaError ? 0 : (toNumber(v) ?? 0));
      }, 0);
    }
    for (const f of formulas) {
      const set = new RecordSet(tableRef, g.rowIds);
      const v = engine.evaluateWith(f.formula, tableRef, g.rowIds[0] ?? -1, { $group: set, group: set });
      const enc = encodeValue({ type: "Any" }, v);
      data[created[k++].id] = enc && typeof enc === "object" && !Array.isArray(enc) ? null : (enc as CellValue);
    }
    return { data };
  });
  await useDoc.getState().addRows(table.id, rows);
  return table.id;
}
