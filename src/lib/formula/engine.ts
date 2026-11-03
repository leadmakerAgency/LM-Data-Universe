// Evaluates formula columns lazily, caching each cell until the document
// changes. Data columns are converted from their stored JSON into runtime
// values (dates, record references) so formulas see consistent types.
import type { CellValue, DocColumn, DocRow, DocTable } from "../types";
import { lookupFunction, stringMethod, toText } from "./functions";
import { Node, parseFormula, FormulaSyntaxError } from "./parser";
import {
  Callable,
  FormulaError,
  RecordRef,
  RecordSet,
  TableHandle,
  flatten,
  isDate,
  parseIsoDate,
  toNumber,
  truthy,
  valueKey,
} from "./values";

export interface DocData {
  tables: Map<string, DocTable>;
  columns: Map<string, DocColumn>;
  colsByTable: Map<string, DocColumn[]>;
  rows: Map<string, Map<number, DocRow>>;
}

const COMPUTING = Symbol("computing");

export class Engine {
  private cache = new Map<string, unknown>();
  private lookupIndex = new Map<string, Map<string, number[]>>();
  private tableByName = new Map<string, DocTable>();
  private colByName = new Map<string, DocColumn>();

  constructor(private data: DocData) {
    for (const t of data.tables.values()) this.tableByName.set(t.table_id, t);
    for (const c of data.columns.values()) this.colByName.set(`${c.table_ref}|${c.col_id}`, c);
  }

  /** Runtime value of a cell (formula result or converted stored value). */
  value(col: DocColumn, rowId: number): unknown {
    if (!col.is_formula) return this.convertStored(col, this.data.rows.get(col.table_ref)?.get(rowId)?.data[col.id]);
    const key = `${col.id}:${rowId}`;
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      if (v === COMPUTING) {
        throw new FormulaError("#CIRCULAR", `Circular reference in ${col.col_id}`);
      }
      if (v instanceof FormulaError) throw v;
      return v;
    }
    this.cache.set(key, COMPUTING);
    let result: unknown;
    try {
      const ast = parseFormula(col.formula);
      result = this.eval(ast, col.table_ref, rowId);
      result = this.coerceFormulaResult(col, result);
    } catch (e) {
      const err =
        e instanceof FormulaError
          ? e
          : e instanceof FormulaSyntaxError
            ? new FormulaError("#SyntaxError", e.message)
            : new FormulaError("#Error", e instanceof Error ? e.message : String(e));
      this.cache.set(key, err);
      throw err;
    }
    this.cache.set(key, result);
    return result;
  }

  /** Like value(), but returns the error object instead of throwing. */
  safeValue(col: DocColumn, rowId: number): unknown {
    try {
      return this.value(col, rowId);
    } catch (e) {
      return e instanceof FormulaError ? e : new FormulaError("#Error", String(e));
    }
  }

  /** Evaluates an ad-hoc formula against a row (used for previews). */
  evaluate(formula: string, tableRef: string, rowId: number): unknown {
    try {
      return this.eval(parseFormula(formula), tableRef, rowId);
    } catch (e) {
      if (e instanceof FormulaError) return e;
      if (e instanceof FormulaSyntaxError) return new FormulaError("#SyntaxError", e.message);
      return new FormulaError("#Error", String(e));
    }
  }

  rowIds(tableRef: string): number[] {
    const rows = this.data.rows.get(tableRef);
    if (!rows) return [];
    return [...rows.values()].sort((a, b) => a.manual_sort - b.manual_sort || a.id - b.id).map((r) => r.id);
  }

  private convertStored(col: DocColumn, raw: CellValue | undefined): unknown {
    if (raw === undefined || raw === null) {
      if (col.type === "Ref") return new RecordRef(col.options.refTable ?? "", 0);
      if (col.type === "RefList") return new RecordSet(col.options.refTable ?? "", []);
      return null;
    }
    switch (col.type) {
      case "Date":
      case "DateTime":
        return typeof raw === "string" ? (parseIsoDate(raw) ?? raw) : raw;
      case "Ref":
        return typeof raw === "number" ? new RecordRef(col.options.refTable ?? "", raw) : raw;
      case "RefList":
        return Array.isArray(raw)
          ? new RecordSet(col.options.refTable ?? "", raw.filter((x): x is number => typeof x === "number"))
          : raw;
      default:
        return raw;
    }
  }

  private coerceFormulaResult(col: DocColumn, v: unknown): unknown {
    switch (col.type) {
      case "Numeric":
      case "Int": {
        if (v === null || v === "") return null;
        const n = toNumber(v);
        return n === null ? v : col.type === "Int" ? Math.round(n) : n;
      }
      case "Bool":
        return truthy(v);
      case "Text":
        return v === null ? "" : toText(v);
      case "Date":
      case "DateTime":
        return typeof v === "string" ? (parseIsoDate(v) ?? v) : v;
      case "Ref":
        if (typeof v === "number") return new RecordRef(col.options.refTable ?? "", v);
        return v;
      default:
        return v;
    }
  }

  private column(tableRef: string, colId: string): DocColumn {
    const c = this.colByName.get(`${tableRef}|${colId}`);
    if (!c) {
      const t = this.data.tables.get(tableRef);
      throw new FormulaError("#NAME?", `${t?.table_id ?? "Table"} has no column "${colId}"`);
    }
    return c;
  }

  private recordAttr(rec: RecordRef, name: string): unknown {
    if (name === "id") return rec.rowId;
    if (!rec.rowId || !this.data.rows.get(rec.tableRef)?.has(rec.rowId)) {
      // Empty or dangling reference: every field reads as empty.
      this.column(rec.tableRef, name);
      return null;
    }
    return this.value(this.column(rec.tableRef, name), rec.rowId);
  }

  private lookup(tableRef: string, kwargs: Record<string, unknown>): number[] {
    const names = Object.keys(kwargs).sort();
    if (!names.length) return this.rowIds(tableRef);
    const cols = names.map((n) => this.column(tableRef, n));
    const indexKey = `${tableRef}|${cols.map((c) => c.id).join(",")}`;
    let index = this.lookupIndex.get(indexKey);
    if (!index) {
      index = new Map();
      for (const id of this.rowIds(tableRef)) {
        const key = cols.map((c) => valueKey(this.safeValue(c, id))).join("\u0001");
        const list = index.get(key);
        if (list) list.push(id);
        else index.set(key, [id]);
      }
      this.lookupIndex.set(indexKey, index);
    }
    const wanted = names.map((n) => valueKey(kwargs[n])).join("\u0001");
    return index.get(wanted) ?? [];
  }

  private getAttr(obj: unknown, name: string): unknown {
    if (obj instanceof RecordRef) return this.recordAttr(obj, name);
    if (obj instanceof RecordSet) {
      if (name === "id") return obj.ids;
      const col = this.column(obj.tableRef, name);
      return obj.ids.map((id) => this.value(col, id));
    }
    if (obj instanceof TableHandle) {
      const t = obj.tableRef;
      if (name === "lookupRecords") return ((_a, kw) => new RecordSet(t, this.lookup(t, kw))) as Callable;
      if (name === "lookupOne") return ((_a, kw) => new RecordRef(t, this.lookup(t, kw)[0] ?? 0)) as Callable;
      if (name === "all") return new RecordSet(t, this.rowIds(t));
      throw new FormulaError("#AttributeError", `Tables support lookupRecords, lookupOne and all, not "${name}"`);
    }
    if (typeof obj === "string") {
      const m = stringMethod(obj, name);
      if (m) return m;
    }
    if (isDate(obj)) {
      if (name === "year") return obj.getUTCFullYear();
      if (name === "month") return obj.getUTCMonth() + 1;
      if (name === "day") return obj.getUTCDate();
    }
    if (obj === null || obj === undefined) return null;
    throw new FormulaError("#AttributeError", `No attribute "${name}"`);
  }

  private eval(n: Node, tableRef: string, rowId: number): unknown {
    switch (n.t) {
      case "num":
      case "str":
      case "const":
        return n.v;
      case "col":
        if (n.name === "id") return rowId;
        return this.value(this.column(tableRef, n.name), rowId);
      case "name": {
        if (n.name === "rec") return new RecordRef(tableRef, rowId);
        const table = this.tableByName.get(n.name);
        if (table) return new TableHandle(table.id, table.table_id);
        const fn = lookupFunction(n.name);
        if (fn) return fn;
        throw new FormulaError("#NAME?", `Unknown name "${n.name}"`);
      }
      case "attr":
        return this.getAttr(this.eval(n.obj, tableRef, rowId), n.name);
      case "call": {
        // IF and IFERROR only evaluate the branch they need.
        if (n.fn.t === "name") {
          const upper = n.fn.name.toUpperCase();
          if (upper === "IF") {
            const [test, a, b] = n.args;
            if (!test) throw new FormulaError("#TypeError", "IF needs a condition");
            return truthy(this.eval(test, tableRef, rowId))
              ? a
                ? this.eval(a, tableRef, rowId)
                : true
              : b
                ? this.eval(b, tableRef, rowId)
                : false;
          }
          if (upper === "IFERROR") {
            try {
              return this.eval(n.args[0], tableRef, rowId);
            } catch (e) {
              if (e instanceof FormulaError && e.code !== "#CIRCULAR") {
                return n.args[1] ? this.eval(n.args[1], tableRef, rowId) : "";
              }
              throw e;
            }
          }
        }
        const fn = this.eval(n.fn, tableRef, rowId);
        if (typeof fn !== "function") throw new FormulaError("#TypeError", "This value cannot be called");
        const args = n.args.map((a) => this.eval(a, tableRef, rowId));
        const kwargs: Record<string, unknown> = {};
        for (const kw of n.kwargs) kwargs[kw.name] = this.eval(kw.value, tableRef, rowId);
        return (fn as Callable)(args, kwargs);
      }
      case "index": {
        const obj = this.eval(n.obj, tableRef, rowId);
        const idx = toNumber(this.eval(n.index, tableRef, rowId));
        const list = obj instanceof RecordSet ? flatten([obj]) : Array.isArray(obj) ? obj : typeof obj === "string" ? obj.split("") : null;
        if (!list || idx === null) throw new FormulaError("#TypeError", "Cannot index this value");
        const i = idx < 0 ? list.length + idx : idx;
        if (i < 0 || i >= list.length) throw new FormulaError("#IndexError", "Index out of range");
        return list[i];
      }
      case "list":
        return n.items.map((i) => this.eval(i, tableRef, rowId));
      case "un": {
        const v = toNumber(this.eval(n.arg, tableRef, rowId)) ?? 0;
        return n.op === "-" ? -v : v;
      }
      case "not":
        return !truthy(this.eval(n.arg, tableRef, rowId));
      case "and": {
        const l = this.eval(n.left, tableRef, rowId);
        return truthy(l) ? this.eval(n.right, tableRef, rowId) : l;
      }
      case "or": {
        const l = this.eval(n.left, tableRef, rowId);
        return truthy(l) ? l : this.eval(n.right, tableRef, rowId);
      }
      case "cond":
        return truthy(this.eval(n.test, tableRef, rowId))
          ? this.eval(n.then, tableRef, rowId)
          : this.eval(n.else, tableRef, rowId);
      case "cmp":
        return compare(n.op, this.eval(n.left, tableRef, rowId), this.eval(n.right, tableRef, rowId));
      case "bin":
        return binary(n.op, this.eval(n.left, tableRef, rowId), this.eval(n.right, tableRef, rowId));
    }
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof RecordRef || b instanceof RecordRef) {
    const x = a instanceof RecordRef ? a.rowId : a;
    const y = b instanceof RecordRef ? b.rowId : b;
    return (x || 0) === (y || 0);
  }
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  if ((a === null || a === "") && (b === null || b === "")) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  return a === b;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case "==":
      return equal(a, b);
    case "!=":
      return !equal(a, b);
    case "in":
    case "not in": {
      let found: boolean;
      if (typeof b === "string") found = b.includes(toText(a));
      else if (b instanceof RecordSet) found = a instanceof RecordRef ? b.ids.includes(a.rowId) : b.ids.includes(a as number);
      else if (Array.isArray(b)) found = b.some((x) => equal(x, a));
      else throw new FormulaError("#TypeError", '"in" needs a list or text on the right');
      return op === "in" ? found : !found;
    }
  }
  let x: number | string;
  let y: number | string;
  if (typeof a === "string" && typeof b === "string") {
    x = a;
    y = b;
  } else {
    const na = isDate(a) ? a.getTime() : toNumber(a);
    const nb = isDate(b) ? b.getTime() : toNumber(b);
    if (na === null || nb === null) return false;
    x = na;
    y = nb;
  }
  switch (op) {
    case "<":
      return x < y;
    case ">":
      return x > y;
    case "<=":
      return x <= y;
    case ">=":
      return x >= y;
  }
  return false;
}

function binary(op: string, a: unknown, b: unknown): unknown {
  if (op === "&") return toText(a) + toText(b);
  if (op === "+") {
    if (typeof a === "string" || typeof b === "string") return toText(a) + toText(b);
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (isDate(a) && !isDate(b)) return new Date(a.getTime() + (toNumber(b) ?? 0) * 86400000);
  }
  if (op === "-") {
    if (isDate(a) && isDate(b)) return Math.round((a.getTime() - b.getTime()) / 86400000);
    if (isDate(a)) return new Date(a.getTime() - (toNumber(b) ?? 0) * 86400000);
  }
  if (op === "*" && typeof a === "string") return a.repeat(Math.max(0, toNumber(b) ?? 0));
  const x = toNumber(a) ?? 0;
  const y = toNumber(b) ?? 0;
  if (a !== null && a !== undefined && a !== "" && toNumber(a) === null)
    throw new FormulaError("#TypeError", `Cannot do math with "${toText(a)}"`);
  if (b !== null && b !== undefined && b !== "" && toNumber(b) === null)
    throw new FormulaError("#TypeError", `Cannot do math with "${toText(b)}"`);
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      if (y === 0) throw new FormulaError("#DIV/0!", "Division by zero");
      return x / y;
    case "//":
      if (y === 0) throw new FormulaError("#DIV/0!", "Division by zero");
      return Math.floor(x / y);
    case "%":
      if (y === 0) throw new FormulaError("#DIV/0!", "Division by zero");
      return ((x % y) + y) % y;
    case "**":
      return Math.pow(x, y);
  }
  throw new FormulaError("#Error", `Unknown operator ${op}`);
}
