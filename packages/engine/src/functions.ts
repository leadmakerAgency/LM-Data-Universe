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
import { zonedParts } from "./zone";

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
  LEN: ([v]) => (v instanceof RecordSet ? v.ids.length : Array.isArray(v) ? v.length : v instanceof Map ? v.size : str(v).length),
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
  TEXT: ([v, fmt]) => (fmt === undefined || fmt === null || fmt === "" ? str(v) : excelFormat(v, str(fmt))),

  // ---- dates
  // TODAY(tz): today's date in a time zone ("Europe/Amsterdam"); the engine
  // passes the document's zone when none is given.
  TODAY: ([tzArg], kw) => {
    const tz = kw.tz ?? tzArg;
    let p;
    try {
      p = zonedParts(new Date(), tz === null || tz === undefined || tz === "" ? null : str(tz));
    } catch {
      throw new FormulaError("#ValueError", `Unknown time zone "${str(tz)}"`);
    }
    return utcDate(p.y, p.m, p.d);
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

// ---------------------------------------------------------------------------
// Phase 1 additions: more math, statistics, text, regex, dates and Python
// builtins (Grist's library covers ~150 functions; these bring ours level).

function list(v: unknown): unknown[] {
  return flatten([v]);
}

/** Excel-style criteria: 5, ">5", "<>x", "a*" (wildcards), or a plain value. */
function matcher(criteria: unknown): (v: unknown) => boolean {
  if (typeof criteria === "function") return (v) => truthy((criteria as Callable)([v], {}));
  if (typeof criteria !== "string") return (v) => v === criteria || (v instanceof RecordRef && v.rowId === criteria);
  const m = /^(<=|>=|<>|=|<|>)(.*)$/.exec(criteria);
  const op = m ? m[1] : "=";
  const raw = m ? m[2] : criteria;
  const n = toNumber(raw);
  if (op !== "=" && op !== "<>" && n !== null) {
    return (v) => {
      const x = isDate(v) ? v.getTime() / 86400000 : toNumber(v);
      if (x === null) return false;
      return op === "<" ? x < n : op === ">" ? x > n : op === "<=" ? x <= n : x >= n;
    };
  }
  const wild = /[*?]/.test(raw);
  const re = wild ? new RegExp(`^${raw.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i") : null;
  const eq = (v: unknown) =>
    re ? re.test(str(v)) : n !== null && typeof v === "number" ? v === n : str(v).toLowerCase() === raw.toLowerCase();
  return op === "<>" ? (v) => !eq(v) : eq;
}

/** Indexes of items in ranges that match every (range, criteria) pair. */
function matchAll(pairs: unknown[]): number[] | null {
  if (!pairs.length) return null;
  const ranges: unknown[][] = [];
  const tests: ((v: unknown) => boolean)[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    ranges.push(list(pairs[i]));
    tests.push(matcher(pairs[i + 1]));
  }
  const n = ranges[0].length;
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (ranges.every((r, j) => tests[j](r[k]))) out.push(k);
  return out;
}

function mean(n: number[]): number {
  if (!n.length) throw new FormulaError("#DIV/0!", "No numbers to average");
  return n.reduce((s, x) => s + x, 0) / n.length;
}

function variance(n: number[], sample: boolean): number {
  if (n.length < (sample ? 2 : 1)) throw new FormulaError("#DIV/0!", "Not enough numbers");
  const m = mean(n);
  return n.reduce((s, x) => s + (x - m) ** 2, 0) / (n.length - (sample ? 1 : 0));
}

function percentile(n: number[], p: number): number {
  if (!n.length) throw new FormulaError("#NUM!", "No numbers");
  if (p < 0 || p > 1) throw new FormulaError("#NUM!", "Percentile must be between 0 and 1");
  const s = [...n].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

function gcd(a: number, b: number): number {
  a = Math.abs(Math.trunc(a));
  b = Math.abs(Math.trunc(b));
  while (b) [a, b] = [b, a % b];
  return a;
}

function regex(pattern: unknown, flags = ""): RegExp {
  try {
    return new RegExp(str(pattern), flags);
  } catch {
    throw new FormulaError("#VALUE!", `Invalid regular expression: ${str(pattern)}`);
  }
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function holidaySet(h: unknown): Set<number> {
  return new Set(list(h).filter(isDate).map((d) => Math.floor((d as Date).getTime() / 86400000)));
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
}

const MORE: Record<string, Callable> = {
  // ---- math
  SUMPRODUCT: (a) => {
    const lists = a.map(list);
    const n = Math.min(...lists.map((l) => l.length));
    let total = 0;
    for (let i = 0; i < n; i++) total += lists.reduce((p, l) => p * (toNumber(l[i]) ?? 0), 1);
    return total;
  },
  SUMSQ: (a) => nums(a).reduce((s, n) => s + n * n, 0),
  EXP: ([v]) => Math.exp(num(v)),
  LN: ([v]) => {
    const n = num(v);
    if (n <= 0) throw new FormulaError("#NUM!", "LN needs a positive number");
    return Math.log(n);
  },
  LOG: ([v, b]) => {
    const n = num(v);
    if (n <= 0) throw new FormulaError("#NUM!", "LOG needs a positive number");
    return Math.log(n) / Math.log(b === undefined ? 10 : num(b));
  },
  LOG10: ([v]) => Math.log10(num(v)),
  PI: () => Math.PI,
  SIGN: ([v]) => Math.sign(num(v)),
  TRUNC: ([v, d]) => {
    const f = Math.pow(10, d === undefined ? 0 : num(d));
    return Math.trunc(num(v) * f) / f;
  },
  EVEN: ([v]) => {
    const n = num(v);
    const r = Math.ceil(Math.abs(n) / 2) * 2;
    return n < 0 ? -r : r;
  },
  ODD: ([v]) => {
    const n = num(v);
    let r = Math.ceil(Math.abs(n));
    if (r % 2 === 0) r += 1;
    return n < 0 ? -r : r;
  },
  ISEVEN: ([v]) => Math.trunc(num(v)) % 2 === 0,
  ISODD: ([v]) => Math.abs(Math.trunc(num(v)) % 2) === 1,
  GCD: (a) => nums(a).reduce((g, n) => gcd(g, n), 0),
  LCM: (a) => nums(a).reduce((l, n) => (l === 0 || n === 0 ? 0 : Math.abs(l * n) / gcd(l, n)), 1),
  FACT: ([v]) => {
    const n = Math.trunc(num(v));
    if (n < 0) throw new FormulaError("#NUM!", "FACT needs a non-negative number");
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  },
  RAND: () => Math.random(),
  RANDBETWEEN: ([lo, hi]) => {
    const a = Math.ceil(num(lo));
    const b = Math.floor(num(hi));
    return a + Math.floor(Math.random() * (b - a + 1));
  },
  MROUND: ([v, m]) => {
    const step = num(m);
    return step === 0 ? 0 : round(Math.round(num(v) / step) * step, 10);
  },
  QUOTIENT: ([a, b]) => {
    const d = num(b);
    if (d === 0) throw new FormulaError("#DIV/0!", "Division by zero");
    return Math.trunc(num(a) / d);
  },
  SIN: ([v]) => Math.sin(num(v)),
  COS: ([v]) => Math.cos(num(v)),
  TAN: ([v]) => Math.tan(num(v)),
  ASIN: ([v]) => Math.asin(num(v)),
  ACOS: ([v]) => Math.acos(num(v)),
  ATAN: ([v]) => Math.atan(num(v)),
  ATAN2: ([x, y]) => Math.atan2(num(y), num(x)),
  DEGREES: ([v]) => (num(v) * 180) / Math.PI,
  RADIANS: ([v]) => (num(v) * Math.PI) / 180,
  SQRTPI: ([v]) => Math.sqrt(num(v) * Math.PI),

  // ---- statistics
  AVERAGEA: (a) => mean(flatten(a).filter((v) => !isEmptyValue(v)).map((v) => toNumber(v) ?? 0)),
  AVERAGEIF: ([range, criteria, avgRange]) => {
    const r = list(range);
    const vals = avgRange === undefined ? r : list(avgRange);
    const t = matcher(criteria);
    return mean(r.flatMap((x, i) => (t(x) && toNumber(vals[i]) !== null ? [toNumber(vals[i])!] : [])));
  },
  AVERAGEIFS: ([avgRange, ...pairs]) => {
    const vals = list(avgRange);
    return mean((matchAll(pairs) ?? []).flatMap((i) => (toNumber(vals[i]) !== null ? [toNumber(vals[i])!] : [])));
  },
  SUMIFS: ([sumRange, ...pairs]) => {
    const vals = list(sumRange);
    return (matchAll(pairs) ?? []).reduce((s, i) => s + (toNumber(vals[i]) ?? 0), 0);
  },
  COUNTIFS: (pairs) => (matchAll(pairs) ?? []).length,
  COUNTBLANK: (a) => flatten(a).filter(isEmptyValue).length,
  MAXA: (a) => {
    const n = flatten(a).filter((v) => !isEmptyValue(v)).map((v) => toNumber(v) ?? 0);
    return n.length ? Math.max(...n) : 0;
  },
  MINA: (a) => {
    const n = flatten(a).filter((v) => !isEmptyValue(v)).map((v) => toNumber(v) ?? 0);
    return n.length ? Math.min(...n) : 0;
  },
  STDEV: (a) => Math.sqrt(variance(nums(a), true)),
  STDEVP: (a) => Math.sqrt(variance(nums(a), false)),
  VAR: (a) => variance(nums(a), true),
  VARP: (a) => variance(nums(a), false),
  MODE: (a) => {
    const counts = new Map<number, number>();
    for (const n of nums(a)) counts.set(n, (counts.get(n) ?? 0) + 1);
    let best: number | null = null;
    let most = 1;
    for (const [n, c] of counts) if (c > most) [best, most] = [n, c];
    if (best === null) throw new FormulaError("#N/A", "No value repeats");
    return best;
  },
  LARGE: ([v, k]) => {
    const s = nums([v]).sort((a, b) => b - a);
    const i = num(k) - 1;
    if (i < 0 || i >= s.length) throw new FormulaError("#NUM!", "k is out of range");
    return s[i];
  },
  SMALL: ([v, k]) => {
    const s = nums([v]).sort((a, b) => a - b);
    const i = num(k) - 1;
    if (i < 0 || i >= s.length) throw new FormulaError("#NUM!", "k is out of range");
    return s[i];
  },
  PERCENTILE: ([v, p]) => percentile(nums([v]), num(p)),
  QUARTILE: ([v, q]) => percentile(nums([v]), num(q) / 4),
  GEOMEAN: (a) => {
    const n = nums(a);
    if (!n.length || n.some((x) => x <= 0)) throw new FormulaError("#NUM!", "GEOMEAN needs positive numbers");
    return Math.exp(n.reduce((s, x) => s + Math.log(x), 0) / n.length);
  },
  CORREL: ([a, b]) => {
    const x = list(a).map((v) => toNumber(v));
    const y = list(b).map((v) => toNumber(v));
    const pairs = x.flatMap((v, i) => (v !== null && y[i] !== null ? [[v, y[i]!]] : []));
    if (pairs.length < 2) throw new FormulaError("#DIV/0!", "Not enough pairs");
    const mx = mean(pairs.map((p) => p[0]));
    const my = mean(pairs.map((p) => p[1]));
    let sxy = 0, sxx = 0, syy = 0;
    for (const [p, q] of pairs) {
      sxy += (p - mx) * (q - my);
      sxx += (p - mx) ** 2;
      syy += (q - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
  },

  // ---- logic and info
  IFS: (a) => {
    for (let i = 0; i + 1 < a.length; i += 2) if (truthy(a[i])) return a[i + 1];
    throw new FormulaError("#N/A", "No condition was true");
  },
  XOR: (a) => flatten(a).filter(truthy).length % 2 === 1,
  TRUE: () => true,
  FALSE: () => false,
  ISLOGICAL: ([v]) => typeof v === "boolean",
  ISNONTEXT: ([v]) => typeof v !== "string",
  ISREF: ([v]) => v instanceof RecordRef,
  ISREFLIST: ([v]) => v instanceof RecordSet,
  ISEMAIL: ([v]) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str(v)),
  ISURL: ([v]) => /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/\S*)?$/i.test(str(v)),
  ISDATE: ([v]) => isDate(v),
  NA: () => {
    throw new FormulaError("#N/A", "Value not available");
  },
  CHOOSE: ([i, ...options]) => {
    const k = num(i);
    if (k < 1 || k > options.length) throw new FormulaError("#VALUE!", "CHOOSE index out of range");
    return options[k - 1];
  },

  // ---- text
  CHAR: ([v]) => String.fromCharCode(num(v)),
  UNICHAR: ([v]) => String.fromCodePoint(num(v)),
  CODE: ([v]) => str(v).charCodeAt(0) || 0,
  UNICODE: ([v]) => str(v).codePointAt(0) ?? 0,
  CLEAN: ([v]) => str(v).replace(/[\x00-\x1f\x7f]/g, ""),
  EXACT: ([a, b]) => str(a) === str(b),
  REPLACE: ([v, start, n, text]) => {
    const s = str(v);
    const i = num(start) - 1;
    return s.slice(0, i) + str(text) + s.slice(i + num(n));
  },
  SEARCH: ([needle, hay, start]) => {
    const i = str(hay).toLowerCase().indexOf(str(needle).toLowerCase(), start === undefined ? 0 : num(start) - 1);
    if (i < 0) throw new FormulaError("#VALUE!", "Text not found");
    return i + 1;
  },
  T: ([v]) => (typeof v === "string" ? v : ""),
  TEXTJOIN: ([sep, ignoreEmpty, ...items]) =>
    flatten(items)
      .filter((v) => !truthy(ignoreEmpty) || !isEmptyValue(v))
      .map(str)
      .join(str(sep)),
  FIXED: ([v, d, noCommas]) => {
    const digits = d === undefined ? 2 : num(d);
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: Math.max(0, digits), maximumFractionDigits: Math.max(0, digits), useGrouping: !truthy(noCommas) }).format(round(num(v), digits));
  },
  DOLLAR: ([v, d]) => {
    const digits = d === undefined ? 2 : num(d);
    const n = round(num(v), digits);
    const text = new Intl.NumberFormat("en-US", { minimumFractionDigits: Math.max(0, digits), maximumFractionDigits: Math.max(0, digits) }).format(Math.abs(n));
    return n < 0 ? `($${text})` : `$${text}`;
  },
  LEFTPAD: ([v, n, ch]) => str(v).padStart(num(n), ch === undefined ? " " : str(ch)),
  REGEXEXTRACT: ([v, pattern]) => {
    const m = regex(pattern).exec(str(v));
    if (!m) throw new FormulaError("#N/A", "No match");
    return m.length > 1 ? (m.length === 2 ? m[1] : m.slice(1)) : m[0];
  },
  REGEXMATCH: ([v, pattern]) => regex(pattern).test(str(v)),
  REGEXREPLACE: ([v, pattern, replacement]) => str(v).replace(regex(pattern, "g"), str(replacement).replace(/\\(\d)/g, "$$$1")),
  SPLITPART: ([v, sep, i]) => str(v).split(str(sep))[num(i) - 1] ?? "",

  // ---- dates
  SECOND: ([v]) => date(v).getUTCSeconds(),
  ISOWEEKNUM: ([v]) => isoWeek(date(v)),
  WEEKNUM: ([v, type]) => {
    const d = date(v);
    const startDay = type === undefined || num(type) === 1 ? 0 : 1;
    const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const offset = (jan1.getUTCDay() - startDay + 7) % 7;
    return Math.floor(((d.getTime() - jan1.getTime()) / 86400000 + offset) / 7) + 1;
  },
  WORKDAY: ([start, days, holidays]) => {
    let d = date(start);
    let n = num(days);
    const skip = holidaySet(holidays);
    const step = n < 0 ? -1 : 1;
    while (n !== 0) {
      d = new Date(d.getTime() + step * 86400000);
      if (!isWeekend(d) && !skip.has(Math.floor(d.getTime() / 86400000))) n -= step;
    }
    return d;
  },
  NETWORKDAYS: ([start, end, holidays]) => {
    let a = date(start);
    let b = date(end);
    const sign = a <= b ? 1 : -1;
    if (sign < 0) [a, b] = [b, a];
    const skip = holidaySet(holidays);
    let count = 0;
    for (let t = a.getTime(); t <= b.getTime(); t += 86400000) {
      const d = new Date(t);
      if (!isWeekend(d) && !skip.has(Math.floor(t / 86400000))) count++;
    }
    return sign * count;
  },
  YEARFRAC: ([start, end]) => Math.abs(date(end).getTime() - date(start).getTime()) / (86400000 * 365.25),
  TIME: ([h, m, s]) => new Date(Date.UTC(1970, 0, 1, num(h), num(m), s === undefined ? 0 : num(s))),
  DATETIME: ([y, mo, d, h, mi, s]) => new Date(Date.UTC(num(y), num(mo) - 1, num(d), h === undefined ? 0 : num(h), mi === undefined ? 0 : num(mi), s === undefined ? 0 : num(s))),
  DTIME: ([v]) => date(v),
  DATE_TO_XL: ([v]) => date(v).getTime() / 86400000 + 25569,
  XL_TO_DATE: ([v]) => new Date((num(v) - 25569) * 86400000),
  MONTHNAME: ([v]) => date(v).toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
  DAYNAME: ([v]) => date(v).toLocaleString("en-US", { weekday: "long", timeZone: "UTC" }),
  QUARTER: ([v]) => Math.floor(date(v).getUTCMonth() / 3) + 1,
  STARTOFMONTH: ([v]) => {
    const d = date(v);
    return utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  },
  STARTOFWEEK: ([v]) => {
    const d = date(v);
    const day = (d.getUTCDay() + 6) % 7;
    return utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate() - day);
  },
  ISLEAPYEAR: ([v]) => {
    const y = isDate(v) ? v.getUTCFullYear() : num(v);
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  },

  // ---- lists and Python builtins
  LEN: F.LEN,
  RANGE: ([a, b, step]) => {
    const start = b === undefined ? 0 : num(a);
    const stop = b === undefined ? num(a) : num(b);
    const st = step === undefined ? 1 : num(step);
    if (st === 0) throw new FormulaError("#ValueError", "range() step can't be zero");
    const out: number[] = [];
    for (let i = start; st > 0 ? i < stop : i > stop; i += st) {
      out.push(i);
      if (out.length > 100_000) throw new FormulaError("#Error", "range() is too long");
    }
    return out;
  },
  ANY: ([v]) => list(v).some(truthy),
  ALL: ([v]) => list(v).every(truthy),
  SET: ([v]) => F.UNIQUE([v], {}),
  ZIP: (a) => {
    const lists = a.map(list);
    const n = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
    return Array.from({ length: n }, (_, i) => lists.map((l) => l[i]));
  },
  ENUMERATE: ([v, start]) => list(v).map((x, i) => [i + (start === undefined ? 0 : num(start)), x]),
  REVERSED: ([v]) => [...list(v)].reverse(),
  FIRST: ([v]) => list(v)[0] ?? null,
  LAST: ([v]) => {
    const l = list(v);
    return l.length ? l[l.length - 1] : null;
  },
  COUNTUNIQUE: ([v]) => (F.UNIQUE([v], {}) as unknown[]).length,
  FILTER: ([a, b]) => {
    // FILTER(items, fn), or Python's filter(fn, items).
    const [v, fn] = typeof a === "function" ? [b, a] : [a, b];
    if (typeof fn !== "function") throw new FormulaError("#TypeError", "FILTER needs a function, e.g. FILTER(items, lambda x: x > 0)");
    return list(v).filter((x) => truthy((fn as Callable)([x], {})));
  },
  MAP: ([a, b]) => {
    // MAP(items, fn), or Python's map(fn, items).
    const [v, fn] = typeof a === "function" ? [b, a] : [a, b];
    if (typeof fn !== "function") throw new FormulaError("#TypeError", "MAP needs a function, e.g. MAP(items, lambda x: x * 2)");
    return list(v).map((x) => (fn as Callable)([x], {}));
  },
};

Object.assign(F, MORE);

// SORTED with Python's key= and reverse=; MIN/MAX/SUM keep their Excel behaviour.
F.SORTED = ([v], kw) => {
  const items = list(v);
  const key = typeof kw.key === "function" ? (x: unknown) => (kw.key as Callable)([x], {}) : (x: unknown) => x;
  const keyed = items.map((x) => [key(x), x] as const);
  keyed.sort(([a], [b]) => {
    const na = isDate(a) ? a.getTime() : toNumber(a);
    const nb = isDate(b) ? b.getTime() : toNumber(b);
    if (typeof a !== "string" && typeof b !== "string" && na !== null && nb !== null) return na - nb;
    return str(a).localeCompare(str(b));
  });
  const out = keyed.map(([, x]) => x);
  return truthy(kw.reverse) ? out.reverse() : out;
};
F.COUNTIF = ([range, criteria]) => list(range).filter(matcher(criteria)).length;
F.SUMIF = ([range, criteria, sumRange]) => {
  const r = list(range);
  const vals = sumRange === undefined ? r : list(sumRange);
  const t = matcher(criteria);
  return r.reduce<number>((s, x, i) => (t(x) ? s + (toNumber(vals[i]) ?? 0) : s), 0);
};

// Python builtins that differ from the Excel names.
F.AVG = F.AVERAGE;
F.LIST = ([v]) => flatten([v]);
F.TUPLE = F.LIST;

export function lookupFunction(name: string): Callable | undefined {
  return F[name.toUpperCase()];
}

export const FUNCTION_NAMES = Object.keys(F).sort();

/** Python format specs used in f-strings: ",", ".2f", ",.0f", ".1%", ">10", "05d". */
export function formatSpec(v: unknown, spec: string): string {
  if (!spec) return str(v);
  const m = /^(?:(.)?([<>^]))?(0)?(\d+)?(,)?(?:\.(\d+))?([fdeg%s])?$/.exec(spec);
  if (!m) return str(v);
  const [, fillCh, align, zero, widthText, comma, precText, type] = m;
  const n = toNumber(v);
  let out: string;
  if (type === "s" || n === null || typeof v === "string") out = str(v);
  else if (type === "%") {
    const p = precText === undefined ? 6 : Number(precText);
    out = new Intl.NumberFormat("en-US", { minimumFractionDigits: p, maximumFractionDigits: p, useGrouping: !!comma }).format(n * 100) + "%";
  } else if (type === "e") out = n.toExponential(precText === undefined ? 6 : Number(precText));
  else {
    const p = type === "d" ? 0 : precText === undefined ? (type === "f" ? 6 : undefined) : Number(precText);
    out = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: p,
      maximumFractionDigits: p ?? 10,
      useGrouping: !!comma,
    }).format(type === "d" ? Math.round(n) : n);
  }
  const width = widthText ? Number(widthText) : 0;
  if (out.length < width) {
    const fill = zero && !align ? "0" : fillCh ?? " ";
    const pad = fill.repeat(width - out.length);
    const al = align ?? (n !== null && typeof v !== "string" ? ">" : "<");
    if (zero && !align && out.startsWith("-")) out = "-" + pad + out.slice(1);
    else if (al === "<") out += pad;
    else if (al === "^") out = pad.slice(0, Math.floor(pad.length / 2)) + out + pad.slice(Math.floor(pad.length / 2));
    else out = pad + out;
  }
  return out;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Excel-style TEXT() formats: "#,##0.00", "0.0%", "000", "$#,##0", and dates such as "yyyy-mm-dd" or "d mmm yyyy hh:mm". */
function excelFormat(v: unknown, fmt: string): string {
  if (isDate(v)) {
    const p2 = (n: number) => String(n).padStart(2, "0");
    const ampm = /am\/pm/i.test(fmt);
    const hours = ampm ? v.getUTCHours() % 12 || 12 : v.getUTCHours();
    let afterHour = false;
    return fmt.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm/gi, (tok) => {
      const t = tok.toLowerCase();
      // "mm" right after hours (hh:mm) means minutes; otherwise the month.
      const minutes = (t === "mm" || t === "m") && afterHour;
      afterHour = t === "hh" || t === "h";
      switch (t) {
        case "yyyy":
          return String(v.getUTCFullYear());
        case "yy":
          return p2(v.getUTCFullYear() % 100);
        case "mmmm":
          return MONTH_NAMES[v.getUTCMonth()];
        case "mmm":
          return MONTH_NAMES[v.getUTCMonth()].slice(0, 3);
        case "mm":
          return minutes ? p2(v.getUTCMinutes()) : p2(v.getUTCMonth() + 1);
        case "m":
          return minutes ? String(v.getUTCMinutes()) : String(v.getUTCMonth() + 1);
        case "dddd":
          return DAY_NAMES[v.getUTCDay()];
        case "ddd":
          return DAY_NAMES[v.getUTCDay()].slice(0, 3);
        case "dd":
          return p2(v.getUTCDate());
        case "d":
          return String(v.getUTCDate());
        case "hh":
          return p2(hours);
        case "h":
          return String(hours);
        case "ss":
          return p2(v.getUTCSeconds());
        case "s":
          return String(v.getUTCSeconds());
        default:
          return v.getUTCHours() < 12 ? "AM" : "PM";
      }
    });
  }
  const n = toNumber(v);
  const m = /[#0][#0,]*(?:\.[#0]+)?/.exec(fmt);
  if (n === null || typeof v === "string" || !m) return str(v);
  const [whole, frac = ""] = m[0].split(".");
  const body = new Intl.NumberFormat("en-US", {
    minimumIntegerDigits: Math.max(1, (whole.match(/0/g) ?? []).length),
    minimumFractionDigits: (frac.match(/0/g) ?? []).length,
    maximumFractionDigits: frac.length,
    useGrouping: whole.includes(","),
  }).format(Math.abs(fmt.includes("%") ? n * 100 : n));
  const sign = n < 0 && /[1-9]/.test(body) ? "-" : "";
  return fmt.slice(0, m.index) + sign + body + fmt.slice(m.index + m[0].length);
}

/** List methods. Lists read from cells are copies, so the changing ones only affect the formula's own list. */
export function listMethod(l: unknown[], name: string): Callable | undefined {
  const same = (y: unknown, x: unknown) => y === x || (y instanceof RecordRef && x instanceof RecordRef && y.rowId === x.rowId);
  const grow = (extra: number) => {
    if (l.length + extra > 100_000) throw new FormulaError("#Error", "The list is too long");
  };
  switch (name) {
    case "append":
      return ([x]) => {
        grow(1);
        l.push(x);
        return null;
      };
    case "extend":
      return ([xs]) => {
        const items = list(xs);
        grow(items.length);
        for (const x of items) l.push(x);
        return null;
      };
    case "insert":
      return ([i, x]) => {
        grow(1);
        l.splice(num(i), 0, x);
        return null;
      };
    case "pop":
      return ([i]) => {
        if (!l.length) throw new FormulaError("#IndexError", "pop from an empty list");
        return i === undefined ? l.pop() : l.splice(num(i), 1)[0];
      };
    case "remove":
      return ([x]) => {
        const i = l.findIndex((y) => same(y, x));
        if (i < 0) throw new FormulaError("#ValueError", "Value is not in the list");
        l.splice(i, 1);
        return null;
      };
    case "reverse":
      return () => {
        l.reverse();
        return null;
      };
    case "sort":
      return (_a, kw) => {
        const sorted = F.SORTED([l], kw) as unknown[];
        l.splice(0, l.length, ...sorted);
        return null;
      };
    case "copy":
      return () => [...l];
    case "index":
      return ([x]) => {
        const i = l.findIndex((y) => y === x || (y instanceof RecordRef && x instanceof RecordRef && y.rowId === x.rowId));
        if (i < 0) throw new FormulaError("#ValueError", "Value is not in the list");
        return i;
      };
    case "count":
      return ([x]) => l.filter((y) => same(y, x)).length;
  }
  return undefined;
}

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
    case "lstrip":
      return ([c]) => (c === undefined ? s.trimStart() : s.replace(new RegExp(`^[${escapeClass(str(c))}]+`), ""));
    case "rstrip":
      return ([c]) => (c === undefined ? s.trimEnd() : s.replace(new RegExp(`[${escapeClass(str(c))}]+$`), ""));
    case "join":
      return ([items]) => flatten([items]).map(str).join(s);
    case "isdigit":
      return () => /^\d+$/.test(s);
    case "isalpha":
      return () => /^[A-Za-z]+$/.test(s);
    case "isupper":
      return () => s === s.toUpperCase() && s !== s.toLowerCase();
    case "islower":
      return () => s === s.toLowerCase() && s !== s.toUpperCase();
    case "zfill":
      return ([w]) => s.padStart(num(w), "0");
    case "ljust":
      return ([w, ch]) => s.padEnd(num(w), ch === undefined ? " " : str(ch));
    case "rjust":
      return ([w, ch]) => s.padStart(num(w), ch === undefined ? " " : str(ch));
    case "center":
      return ([w]) => {
        const total = Math.max(0, num(w) - s.length);
        return " ".repeat(Math.floor(total / 2)) + s + " ".repeat(Math.ceil(total / 2));
      };
    case "format":
      return (args, kw) => {
        let k = 0;
        return s.replace(/\{([^{}]*)\}/g, (_, inner: string) => {
          const [key, spec = ""] = inner.split(":");
          const v = key === "" ? args[k++] : /^\d+$/.test(key) ? args[Number(key)] : kw[key];
          return formatSpec(v, spec);
        });
      };
    case "partition":
      return ([sep]) => {
        const i = s.indexOf(str(sep));
        return i < 0 ? [s, "", ""] : [s.slice(0, i), str(sep), s.slice(i + str(sep).length)];
      };
  }
  return undefined;
}

function escapeClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, "\\$&");
}
