// Parser for the formula language: Python-flavoured expressions with
// Excel-style functions. `$Col` reads a column of the current record,
// `$Customer.Name` follows references, and `Orders.lookupRecords(Customer=$id)`
// queries other tables.

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "const"; v: boolean | null }
  | { t: "col"; name: string }
  | { t: "name"; name: string }
  | { t: "attr"; obj: Node; name: string }
  | { t: "call"; fn: Node; args: Node[]; kwargs: { name: string; value: Node }[] }
  | { t: "index"; obj: Node; index: Node }
  | { t: "list"; items: Node[] }
  | { t: "un"; op: "-" | "+"; arg: Node }
  | { t: "bin"; op: string; left: Node; right: Node }
  | { t: "cmp"; op: string; left: Node; right: Node }
  | { t: "and" | "or"; left: Node; right: Node }
  | { t: "not"; arg: Node }
  | { t: "cond"; test: Node; then: Node; else: Node };

type Tok =
  | { k: "num"; v: number; pos: number }
  | { k: "str"; v: string; pos: number }
  | { k: "ident"; v: string; pos: number }
  | { k: "col"; v: string; pos: number }
  | { k: "op"; v: string; pos: number }
  | { k: "eof"; v: ""; pos: number };

export class FormulaSyntaxError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
  }
}

const OPS = ["**", "//", "==", "!=", "<=", ">=", "<>", "<", ">", "=", "+", "-", "*", "/", "%", "&", "^", ".", ",", "(", ")", "[", "]"];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      toks.push({ k: "num", v: parseFloat(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
        } else {
          out += src[j++];
        }
      }
      if (j >= src.length) throw new FormulaSyntaxError("Unterminated string", i);
      toks.push({ k: "str", v: out, pos: i });
      i = j + 1;
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
    toks.push({ k: "op", v: op, pos: i });
    i += op.length;
  }
  toks.push({ k: "eof", v: "", pos: src.length });
  return toks;
}

const KEYWORDS = new Set(["and", "or", "not", "if", "else", "in", "is"]);

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

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

  parseAll(): Node {
    const node = this.expr();
    const t = this.peek();
    if (t.k !== "eof") throw new FormulaSyntaxError(`Unexpected "${t.v}"`, t.pos);
    return node;
  }

  expr(): Node {
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
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && ["==", "!=", "<>", "<", ">", "<=", ">=", "="].includes(t.v)) {
        this.next();
        const op = t.v === "=" ? "==" : t.v === "<>" ? "!=" : t.v;
        left = { t: "cmp", op, left, right: this.concat() };
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
        node = { t: "attr", obj: node, name: t.v };
      } else if (this.isOp("(")) {
        this.next();
        const args: Node[] = [];
        const kwargs: { name: string; value: Node }[] = [];
        while (!this.isOp(")")) {
          const t = this.peek();
          if (t.k === "ident" && this.isOp("=", 1)) {
            this.next();
            this.next();
            kwargs.push({ name: t.v, value: this.expr() });
          } else {
            if (kwargs.length) throw new FormulaSyntaxError("Positional argument after keyword argument", t.pos);
            args.push(this.expr());
          }
          if (!this.isOp(",")) break;
          this.next();
        }
        this.expectOp(")");
        node = { t: "call", fn: node, args, kwargs };
      } else if (this.isOp("[")) {
        this.next();
        const index = this.expr();
        this.expectOp("]");
        node = { t: "index", obj: node, index };
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
      case "str":
        return { t: "str", v: t.v };
      case "col":
        return { t: "col", name: t.v };
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
          const inner = this.expr();
          this.expectOp(")");
          return inner;
        }
        if (t.v === "[") {
          const items: Node[] = [];
          while (!this.isOp("]")) {
            items.push(this.expr());
            if (!this.isOp(",")) break;
            this.next();
          }
          this.expectOp("]");
          return { t: "list", items };
        }
        throw new FormulaSyntaxError(`Unexpected "${t.v}"`, t.pos);
      case "eof":
        throw new FormulaSyntaxError("Formula is incomplete", t.pos);
    }
  }
}

const cache = new Map<string, Node | FormulaSyntaxError>();

/** Parses a formula, accepting an optional leading "=" or "return". Cached. */
export function parseFormula(src: string): Node {
  let hit = cache.get(src);
  if (!hit) {
    let text = src.trim();
    if (text.startsWith("=")) text = text.slice(1);
    text = text.replace(/^return\s+/, "");
    try {
      hit = text ? new Parser(tokenize(text)).parseAll() : { t: "const", v: null };
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
