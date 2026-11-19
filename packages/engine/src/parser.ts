// Parser for the formula language: Python-flavoured expressions with
// Excel-style functions. `$Col` reads a column of the current record,
// `$Customer.Name` follows references, and `Orders.lookupRecords(Customer=$id)`
// queries other tables.
//
// Formulas can also be small Python programs: several lines with local
// variables, `if/elif/else`, `for` loops, `return`, list comprehensions,
// lambdas and f-strings. A one-line formula is a single expression; in a
// multi-line formula a final bare expression is returned, as in Grist.

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string; pos?: number }
  | { t: "const"; v: boolean | null }
  | { t: "col"; name: string; pos?: number }
  | { t: "name"; name: string }
  | { t: "attr"; obj: Node; name: string; pos?: number }
  | { t: "call"; fn: Node; args: Node[]; kwargs: { name: string; value: Node; pos?: number }[] }
  | { t: "index"; obj: Node; index: Node }
  | { t: "slice"; obj: Node; start: Node | null; end: Node | null; step?: Node | null }
  | { t: "list"; items: Node[] }
  | { t: "dict"; entries: { key: Node; value: Node }[] }
  | { t: "un"; op: "-" | "+"; arg: Node }
  | { t: "bin"; op: string; left: Node; right: Node }
  | { t: "cmp"; op: string; left: Node; right: Node }
  | { t: "and" | "or"; left: Node; right: Node }
  | { t: "not"; arg: Node }
  | { t: "cond"; test: Node; then: Node; else: Node }
  | { t: "comp"; expr: Node; target: string[]; iter: Node; cond: Node | null }
  | { t: "lambda"; params: string[]; body: Node }
  | { t: "fstr"; parts: (string | { expr: Node; spec: string })[] }
  | { t: "block"; body: Stmt[] };

export type Stmt =
  | { s: "assign"; target: string[]; op: string; value: Node }
  | { s: "return"; value: Node | null }
  | { s: "if"; branches: { test: Node; body: Stmt[] }[]; orelse: Stmt[] | null }
  | { s: "for"; target: string[]; iter: Node; body: Stmt[] }
  | { s: "expr"; value: Node }
  | { s: "pass" }
  | { s: "break" }
  | { s: "continue" };

type Tok =
  | { k: "num"; v: number; pos: number }
  | { k: "str"; v: string; pos: number }
  | { k: "fstr"; v: string; pos: number }
  | { k: "ident"; v: string; pos: number }
  | { k: "col"; v: string; pos: number }
  | { k: "op"; v: string; pos: number }
  | { k: "nl"; v: number; pos: number }
  | { k: "eof"; v: ""; pos: number };

export class FormulaSyntaxError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
  }
}

const OPS = [
  "**", "//", "==", "!=", "<=", ">=", "<>", "+=", "-=", "*=", "/=",
  "<", ">", "=", "+", "-", "*", "/", "%", "&", "^", ".", ",", "(", ")", "[", "]", "{", "}", ":",
];

function readString(src: string, i: number): { text: string; end: number } {
  const quote = src[i];
  const triple = src.startsWith(quote.repeat(3), i);
  const close = triple ? quote.repeat(3) : quote;
  let j = i + close.length;
  let out = "";
  while (j < src.length && !src.startsWith(close, j)) {
    if (src[j] === "\\" && j + 1 < src.length) {
      const e = src[j + 1];
      out += e === "n" ? "\n" : e === "t" ? "\t" : e;
      j += 2;
    } else {
      if (!triple && src[j] === "\n") break;
      out += src[j++];
    }
  }
  if (!src.startsWith(close, j)) throw new FormulaSyntaxError("Unterminated string", i);
  return { text: out, end: j + close.length };
}

/**
 * Splits source into tokens. With `lines`, newlines outside brackets become
 * "nl" tokens carrying the next line's indentation (blank and comment-only
 * lines are skipped); otherwise newlines are plain whitespace.
 */
function tokenize(src: string, lines = false): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let depth = 0;
  const pushNl = (pos: number) => {
    // Measure the indentation of the next non-blank line.
    let j = pos;
    for (;;) {
      let indent = 0;
      while (j < src.length && (src[j] === " " || src[j] === "\t")) {
        indent += src[j] === "\t" ? 4 : 1;
        j++;
      }
      if (j < src.length && (src[j] === "\n" || src[j] === "\r")) {
        j++;
        continue;
      }
      if (j < src.length && src[j] === "#") {
        while (j < src.length && src[j] !== "\n") j++;
        continue;
      }
      const last = toks[toks.length - 1];
      if (j >= src.length) return j;
      if (last && last.k === "nl") last.v = indent;
      else toks.push({ k: "nl", v: indent, pos: j });
      return j;
    }
  };
  if (lines) i = pushNl(0);
  while (i < src.length) {
    const ch = src[i];
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n" && lines && depth === 0) {
      i = pushNl(i + 1);
      continue;
    }
    if (ch === "\\" && src[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d[\d_]*\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      toks.push({ k: "num", v: parseFloat(m[0].replace(/_/g, "")), pos: i });
      i += m[0].length;
      continue;
    }
    if ((ch === "f" || ch === "F") && (src[i + 1] === '"' || src[i + 1] === "'")) {
      const { text, end } = readString(src, i + 1);
      toks.push({ k: "fstr", v: text, pos: i });
      i = end;
      continue;
    }
    if ((ch === "r" || ch === "R") && (src[i + 1] === '"' || src[i + 1] === "'")) {
      // Raw string (handy for regular expressions): no escapes.
      const quote = src[i + 1];
      const close = src.indexOf(quote, i + 2);
      if (close < 0) throw new FormulaSyntaxError("Unterminated string", i);
      toks.push({ k: "str", v: src.slice(i + 2, close), pos: i });
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const { text, end } = readString(src, i);
      toks.push({ k: "str", v: text, pos: i });
      i = end;
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (!m) throw new FormulaSyntaxError("Expected a column name after $", i);
      toks.push({ k: "col", v: m[1], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      toks.push({ k: "ident", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaSyntaxError(`Unexpected character "${ch}"`, i);
    if (op === "(" || op === "[" || op === "{") depth++;
    if (op === ")" || op === "]" || op === "}") depth = Math.max(0, depth - 1);
    toks.push({ k: "op", v: op, pos: i });
    i += op.length;
  }
  toks.push({ k: "eof", v: "", pos: src.length });
  return toks;
}

const KEYWORDS = new Set([
  "and", "or", "not", "if", "elif", "else", "in", "is", "for", "return", "lambda", "pass", "break", "continue", "while", "def",
]);

class Parser {
  private i = 0;
  /**
   * `base` is where the tokenized text starts in the formula source, so the
   * `pos` of column, attribute and keyword names are offsets into that source
   * (used to rename columns). NaN when unknown (inside f-strings).
   */
  constructor(private toks: Tok[], private base = 0) {}

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)];
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private isOp(v: string, offset = 0) {
    const t = this.peek(offset);
    return t.k === "op" && t.v === v;
  }
  private isKw(v: string, offset = 0) {
    const t = this.peek(offset);
    return t.k === "ident" && t.v === v;
  }
  private expectOp(v: string) {
    const t = this.next();
    if (t.k !== "op" || t.v !== v) throw new FormulaSyntaxError(`Expected "${v}"`, t.pos);
  }
  private expectKw(v: string) {
    const t = this.next();
    if (t.k !== "ident" || t.v !== v) throw new FormulaSyntaxError(`Expected "${v}"`, t.pos);
  }
  private ident(): string {
    const t = this.next();
    if (t.k !== "ident" || KEYWORDS.has(t.v)) throw new FormulaSyntaxError("Expected a name", t.pos);
    return t.v;
  }

  parseAll(): Node {
    const node = this.expr();
    const t = this.peek();
    if (t.k !== "eof") throw new FormulaSyntaxError(`Unexpected "${t.v}"`, t.pos);
    return node;
  }

  // ---- statements (multi-line formulas)

  parseProgram(): Node {
    const first = this.peek();
    const indent = first.k === "nl" ? first.v : 0;
    const body = this.stmts(indent);
    const t = this.peek();
    if (t.k !== "eof") throw new FormulaSyntaxError(t.k === "nl" ? "Unexpected indentation" : `Unexpected "${t.v}"`, t.pos);
    // A final bare expression is the formula's value.
    const last = body[body.length - 1];
    if (last && last.s === "expr") body[body.length - 1] = { s: "return", value: last.value };
    return { t: "block", body };
  }

  private stmts(indent: number): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      const t = this.peek();
      if (t.k === "nl") {
        if (t.v < indent) break;
        if (t.v > indent) throw new FormulaSyntaxError("Unexpected indentation", t.pos);
        this.next();
      } else if (out.length) {
        break;
      }
      if (this.peek().k === "eof") break;
      out.push(this.stmt(indent));
    }
    if (!out.length) throw new FormulaSyntaxError("Expected a statement", this.peek().pos);
    return out;
  }

  /** Body after ":": an indented block on the next lines, or one statement on the same line. */
  private suite(indent: number): Stmt[] {
    this.expectOp(":");
    const t = this.peek();
    if (t.k === "nl") {
      if (t.v <= indent) throw new FormulaSyntaxError("Expected an indented block", t.pos);
      return this.stmts(t.v);
    }
    return [this.stmt(indent)];
  }

  private targets(): string[] {
    const names = [this.ident()];
    while (this.isOp(",")) {
      this.next();
      names.push(this.ident());
    }
    return names;
  }

  private stmt(indent: number): Stmt {
    const t = this.peek();
    if (t.k === "ident") {
      switch (t.v) {
        case "return": {
          this.next();
          const end = this.peek();
          return { s: "return", value: end.k === "nl" || end.k === "eof" ? null : this.tupleExpr() };
        }
        case "pass":
          this.next();
          return { s: "pass" };
        case "break":
          this.next();
          return { s: "break" };
        case "continue":
          this.next();
          return { s: "continue" };
        case "if": {
          this.next();
          const branches = [{ test: this.expr(), body: this.suite(indent) }];
          let orelse: Stmt[] | null = null;
          for (;;) {
            const nl = this.peek();
            const atSameIndent = nl.k === "nl" && nl.v === indent;
            if (atSameIndent && this.isKw("elif", 1)) {
              this.next();
              this.next();
              branches.push({ test: this.expr(), body: this.suite(indent) });
            } else if (atSameIndent && this.isKw("else", 1)) {
              this.next();
              this.next();
              orelse = this.suite(indent);
              break;
            } else break;
          }
          return { s: "if", branches, orelse };
        }
        case "for": {
          this.next();
          const target = this.targets();
          this.expectKw("in");
          const iter = this.expr();
          return { s: "for", target, iter, body: this.suite(indent) };
        }
        case "while":
        case "def":
        case "try":
        case "import":
        case "from":
        case "class":
        case "with":
          // Only as a statement keyword: `try_x = 1` or `with(...)` are still ordinary names.
          if (t.v === "while" || t.v === "def" || this.peek(1).k === "ident" || this.isOp(":", 1)) {
            throw new FormulaSyntaxError(`"${t.v}" isn't supported in formulas`, t.pos);
          }
      }
      // name = value, a, b = value, name += value
      let k = 1;
      while (this.isOp(",", k) && this.peek(k + 1).k === "ident") k += 2;
      const op = this.peek(k);
      if (op.k === "op" && ["=", "+=", "-=", "*=", "/="].includes(op.v)) {
        const target = this.targets();
        this.next();
        return { s: "assign", target, op: op.v, value: this.tupleExpr() };
      }
    }
    return { s: "expr", value: this.tupleExpr() };
  }

  /** `a, b` (a tuple, as a list) or a single expression. */
  private tupleExpr(): Node {
    const first = this.expr();
    if (!this.isOp(",")) return first;
    const items = [first];
    while (this.isOp(",")) {
      this.next();
      const t = this.peek();
      if (t.k === "nl" || t.k === "eof") break;
      items.push(this.expr());
    }
    return { t: "list", items };
  }

  // ---- expressions

  expr(): Node {
    if (this.isKw("lambda")) {
      this.next();
      const params: string[] = [];
      while (!this.isOp(":")) {
        params.push(this.ident());
        if (!this.isOp(",")) break;
        this.next();
      }
      this.expectOp(":");
      return { t: "lambda", params, body: this.expr() };
    }
    const body = this.or();
    if (this.isKw("if")) {
      this.next();
      const test = this.or();
      if (!this.isKw("else")) throw new FormulaSyntaxError('Expected "else"', this.peek().pos);
      this.next();
      const otherwise = this.expr();
      return { t: "cond", test, then: body, else: otherwise };
    }
    return body;
  }

  /** After an element: `for x in items [if cond]`, turning it into a comprehension. */
  private comprehension(expr: Node): Node {
    this.expectKw("for");
    const target = this.targets();
    this.expectKw("in");
    const iter = this.or();
    let cond: Node | null = null;
    if (this.isKw("if")) {
      this.next();
      cond = this.or();
      while (this.isKw("if")) {
        this.next();
        cond = { t: "and", left: cond, right: this.or() };
      }
    }
    if (this.isKw("for")) throw new FormulaSyntaxError("Nested comprehensions aren't supported", this.peek().pos);
    return { t: "comp", expr, target, iter, cond };
  }

  or(): Node {
    let left = this.and();
    while (this.isKw("or")) {
      this.next();
      left = { t: "or", left, right: this.and() };
    }
    return left;
  }

  and(): Node {
    let left = this.not();
    while (this.isKw("and")) {
      this.next();
      left = { t: "and", left, right: this.not() };
    }
    return left;
  }

  not(): Node {
    if (this.isKw("not")) {
      this.next();
      return { t: "not", arg: this.not() };
    }
    return this.comparison();
  }

  comparison(): Node {
    let left = this.concat();
    // The right-hand side of the previous ordering comparison, for chains like 1 < x < 10.
    let chainFrom: Node | null = null;
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && ["==", "!=", "<>", "<", ">", "<=", ">=", "="].includes(t.v)) {
        this.next();
        const op = t.v === "=" ? "==" : t.v === "<>" ? "!=" : t.v;
        const right = this.concat();
        const ordering = op === "<" || op === ">" || op === "<=" || op === ">=";
        if (chainFrom && ordering) left = { t: "and", left, right: { t: "cmp", op, left: chainFrom, right } };
        else left = { t: "cmp", op, left, right };
        chainFrom = ordering ? right : null;
      } else if (this.isKw("in")) {
        this.next();
        left = { t: "cmp", op: "in", left, right: this.concat() };
      } else if (this.isKw("not") && this.isKw("in", 1)) {
        this.next();
        this.next();
        left = { t: "cmp", op: "not in", left, right: this.concat() };
      } else if (this.isKw("is")) {
        this.next();
        const negate = this.isKw("not");
        if (negate) this.next();
        left = { t: "cmp", op: negate ? "!=" : "==", left, right: this.concat() };
      } else {
        return left;
      }
    }
  }

  concat(): Node {
    let left = this.additive();
    while (this.isOp("&")) {
      this.next();
      left = { t: "bin", op: "&", left, right: this.additive() };
    }
    return left;
  }

  additive(): Node {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().v as string;
      left = { t: "bin", op, left, right: this.term() };
    }
    return left;
  }

  term(): Node {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("//") || this.isOp("%")) {
      const op = this.next().v as string;
      left = { t: "bin", op, left, right: this.unary() };
    }
    return left;
  }

  unary(): Node {
    if (this.isOp("-") || this.isOp("+")) {
      const op = this.next().v as "-" | "+";
      return { t: "un", op, arg: this.unary() };
    }
    return this.power();
  }

  power(): Node {
    const base = this.postfix();
    if (this.isOp("**") || this.isOp("^")) {
      this.next();
      return { t: "bin", op: "**", left: base, right: this.unary() };
    }
    return base;
  }

  postfix(): Node {
    let node = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const t = this.next();
        if (t.k !== "ident") throw new FormulaSyntaxError("Expected a name after .", t.pos);
        node = { t: "attr", obj: node, name: t.v, pos: this.base + t.pos };
      } else if (this.isOp("(")) {
        this.next();
        const args: Node[] = [];
        const kwargs: { name: string; value: Node; pos?: number }[] = [];
        while (!this.isOp(")")) {
          const t = this.peek();
          if (t.k === "ident" && this.isOp("=", 1)) {
            this.next();
            this.next();
            kwargs.push({ name: t.v, value: this.expr(), pos: this.base + t.pos });
          } else {
            if (kwargs.length) throw new FormulaSyntaxError("Positional argument after keyword argument", t.pos);
            let arg = this.expr();
            // A generator argument: sum(r.Amount for r in recs)
            if (this.isKw("for")) arg = this.comprehension(arg);
            args.push(arg);
          }
          if (!this.isOp(",")) break;
          this.next();
        }
        this.expectOp(")");
        node = { t: "call", fn: node, args, kwargs };
      } else if (this.isOp("[")) {
        this.next();
        let start: Node | null = null;
        if (!this.isOp(":")) start = this.expr();
        if (this.isOp(":")) {
          this.next();
          const end = this.isOp("]") || this.isOp(":") ? null : this.expr();
          let step: Node | null = null;
          if (this.isOp(":")) {
            this.next();
            if (!this.isOp("]")) step = this.expr();
          }
          this.expectOp("]");
          node = { t: "slice", obj: node, start, end, step };
        } else {
          this.expectOp("]");
          node = { t: "index", obj: node, index: start! };
        }
      } else {
        return node;
      }
    }
  }

  primary(): Node {
    const t = this.next();
    switch (t.k) {
      case "num":
        return { t: "num", v: t.v };
      case "str": {
        // Adjacent strings concatenate, as in Python.
        let v = t.v;
        const single = this.peek().k !== "str";
        while (this.peek().k === "str") v += (this.next() as { v: string }).v;
        return single ? { t: "str", v, pos: this.base + t.pos } : { t: "str", v };
      }
      case "fstr":
        return parseFString(t.v, t.pos);
      case "col":
        return { t: "col", name: t.v, pos: this.base + t.pos };
      case "ident": {
        const lower = t.v.toLowerCase();
        if (t.v === "True" || t.v === "TRUE" || lower === "true") return { t: "const", v: true };
        if (t.v === "False" || t.v === "FALSE" || lower === "false") return { t: "const", v: false };
        if (t.v === "None") return { t: "const", v: null };
        if (KEYWORDS.has(t.v)) throw new FormulaSyntaxError(`Unexpected "${t.v}"`, t.pos);
        return { t: "name", name: t.v };
      }
      case "op":
        if (t.v === "(") {
          if (this.isOp(")")) {
            this.next();
            return { t: "list", items: [] };
          }
          const inner = this.expr();
          if (this.isKw("for")) {
            const comp = this.comprehension(inner);
            this.expectOp(")");
            return comp;
          }
          if (this.isOp(",")) {
            // A tuple: (a, b) — represented as a list.
            const items = [inner];
            while (this.isOp(",")) {
              this.next();
              if (this.isOp(")")) break;
              items.push(this.expr());
            }
            this.expectOp(")");
            return { t: "list", items };
          }
          this.expectOp(")");
          return inner;
        }
        if (t.v === "[") {
          const items: Node[] = [];
          if (!this.isOp("]")) {
            const first = this.expr();
            if (this.isKw("for")) {
              const comp = this.comprehension(first);
              this.expectOp("]");
              return comp;
            }
            items.push(first);
            while (this.isOp(",")) {
              this.next();
              if (this.isOp("]")) break;
              items.push(this.expr());
            }
          }
          this.expectOp("]");
          return { t: "list", items };
        }
        if (t.v === "{") {
          const entries: { key: Node; value: Node }[] = [];
          while (!this.isOp("}")) {
            const key = this.expr();
            this.expectOp(":");
            entries.push({ key, value: this.expr() });
            if (!this.isOp(",")) break;
            this.next();
          }
          this.expectOp("}");
          return { t: "dict", entries };
        }
        throw new FormulaSyntaxError(`Unexpected "${t.v}"`, t.pos);
      case "nl":
        throw new FormulaSyntaxError("Unexpected line break", t.pos);
      case "eof":
        throw new FormulaSyntaxError("Formula is incomplete", t.pos);
    }
  }
}

/** f"Total: {$Amount:,.2f}" → literal parts and embedded expressions. */
function parseFString(text: string, pos: number): Node {
  const parts: (string | { expr: Node; spec: string })[] = [];
  let lit = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" && text[i + 1] === "{") {
      lit += "{";
      i += 2;
    } else if (ch === "}" && text[i + 1] === "}") {
      lit += "}";
      i += 2;
    } else if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      let quote: string | null = null;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "{" || c === "[" || c === "(") depth++;
        else if (c === "}" || c === "]" || c === ")") depth--;
        if (depth > 0) j++;
      }
      if (depth > 0) throw new FormulaSyntaxError("Unclosed { in f-string", pos);
      const inner = text.slice(i + 1, j);
      // A format spec follows the last top-level ":" (not inside brackets or strings).
      let split = -1;
      let d = 0;
      let q: string | null = null;
      for (let k = 0; k < inner.length; k++) {
        const c = inner[k];
        if (q) {
          if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if ("([{".includes(c)) d++;
        else if (")]}".includes(c)) d--;
        else if (c === ":" && d === 0 && inner[k + 1] !== "=") split = k;
      }
      const exprText = split >= 0 ? inner.slice(0, split) : inner;
      const spec = split >= 0 ? inner.slice(split + 1) : "";
      if (lit) parts.push(lit);
      lit = "";
      parts.push({ expr: new Parser(tokenize(exprText), NaN).parseAll(), spec });
      i = j + 1;
    } else {
      lit += ch;
      i++;
    }
  }
  if (lit) parts.push(lit);
  return { t: "fstr", parts };
}

const cache = new Map<string, Node | FormulaSyntaxError>();

/**
 * One expression (newlines are whitespace, as before) when that parses;
 * otherwise a multi-line program. A lone `return x` is the expression x.
 */
function parseText(text: string, base: number): Node {
  const trimmed = text.trim();
  if (!trimmed) return { t: "const", v: null };
  const lead = text.length - text.trimStart().length;
  const ret = /^return\s+/.exec(trimmed);
  const single = ret ? trimmed.slice(ret[0].length) : trimmed;
  try {
    return new Parser(tokenize(single), base + lead + (ret ? ret[0].length : 0)).parseAll();
  } catch (first) {
    if (!(first instanceof FormulaSyntaxError)) throw first;
    // Only fall back to statements when the text looks like a program.
    if (!/\n|^\s*(if|for|return|pass)\b|(^|[^=!<>])=($|[^=])|[+\-*/]=|;/.test(trimmed)) throw first;
    try {
      // Indentation is measured relative to the first line, so the text is used
      // as it is and token positions stay offsets into the source.
      return new Parser(tokenize(text, true), base).parseProgram();
    } catch (second) {
      throw second instanceof FormulaSyntaxError ? second : first;
    }
  }
}

/** Parses a formula, accepting an optional leading "=" or "return". Cached. */
export function parseFormula(src: string): Node {
  let hit = cache.get(src);
  if (!hit) {
    let text = src.replace(/\s+$/, "");
    let base = 0;
    if (text.trimStart().startsWith("=")) {
      base = text.length - text.trimStart().length + 1;
      text = text.trimStart().slice(1);
    }
    try {
      hit = parseText(text, base);
    } catch (e) {
      hit = e instanceof FormulaSyntaxError ? e : new FormulaSyntaxError(String(e), 0);
    }
    if (cache.size > 5000) cache.clear();
    cache.set(src, hit);
  }
  if (hit instanceof FormulaSyntaxError) throw hit;
  return hit;
}

/** Column identifiers referenced as $Name anywhere in a formula. */
export function referencedColumns(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
  return [...out];
}

/** Renames `$Old` references (not inside strings) when a column is renamed. */
export function renameColumnInFormula(src: string, oldId: string, newId: string): string {
  return replaceOutsideStrings(src, new RegExp(`\\$${oldId}\\b`, "g"), `$${newId}`);
}

/** Renames a table used as `Old.lookupRecords(...)` etc. */
export function renameTableInFormula(src: string, oldId: string, newId: string): string {
  return replaceOutsideStrings(src, new RegExp(`(?<![$.\\w])${oldId}\\b`, "g"), newId);
}

function replaceOutsideStrings(src: string, re: RegExp, replacement: string): string {
  const parts = src.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
  return parts.map((p, i) => (i % 2 === 1 ? p : p.replace(re, replacement))).join("");
}
