// A small Customers/Orders document shared by the engine tests.
import type { DocData } from "../src/engine";
import type { DocColumn, DocRow, DocTable } from "../src/types";

export function col(id: string, table: string, colId: string, type: DocColumn["type"], formula = "", options = {}): DocColumn {
  return { id, doc_id: "d", table_ref: table, col_id: colId, label: colId, type, is_formula: !!formula, formula, options, position: 0 };
}

const row = (id: number, t: string, data: DocRow["data"]): DocRow => ({ id, table_ref: t, manual_sort: id, data });

export function fixture(extra: DocColumn[] = []): DocData {
  const tables = new Map<string, DocTable>([
    ["tc", { id: "tc", doc_id: "d", table_id: "Customers", position: 1 }],
    ["to", { id: "to", doc_id: "d", table_id: "Orders", position: 2 }],
  ]);
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
    ...extra,
  ];
  const columns = new Map(cols.map((c) => [c.id, c]));
  const colsByTable = new Map<string, DocColumn[]>([
    ["tc", cols.filter((c) => c.table_ref === "tc")],
    ["to", cols.filter((c) => c.table_ref === "to")],
  ]);
  const rows = new Map<string, Map<number, DocRow>>([
    ["tc", new Map([[1, row(1, "tc", { cName: "Ada" })], [2, row(2, "tc", { cName: "Bob" })]])],
    [
      "to",
      new Map([
        [10, row(10, "to", { oCust: 1, oAmt: 80, oDate: "2026-01-31" })],
        [11, row(11, "to", { oCust: 1, oAmt: 40, oDate: "2026-02-10" })],
        [12, row(12, "to", { oCust: 2, oAmt: 15 })],
      ]),
    ],
  ]);
  return { tables, columns, colsByTable, rows };
}
