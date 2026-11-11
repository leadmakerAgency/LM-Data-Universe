import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine";
import { FormulaError, RecordRef } from "../src/values";
import { fixture } from "./fixture";

const show = (v: unknown) =>
  v instanceof FormulaError ? v.code : v instanceof RecordRef ? `Ref(${v.rowId})` : v instanceof Date ? v.toISOString().slice(0, 10) : v;

describe("Engine", () => {
  const data = fixture();
  const e = new Engine(data);
  const cell = (colId: string, rowId: number) => show(e.safeValue(data.columns.get(colId)!, rowId));

  it.each([
    ["lookup + SUM", "cTotal", 1, 120],
    ["lookup + len", "cCount", 1, 2],
    ["formula reading a formula", "cBig", 1, "big"],
    ["formula reading a formula (other row)", "cBig", 2, "small"],
    ["reference + string method", "oName", 10, "ADA"],
    ["date function", "oNext", 10, "2026-03-02"],
    ["circular reference", "oCirc", 10, "#CIRCULAR"],
    ["division by zero", "oErr", 10, "#DIV/0!"],
    ["IF, ROUND and &", "oIf", 10, "high / 96"],
  ])("%s", (_name, colId, rowId, want) => {
    expect(cell(colId, rowId)).toEqual(want);
  });

  it.each([
    ["SUM([1,2,3]) * 2 if not False else 0", 12],
    ["$Amount +", "#SyntaxError"],
    ["$Nope", "#NAME?"],
    ['SWITCH("b", "a", 1, "b", 2, 0)', 2],
    ['"x" in ["x", "y"]', true],
    ["DAYS(DATE(2026,3,1), $Date)", 29],
  ])("evaluates %s", (formula, want) => {
    expect(show(e.evaluate(formula, "to", 10))).toEqual(want);
  });
});

describe("Engine with server values (documents with access rules)", () => {
  it("shows the server's formula value, its errors, and computes locally when there is none", () => {
    const data = fixture();
    // The browser only has some orders: a local SUM would be wrong.
    data.rows.get("to")!.delete(11);
    data.rows.get("tc")!.get(1)!.computed = { cTotal: 120, cBig: { error: "#DIV/0!", message: "Division by zero" } };
    const e = new Engine(data, { serverValues: true });
    const cell = (colId: string, rowId: number) => show(e.safeValue(data.columns.get(colId)!, rowId));
    expect(cell("cTotal", 1)).toBe(120);
    expect(cell("cBig", 1)).toBe("#DIV/0!");
    expect(cell("cCount", 1)).toBe(1); // no server value yet: computed from what's loaded
    expect(show(new Engine(data).safeValue(data.columns.get("cTotal")!, 1))).toBe(80);
  });
});
