// Static dependency analysis: which stored or formula columns, and which
// tables' row sets, a formula reads. Used to recompute only the formula
// columns an action can affect.
//
//   $Col                         → column Col of this table
//   $Ref.Col / rec.Ref.Col       → Ref (on this table) and Col (on the target table)
//   Table.lookupRecords(K=…).Col → rows of Table, its column K, and Col
//   Table.all                    → rows of Table
//
// When the target of an attribute can't be known statically (e.g. a column
// of type Any holding a record), the formula is marked `dynamic`, meaning it
// depends on everything.
import { parseFormula, type Node, type Stmt } from "./parser";
import type { DocColumn, DocTable } from "./types";

export interface FormulaDeps {
  /** Column uuids read by the formula. */
  cols: Set<string>;
  /** Table uuids whose set of rows the formula reads (lookups, `.all`). */
  tables: Set<string>;
  /** True when the formula may read anything. */
  dynamic: boolean;
}

export interface SchemaInfo {
  tables: Iterable<DocTable>;
  columns: Iterable<DocColumn>;
}

type Kind =
  | { k: "record"; table: string }
  | { k: "records"; table: string }
  | { k: "table"; table: string }
  | { k: "lookup"; table: string; one: boolean }
  | { k: "value" }
  | { k: "any" };

const VALUE: Kind = { k: "value" };
const ANY: Kind = { k: "any" };

/** Attributes on plain values (string methods, date parts), never record fields. */
const VALUE_ATTRS = new Set([
  "upper", "lower", "strip", "title", "capitalize", "replace", "split", "startswith", "endswith", "find", "count",
  "lstrip", "rstrip", "join", "isdigit", "isalpha", "isupper", "islower", "zfill", "ljust", "rjust", "center", "format",
  "partition", "index", "get", "keys", "values", "items",
  "year", "month", "day", "hour", "minute", "second", "weekday", "isoweekday", "isoformat", "date", "strftime",
]);

/** Functions that read other rows of the record's own table (by group_by / order_by column names). */
const ROW_FUNCS = new Set(["PREVIOUS", "NEXT", "RANK"]);

type Locals = Map<string, Kind>;

/** String literals in an argument: "Col", ("A", "-B"), ["A"]. */
function literalNames(n: Node | undefined): string[] {
  if (!n) return [];
  if (n.t === "str") return [n.v.replace(/^-/, "")];
  if (n.t === "list") return n.items.flatMap(literalNames);
  return [];
}

export class DependencyAnalyzer {
  private tableByName = new Map<string, DocTable>();
  private colByName = new Map<string, DocColumn>();

  constructor(schema: SchemaInfo) {
    // Each iterable is read exactly once.
    for (const t of schema.tables) this.tableByName.set(t.table_id, t);
    for (const c of schema.columns) this.colByName.set(`${c.table_ref}|${c.col_id}`, c);
  }

  analyze(col: Pick<DocColumn, "table_ref" | "formula">): FormulaDeps {
    const deps: FormulaDeps = { cols: new Set(), tables: new Set(), dynamic: false };
    let ast: Node;
    try {
      ast = parseFormula(col.formula);
    } catch {
      return deps; // a syntax error doesn't depend on any data
    }
    this.walk(ast, col.table_ref, deps, new Map());
    return deps;
  }

  private columnKind(c: DocColumn): Kind {
    if (c.type === "Ref" && c.options.refTable) return { k: "record", table: c.options.refTable };
    if (c.type === "RefList" && c.options.refTable) return c.is_formula ? ANY : { k: "records", table: c.options.refTable };
    if (c.type === "Any") return ANY;
    return VALUE;
  }

  private field(table: string, name: string, deps: FormulaDeps): Kind {
    if (name === "id") return VALUE;
    const c = this.colByName.get(`${table}|${name}`);
    if (!c) return VALUE; // evaluates to #NAME?; adding the column is a schema change
    deps.cols.add(c.id);
    return this.columnKind(c);
  }

  private sortCols(table: string, n: Node | undefined, deps: FormulaDeps) {
    if (!n) return;
    const names = literalNames(n);
    if (!names.length && n.t !== "const") deps.dynamic = true; // computed column names
    for (const name of names) this.field(table, name, deps);
  }

  private walkStmts(body: Stmt[], table: string, deps: FormulaDeps, locals: Locals) {
    for (const st of body) {
      switch (st.s) {
        case "assign": {
          const k = this.walk(st.value, table, deps, locals);
          for (const name of st.target) {
            // `x += …` or unpacking: the kind is no longer certain.
            locals.set(name, st.op === "=" && st.target.length === 1 ? k : ANY);
          }
          break;
        }
        case "return":
        case "expr":
          if (st.value) this.walk(st.value, table, deps, locals);
          break;
        case "if":
          for (const b of st.branches) {
            this.walk(b.test, table, deps, locals);
            this.walkStmts(b.body, table, deps, locals);
          }
          if (st.orelse) this.walkStmts(st.orelse, table, deps, locals);
          break;
        case "for": {
          const it = this.walk(st.iter, table, deps, locals);
          for (const name of st.target) locals.set(name, st.target.length === 1 ? this.elementKind(it) : ANY);
          // Twice, so names assigned late in the loop body are known on the second pass.
          this.walkStmts(st.body, table, deps, locals);
          this.walkStmts(st.body, table, deps, locals);
          break;
        }
      }
    }
  }

  private elementKind(k: Kind): Kind {
    if (k.k === "records") return { k: "record", table: k.table };
    if (k.k === "value") return VALUE;
    return ANY;
  }

  private walk(n: Node, table: string, deps: FormulaDeps, locals: Locals): Kind {
    switch (n.t) {
      case "num":
      case "str":
      case "const":
        return VALUE;
      case "col":
        return this.field(table, n.name, deps);
      case "name": {
        const local = locals.get(n.name);
        if (local) return local;
        if (n.name === "rec") return { k: "record", table };
        if (n.name === "user") return VALUE;
        const t = this.tableByName.get(n.name);
        if (t) return { k: "table", table: t.id };
        return VALUE; // a function name
      }
      case "attr": {
        const obj = this.walk(n.obj, table, deps, locals);
        switch (obj.k) {
          case "record":
            // A removed target row empties the reference, so its table's rows matter too.
            if (obj.table !== table) deps.tables.add(obj.table);
            return this.field(obj.table, n.name, deps);
          case "records": {
            deps.tables.add(obj.table);
            const kind = this.field(obj.table, n.name, deps);
            return kind.k === "value" ? VALUE : ANY;
          }
          case "table":
            if (n.name === "all") {
              deps.tables.add(obj.table);
              return { k: "records", table: obj.table };
            }
            if (n.name === "lookupRecords" || n.name === "lookupOne") {
              return { k: "lookup", table: obj.table, one: n.name === "lookupOne" };
            }
            return VALUE;
          case "value":
            return VALUE;
          default:
            if (!VALUE_ATTRS.has(n.name)) deps.dynamic = true;
            return ANY;
        }
      }
      case "call": {
        const fnName = n.fn.t === "name" && !locals.has(n.fn.name) ? n.fn.name.toUpperCase() : null;
        if (fnName && ROW_FUNCS.has(fnName)) {
          // Reads the rows of the record's table and the grouping / ordering columns.
          const target = n.args[0] ? this.walk(n.args[0], table, deps, locals) : ANY;
          const t = target.k === "record" ? target.table : null;
          if (!t) {
            deps.dynamic = true;
            return fnName === "RANK" ? VALUE : ANY;
          }
          deps.tables.add(t);
          for (const kw of n.kwargs) {
            if (kw.name === "group_by" || kw.name === "order_by") this.sortCols(t, kw.value, deps);
            else this.walk(kw.value, table, deps, locals);
          }
          return fnName === "RANK" ? VALUE : { k: "record", table: t };
        }
        if (fnName === "VLOOKUP") {
          const target = n.args[0] ? this.walk(n.args[0], table, deps, locals) : ANY;
          if (target.k !== "table") {
            deps.dynamic = true;
            return ANY;
          }
          deps.tables.add(target.table);
          for (const kw of n.kwargs) {
            this.walk(kw.value, table, deps, locals);
            if (kw.name === "sort_by" || kw.name === "order_by") this.sortCols(target.table, kw.value, deps);
            else this.field(target.table, kw.name, deps);
          }
          return { k: "record", table: target.table };
        }
        const fn = this.walk(n.fn, table, deps, locals);
        n.args.forEach((a) => this.walk(a, table, deps, locals));
        if (fn.k === "lookup") {
          deps.tables.add(fn.table);
          for (const kw of n.kwargs) {
            this.walk(kw.value, table, deps, locals);
            if (kw.name === "sort_by" || kw.name === "order_by") this.sortCols(fn.table, kw.value, deps);
            else this.field(fn.table, kw.name, deps);
          }
          return fn.one ? { k: "record", table: fn.table } : { k: "records", table: fn.table };
        }
        n.kwargs.forEach((kw) => this.walk(kw.value, table, deps, locals));
        if (fn.k === "any") deps.dynamic = true;
        return n.fn.t === "attr" && fn.k === "value" ? VALUE : ANY;
      }
      case "index":
        this.walk(n.obj, table, deps, locals);
        this.walk(n.index, table, deps, locals);
        return ANY;
      case "slice": {
        const k = this.walk(n.obj, table, deps, locals);
        if (n.start) this.walk(n.start, table, deps, locals);
        if (n.end) this.walk(n.end, table, deps, locals);
        return k.k === "records" ? k : k.k === "value" ? VALUE : ANY;
      }
      case "list":
        n.items.forEach((i) => this.walk(i, table, deps, locals));
        return VALUE;
      case "dict":
        n.entries.forEach((e) => {
          this.walk(e.key, table, deps, locals);
          this.walk(e.value, table, deps, locals);
        });
        return VALUE;
      case "comp": {
        const it = this.walk(n.iter, table, deps, locals);
        const inner: Locals = new Map(locals);
        for (const name of n.target) inner.set(name, n.target.length === 1 ? this.elementKind(it) : ANY);
        if (n.cond) this.walk(n.cond, table, deps, inner);
        const k = this.walk(n.expr, table, deps, inner);
        // [r for r in recs if …] keeps the records.
        if (it.k === "records" && k.k === "record" && k.table === it.table) return it;
        return k.k === "value" ? VALUE : ANY;
      }
      case "lambda": {
        // Parameters are usually records from the list the lambda is applied to: unknown here.
        const inner: Locals = new Map(locals);
        for (const p of n.params) inner.set(p, ANY);
        const before = deps.dynamic;
        this.walk(n.body, table, deps, inner);
        // Plain value attributes on an unknown parameter mark the formula dynamic; that's
        // the safe answer, but keep it only if the body reads attributes of the parameter.
        deps.dynamic = before || deps.dynamic;
        return VALUE;
      }
      case "fstr":
        for (const p of n.parts) if (typeof p !== "string") this.walk(p.expr, table, deps, locals);
        return VALUE;
      case "block":
        this.walkStmts(n.body, table, deps, locals);
        return ANY;
      case "un":
      case "not":
        this.walk(n.arg, table, deps, locals);
        return VALUE;
      case "bin":
      case "cmp":
      case "and":
      case "or": {
        const l = this.walk(n.left, table, deps, locals);
        const r = this.walk(n.right, table, deps, locals);
        return n.t === "and" || n.t === "or" ? (l.k === "value" && r.k === "value" ? VALUE : ANY) : VALUE;
      }
      case "cond": {
        this.walk(n.test, table, deps, locals);
        const a = this.walk(n.then, table, deps, locals);
        const b = this.walk(n.else, table, deps, locals);
        return a.k === "value" && b.k === "value" ? VALUE : ANY;
      }
    }
  }
}

/** What changed: stored/formula columns whose values changed, and tables that gained or lost rows. */
export interface ChangeSet {
  cols: Set<string>;
  tables: Set<string>;
  /** Schema changed or the history is unknown: recompute everything. */
  all: boolean;
}

/**
 * Formula columns to recompute after a change, closed over formulas that read
 * other formulas. A table that gained rows recomputes all of its own formulas.
 */
export function affectedFormulas(schema: SchemaInfo, change: ChangeSet): Set<string> {
  // Iterables may be one-shot (e.g. Map.values()): read each once.
  const tables = [...schema.tables];
  const columns = [...schema.columns];
  const formulas = columns.filter((c) => c.is_formula && c.formula.trim() !== "");
  if (change.all) return new Set(formulas.map((c) => c.id));
  const analyzer = new DependencyAnalyzer({ tables, columns });
  const deps = new Map(formulas.map((c) => [c.id, analyzer.analyze(c)]));
  const changedCols = new Set(change.cols);
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of formulas) {
      if (out.has(c.id)) continue;
      const d = deps.get(c.id)!;
      const hit =
        d.dynamic ||
        change.tables.has(c.table_ref) ||
        [...d.tables].some((t) => change.tables.has(t)) ||
        [...d.cols].some((id) => changedCols.has(id));
      if (hit) {
        out.add(c.id);
        changedCols.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}
