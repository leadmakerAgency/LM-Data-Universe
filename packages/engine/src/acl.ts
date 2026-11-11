// Access rule conditions. Owners write them in the formula language
// (`user.Access != "owner" and rec.Owner == user.Email`); this module turns
// that text into the condition tree the database enforces (see the
// phase3_access_rules migration), and prints a tree back as text using the
// current table and column names. Only a small, predictable subset of the
// language is allowed: anything else is rejected with a clear message rather
// than being quietly ignored.
import { parseFormula, FormulaSyntaxError, type Node } from "./parser";
import type { DocColumn, DocTable } from "./types";

export const USER_FIELDS = ["Email", "UserID", "Name", "Access", "IsLoggedIn"] as const;
export type UserField = (typeof USER_FIELDS)[number];
export type AclCmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not in";
export type AclFn = "lower" | "upper" | "strip";
const FNS: AclFn[] = ["lower", "upper", "strip"];
const CMP_OPS: AclCmpOp[] = ["==", "!=", "<", "<=", ">", ">=", "in", "not in"];

export type AclNode =
  | { t: "lit"; v: string | number | boolean | null }
  | { t: "list"; items: AclNode[] }
  | { t: "user"; f: UserField }
  | { t: "uattr"; a: string; col: string }
  | { t: "rec"; which: "rec" | "newRec"; path: string[] }
  | { t: "cmp"; op: AclCmpOp; l: AclNode; r: AclNode }
  | { t: "and" | "or"; args: AclNode[] }
  | { t: "not"; arg: AclNode }
  | { t: "fn"; fn: AclFn; arg: AclNode };

/** The `user.<name>` lookups of a document: the record of `table_ref` matching the person. */
export interface AclAttribute {
  name: string;
  table_ref: string;
}

export interface AclSchema {
  tables: readonly DocTable[];
  columns: readonly DocColumn[];
  attributes: AclAttribute[];
}

export class AclConditionError extends Error {}

interface Index {
  tables: Map<string, DocTable>;
  cols: Map<string, DocColumn>;
  byTable: Map<string, DocColumn[]>;
  attrs: Map<string, AclAttribute>;
}

function index(schema: AclSchema): Index {
  const tables = new Map<string, DocTable>();
  for (const t of schema.tables) tables.set(t.id, t);
  const cols = new Map<string, DocColumn>();
  const byTable = new Map<string, DocColumn[]>();
  for (const c of schema.columns) {
    cols.set(c.id, c);
    const list = byTable.get(c.table_ref) ?? [];
    list.push(c);
    byTable.set(c.table_ref, list);
  }
  for (const list of byTable.values()) list.sort((a, b) => a.position - b.position);
  return { tables, cols, byTable, attrs: new Map(schema.attributes.map((a) => [a.name, a])) };
}

/** `a.b.c` as ["a", "b", "c"]; `$Col` as ["rec", "Col"]; null for anything else. */
function dotted(n: Node): string[] | null {
  if (n.t === "name") return [n.name];
  if (n.t === "col") return ["rec", n.name];
  if (n.t === "attr") {
    const base = dotted(n.obj);
    return base ? [...base, n.name] : null;
  }
  return null;
}

function tableName(ix: Index, id: string) {
  return ix.tables.get(id)?.table_id ?? "the table";
}

/**
 * Compiles condition text for a rule on `tableRef` (null: a default rule for
 * every table). Empty text means "always" and gives null.
 */
export function compileCondition(src: string, schema: AclSchema, tableRef: string | null): AclNode | null {
  if (!src.trim()) return null;
  let ast: Node;
  try {
    ast = parseFormula(src);
  } catch (e) {
    throw new AclConditionError(e instanceof FormulaSyntaxError ? e.message : String(e));
  }
  if (ast.t === "block") throw new AclConditionError("A condition is a single expression, on one line");
  return convert(ast, index(schema), tableRef);
}

function convert(n: Node, ix: Index, tableRef: string | null): AclNode {
  switch (n.t) {
    case "num":
      return { t: "lit", v: n.v };
    case "str":
      return { t: "lit", v: n.v };
    case "const":
      return { t: "lit", v: n.v };
    case "un":
      if (n.op === "-" && n.arg.t === "num") return { t: "lit", v: -n.arg.v };
      break;
    case "list":
      return { t: "list", items: n.items.map((i) => convert(i, ix, tableRef)) };
    case "and":
    case "or": {
      const args: AclNode[] = [];
      for (const side of [n.left, n.right]) {
        const c = convert(side, ix, tableRef);
        if (c.t === n.t) args.push(...c.args);
        else args.push(c);
      }
      return { t: n.t, args };
    }
    case "not":
      return { t: "not", arg: convert(n.arg, ix, tableRef) };
    case "cmp": {
      if (!CMP_OPS.includes(n.op as AclCmpOp)) throw new AclConditionError(`The comparison "${n.op}" isn't supported`);
      return { t: "cmp", op: n.op as AclCmpOp, l: convert(n.left, ix, tableRef), r: convert(n.right, ix, tableRef) };
    }
    case "call": {
      if (n.fn.t === "attr" && !n.args.length && !n.kwargs.length && FNS.includes(n.fn.name as AclFn)) {
        return { t: "fn", fn: n.fn.name as AclFn, arg: convert(n.fn.obj, ix, tableRef) };
      }
      const name = n.fn.t === "attr" ? `.${n.fn.name}()` : n.fn.t === "name" ? `${n.fn.name}()` : "This call";
      throw new AclConditionError(`${name} isn't supported in conditions (only .lower(), .upper() and .strip())`);
    }
    case "name":
    case "attr":
    case "col": {
      const parts = dotted(n);
      if (parts) return reference(parts, ix, tableRef);
      break;
    }
  }
  throw new AclConditionError(
    "Conditions may use user.…, rec.…, newRec.…, text, numbers, True/False/None, lists, comparisons (== != < <= > >= in, not in), and, or, not",
  );
}

function reference(parts: string[], ix: Index, tableRef: string | null): AclNode {
  const [base, ...rest] = parts;
  if (base === "user") {
    if (!rest.length) throw new AclConditionError(`Use a field of user, e.g. user.Email (${USER_FIELDS.join(", ")})`);
    if (rest.length === 1 && (USER_FIELDS as readonly string[]).includes(rest[0])) return { t: "user", f: rest[0] as UserField };
    const attr = ix.attrs.get(rest[0]);
    if (!attr) {
      throw new AclConditionError(`user.${rest[0]} isn't known. Use ${USER_FIELDS.map((f) => `user.${f}`).join(", ")} or a user attribute.`);
    }
    if (rest.length !== 2) throw new AclConditionError(`Use a column of user.${attr.name}, e.g. user.${attr.name}.${ix.byTable.get(attr.table_ref)?.[0]?.col_id ?? "id"}`);
    if (rest[1] === "id") return { t: "uattr", a: attr.name, col: "id" };
    const col = ix.byTable.get(attr.table_ref)?.find((c) => c.col_id === rest[1]);
    if (!col) throw new AclConditionError(`${tableName(ix, attr.table_ref)} has no column ${rest[1]}`);
    return { t: "uattr", a: attr.name, col: col.id };
  }
  if (base === "rec" || base === "newRec") {
    if (!tableRef) throw new AclConditionError(`${base} can only be used in rules for a specific table`);
    if (!rest.length) throw new AclConditionError(`Use a column of ${base}, e.g. ${base}.${ix.byTable.get(tableRef)?.[0]?.col_id ?? "id"}`);
    if (rest.length > 5) throw new AclConditionError("That reference chain is too long");
    const path: string[] = [];
    let table = tableRef;
    for (let i = 0; i < rest.length; i++) {
      const name = rest[i];
      if (name === "id") {
        if (i !== rest.length - 1) throw new AclConditionError(`.id must come last`);
        path.push("id");
        break;
      }
      const col = ix.byTable.get(table)?.find((c) => c.col_id === name);
      if (!col) throw new AclConditionError(`${tableName(ix, table)} has no column ${name}`);
      path.push(col.id);
      if (i < rest.length - 1) {
        if (col.type !== "Ref" || !col.options.refTable) {
          throw new AclConditionError(`${name} isn't a Reference column, so it can't be followed with "."`);
        }
        table = col.options.refTable;
      }
    }
    return { t: "rec", which: base, path };
  }
  throw new AclConditionError(`"${parts.join(".")}" isn't known here. Conditions can use user, rec and newRec.`);
}

// ------------------------------------------------------------------
// Printing
// ------------------------------------------------------------------

const PREC: Record<string, number> = { or: 1, and: 2, not: 3, cmp: 4 };

function prec(n: AclNode) {
  return PREC[n.t] ?? 5;
}

function literal(v: string | number | boolean | null): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** Condition text for a tree, with current names; unknown columns print as `?`. */
export function printCondition(node: AclNode | null, schema: AclSchema): string {
  if (!node) return "";
  const ix = index(schema);
  const p = (n: AclNode, min: number): string => {
    const s = print(n);
    return prec(n) < min ? `(${s})` : s;
  };
  const print = (n: AclNode): string => {
    switch (n.t) {
      case "lit":
        return literal(n.v);
      case "list":
        return `[${n.items.map(print).join(", ")}]`;
      case "user":
        return `user.${n.f}`;
      case "uattr":
        return `user.${n.a}.${n.col === "id" ? "id" : (ix.cols.get(n.col)?.col_id ?? "?")}`;
      case "rec":
        return [n.which, ...n.path.map((id) => (id === "id" ? "id" : (ix.cols.get(id)?.col_id ?? "?")))].join(".");
      case "cmp":
        return `${p(n.l, 5)} ${n.op} ${p(n.r, 5)}`;
      case "and":
      case "or":
        return n.args.map((a) => p(a, PREC[n.t] + 1)).join(` ${n.t} `);
      case "not":
        return `not ${p(n.arg, 3)}`;
      case "fn":
        return `${p(n.arg, 5)}.${n.fn}()`;
    }
  };
  return print(node);
}

/** Column ids a condition refers to (to warn before a column is removed). */
export function conditionColumns(node: AclNode | null): string[] {
  const out = new Set<string>();
  const walk = (n: AclNode) => {
    switch (n.t) {
      case "rec":
        n.path.forEach((id) => id !== "id" && out.add(id));
        break;
      case "uattr":
        if (n.col !== "id") out.add(n.col);
        break;
      case "list":
        n.items.forEach(walk);
        break;
      case "cmp":
        walk(n.l);
        walk(n.r);
        break;
      case "and":
      case "or":
        n.args.forEach(walk);
        break;
      case "not":
      case "fn":
        walk(n.arg);
        break;
    }
  };
  if (node) walk(node);
  return [...out];
}

/**
 * Completions for the word being typed at the end of `before` (text up to
 * the cursor): returns the partial word and the candidates that extend it.
 */
export function conditionCompletions(before: string, schema: AclSchema, tableRef: string | null): { prefix: string; items: string[] } {
  const ix = index(schema);
  // Nothing inside quoted text, and nothing until a name is being typed.
  const quotes = (before.match(/"/g)?.length ?? 0) + (before.match(/'/g)?.length ?? 0);
  if (quotes % 2 === 1) return { prefix: "", items: [] };
  const m = /([A-Za-z_$][A-Za-z0-9_.]*)$/.exec(before);
  const word = m ? m[1] : "";
  if (!word) return { prefix: "", items: [] };
  const dot = word.lastIndexOf(".");
  const head = dot >= 0 ? word.slice(0, dot).replace(/^\$/, "rec.") : "";
  const prefix = dot >= 0 ? word.slice(dot + 1) : word;
  let items: string[] = [];
  if (dot < 0) {
    items = ["user", "and", "or", "not", "in", "True", "False", "None"];
    if (tableRef) items.unshift("rec", "newRec");
  } else {
    const parts = head.split(".");
    if (parts[0] === "user") {
      if (parts.length === 1) items = [...USER_FIELDS, ...ix.attrs.keys()];
      else if (parts.length === 2 && ix.attrs.has(parts[1])) {
        items = ["id", ...(ix.byTable.get(ix.attrs.get(parts[1])!.table_ref) ?? []).map((c) => c.col_id)];
      }
    } else if ((parts[0] === "rec" || parts[0] === "newRec") && tableRef) {
      let table: string | undefined = tableRef;
      for (const name of parts.slice(1)) {
        const col: DocColumn | undefined = ix.byTable.get(table ?? "")?.find((c) => c.col_id === name);
        table = col?.type === "Ref" ? col.options.refTable : undefined;
      }
      if (table) items = ["id", ...(ix.byTable.get(table) ?? []).map((c) => c.col_id)];
    }
  }
  return { prefix, items: items.filter((i) => i.toLowerCase().startsWith(prefix.toLowerCase()) && i !== prefix) };
}
