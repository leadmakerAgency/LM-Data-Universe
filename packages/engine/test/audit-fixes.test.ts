// Regression tests for engine fixes: Python-style chained comparisons, slice
// steps, list methods, % formatting, TEXT() formats, empty-reference lookups
// and column renames that follow references across tables.
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine";
import { DependencyAnalyzer } from "../src/deps";
import { renameColumnRefs } from "../src/rename";
import { FormulaError, RecordRef, RecordSet } from "../src/values";
import { col, fixture } from "./fixture";

const show = (v: unknown): unknown =>
  v instanceof FormulaError
    ? v.code
    : v instanceof RecordRef
      ? `Ref(${v.rowId})`
      : v instanceof RecordSet
        ? `Set(${v.ids.join(",")})`
        : v instanceof Date
          ? v.toISOString().slice(0, 10)
          : Array.isArray(v)
            ? v.map(show)
            : v;

describe("python semantics", () => {
  const data = fixture([col("oTags", "to", "Tags", "ChoiceList")]);
  data.rows.get("to")!.get(10)!.data.oTags = ["a", "b"];
  data.rows.get("to")!.get(12)!.data.oCust = null;
  const e = new Engine(data);
  const run = (f: string, table = "to", row = 10) => show(e.evaluate(f, table, row));

  it.each([
    ["chain true", "1 < 2 < 3", true],
    ["chain descending", "3 > 2 > 1", true],
    ["chain false", "1 < 3 < 2", false],
    ["chain with a column", "50 <= $Amount < 100", true],
    ["chain mixed operators", "1 < 2 <= 2 < 3", true],
    ["equality is not chained", "(1 == 1) == True", true],
    ["slice step", "[1, 2, 3, 4, 5][::2]", [1, 3, 5]],
    ["slice reversed", "'abc'[::-1]", "cba"],
    ["slice start stop step", "list(range(10))[1:8:3]", [1, 4, 7]],
    ["list repeat", "[1, 2] * 2", [1, 2, 1, 2]],
    ["percent format", "'%s has %d (%.1f%%)' % ('Ada', 3, 12.345)", "Ada has 3 (12.3%)"],
    ["percent format single", "'%05.1f' % 3.14159", "003.1"],
    ["modulo still works", "10 % 3", 1],
    ["len of dict", "len({'a': 1, 'b': 2})", 2],
    ["len of empty dict", "len({})", 0],
    ["append in a loop", "out = []\nfor r in Orders.all:\n  if r.Amount > 20:\n    out.append(r.Amount)\nout", [80, 40]],
    ["extend, pop, sort", "x = [3, 1]\nx.extend([2])\nx.sort()\nlast = x.pop()\n[x, last]", [[1, 2], 3]],
    ["python map order", "list(map(lambda x: x * 2, [1, 2]))", [2, 4]],
    ["python filter order", "list(filter(lambda x: x > 1, [1, 2, 3]))", [2, 3]],
    ["excel map order", "MAP([1, 2], lambda x: x + 1)", [2, 3]],
    ["TEXT number", "TEXT(1234.5, '#,##0.00')", "1,234.50"],
    ["TEXT percent", "TEXT(0.256, '0.0%')", "25.6%"],
    ["TEXT padded", "TEXT(7, '000')", "007"],
    ["TEXT currency negative", "TEXT(-1234.567, '$#,##0.00')", "$-1,234.57"],
    ["TEXT date", "TEXT($Date, 'd mmm yyyy')", "31 Jan 2026"],
    ["TEXT date iso", "TEXT($Date, 'yyyy-mm-dd')", "2026-01-31"],
    ["TEXT without a format", "TEXT(12)", "12"],
    ["empty reference matches None", "Orders.lookupRecords(Customer=None)", "Set(12)"],
    ["empty reference matches 0", "Orders.lookupRecords(Customer=0)", "Set(12)"],
    ["try is refused clearly", "try:\n  1 / 0\nexcept:\n  0", "#SyntaxError"],
    ["import is refused clearly", "import math\nmath.floor(2.5)", "#SyntaxError"],
    ["indented program", "  x = $Amount\n  if x > 50:\n    return 'hi'\n  return 'lo'", "hi"],
  ])("%s", (_name, formula, expected) => {
    expect(run(formula)).toEqual(expected);
  });

  it("names what isn't supported", () => {
    const v = e.evaluate("try:\n  1\nexcept:\n  0", "to", 10) as FormulaError;
    expect(v.message).toContain('"try" isn\'t supported');
  });

  it("list methods never change the stored cell", () => {
    expect(run("t = $Tags\nt.append('c')\nlen(t)")).toBe(3);
    expect(run("$Tags.append('z')\nlen($Tags)")).toBe(2);
    expect(data.rows.get("to")!.get(10)!.data.oTags).toEqual(["a", "b"]);
  });
});

describe("renaming a column", () => {
  const data = fixture([col("cAmount", "tc", "Amount", "Numeric")]);
  const analyzer = new DependencyAnalyzer({ tables: [...data.tables.values()], columns: [...data.columns.values()] });
  const amount = data.columns.get("oAmt")!; // Orders.Amount
  const name = data.columns.get("cName")!; // Customers.Name
  const rename = (formula: string, table: string, target = amount, to = "Price") => renameColumnRefs(formula, table, target, to, analyzer);

  it.each([
    ["own table", "$Amount * 2 + $Amount", "to", "$Price * 2 + $Price"],
    ["leaves longer names", "$AmountDue + $Amount", "to", "$AmountDue + $Price"],
    ["rec.", "rec.Amount + 1", "to", "rec.Price + 1"],
    ["leading equals sign", "= $Amount", "to", "= $Price"],
    ["leading return", "return $Amount", "to", "return $Price"],
    ["lookup from another table", "SUM(Orders.lookupRecords(Customer=$id).Amount)", "tc", "SUM(Orders.lookupRecords(Customer=$id).Price)"],
    ["lookup key", "Orders.lookupOne(Amount=$Amount)", "tc", "Orders.lookupOne(Price=$Amount)"],
    ["lookup key and own column", "Orders.lookupOne(Amount=$Amount)", "to", "Orders.lookupOne(Price=$Price)"],
    ["sort_by text", 'Orders.lookupRecords(Customer=$id, sort_by="-Amount")', "tc", 'Orders.lookupRecords(Customer=$id, sort_by="-Price")'],
    ["order_by", "PREVIOUS(rec, order_by='Amount').Amount", "to", "PREVIOUS(rec, order_by='Price').Price"],
    ["comprehension", "[r.Amount for r in Orders.all if r.Amount > 1]", "tc", "[r.Price for r in Orders.all if r.Price > 1]"],
    ["multi-line", "total = 0\nfor r in Orders.all:\n  total += r.Amount\ntotal", "tc", "total = 0\nfor r in Orders.all:\n  total += r.Price\ntotal"],
    ["same name in another table is kept", "$Amount + SUM(Orders.all.Amount)", "tc", "$Amount + SUM(Orders.all.Price)"],
    ["text is kept", '"$Amount" & $Amount', "to", '"$Amount" & $Price'],
    ["unrelated formula", "$Customer.Name", "to", "$Customer.Name"],
  ])("%s", (_n, formula, table, expected) => {
    expect(rename(formula, table)).toBe(expected);
  });

  it("follows references into the renamed column's table", () => {
    expect(rename("$Customer.Name.upper()", "to", name, "FullName")).toBe("$Customer.FullName.upper()");
    expect(rename("$Name", "to", name, "FullName")).toBe("$Name");
  });

  it("falls back to $Old for formulas that don't parse", () => {
    expect(rename("$Amount +", "to")).toBe("$Price +");
    expect(rename("$Amount +", "tc")).toBe("$Amount +");
  });
});
