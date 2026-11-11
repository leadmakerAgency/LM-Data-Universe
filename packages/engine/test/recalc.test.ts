import { describe, expect, it } from "vitest";
import { DependencyAnalyzer, affectedFormulas } from "../src/deps";
import { changeSetFromActions, encodeValue, recompute } from "../src/recalc";
import { FormulaError, RecordRef, RecordSet } from "../src/values";
import { col, fixture } from "./fixture";

const schemaOf = (d: ReturnType<typeof fixture>) => ({ tables: d.tables.values(), columns: d.columns.values() });

describe("dependency analysis", () => {
  const data = fixture();
  const a = new DependencyAnalyzer(schemaOf(data));
  const deps = (id: string) => {
    const d = a.analyze(data.columns.get(id)!);
    return { cols: [...d.cols].sort(), tables: [...d.tables].sort(), dynamic: d.dynamic };
  };

  it("lookups depend on the looked-up table, its key and the read column", () => {
    expect(deps("cTotal")).toEqual({ cols: ["oAmt", "oCust"], tables: ["to"], dynamic: false });
  });
  it("following a reference depends on the ref column, the target column and target rows", () => {
    expect(deps("oName")).toEqual({ cols: ["cName", "oCust"], tables: ["tc"], dynamic: false });
  });
  it("plain column references", () => {
    expect(deps("cBig")).toEqual({ cols: ["cTotal"], tables: [], dynamic: false });
  });
  it("attributes of an untyped value make the formula dynamic", () => {
    const d = a.analyze({ table_ref: "to", formula: "$CustName.Name" });
    expect(d.dynamic).toBe(true);
  });
  it("syntax errors depend on nothing", () => {
    expect(a.analyze({ table_ref: "to", formula: "$Amount +" }).cols.size).toBe(0);
  });
});

describe("affected formulas", () => {
  const data = fixture();
  const affected = (change: { cols?: string[]; tables?: string[]; all?: boolean }) =>
    [...affectedFormulas(schemaOf(data), { cols: new Set(change.cols), tables: new Set(change.tables), all: !!change.all })].sort();

  it("an amount edit reaches totals, and formulas reading totals", () => {
    expect(affected({ cols: ["oAmt"] })).toEqual(["cBig", "cTotal", "oErr", "oIf"]);
  });
  it("a customer name edit only reaches CustName", () => {
    expect(affected({ cols: ["cName"] })).toEqual(["oName"]);
  });
  it("new orders recompute order formulas and customer lookups", () => {
    expect(affected({ tables: ["to"] })).toEqual(["cBig", "cCount", "cTotal", "oCirc", "oCirc2", "oErr", "oIf", "oName", "oNext"]);
  });
  it("schema changes recompute everything", () => {
    expect(affected({ all: true })).toHaveLength(9);
  });
});

describe("changeSetFromActions", () => {
  it("collects edited columns and tables with added/removed rows", () => {
    const c = changeSetFromActions([
      [{ op: "UpdateRecords", table: "to", records: [{ values: { oAmt: 5 } }] }],
      [{ op: "RemoveRecords", table: "tc" }],
      [{ op: "Update", entity: "widget" }],
    ]);
    expect([...c.cols]).toEqual(["oAmt"]);
    expect([...c.tables]).toEqual(["tc"]);
    expect(c.all).toBe(false);
  });
  it("treats column changes and unknown ops as schema changes", () => {
    expect(changeSetFromActions([[{ op: "Update", entity: "column" }]]).all).toBe(true);
    expect(changeSetFromActions([[{ op: "Mystery" }]]).all).toBe(true);
  });
});

describe("encodeValue", () => {
  it("stores values in the same shapes as data", () => {
    expect(encodeValue({ type: "Date" }, new Date("2026-03-02T00:00:00Z"))).toBe("2026-03-02");
    expect(encodeValue({ type: "DateTime" }, new Date("2026-03-02T10:00:00Z"))).toBe("2026-03-02T10:00:00.000Z");
    expect(encodeValue({ type: "Ref" }, new RecordRef("t", 5))).toBe(5);
    expect(encodeValue({ type: "Ref" }, new RecordRef("t", 0))).toBeNull();
    expect(encodeValue({ type: "RefList" }, new RecordSet("t", [1, 2]))).toEqual([1, 2]);
    expect(encodeValue({ type: "Any" }, new FormulaError("#DIV/0!", "Division by zero"))).toEqual({ error: "#DIV/0!", message: "Division by zero" });
    expect(encodeValue({ type: "Numeric" }, Infinity)).toMatchObject({ error: "#NUM!" });
  });
});

describe("recompute", () => {
  it("fills computed values from scratch", () => {
    const data = fixture();
    const { updates } = recompute(data, new Map(), { cols: new Set(), tables: new Set(), all: true });
    const ada = updates.find((u) => u.id === 1)!.computed;
    expect(ada).toMatchObject({ cTotal: 120, cCount: 2, cBig: "big" });
    expect(updates.find((u) => u.id === 10)!.computed).toMatchObject({ oName: "ADA", oNext: "2026-03-02", oErr: { error: "#DIV/0!" } });
  });

  it("after an edit, writes only rows whose values changed", () => {
    const data = fixture();
    const first = recompute(data, new Map(), { cols: new Set(), tables: new Set(), all: true });
    const current = new Map(first.updates.map((u) => [u.id, u.computed as Record<string, unknown>]));
    // Bob's order goes from 15 to 200.
    data.rows.get("to")!.get(12)!.data.oAmt = 200;
    const { updates, recomputed } = recompute(data, current, { cols: new Set(["oAmt"]), tables: new Set(), all: false });
    expect(recomputed.sort()).toEqual(["cBig", "cTotal", "oErr", "oIf"]);
    expect(updates.map((u) => u.id).sort((a, b) => a - b)).toEqual([2, 12]);
    expect(updates.find((u) => u.id === 2)!.computed).toMatchObject({ cTotal: 200, cBig: "big" });
  });

  it("drops values of columns that are no longer formulas", () => {
    const data = fixture([col("cOld", "tc", "Old", "Any")]);
    const current = new Map<number, Record<string, unknown>>([[1, { cOld: 1, cTotal: 120 }]]);
    const { updates } = recompute(data, current, { cols: new Set(["cName"]), tables: new Set(), all: false });
    expect(updates.find((u) => u.id === 1)!.computed).toEqual({ cTotal: 120 });
  });
});
