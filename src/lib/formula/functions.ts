// Built-in functions available in formulas. Names are matched
// case-insensitively, so SUM, Sum and sum all work.
import {
  Callable,
  FormulaError,
  RecordRef,
  RecordSet,
  dateToIso,
  flatten,
  isDate,
  isEmptyValue,
  parseIsoDate,
  toNumber,
  truthy,
} from "./values";

export function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isDate(v)) {
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? dateToIso(v) : iso.replace("T", " ").slice(0, 19);
  }
  if (v instanceof RecordRef) return v.rowId ? `#${v.rowId}` : "";
  if (v instanceof RecordSet) return v.ids.map((id) => `#${id}`).join(", ");
  if (Array.isArray(v)) return v.map(toText).join(", ");
  return String(v);
}

function nums(args: unknown[]): number[] {
  return flatten(args)
    .map((v) => (typeof v === "number" ? v : typeof v === "boolean" ? null : toNumber(v)))
    .filter((n): n is number => n !== null);
}

function num(v: unknown, name = "value"): number {
  const n = toNumber(v);
  if (n === null) throw new FormulaError("#TypeError", `Expected a number for ${name}`);
  return n;
}

function str(v: unknown): string {
  return toText(v);
}

function date(v: unknown): Date {
  if (isDate(v)) return v;
  if (typeof v === "string") {
    const d = parseIsoDate(v) ?? new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  throw new FormulaError("#TypeError", "Expected a date");
}

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  target.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return target;
}

function round(n: number, digits = 0): number {
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}

const F: Record<string, Callable> = {
  // ---- math
  SUM: (a) => nums(a).reduce((s, n) => s + n, 0),
  AVERAGE: (a) => {
    const n = nums(a);
    if (!n.length) throw new FormulaError("#DIV/0!", "AVERAGE of no numbers");
    return n.reduce((s, x) => s + x, 0) / n.length;
  },
  MIN: (a) => (nums(a).length ? Math.min(...nums(a)) : 0),
  MAX: (a) => (nums(a).length ? Math.max(...nums(a)) : 0),
  MEDIAN: (a) => {
    const n = nums(a).sort((x, y) => x - y);
    if (!n.length) return null;
    const mid = Math.floor(n.length / 2);
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
  },
  COUNT: (a) => nums(a).length,
  COUNTA: (a) => flatten(a).filter((v) => !isEmptyValue(v)).length,
  PRODUCT: (a) => nums(a).reduce((s, n) => s * n, 1),
  ROUND: ([v, d]) => round(num(v), d === undefined ? 0 : num(d)),
  ROUNDUP: ([v, d]) => {
    const f = Math.pow(10, d === undefined ? 0 : num(d));
    const n = num(v);
    return (n < 0 ? -Math.ceil(-n * f) : Math.ceil(n * f)) / f;
  },
  ROUNDDOWN: ([v, d]) => Math.trunc(num(v) * Math.pow(10, d === undefined ? 0 : num(d))) / Math.pow(10, d === undefined ? 0 : num(d)),
  INT: ([v]) => Math.floor(num(v)),
  ABS: ([v]) => Math.abs(num(v)),
  SQRT: ([v]) => Math.sqrt(num(v)),
  POWER: ([a, b]) => Math.pow(num(a), num(b)),
  MOD: ([a, b]) => {
    const d = num(b);
    if (d === 0) throw new FormulaError("#DIV/0!", "Division by zero");
    return ((num(a) % d) + d) % d;
  },
  CEILING: ([v, s]) => {
    const step = s === undefined ? 1 : num(s);
    return Math.ceil(num(v) / step) * step;
  },
  FLOOR: ([v, s]) => {
    const step = s === undefined ? 1 : num(s);
    return Math.floor(num(v) / step) * step;
  },
  VALUE: ([v]) => num(v),

  // ---- logic
  NOT: ([v]) => !truthy(v),
  AND: (a) => flatten(a).every(truthy),
  OR: (a) => flatten(a).some(truthy),
  ISBLANK: ([v]) => isEmptyValue(v),
  ISNUMBER: ([v]) => typeof v === "number",
  ISTEXT: ([v]) => typeof v === "string",
  SWITCH: (a) => {
    const [value, ...rest] = a;
    for (let i = 0; i + 1 < rest.length; i += 2) if (rest[i] === value) return rest[i + 1];
    return rest.length % 2 ? rest[rest.length - 1] : null;
  },

  // ---- text
  LEN: ([v]) => (v instanceof RecordSet ? v.ids.length : Array.isArray(v) ? v.length : str(v).length),
  UPPER: ([v]) => str(v).toUpperCase(),
  LOWER: ([v]) => str(v).toLowerCase(),
  PROPER: ([v]) => str(v).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
  TRIM: ([v]) => str(v).trim().replace(/\s+/g, " "),
  CONCAT: (a) => flatten(a).map(str).join(""),
  CONCATENATE: (a) => flatten(a).map(str).join(""),
  JOIN: ([list, sep]) => flatten([list]).map(str).join(sep === undefined ? ", " : str(sep)),
  LEFT: ([v, n]) => str(v).slice(0, n === undefined ? 1 : num(n)),
  RIGHT: ([v, n]) => {
    const s = str(v);
    const k = n === undefined ? 1 : num(n);
    return k <= 0 ? "" : s.slice(-k);
  },
  MID: ([v, start, n]) => str(v).substr(num(start) - 1, num(n)),
  FIND: ([needle, hay, start]) => {
    const i = str(hay).indexOf(str(needle), start === undefined ? 0 : num(start) - 1);
    if (i < 0) throw new FormulaError("#VALUE!", "Text not found");
    return i + 1;
  },
  SUBSTITUTE: ([v, oldText, newText]) => str(v).split(str(oldText)).join(str(newText)),
  REPT: ([v, n]) => str(v).repeat(Math.max(0, num(n))),
  CONTAINS: ([hay, needle]) => {
    if (hay instanceof RecordSet) return needle instanceof RecordRef && hay.ids.includes(needle.rowId);
    if (Array.isArray(hay)) return hay.some((x) => x === needle || (x instanceof RecordRef && needle instanceof RecordRef && x.rowId === needle.rowId));
    return str(hay).toLowerCase().includes(str(needle).toLowerCase());
  },
  SPLIT: ([v, sep]) => str(v).split(sep === undefined ? "," : str(sep)).map((s) => s.trim()),
  TEXT: ([v]) => str(v),

  // ---- dates
  TODAY: () => {
    const now = new Date();
    return utcDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  },
  NOW: () => new Date(),
  DATE: ([y, m, d]) => utcDate(num(y), num(m), num(d)),
  DATEVALUE: ([v]) => date(v),
  YEAR: ([v]) => date(v).getUTCFullYear(),
  MONTH: ([v]) => date(v).getUTCMonth() + 1,
  DAY: ([v]) => date(v).getUTCDate(),
  WEEKDAY: ([v]) => date(v).getUTCDay() + 1,
  HOUR: ([v]) => date(v).getUTCHours(),
  MINUTE: ([v]) => date(v).getUTCMinutes(),
  DAYS: ([end, start]) => Math.round((date(end).getTime() - date(start).getTime()) / 86400000),
  EDATE: ([v, months]) => addMonths(date(v), num(months)),
  EOMONTH: ([v, months]) => {
    const d = addMonths(date(v), num(months ?? 0));
    return utcDate(d.getUTCFullYear(), d.getUTCMonth() + 2, 0);
  },
  DATEADD: ([v, ...rest], kw) => {
    let d = date(v);
    const days = num(kw.days ?? rest[0] ?? 0);
    const months = num(kw.months ?? rest[1] ?? 0);
    const years = num(kw.years ?? rest[2] ?? 0);
    const weeks = num(kw.weeks ?? 0);
    d = addMonths(d, months + years * 12);
    return new Date(d.getTime() + (days + weeks * 7) * 86400000);
  },
  DATEDIF: ([start, end, unit]) => {
    const a = date(start);
    const b = date(end);
    const u = str(unit ?? "D").toUpperCase();
    if (u === "Y") return b.getUTCFullYear() - a.getUTCFullYear() - (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate()) ? 1 : 0);
    if (u === "M") return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
    return Math.floor((b.getTime() - a.getTime()) / 86400000);
  },

  // ---- lists
  UNIQUE: ([v]) => {
    const seen = new Set<string>();
    return flatten([v]).filter((x) => {
      const k = x instanceof RecordRef ? `r${x.rowId}` : JSON.stringify(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
  COUNTIF: ([list, value]) => flatten([list]).filter((x) => x === value).length,
  SUMIF: ([list, value, sumList]) => {
    const a = flatten([list]);
    const b = sumList === undefined ? a : flatten([sumList]);
    let total = 0;
    a.forEach((x, i) => {
      if (x === value) total += toNumber(b[i]) ?? 0;
    });
    return total;
  },
  SORTED: ([v], kw) => {
    const items = flatten([v]);
    const sorted = [...items].sort((x, y) => {
      const nx = toNumber(x);
      const ny = toNumber(y);
      if (nx !== null && ny !== null) return nx - ny;
      return str(x).localeCompare(str(y));
    });
    return truthy(kw.reverse) ? sorted.reverse() : sorted;
  },

  // ---- python-style conversions
  STR: ([v]) => str(v),
  FLOAT: ([v]) => num(v),
  BOOL: ([v]) => truthy(v),
};

// Python builtins that differ from the Excel names.
F.AVG = F.AVERAGE;
F.LIST = ([v]) => flatten([v]);

export function lookupFunction(name: string): Callable | undefined {
  return F[name.toUpperCase()];
}

export const FUNCTION_NAMES = Object.keys(F).sort();

/** Methods callable on strings, e.g. $Name.upper(). */
export function stringMethod(s: string, name: string): Callable | undefined {
  switch (name) {
    case "upper":
      return () => s.toUpperCase();
    case "lower":
      return () => s.toLowerCase();
    case "strip":
      return () => s.trim();
    case "title":
      return () => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    case "capitalize":
      return () => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    case "replace":
      return ([a, b]) => s.split(str(a)).join(str(b));
    case "split":
      return ([sep]) => (sep === undefined ? s.trim().split(/\s+/) : s.split(str(sep)));
    case "startswith":
      return ([p]) => s.startsWith(str(p));
    case "endswith":
      return ([p]) => s.endsWith(str(p));
    case "find":
      return ([p]) => s.indexOf(str(p));
    case "count":
      return ([p]) => s.split(str(p)).length - 1;
  }
  return undefined;
}
