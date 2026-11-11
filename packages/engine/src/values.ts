// Runtime values used while evaluating formulas.

export class RecordRef {
  constructor(public tableRef: string, public rowId: number) {}
}

export class RecordSet {
  constructor(public tableRef: string, public ids: number[]) {}
}

export class TableHandle {
  constructor(public tableRef: string, public name: string) {}
}

export type Callable = (args: unknown[], kwargs: Record<string, unknown>) => unknown;

export class FormulaError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function isDate(v: unknown): v is Date {
  return v instanceof Date && !isNaN(v.getTime());
}

/** "YYYY-MM-DD" (or full ISO) to a Date at UTC midnight / that instant. */
export function parseIsoDate(s: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function dateToIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isEmptyValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (v instanceof RecordRef && !v.rowId) ||
    (v instanceof RecordSet && v.ids.length === 0)
  );
}

export function truthy(v: unknown): boolean {
  if (v instanceof RecordRef) return v.rowId > 0;
  if (v instanceof RecordSet) return v.ids.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

/** Flattens arrays/record sets into a list of plain values. */
export function flatten(values: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    if (Array.isArray(v)) out.push(...flatten(v));
    else if (v instanceof RecordSet) out.push(...v.ids.map((id) => new RecordRef(v.tableRef, id)));
    else out.push(v);
  }
  return out;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,\s]/g, ""));
    return isNaN(n) ? null : n;
  }
  if (isDate(v)) return v.getTime() / 86400000;
  if (v instanceof RecordRef) return v.rowId;
  return null;
}

/** Stable key used to compare values in lookups and grouping. */
export function valueKey(v: unknown): string {
  if (v === null || v === undefined || v === "") return "∅";
  if (v instanceof RecordRef) return `n:${v.rowId}`;
  if (v instanceof RecordSet) return `l:${v.ids.join(",")}`;
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "boolean") return `b:${v}`;
  if (isDate(v)) return `d:${v.toISOString()}`;
  if (Array.isArray(v)) return `l:${v.map(valueKey).join(",")}`;
  return `s:${String(v)}`;
}
