// Which rows a widget shows: linking, filters, quick search and sort.
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";
import { displayValue } from "./format";
import { FormulaError, RecordRef, RecordSet, isDate, toNumber, valueKey } from "@engine/values";
import type { DateBucket, DocColumn, DocWidget, SortSpec } from "./types";

export interface SummaryGroup {
  key: string;
  values: unknown[];
  rowIds: number[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The start of a date's period, so grouping by month etc. compares equal dates. */
export function bucketDate(v: unknown, bucket: DateBucket | undefined): unknown {
  if (!bucket || !isDate(v)) return v;
  const y = v.getUTCFullYear();
  const m = v.getUTCMonth();
  switch (bucket) {
    case "day":
      return new Date(Date.UTC(y, m, v.getUTCDate()));
    case "week": {
      const day = (v.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(y, m, v.getUTCDate() - day));
    }
    case "month":
      return new Date(Date.UTC(y, m, 1));
    case "quarter":
      return new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1));
    case "year":
      return new Date(Date.UTC(y, 0, 1));
  }
}

/** How a bucketed date is shown: "2026", "Q1 2026", "Mar 2026", "Week of 2026-03-02". */
export function bucketLabel(v: unknown, bucket: DateBucket | undefined): string | null {
  if (!bucket || !isDate(v)) return null;
  const y = v.getUTCFullYear();
  const m = v.getUTCMonth();
  switch (bucket) {
    case "year":
      return String(y);
    case "quarter":
      return `Q${Math.floor(m / 3) + 1} ${y}`;
    case "month":
      return `${MONTHS[m]} ${y}`;
    case "week":
      return `Week of ${v.toISOString().slice(0, 10)}`;
    default:
      return null;
  }
}

/** Groups a table's rows by the summary widget's group-by columns. */
export function summaryGroups(widget: DocWidget): SummaryGroup[] {
  const { engine } = getDerived();
  const cols = tableColumns(widget.table_ref);
  const groupCols = (widget.options.groupBy ?? [])
    .map((id) => cols.find((c) => c.id === id))
    .filter((c): c is DocColumn => !!c);
  const buckets = widget.options.groupDates ?? {};
  const groups = new Map<string, SummaryGroup>();
  for (const id of engine.rowIds(widget.table_ref ?? "")) {
    const values = groupCols.map((c) => bucketDate(engine.safeValue(c, id), buckets[c.id]));
    const key = values.map(valueKey).join("\u0001");
    const g = groups.get(key);
    if (g) g.rowIds.push(id);
    else groups.set(key, { key, values, rowIds: [id] });
  }
  const list = [...groups.values()];
  list.sort((a, b) => {
    for (let i = 0; i < groupCols.length; i++) {
      const c = compareValues(a.values[i], b.values[i]);
      if (c) return c;
    }
    return 0;
  });
  return list;
}

export function compareValues(a: unknown, b: unknown): number {
  const emptyA = a === null || a === undefined || a === "" || a instanceof FormulaError;
  const emptyB = b === null || b === undefined || b === "" || b instanceof FormulaError;
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (isDate(a) && isDate(b)) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Comparable form of a value; references sort by what they display. */
function sortValue(col: DocColumn, v: unknown): unknown {
  if (v instanceof RecordRef || v instanceof RecordSet || Array.isArray(v)) return displayValue(displayCtx(), col, v);
  return v;
}

export function sortRows(ids: number[], cols: DocColumn[], sort: SortSpec[] | undefined): number[] {
  if (!sort?.length) return ids;
  const { engine } = getDerived();
  const specs = sort
    .map((s) => ({ col: cols.find((c) => c.id === s.col), dir: s.dir === "desc" ? -1 : 1 }))
    .filter((s): s is { col: DocColumn; dir: number } => !!s.col);
  const keyed = ids.map((id) => ({ id, keys: specs.map((s) => sortValue(s.col, engine.safeValue(s.col, id))) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < specs.length; i++) {
      const c = compareValues(a.keys[i], b.keys[i]);
      if (c) {
        // Empty values stay last regardless of direction.
        const emptyish = a.keys[i] === null || a.keys[i] === "" || b.keys[i] === null || b.keys[i] === "";
        return emptyish ? c : c * specs[i].dir;
      }
    }
    return 0;
  });
  return keyed.map((k) => k.id);
}

/** Display text used by column filters for a cell. */
export function filterText(col: DocColumn, rowId: number): string {
  const v = getDerived().engine.safeValue(col, rowId);
  return displayValue(displayCtx(), col, v);
}

export interface LinkState {
  /** The source widget has nothing selected, so a filtered target shows nothing. */
  waiting: boolean;
  /** For same-record links, the record to show. */
  recordId: number | null;
  /** Defaults to apply to new rows created in the target (keeps them in view). */
  newRowDefaults: Record<string, unknown>;
}

/**
 * Row ids for a widget after linking, filters, quick search and sort.
 * `ignoreFilters` is used by the filter menu itself to list all values.
 */
export function widgetRows(widget: DocWidget, opts: { search?: string; ignoreFilterFor?: string } = {}): { ids: number[]; link: LinkState } {
  const state = useDoc.getState();
  const { engine } = getDerived();
  const cols = tableColumns(widget.table_ref);
  let ids = engine.rowIds(widget.table_ref ?? "");
  const link: LinkState = { waiting: false, recordId: null, newRowDefaults: {} };

  const source = widget.link_source ? state.widgets.get(widget.link_source) : undefined;
  if (source) {
    const selected = state.cursors[source.id] ?? null;
    if (source.type === "summary" && source.table_ref === widget.table_ref) {
      const groups = summaryGroups(source);
      const group = selected !== null ? groups[selected] : undefined;
      if (!group) {
        link.waiting = true;
        ids = [];
      } else {
        const members = new Set(group.rowIds);
        ids = ids.filter((id) => members.has(id));
      }
    } else if (sourceRefColumn(widget, source)) {
      // The selected source record's own reference column says which records to show here.
      const refCol = sourceRefColumn(widget, source)!;
      const v = selected === null ? null : engine.safeValue(refCol, selected);
      if (refCol.type === "Ref") {
        // One record: every row stays visible and the cursor follows.
        link.recordId = v instanceof RecordRef && v.rowId ? v.rowId : null;
      } else if (v instanceof RecordSet) {
        const members = new Set(v.ids);
        ids = ids.filter((id) => members.has(id));
      } else {
        link.waiting = selected === null;
        ids = [];
      }
    } else if (widget.link_col) {
      const linkCol = state.columns.get(widget.link_col);
      if (selected === null || !linkCol) {
        link.waiting = true;
        ids = [];
      } else {
        ids = ids.filter((id) => {
          const v = engine.safeValue(linkCol, id);
          if (v instanceof RecordRef) return v.rowId === selected;
          if (v instanceof RecordSet) return v.ids.includes(selected);
          return false;
        });
        if (!linkCol.is_formula) {
          link.newRowDefaults[linkCol.id] = linkCol.type === "RefList" ? [selected] : selected;
        }
      }
    } else if (source.table_ref === widget.table_ref) {
      link.recordId = selected;
    }
  }

  // Client filter of hub sections: only records that point at one record.
  const only = widget.options.onlyRef;
  const onlyCol = only ? state.columns.get(only.col) : undefined;
  if (only && onlyCol) {
    ids = ids.filter((id) => {
      const v = engine.safeValue(onlyCol, id);
      return v instanceof RecordRef ? v.rowId === only.id : v instanceof RecordSet ? v.ids.includes(only.id) : false;
    });
    if (!onlyCol.is_formula && link.newRowDefaults[onlyCol.id] === undefined) link.newRowDefaults[onlyCol.id] = onlyCol.type === "RefList" ? [only.id] : only.id;
  }

  const filters = widget.options.filters ?? {};
  for (const [colId, f] of Object.entries(filters)) {
    if (colId === opts.ignoreFilterFor) continue;
    const col = cols.find((c) => c.id === colId);
    if (!col) continue;
    if (f.exclude?.length) {
      const excluded = new Set(f.exclude);
      ids = ids.filter((id) => !excluded.has(filterText(col, id)));
    }
    if ((f.min !== null && f.min !== undefined && f.min !== "") || (f.max !== null && f.max !== undefined && f.max !== "")) {
      ids = ids.filter((id) => {
        const v = engine.safeValue(col, id);
        const n = isDate(v) ? v.getTime() : toNumber(v);
        if (n === null) return false;
        const min = f.min === null || f.min === undefined || f.min === "" ? null : rangeBound(f.min);
        const max = f.max === null || f.max === undefined || f.max === "" ? null : rangeBound(f.max, true);
        return (min === null || n >= min) && (max === null || n <= max);
      });
    }
  }

  const q = opts.search?.trim().toLowerCase();
  if (q) {
    const hidden = new Set(widget.options.hidden ?? []);
    const visible = cols.filter((c) => !hidden.has(c.id));
    ids = ids.filter((id) => visible.some((c) => filterText(c, id).toLowerCase().includes(q)));
  }

  return { ids: sortRows(ids, cols, widget.options.sort), link };
}

/**
 * Relative dates in filters: "@today", "@today-7", "@today+30", "@startOfWeek",
 * "@startOfMonth", "@endOfMonth", "@startOfYear", "@endOfYear". Resolved each
 * time rows are listed, so a saved "last 7 days" filter stays current.
 */
export function resolveRelativeDate(v: string, now = new Date()): number | null {
  const m = /^@(today|startOfWeek|startOfMonth|endOfMonth|startOfYear|endOfYear)([+-]\d+)?$/.exec(v);
  if (!m) return null;
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  let base: number;
  switch (m[1]) {
    case "today":
      base = Date.UTC(y, mo, d);
      break;
    case "startOfWeek":
      base = Date.UTC(y, mo, d - ((now.getDay() + 6) % 7));
      break;
    case "startOfMonth":
      base = Date.UTC(y, mo, 1);
      break;
    case "endOfMonth":
      base = Date.UTC(y, mo + 1, 0);
      break;
    case "startOfYear":
      base = Date.UTC(y, 0, 1);
      break;
    default:
      base = Date.UTC(y, 11, 31);
  }
  return base + (m[2] ? Number(m[2]) : 0) * 86400000;
}

export const RELATIVE_LABELS: Record<string, string> = {
  "@today": "today",
  "@today-1": "yesterday",
  "@today+1": "tomorrow",
  "@startOfWeek": "start of this week",
  "@startOfMonth": "start of this month",
  "@endOfMonth": "end of this month",
  "@startOfYear": "start of this year",
  "@endOfYear": "end of this year",
};

export function boundLabel(v: number | string): string {
  if (typeof v === "number") return String(v);
  if (RELATIVE_LABELS[v]) return RELATIVE_LABELS[v];
  const m = /^@today([+-])(\d+)$/.exec(v);
  if (m) return `${m[2]} days ${m[1] === "-" ? "ago" : "from now"}`;
  return v;
}

/** A filter bound as a number. An upper bound that is a day includes the whole day (times on it too). */
function rangeBound(v: number | string, upper = false): number | null {
  if (typeof v === "number") return v;
  const endOfDay = upper ? 86400000 - 1 : 0;
  if (v.startsWith("@")) {
    const day = resolveRelativeDate(v);
    return day === null ? null : day + endOfDay;
  }
  const asDate = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  if (!isNaN(asDate)) return asDate + endOfDay;
  return toNumber(v);
}

/**
 * For a link through the source's own reference column (options.linkSourceCol):
 * that column, when it still exists, belongs to the source's table and points here.
 */
export function sourceRefColumn(widget: DocWidget, source: DocWidget): DocColumn | null {
  const id = widget.options.linkSourceCol;
  if (!id || widget.link_col) return null;
  const c = useDoc.getState().columns.get(id);
  if (!c || c.table_ref !== source.table_ref || c.options.refTable !== widget.table_ref) return null;
  return c.type === "Ref" || c.type === "RefList" ? c : null;
}

/** Columns a widget shows, in order, without hidden ones. */
export function visibleColumns(widget: DocWidget): DocColumn[] {
  const hidden = new Set(widget.options.hidden ?? []);
  return tableColumns(widget.table_ref).filter((c) => !hidden.has(c.id));
}
