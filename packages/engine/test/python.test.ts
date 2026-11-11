// Phase 1: multi-line formulas, comprehensions, f-strings, sorted lookups,
// PREVIOUS/NEXT/RANK, the user object and the larger function library.
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine";
import { DependencyAnalyzer } from "../src/deps";
import { FUNCTION_NAMES } from "../src/functions";
import { FormulaError, RecordRef, RecordSet } from "../src/values";
import { fixture } from "./fixture";

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

describe("multi-line formulas", () => {
  const data = fixture();
  const e = new Engine(data, { user: { Email: "ada@example.com", Name: "Ada", UserID: "u1", Access: "owner" } });
  const run = (f: string, table = "to", row = 10) => show(e.evaluate(f, table, row));

  it.each([
    ["locals and return", "x = $Amount * 2\nreturn x + 1", 161],
    ["final expression is returned", "x = $Amount\nx / 4", 20],
    ["if / elif / else", 'if $Amount > 100:\n  return "big"\nelif $Amount > 50:\n  return "mid"\nelse:\n  return "small"', "mid"],
    ["inline if body", 'if $Amount > 50: return "yes"\nreturn "no"', "yes"],
    ["for loop with +=", "total = 0\nfor o in Orders.all:\n  total += o.Amount\nreturn total", 135],
    ["break in loop", "n = 0\nfor i in range(10):\n  if i == 3:\n    break\n  n += 1\nreturn n", 3],
    ["tuple unpacking", "a, b = [1, 2]\nreturn a * 10 + b", 12],
    ["comment lines and blank lines", "# leading comment\n\nx = 1  # trailing\n\nreturn x", 1],
    ["no return gives None", "x = 1\ny = 2", null],
    ["indented whole formula", "    x = 2\n    return x * 3", 6],
  ])("%s", (_n, f, want) => {
    expect(run(f)).toEqual(want);
  });

  it.each([
    ["list comprehension", "[o.Amount for o in Orders.all if o.Amount > 20]", [80, 40]],
    ["generator in a call", "sum(o.Amount for o in Orders.all)", 135],
    ["comprehension keeps records", "[o for o in Orders.all if o.Amount < 50]", "Set(11,12)"],
    ["lambda with sorted key", "[o.Amount for o in sorted(Orders.all, key=lambda o: o.Amount)]", [15, 40, 80]],
    ["sorted reverse", "sorted([3, 1, 2], reverse=True)", [3, 2, 1]],
    ["f-string", 'f"{$Customer.Name} owes {$Amount:,.2f}"', "Ada owes 80.00"],
    ["f-string percent and width", 'f"{0.256:.1%}|{7:03d}|{\'x\':>3}"', "25.6%|007|  x"],
    ["str.format", '"{} and {name}".format(1, name="two")', "1 and two"],
    ["tuple", "(1, 2)[1]", 2],
    ["slice", '"hello"[1:3]', "el"],
    ["dict get", '{"a": 1}.get("a")', 1],
    ["lookupRecords sort_by", "Orders.lookupRecords(Customer=$Customer, sort_by=\"Amount\").Amount", [40, 80]],
    ["lookupOne order_by desc", 'Orders.lookupOne(Customer=$Customer, order_by="-Amount").Amount', 80],
    ["PREVIOUS by date", 'PREVIOUS(rec, group_by="Customer", order_by="Date")', "Ref(0)"],
    ["NEXT by date", 'NEXT(rec, group_by="Customer", order_by="Date")', "Ref(11)"],
    ["RANK", 'RANK(rec, order_by="Amount", order="desc")', 1],
    ["VLOOKUP", 'VLOOKUP(Customers, Name="Bob")', "Ref(2)"],
    ["user object", "user.Email", "ada@example.com"],
    ["date methods", '$Date.strftime("%d %b %Y")', "31 Jan 2026"],
    ["string methods", '", ".join(["a", "b"]).upper()', "A, B"],
  ])("%s", (_n, f, want) => {
    expect(run(f)).toEqual(want);
  });

  it.each([
    ["SUMIFS", 'SUMIFS(Orders.all.Amount, Orders.all.Amount, ">20")', 120],
    ["COUNTIF with criteria", 'COUNTIF([1, 5, 10], ">=5")', 2],
    ["AVERAGEIF", 'AVERAGEIF([1, 5, 10], ">1")', 7.5],
    ["REGEXEXTRACT", 'REGEXEXTRACT("Order #1234", r"#(\\d+)")', "1234"],
    ["REGEXMATCH", 'REGEXMATCH("abc", "^a")', true],
    ["REGEXREPLACE", 'REGEXREPLACE("a-b-c", "-", "+")', "a+b+c"],
    ["SUMPRODUCT", "SUMPRODUCT([1, 2], [3, 4])", 11],
    ["STDEV", "ROUND(STDEV([2, 4, 4, 4, 5, 5, 7, 9]), 3)", 2.138],
    ["PERCENTILE", "PERCENTILE([1, 2, 3, 4], 0.5)", 2.5],
    ["NETWORKDAYS", "NETWORKDAYS(DATE(2026,11,2), DATE(2026,11,13))", 10],
    ["WORKDAY", "WORKDAY(DATE(2026,11,6), 1)", "2026-11-09"],
    ["ISOWEEKNUM", "ISOWEEKNUM(DATE(2026,1,1))", 1],
    ["TEXTJOIN", 'TEXTJOIN("-", True, "a", "", "b")', "a-b"],
    ["IFS", 'IFS(False, 1, True, 2)', 2],
    ["ISERROR is lazy", "ISERROR(1/0)", true],
    ["any / all", "any([0, 1]) and not all([0, 1])", true],
    ["zip / enumerate", "[a + b for a, b in zip([1, 2], [10, 20])]", [11, 22]],
  ])("%s", (_n, f, want) => {
    expect(run(f)).toEqual(want);
  });

  it("has at least 150 functions", () => {
    expect(FUNCTION_NAMES.length).toBeGreaterThanOrEqual(150);
  });

  it("reports syntax errors in programs", () => {
    expect(run("if $Amount > 1\n  return 1")).toBe("#SyntaxError");
    expect(run("x = \nreturn 1")).toBe("#SyntaxError");
  });

  it("keeps single-line formulas that span lines", () => {
    expect(run("$Amount +\n 1")).toBe(81);
    expect(run("IF($Amount > 1,\n  1,\n  2)")).toBe(1);
  });
});

describe("dependencies of new syntax", () => {
  const data = fixture();
  const a = new DependencyAnalyzer({ tables: data.tables.values(), columns: data.columns.values() });
  const deps = (formula: string, table = "to") => {
    const d = a.analyze({ table_ref: table, formula });
    return { cols: [...d.cols].sort(), tables: [...d.tables].sort(), dynamic: d.dynamic };
  };

  it("tracks locals holding records", () => {
    expect(deps("c = $Customer\nreturn c.Name")).toEqual({ cols: ["cName", "oCust"], tables: ["tc"], dynamic: false });
  });

  it("tracks comprehension variables", () => {
    expect(deps("[o.Amount for o in Orders.all]")).toEqual({ cols: ["oAmt"], tables: ["to"], dynamic: false });
  });

  it("tracks PREVIOUS group and order columns", () => {
    expect(deps('PREVIOUS(rec, group_by="Customer", order_by="-Date").Amount')).toEqual({
      cols: ["oAmt", "oCust", "oDate"],
      tables: ["to"],
      dynamic: false,
    });
  });

  it("tracks sort_by on lookups", () => {
    expect(deps('Orders.lookupOne(Customer=$id, sort_by="Date").Amount', "tc")).toEqual({
      cols: ["oAmt", "oCust", "oDate"],
      tables: ["to"],
      dynamic: false,
    });
  });
});
