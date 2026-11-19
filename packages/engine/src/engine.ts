// Evaluates formula columns lazily, caching each cell until the document
// changes. Data columns are converted from their stored JSON into runtime
// values (dates, record references) so formulas see consistent types.
import type { CellValue, DocColumn, DocRow, DocTable } from "./types";
import { formatSpec, listMethod, lookupFunction, stringMethod, toText } from "./functions";
import { Node, Stmt, parseFormula, FormulaSyntaxError } from "./parser";
import {
  Callable,
  FormulaError,
  RecordRef,
  RecordSet,
  TableHandle,
  flatten,
  isDate,
  isEmptyValue,
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
  /** The document's time zone (IANA name) for TODAY(); local time when unset. */
  timezone?: string | null;
}

/** The person a formula runs for (trigger formulas, access rules). */
export interface FormulaUser {
  Email: string;
  Name: string;
  UserID: string;
  Access: string | null;
}

export interface EngineOptions {
  user?: FormulaUser | null;
  /**
   * Show the server's formula values (DocRow.computed) where it has them.
   * Used in documents with access rules: the browser only has the records it
   * may read, so computing formulas locally could give wrong answers.
   */
  serverValues?: boolean;
  /** Time zone for TODAY(); defaults to DocData.timezone. */
  timezone?: string | null;
}

const COMPUTING = Symbol("computing");

/** Where an expression is evaluated: the record, plus local variables of a multi-line formula. */
interface Ctx {
  table: string;
  row: number;
  scope: Map<string, unknown> | null;
}

class ReturnSignal {
  constructor(public value: unknown) {}
}
const BREAK = Symbol("break");
const CONTINUE = Symbol("continue");
const MAX_LOOP = 100_000;

/** Column names in group_by / order_by arguments: "Col", "-Col", or a list of them. */
function colNames(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v.flatMap(colNames);
  return [toText(v)];
}

export class Engine {
  private cache = new Map<string, unknown>();
  private lookupIndex = new Map<string, Map<string, number[]>>();
  private tableByName = new Map<string, DocTable>();
  private colByName = new Map<string, DocColumn>();

  private user: FormulaUser | null;
  private serverValues: boolean;
  private timezone: string | null;

  constructor(private data: DocData, opts: EngineOptions = {}) {
    this.user = opts.user ?? null;
    this.serverValues = !!opts.serverValues;
    this.timezone = opts.timezone ?? data.timezone ?? null;
    for (const t of data.tables.values()) this.tableByName.set(t.table_id, t);
    for (const c of data.columns.values()) this.colByName.set(`${c.table_ref}|${c.col_id}`, c);
  }

  /** Runtime value of a cell (formula result or converted stored value). */
  value(col: DocColumn, rowId: number): unknown {
    if (!col.is_formula) return this.convertStored(col, this.data.rows.get(col.table_ref)?.get(rowId)?.data[col.id]);
    if (this.serverValues) {
      const computed = this.data.rows.get(col.table_ref)?.get(rowId)?.computed;
      if (computed && Object.prototype.hasOwnProperty.call(computed, col.id)) {
        const v = computed[col.id];
        if (v && typeof v === "object" && !Array.isArray(v) && "error" in v) {
          const e = v as { error: unknown; message?: unknown };
          throw new FormulaError(String(e.error), String(e.message ?? ""));
        }
        return this.convertStored(col, v as CellValue);
      }
    }
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
      result = this.run(ast, { table: col.table_ref, row: rowId, scope: null });
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
      return this.run(parseFormula(formula), { table: tableRef, row: rowId, scope: null });
    } catch (e) {
      if (e instanceof FormulaError) return e;
      if (e instanceof FormulaSyntaxError) return new FormulaError("#SyntaxError", e.message);
      return new FormulaError("#Error", String(e));
    }
  }

  /** Evaluates a formula with extra names bound (e.g. `choice` in dropdown conditions). */
  evaluateWith(formula: string, tableRef: string, rowId: number, vars: Record<string, unknown>): unknown {
    try {
      return this.run(parseFormula(formula), { table: tableRef, row: rowId, scope: new Map(Object.entries(vars)) });
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
    return fresh(this.value(this.column(rec.tableRef, name), rec.rowId));
  }

  /** Rows matching field=value pairs, optionally sorted (sort_by / order_by: "Col", "-Col" or a list). */
  private lookupSorted(tableRef: string, kwargs: Record<string, unknown>): number[] {
    const { sort_by, order_by, ...match } = kwargs;
    const ids = this.lookup(tableRef, match);
    const order = colNames(order_by ?? sort_by);
    return order.length ? this.sortIds(tableRef, ids, order) : ids;
  }

  private sortIds(tableRef: string, ids: number[], order: string[]): number[] {
    const keys = order.map((name) => {
      const desc = name.startsWith("-");
      const colName = desc ? name.slice(1) : name;
      return { col: colName === "id" ? null : this.column(tableRef, colName), desc };
    });
    const pos = new Map(this.rowIds(tableRef).map((id, i) => [id, i]));
    return [...ids].sort((a, b) => {
      for (const k of keys) {
        const va = k.col ? this.safeValue(k.col, a) : a;
        const vb = k.col ? this.safeValue(k.col, b) : b;
        const c = sortCompare(va, vb);
        if (c) return k.desc ? -c : c;
      }
      return (pos.get(a) ?? 0) - (pos.get(b) ?? 0);
    });
  }

  /** Rows of rec's table sharing its group_by values, in order_by order (default: row order). */
  private groupRows(rec: RecordRef, groupBy: unknown, orderBy: unknown): number[] {
    const t = rec.tableRef;
    const groups = colNames(groupBy).map((n) => this.column(t, n));
    let ids = this.rowIds(t);
    if (groups.length) {
      const want = groups.map((c) => valueKey(this.safeValue(c, rec.rowId))).join("\u0001");
      ids = ids.filter((id) => groups.map((c) => valueKey(this.safeValue(c, id))).join("\u0001") === want);
    }
    const order = colNames(orderBy);
    return order.length ? this.sortIds(t, ids, order) : ids;
  }

  private recordArg(v: unknown, fn: string): RecordRef {
    if (v instanceof RecordRef && v.rowId) return v;
    throw new FormulaError("#TypeError", `${fn} needs a record, e.g. ${fn}(rec)`);
  }

  /** Functions that need the document: PREVIOUS, NEXT, RANK, VLOOKUP, PEEK. */
  private docFunction(name: string): Callable | null {
    switch (name) {
      case "PREVIOUS":
      case "NEXT":
        return ([r], kw) => {
          const rec = this.recordArg(r, name);
          const ids = this.groupRows(rec, kw.group_by, kw.order_by);
          const i = ids.indexOf(rec.rowId);
          const j = name === "PREVIOUS" ? i - 1 : i + 1;
          return new RecordRef(rec.tableRef, i >= 0 && j >= 0 && j < ids.length ? ids[j] : 0);
        };
      case "RANK":
        return ([r], kw) => {
          const rec = this.recordArg(r, name);
          let ids = this.groupRows(rec, kw.group_by, kw.order_by);
          if (toText(kw.order ?? "asc").toLowerCase().startsWith("desc")) ids = ids.reverse();
          return ids.indexOf(rec.rowId) + 1;
        };
      case "VLOOKUP":
        return ([table, ...rest], kw) => {
          if (!(table instanceof TableHandle)) throw new FormulaError("#TypeError", "VLOOKUP needs a table, e.g. VLOOKUP(People, Email=$Email)");
          if (rest.length) throw new FormulaError("#TypeError", "VLOOKUP takes field=value pairs after the table");
          return new RecordRef(table.tableRef, this.lookupSorted(table.tableRef, kw)[0] ?? 0);
        };
      case "PEEK":
        return ([v]) => v;
    }
    return null;
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
    // An empty reference holds no record: Customer=None and Customer=0 both find it.
    const wanted = names
      .map((n, i) => (cols[i].type === "Ref" && kwargs[n] === 0 ? valueKey(null) : valueKey(kwargs[n])))
      .join("\u0001");
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
      if (name === "lookupRecords") return ((_a, kw) => new RecordSet(t, this.lookupSorted(t, kw))) as Callable;
      if (name === "lookupOne") return ((_a, kw) => new RecordRef(t, this.lookupSorted(t, kw)[0] ?? 0)) as Callable;
      if (name === "all") return new RecordSet(t, this.rowIds(t));
      throw new FormulaError("#AttributeError", `Tables support lookupRecords, lookupOne and all, not "${name}"`);
    }
    if (obj instanceof UserInfo) {
      if (name in obj.fields) return obj.fields[name];
      throw new FormulaError("#AttributeError", `user has Email, Name, UserID and Access, not "${name}"`);
    }
    if (typeof obj === "string") {
      const m = stringMethod(obj, name);
      if (m) return m;
    }
    if (Array.isArray(obj)) {
      const m = listMethod(obj, name);
      if (m) return m;
    }
    if (obj instanceof Map) {
      if (name === "get") return (([k, d]) => (obj.has(valueKey(k)) ? (obj.get(valueKey(k)) as [unknown, unknown])[1] : (d ?? null))) as Callable;
      if (name === "keys") return () => [...obj.values()].map((e) => (e as [unknown, unknown])[0]);
      if (name === "values") return () => [...obj.values()].map((e) => (e as [unknown, unknown])[1]);
      if (name === "items") return () => [...obj.values()].map((e) => [...(e as [unknown, unknown])]);
    }
    if (isDate(obj)) {
      switch (name) {
        case "year":
          return obj.getUTCFullYear();
        case "month":
          return obj.getUTCMonth() + 1;
        case "day":
          return obj.getUTCDate();
        case "hour":
          return obj.getUTCHours();
        case "minute":
          return obj.getUTCMinutes();
        case "second":
          return obj.getUTCSeconds();
        case "weekday":
          return () => (obj.getUTCDay() + 6) % 7;
        case "isoweekday":
          return () => obj.getUTCDay() || 7;
        case "isoformat":
          return () => toText(obj).replace(" ", "T");
        case "date":
          return () => new Date(Date.UTC(obj.getUTCFullYear(), obj.getUTCMonth(), obj.getUTCDate()));
        case "strftime":
          return (([fmt]) => strftime(obj, toText(fmt))) as Callable;
      }
    }
    if (obj === null || obj === undefined) return null;
    throw new FormulaError("#AttributeError", `No attribute "${name}"`);
  }

  /** Runs a parsed formula: an expression, or a multi-line program. */
  private run(n: Node, c: Ctx): unknown {
    if (n.t !== "block") return this.eval(n, c);
    const ctx: Ctx = { ...c, scope: new Map(c.scope ?? []) };
    try {
      this.exec(n.body, ctx);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return null;
  }

  private exec(body: Stmt[], c: Ctx): typeof BREAK | typeof CONTINUE | void {
    for (const st of body) {
      switch (st.s) {
        case "expr":
          this.eval(st.value, c);
          break;
        case "pass":
          break;
        case "return":
          throw new ReturnSignal(st.value ? this.eval(st.value, c) : null);
        case "break":
          return BREAK;
        case "continue":
          return CONTINUE;
        case "assign": {
          let v = this.eval(st.value, c);
          if (st.op !== "=") {
            const name = st.target[0];
            if (!c.scope!.has(name)) throw new FormulaError("#NameError", `"${name}" is used before it's set`);
            v = binary(st.op[0], c.scope!.get(name), v);
          }
          this.bind(c.scope!, st.target, v);
          break;
        }
        case "if": {
          const hit = st.branches.find((b) => truthy(this.eval(b.test, c)));
          const r = hit ? this.exec(hit.body, c) : st.orelse ? this.exec(st.orelse, c) : undefined;
          if (r) return r;
          break;
        }
        case "for": {
          let n = 0;
          for (const item of this.iterate(this.eval(st.iter, c))) {
            if (++n > MAX_LOOP) throw new FormulaError("#Error", "Loop ran too many times");
            this.bind(c.scope!, st.target, item);
            const r = this.exec(st.body, c);
            if (r === BREAK) break;
          }
          break;
        }
      }
    }
  }

  private bind(scope: Map<string, unknown>, target: string[], v: unknown) {
    if (target.length === 1) {
      scope.set(target[0], v);
      return;
    }
    const items = this.iterate(v);
    if (items.length !== target.length) throw new FormulaError("#ValueError", `Expected ${target.length} values to unpack, got ${items.length}`);
    target.forEach((name, i) => scope.set(name, items[i]));
  }

  /** Items of something iterable: lists, record sets (as records), text (characters), dicts (keys). */
  private iterate(v: unknown): unknown[] {
    if (v instanceof RecordSet) return v.ids.map((id) => new RecordRef(v.tableRef, id));
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return v.split("");
    if (v instanceof Map) return [...v.values()].map((e) => (e as [unknown, unknown])[0]);
    if (v === null || v === undefined) return [];
    throw new FormulaError("#TypeError", "This value can't be looped over");
  }

  private eval(n: Node, c: Ctx): unknown {
    switch (n.t) {
      case "num":
      case "str":
      case "const":
        return n.v;
      case "col":
        if (c.scope?.has("$" + n.name)) return c.scope.get("$" + n.name);
        if (n.name === "id") return c.row;
        return fresh(this.value(this.column(c.table, n.name), c.row));
      case "name": {
        if (c.scope?.has(n.name)) return c.scope.get(n.name);
        if (n.name === "rec") return new RecordRef(c.table, c.row);
        if (n.name === "user") return new UserInfo(this.user);
        const table = this.tableByName.get(n.name);
        if (table) return new TableHandle(table.id, table.table_id);
        const special = this.docFunction(n.name.toUpperCase());
        if (special) return special;
        const fn = lookupFunction(n.name);
        // TODAY() without a zone means today in the document's time zone.
        if (fn && this.timezone && n.name.toUpperCase() === "TODAY") {
          const tz = this.timezone;
          return ((args, kw) => (args.length || kw.tz !== undefined ? fn(args, kw) : fn([tz], kw))) as Callable;
        }
        if (fn) return fn;
        throw new FormulaError("#NAME?", `Unknown name "${n.name}"`);
      }
      case "attr":
        return this.getAttr(this.eval(n.obj, c), n.name);
      case "call": {
        // IF, IFERROR, ISERROR and ISERR only evaluate what they need.
        if (n.fn.t === "name" && !c.scope?.has(n.fn.name)) {
          const upper = n.fn.name.toUpperCase();
          if (upper === "IF") {
            const [test, a, b] = n.args;
            if (!test) throw new FormulaError("#TypeError", "IF needs a condition");
            return truthy(this.eval(test, c)) ? (a ? this.eval(a, c) : true) : b ? this.eval(b, c) : false;
          }
          if (upper === "IFERROR" || upper === "ISERROR" || upper === "ISERR") {
            try {
              const v = this.eval(n.args[0], c);
              return upper === "IFERROR" ? v : false;
            } catch (e) {
              if (e instanceof FormulaError && e.code !== "#CIRCULAR") {
                if (upper !== "IFERROR") return true;
                return n.args[1] ? this.eval(n.args[1], c) : "";
              }
              throw e;
            }
          }
        }
        const fn = this.eval(n.fn, c);
        if (typeof fn !== "function") throw new FormulaError("#TypeError", "This value cannot be called");
        const args = n.args.map((a) => this.eval(a, c));
        const kwargs: Record<string, unknown> = {};
        for (const kw of n.kwargs) kwargs[kw.name] = this.eval(kw.value, c);
        return (fn as Callable)(args, kwargs);
      }
      case "index": {
        const obj = this.eval(n.obj, c);
        const key = this.eval(n.index, c);
        if (obj instanceof Map) {
          const k = valueKey(key);
          if (!obj.has(k)) throw new FormulaError("#KeyError", `No key ${toText(key)}`);
          return (obj.get(k) as [unknown, unknown])[1];
        }
        const idx = toNumber(key);
        const list = obj instanceof RecordSet ? flatten([obj]) : Array.isArray(obj) ? obj : typeof obj === "string" ? obj.split("") : null;
        if (!list || idx === null) throw new FormulaError("#TypeError", "Cannot index this value");
        const i = idx < 0 ? list.length + idx : idx;
        if (i < 0 || i >= list.length) throw new FormulaError("#IndexError", "Index out of range");
        return list[i];
      }
      case "slice": {
        const obj = this.eval(n.obj, c);
        const a = n.start ? toNumber(this.eval(n.start, c)) : null;
        const b = n.end ? toNumber(this.eval(n.end, c)) : null;
        const step = n.step ? toNumber(this.eval(n.step, c)) : null;
        if (step !== null && step !== 1) {
          if (step === 0 || !Number.isInteger(step)) throw new FormulaError("#ValueError", "A slice step must be a whole number other than 0");
          const items = obj instanceof RecordSet ? obj.ids : typeof obj === "string" ? obj.split("") : Array.isArray(obj) ? obj : null;
          if (!items) throw new FormulaError("#TypeError", "Cannot slice this value");
          const picked = stepSlice<unknown>(items, a, b, step);
          if (typeof obj === "string") return picked.join("");
          return obj instanceof RecordSet ? new RecordSet(obj.tableRef, picked as number[]) : picked;
        }
        if (typeof obj === "string") return obj.slice(a ?? 0, b ?? undefined);
        if (obj instanceof RecordSet) return new RecordSet(obj.tableRef, obj.ids.slice(a ?? 0, b ?? undefined));
        if (Array.isArray(obj)) return obj.slice(a ?? 0, b ?? undefined);
        throw new FormulaError("#TypeError", "Cannot slice this value");
      }
      case "list":
        return n.items.map((i) => this.eval(i, c));
      case "dict": {
        const m = new Map<string, [unknown, unknown]>();
        for (const e of n.entries) {
          const k = this.eval(e.key, c);
          m.set(valueKey(k), [k, this.eval(e.value, c)]);
        }
        return m;
      }
      case "comp": {
        const source = this.eval(n.iter, c);
        const scope = new Map(c.scope ?? []);
        const inner: Ctx = { ...c, scope };
        const out: unknown[] = [];
        for (const item of this.iterate(source)) {
          this.bind(scope, n.target, item);
          if (n.cond && !truthy(this.eval(n.cond, inner))) continue;
          out.push(this.eval(n.expr, inner));
        }
        // Records collected from a record set stay a record set (e.g. [r for r in recs if ...]).
        if (source instanceof RecordSet && out.length && out.every((x) => x instanceof RecordRef && x.tableRef === source.tableRef)) {
          return new RecordSet(source.tableRef, out.map((x) => (x as RecordRef).rowId));
        }
        return out;
      }
      case "lambda": {
        const captured = c.scope;
        return ((args: unknown[]) => {
          const scope = new Map(captured ?? []);
          n.params.forEach((p, i) => scope.set(p, args[i] ?? null));
          return this.eval(n.body, { ...c, scope });
        }) as Callable;
      }
      case "fstr":
        return n.parts.map((p) => (typeof p === "string" ? p : formatSpec(this.eval(p.expr, c), p.spec))).join("");
      case "block":
        return this.run(n, c);
      case "un": {
        const v = toNumber(this.eval(n.arg, c)) ?? 0;
        return n.op === "-" ? -v : v;
      }
      case "not":
        return !truthy(this.eval(n.arg, c));
      case "and": {
        const l = this.eval(n.left, c);
        return truthy(l) ? this.eval(n.right, c) : l;
      }
      case "or": {
        const l = this.eval(n.left, c);
        return truthy(l) ? l : this.eval(n.right, c);
      }
      case "cond":
        return truthy(this.eval(n.test, c)) ? this.eval(n.then, c) : this.eval(n.else, c);
      case "cmp":
        return compare(n.op, this.eval(n.left, c), this.eval(n.right, c));
      case "bin":
        return binary(n.op, this.eval(n.left, c), this.eval(n.right, c));
    }
  }
}

/** Lists read from a cell are copied, so list methods like append() never change stored or cached values. */
function fresh(v: unknown): unknown {
  return Array.isArray(v) ? [...v] : v;
}

/** Python's items[start:stop:step] for a step other than 1. */
function stepSlice<T>(items: T[], start: number | null, stop: number | null, step: number): T[] {
  const n = items.length;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const norm = (v: number) => (v < 0 ? v + n : v);
  const out: T[] = [];
  if (step > 0) {
    const from = start === null ? 0 : clamp(norm(start), 0, n);
    const to = stop === null ? n : clamp(norm(stop), 0, n);
    for (let i = from; i < to; i += step) out.push(items[i]);
  } else {
    const from = start === null ? n - 1 : clamp(norm(start), -1, n - 1);
    const to = stop === null ? -1 : clamp(norm(stop), -1, n - 1);
    for (let i = from; i > to; i += step) out.push(items[i]);
  }
  return out;
}

/** Python's "text %s" % values: %s %d %i %f %.2f %x %% (and widths such as %5d, %-8s, %05.1f). */
function percentFormat(fmt: string, arg: unknown): string {
  const args = Array.isArray(arg) ? arg : [arg];
  let k = 0;
  return fmt.replace(/%(-)?(0)?(\d+)?(?:\.(\d+))?([sdifxr%])/g, (_m, left: string, zero: string, width: string, prec: string, type: string) => {
    if (type === "%") return "%";
    if (k >= args.length) throw new FormulaError("#TypeError", "Not enough values for the format text");
    const v = args[k++];
    let out: string;
    if (type === "s" || type === "r") out = toText(v);
    else {
      const num = toNumber(v);
      if (num === null) throw new FormulaError("#TypeError", `%${type} needs a number, got "${toText(v)}"`);
      if (type === "f") out = num.toFixed(prec === undefined ? 6 : Number(prec));
      else if (type === "x") out = Math.trunc(num).toString(16);
      else out = String(Math.trunc(num));
    }
    const w = width ? Number(width) : 0;
    if (out.length >= w) return out;
    if (left) return out.padEnd(w, " ");
    if (zero && type !== "s" && type !== "r") return out.startsWith("-") ? "-" + out.slice(1).padStart(w - 1, "0") : out.padStart(w, "0");
    return out.padStart(w, " ");
  });
}

/** The `user` object in formulas. */
class UserInfo {
  fields: Record<string, unknown>;
  constructor(u: FormulaUser | null) {
    this.fields = { Email: u?.Email ?? "", Name: u?.Name ?? "", UserID: u?.UserID ?? "", Access: u?.Access ?? null };
  }
}

/** Ordering used by sort_by / order_by: empty values last, numbers and dates numerically, text case-insensitively. */
export function sortCompare(a: unknown, b: unknown): number {
  const ea = isEmptyValue(a) || a instanceof FormulaError;
  const eb = isEmptyValue(b) || b instanceof FormulaError;
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const na = isDate(a) ? a.getTime() : typeof a === "number" || typeof a === "boolean" ? Number(a) : a instanceof RecordRef ? null : null;
  const nb = isDate(b) ? b.getTime() : typeof b === "number" || typeof b === "boolean" ? Number(b) : null;
  if (na !== null && nb !== null) return na - nb;
  return toText(a).localeCompare(toText(b), undefined, { sensitivity: "base", numeric: true });
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Python-style date formatting (%Y %m %d %H %M %S %b %B %a %A %y %j %p %I %%), in UTC. */
export function strftime(d: Date, fmt: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return fmt.replace(/%([YmdHMSbBaAyjpI%])/g, (_, k: string) => {
    switch (k) {
      case "Y":
        return String(d.getUTCFullYear());
      case "y":
        return p(d.getUTCFullYear() % 100);
      case "m":
        return p(d.getUTCMonth() + 1);
      case "d":
        return p(d.getUTCDate());
      case "H":
        return p(d.getUTCHours());
      case "I":
        return p(d.getUTCHours() % 12 || 12);
      case "p":
        return d.getUTCHours() < 12 ? "AM" : "PM";
      case "M":
        return p(d.getUTCMinutes());
      case "S":
        return p(d.getUTCSeconds());
      case "b":
        return MONTH_NAMES[d.getUTCMonth()].slice(0, 3);
      case "B":
        return MONTH_NAMES[d.getUTCMonth()];
      case "a":
        return DAY_NAMES[d.getUTCDay()].slice(0, 3);
      case "A":
        return DAY_NAMES[d.getUTCDay()];
      case "j": {
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        return p(Math.floor((d.getTime() - start) / 86400000) + 1, 3);
      }
      default:
        return "%";
    }
  });
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
      else if (b instanceof Map) found = b.has(valueKey(a));
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
  if (op === "*" && (Array.isArray(a) || Array.isArray(b))) {
    const items = (Array.isArray(a) ? a : b) as unknown[];
    const other = Array.isArray(a) ? b : a;
    const times = Array.isArray(other) ? null : toNumber(other);
    if (times === null) throw new FormulaError("#TypeError", "A list can only be multiplied by a number");
    const count = Math.max(0, Math.floor(times));
    if (items.length * count > 100_000) throw new FormulaError("#Error", "The list would be too long");
    return Array.from({ length: count }, () => items).flat();
  }
  if (op === "%" && typeof a === "string") return percentFormat(a, b);
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
