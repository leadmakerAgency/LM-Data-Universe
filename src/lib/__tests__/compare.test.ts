import { describe, expect, it } from "vitest";
import { diffContents, showValue, type DocContent } from "../compare";

const base = (): DocContent => ({
  tables: [{ id: "t1", table_id: "People", position: 1 }],
  columns: [
    { id: "c1", table_ref: "t1", col_id: "Name", label: "Name", type: "Text", is_formula: false, formula: "", options: {} },
    { id: "c2", table_ref: "t1", col_id: "Age", label: "Age", type: "Int", is_formula: false, formula: "", options: {} },
  ],
  rows: [
    { id: 1, table_ref: "t1", manual_sort: 1, data: { c1: "Ada", c2: 36 } },
    { id: 2, table_ref: "t1", manual_sort: 2, data: { c1: "Bob", c2: 40 } },
  ],
  pages: [{ id: "p1", name: "Main" }],
  widgets: [{ id: "w1", page_id: "p1", type: "table", title: "" }],
});

describe("diffContents", () => {
  it("finds no differences in identical versions", () => {
    expect(diffContents(base(), base()).identical).toBe(true);
  });

  it("reports added, removed and changed records and cells", () => {
    const after = base();
    after.rows[0] = { ...after.rows[0], data: { c1: "Ada", c2: 37 } };
    after.rows.splice(1, 1);
    after.rows.push({ id: 3, table_ref: "t1", manual_sort: 3, data: { c1: "Cy" } });
    const d = diffContents(base(), after);
    const t = d.tables[0];
    expect([t.status, t.rowsAdded, t.rowsRemoved, t.rowsChanged]).toEqual(["changed", 1, 1, 1]);
    expect(t.cells).toEqual([{ rowId: 1, column: "Age", before: 36, after: 37 }]);
  });

  it("reports column changes and new tables and pages", () => {
    const after = base();
    after.columns[1] = { ...after.columns[1], type: "Numeric", is_formula: true, formula: "$x" };
    after.columns.push({ id: "c3", table_ref: "t1", col_id: "Email", label: "Email", type: "Text", is_formula: false, formula: "", options: {} });
    after.tables.push({ id: "t2", table_id: "Orders", position: 2 });
    after.pages.push({ id: "p2", name: "Orders" });
    const d = diffContents(base(), after);
    const people = d.tables.find((t) => t.name === "People")!;
    expect(people.columnsAdded).toEqual(["Email"]);
    expect(people.columnsChanged[0].what).toEqual(["type Int → Numeric", "now a formula"]);
    expect(d.tables.find((t) => t.name === "Orders")!.status).toBe("added");
    expect(d.pagesAdded).toEqual(["Orders"]);
  });

  it("matches a copy and its original by name and position", () => {
    const copy = base();
    copy.tables = [{ id: "x1", table_id: "People", position: 1 }];
    copy.columns = copy.columns.map((c) => ({ ...c, id: c.id === "c1" ? "y1" : "y2", table_ref: "x1" }));
    copy.rows = [
      { id: 10, table_ref: "x1", manual_sort: 1, data: { y1: "Ada", y2: 36 } },
      { id: 11, table_ref: "x1", manual_sort: 2, data: { y1: "Robert", y2: 40 } },
    ];
    copy.pages = [{ id: "q1", name: "Main" }];
    copy.widgets = [{ id: "v1", page_id: "q1", type: "table", title: "" }];
    const d = diffContents(base(), copy, { byName: true });
    expect(d.tables[0].rowsChanged).toBe(1);
    expect(d.tables[0].cells).toEqual([{ rowId: 11, column: "Name", before: "Bob", after: "Robert" }]);
    expect(d.widgetsAdded + d.widgetsRemoved + d.pagesAdded.length).toBe(0);
  });

  it("shows values briefly", () => {
    expect([showValue(null), showValue([1, 2]), showValue(true), showValue("x".repeat(80)).length]).toEqual(["(empty)", "1, 2", "✓", 58]);
  });
});
