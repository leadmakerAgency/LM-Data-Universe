// Quick sanity checks for the formula engine (run: npx tsx scripts/formula-check.ts).
import { Engine } from "../src/lib/formula/engine";
import { FormulaError, RecordRef } from "../src/lib/formula/values";
import type { DocColumn, DocRow, DocTable } from "../src/lib/types";

const tables = new Map<string, DocTable>([
  ["tc", { id: "tc", doc_id: "d", table_id: "Customers", position: 1 }],
  ["to", { id: "to", doc_id: "d", table_id: "Orders", position: 2 }],
]);
const col = (id: string, table: string, colId: string, type: DocColumn["type"], formula = "", options = {}): DocColumn => ({
  id, doc_id: "d", table_ref: table, col_id: colId, label: colId, type, is_formula: !!formula, formula, options, position: 0,
});
const cols = [
  col("cName", "tc", "Name", "Text"),
  col("cTotal", "tc", "Total", "Numeric", "SUM(Orders.lookupRecords(Customer=$id).Amount)"),
  col("cCount", "tc", "Count", "Int", "len(Orders.lookupRecords(Customer=$id))"),
  col("cBig", "tc", "Big", "Any", '"big" if $Total > 100 else "small"'),
  col("oCust", "to", "Customer", "Ref", "", { refTable: "tc" }),
  col("oAmt", "to", "Amount", "Numeric"),
  col("oDate", "to", "Date", "Date"),
  col("oName", "to", "CustName", "Any", "$Customer.Name.upper()"),
  col("oNext", "to", "Next", "Date", "DATEADD($Date, days=30)"),
  col("oCirc", "to", "Circ", "Any", "$Circ2 + 1"),
  col("oCirc2", "to", "Circ2", "Any", "$Circ + 1"),
  col("oErr", "to", "Err", "Any", "$Amount / 0"),
  col("oIf", "to", "Iff", "Any", 'IF($Amount >= 50, "high", "low") & " / " & ROUND($Amount * 1.2, 1)'),
];
const columns = new Map(cols.map((c) => [c.id, c]));
const colsByTable = new Map<string, DocColumn[]>([["tc", cols.filter((c) => c.table_ref === "tc")], ["to", cols.filter((c) => c.table_ref === "to")]]);
const row = (id: number, t: string, data: DocRow["data"]): DocRow => ({ id, table_ref: t, manual_sort: id, data });
const rows = new Map<string, Map<number, DocRow>>([
  ["tc", new Map([[1, row(1, "tc", { cName: "Ada" })], [2, row(2, "tc", { cName: "Bob" })]])],
  ["to", new Map([
    [10, row(10, "to", { oCust: 1, oAmt: 80, oDate: "2026-01-31" })],
    [11, row(11, "to", { oCust: 1, oAmt: 40, oDate: "2026-02-10" })],
    [12, row(12, "to", { oCust: 2, oAmt: 15 })],
  ])],
]);
const e = new Engine({ tables, columns, colsByTable, rows });
const show = (v: unknown) => (v instanceof FormulaError ? v.code : v instanceof RecordRef ? `Ref(${v.rowId})` : v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v));
const checks: [string, unknown, unknown][] = [
  ["Total Ada", e.safeValue(columns.get("cTotal")!, 1), 120],
  ["Count Ada", e.safeValue(columns.get("cCount")!, 1), 2],
  ["Big Ada", e.safeValue(columns.get("cBig")!, 1), "big"],
  ["Big Bob", e.safeValue(columns.get("cBig")!, 2), "small"],
  ["CustName", e.safeValue(columns.get("oName")!, 10), "ADA"],
  ["Next", show(e.safeValue(columns.get("oNext")!, 10)), "2026-03-02"],
  ["Circ", show(e.safeValue(columns.get("oCirc")!, 10)), "#CIRCULAR"],
  ["Err", show(e.safeValue(columns.get("oErr")!, 10)), "#DIV/0!"],
  ["Iff", e.safeValue(columns.get("oIf")!, 10), "high / 96"],
  ["Adhoc", e.evaluate("SUM([1,2,3]) * 2 if not False else 0", "to", 10), 12],
  ["Syntax", show(e.evaluate("$Amount +", "to", 10)), "#SyntaxError"],
  ["Name", show(e.evaluate("$Nope", "to", 10)), "#NAME?"],
  ["Switch", e.evaluate('SWITCH("b", "a", 1, "b", 2, 0)', "to", 10), 2],
  ["In", e.evaluate('"x" in ["x", "y"]', "to", 10), true],
  ["DateDiff", e.evaluate('DAYS(DATE(2026,3,1), $Date)', "to", 10), 29],
];
let fail = 0;
for (const [name, got, want] of checks) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${show(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
}
process.exit(fail ? 1 : 0);
