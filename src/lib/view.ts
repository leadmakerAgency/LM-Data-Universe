// Which rows a widget shows: linking, filters, quick search and sort.
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";
import { displayValue } from "./format";
import { FormulaError, RecordRef, RecordSet, isDate, toNumber, valueKey } from "./formula/values";
import type { DocColumn, DocWidget, SortSpec } from "./types";

export interface SummaryGroup {
  key: string;
  values: unknown[];
  rowIds: number[];
}

/** Groups a table's rows by the summary widget's group-by columns. */
export function summaryGroups(widget: DocWidget): SummaryGroup[] {
  const { engine } = getDerived();
  const cols = tableColumns(widget.table_ref);
  const groupCols = (widget.options.groupBy ?? [])
    .map((id) => cols.find((c) => c.id === id))
    .filter((c): c is DocColumn => !!c);
  const groups = new Map<string, SummaryGroup>();
  for (const id of engine.rowIds(widget.table_ref ?? "")) {
    const values = groupCols.map((c) => engine.safeValue(c, id));
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
        const max = f.max === null || f.max === undefined || f.max === "" ? null : rangeBound(f.max);
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

function rangeBound(v: number | string): number | null {
  if (typeof v === "number") return v;
  const asDate = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  if (!isNaN(asDate)) return asDate;
  return toNumber(v);
}

/** Columns a widget shows, in order, without hidden ones. */
export function visibleColumns(widget: DocWidget): DocColumn[] {
  const hidden = new Set(widget.options.hidden ?? []);
  return tableColumns(widget.table_ref).filter((c) => !hidden.has(c.id));
}
