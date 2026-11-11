import { describe, expect, it } from "vitest";
import { AclConditionError, compileCondition, conditionColumns, conditionCompletions, printCondition, type AclSchema } from "../src/acl";
import { col, fixture } from "./fixture";

const data = fixture([col("oOwner", "to", "Owner", "Text"), col("pEmail", "tp", "Email", "Text"), col("pDept", "tp", "Dept", "Text")]);
const schema: AclSchema = {
  tables: [...data.tables.values(), { id: "tp", doc_id: "d", table_id: "People", position: 3 }],
  columns: [...data.columns.values()],
  attributes: [{ name: "Person", table_ref: "tp" }],
};
const compile = (src: string, table: string | null = "to") => compileCondition(src, schema, table);
const roundTrip = (src: string, table: string | null = "to") => printCondition(compile(src, table), schema);

describe("access rule conditions", () => {
  it("compiles user fields, record columns and comparisons", () => {
    expect(compile('user.Access != "owner" and rec.Owner == user.Email')).toEqual({
      t: "and",
      args: [
        { t: "cmp", op: "!=", l: { t: "user", f: "Access" }, r: { t: "lit", v: "owner" } },
        { t: "cmp", op: "==", l: { t: "rec", which: "rec", path: ["oOwner"] }, r: { t: "user", f: "Email" } },
      ],
    });
  });

  it("is empty for an empty condition", () => {
    expect(compile("   ")).toBeNull();
  });

  it("follows references and accepts $Col, .id and newRec", () => {
    expect(compile("rec.Customer.Name == 'Ada'")).toMatchObject({ l: { t: "rec", path: ["oCust", "cName"] } });
    expect(compile("$Amount > 10")).toMatchObject({ l: { t: "rec", which: "rec", path: ["oAmt"] } });
    expect(compile("newRec.Customer.id == 1")).toMatchObject({ l: { t: "rec", which: "newRec", path: ["oCust", "id"] } });
  });

  it("supports user attributes, lists, in, not, is None and string methods", () => {
    expect(compile("user.Person.Dept in ['A', 'B']")).toMatchObject({
      t: "cmp",
      op: "in",
      l: { t: "uattr", a: "Person", col: "pDept" },
      r: { t: "list", items: [{ t: "lit", v: "A" }, { t: "lit", v: "B" }] },
    });
    expect(compile("not rec.Owner.lower() == user.Email.lower()")).toMatchObject({ t: "not", arg: { t: "cmp", l: { t: "fn", fn: "lower" } } });
    expect(compile("rec.Owner is None")).toMatchObject({ t: "cmp", op: "==", r: { t: "lit", v: null } });
    expect(compile("rec.Amount >= -5")).toMatchObject({ r: { t: "lit", v: -5 } });
  });

  it("flattens chains of and / or", () => {
    expect(compile("user.IsLoggedIn and rec.Amount > 1 and rec.Amount < 9")).toMatchObject({ t: "and", args: [{}, {}, {}] });
  });

  it("rejects what the database can't enforce, with a clear message", () => {
    const bad: [string, string | null, RegExp][] = [
      ["rec.Owner == 1", null, /only be used in rules for a specific table/],
      ["rec.Nope == 1", "to", /no column Nope/],
      ["rec.Amount.Name == 1", "to", /isn't a Reference column/],
      ["user.Salary == 1", "to", /user\.Salary isn't known/],
      ["user.Person.Nope == 1", "to", /People has no column Nope/],
      ["len(rec.Owner) > 1", "to", /len\(\) isn't supported/],
      ["rec.Amount + 1 > 2", "to", /Conditions may use/],
      ["Orders.lookupRecords(Owner=user.Email)", "to", /isn't supported/],
      ["x = 1\nx", "to", /single expression/],
      ["rec.Owner ==", "to", /./],
    ];
    for (const [src, table, msg] of bad) {
      expect(() => compile(src, table), src).toThrow(AclConditionError);
      expect(() => compile(src, table), src).toThrow(msg);
    }
  });

  it("prints conditions back with current names", () => {
    expect(roundTrip('user.Access != "owner" and rec.Owner == user.Email')).toBe('user.Access != "owner" and rec.Owner == user.Email');
    expect(roundTrip("(user.IsLoggedIn or rec.Amount > 1) and not rec.Owner in ['a', None, True]")).toBe(
      '(user.IsLoggedIn or rec.Amount > 1) and not rec.Owner in ["a", None, True]',
    );
    expect(roundTrip("rec.Customer.Name.lower() == user.Person.Dept")).toBe("rec.Customer.Name.lower() == user.Person.Dept");
    const renamed = { ...schema, columns: [...data.columns.values()].map((c) => (c.id === "oOwner" ? { ...c, col_id: "Assignee" } : c)) };
    expect(printCondition(compile("rec.Owner == user.Email"), renamed)).toBe("rec.Assignee == user.Email");
    expect(printCondition({ t: "rec", which: "rec", path: ["gone"] }, schema)).toBe("rec.?");
  });

  it("lists the columns a condition uses", () => {
    expect(conditionColumns(compile("rec.Customer.Name == user.Person.Dept"))).toEqual(["oCust", "cName", "pDept"]);
  });

  it("completes names", () => {
    expect(conditionCompletions("user.", schema, "to").items).toEqual(["Email", "UserID", "Name", "Access", "IsLoggedIn", "Person"]);
    expect(conditionCompletions("user.Person.D", schema, "to").items).toEqual(["Dept"]);
    expect(conditionCompletions("rec.Customer.", schema, "to").items).toContain("Name");
    expect(conditionCompletions("rec.Am", schema, "to")).toEqual({ prefix: "Am", items: ["Amount"] });
    expect(conditionCompletions("re", schema, null).items).toEqual([]);
    expect(conditionCompletions("ne", schema, "to").items).toEqual(["newRec"]);
    // Not after a space or a closing quote, and not inside text.
    expect(conditionCompletions('user.Access != "owner"', schema, "to").items).toEqual([]);
    expect(conditionCompletions("rec.Owner == ", schema, "to").items).toEqual([]);
    expect(conditionCompletions('rec.Owner == "us', schema, "to").items).toEqual([]);
  });
});
