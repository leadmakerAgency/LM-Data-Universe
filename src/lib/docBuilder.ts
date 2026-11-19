// Creates whole documents (or extra tables) from a declarative spec: used by
// templates, "new blank document" and file imports.
import { defaultFormItems } from "./forms";
import { guessType, parseInput } from "./format";
import { labelToIdent, uniqueIdent } from "./ids";
import { supabase } from "./supabase";
import { newId, type ApplyResult, type DocAction } from "./actions";
import type { CellValue, ColumnOptions, ColumnType, DocColumn, WidgetOptions, WidgetType } from "./types";

/** In template rows, `{ $ref: n }` points at the n-th row (0-based) of the Ref column's target table. */
export type SpecCell = CellValue | { $ref: number } | { $refs: number[] };

export interface ColumnSpec {
  label: string;
  type?: ColumnType;
  formula?: string;
  options?: ColumnOptions;
  /** For Ref/RefList: target table name and the label of the column it displays. */
  refTable?: string;
  visibleCol?: string;
}

export interface TableSpec {
  name: string;
  columns: ColumnSpec[];
  rows: SpecCell[][];
}

export interface WidgetSpec {
  type: WidgetType;
  table: string;
  title?: string;
  width?: number;
  height?: number;
  options?: WidgetOptions & {
    groupByLabels?: string[];
    xLabel?: string;
    yLabels?: string[];
    /** Any option that holds a column id (or a list of them), given by column label: { boardCol: "Stage" }. */
    labels?: Partial<Record<keyof WidgetOptions, string | string[]>>;
  };
  /** Index of the widget on the same page whose selection drives this one. */
  linkTo?: number;
  /** Label of the Ref column (in this widget's table) used for the link. */
  linkCol?: string;
}

export interface PageSpec {
  name: string;
  widgets: WidgetSpec[];
}

export interface DocSpec {
  name: string;
  tables: TableSpec[];
  pages?: PageSpec[];
}

export async function createDocument(workspaceId: string, spec: DocSpec): Promise<string> {
  const sb = supabase();
  const { data: doc, error } = await sb.from("documents").insert({ workspace_id: workspaceId, name: spec.name }).select().single();
  if (error) throw error;
  try {
    await addTablesToDoc(doc.id, spec.tables, spec.pages);
  } catch (e) {
    await sb.from("documents").delete().eq("id", doc.id);
    throw e;
  }
  return doc.id as string;
}

/** Sends one bundle of actions for a document (not undoable: builds aren't edits). */
async function send(docId: string, actions: DocAction[]): Promise<ApplyResult> {
  const { data, error } = await supabase().rpc("apply_actions", {
    p_doc: docId,
    p_actions: actions,
    p_undoable: false,
    p_source: "app",
  });
  if (error) throw error;
  return data as ApplyResult;
}

/**
 * Inserts tables (with columns, rows, and pages) into an existing document,
 * through apply_actions like every other change. Returns the created table
 * uuids by spec name.
 */
export async function addTablesToDoc(
  docId: string,
  tables: TableSpec[],
  pages?: PageSpec[],
  opts: { existingTableIds?: string[]; startPosition?: number; withPages?: boolean } = {},
): Promise<Map<string, string>> {
  const tableIds = new Map<string, string>();
  const taken = [...(opts.existingTableIds ?? [])];
  let position = opts.startPosition ?? 0;
  const schema: DocAction[] = [];
  for (const t of tables) {
    const tableId = uniqueIdent(labelToIdent(t.name, { capitalize: true }), taken);
    taken.push(tableId);
    const id = newId();
    tableIds.set(t.name, id);
    schema.push({ op: "Add", entity: "table", row: { id, table_id: tableId, position: ++position } });
  }

  // Columns get their ids up front, so Ref columns can name their display column directly.
  const colsByTable = new Map<string, DocColumn[]>();
  for (const t of tables) {
    const used: string[] = [];
    colsByTable.set(
      t.name,
      t.columns.map((c, i) => {
        const colId = uniqueIdent(labelToIdent(c.label), used);
        used.push(colId);
        return {
          id: newId(),
          doc_id: docId,
          table_ref: tableIds.get(t.name)!,
          col_id: colId,
          label: c.label,
          type: c.type ?? "Text",
          is_formula: !!c.formula,
          formula: c.formula ?? "",
          options: { ...(c.options ?? {}), ...(c.refTable ? { refTable: tableIds.get(c.refTable) } : {}) },
          position: i + 1,
        };
      }),
    );
  }
  for (const t of tables) {
    const cols = colsByTable.get(t.name)!;
    t.columns.forEach((spec, i) => {
      if (!spec.refTable || !spec.visibleCol) return;
      const target = colsByTable.get(spec.refTable)?.find((c) => c.label === spec.visibleCol);
      if (target) cols[i].options = { ...cols[i].options, visibleCol: target.id };
    });
    for (const c of cols) {
      const { doc_id, ...row } = c;
      void doc_id;
      schema.push({ op: "Add", entity: "column", row: row as unknown as Record<string, unknown> });
    }
  }
  await send(docId, schema);

  // Rows, in spec order so references to earlier tables resolve.
  const rowIds = new Map<string, number[]>();
  for (const t of tables) {
    const cols = colsByTable.get(t.name)!;
    const ids: number[] = [];
    const resolve = (cell: SpecCell, col: ColumnSpec): CellValue => {
      if (cell && typeof cell === "object" && !Array.isArray(cell)) {
        const targetIds = rowIds.get(col.refTable ?? "") ?? [];
        if ("$ref" in cell) return targetIds[cell.$ref] ?? null;
        if ("$refs" in cell) return cell.$refs.map((i) => targetIds[i]).filter((x) => x !== undefined);
      }
      return cell as CellValue;
    };
    for (let i = 0; i < t.rows.length; i += 1000) {
      const records = t.rows.slice(i, i + 1000).map((row, j) => {
        const data: Record<string, CellValue> = {};
        t.columns.forEach((c, k) => {
          if (c.formula) return;
          const v = resolve(row[k] ?? null, c);
          if (v !== null && v !== "") data[cols[k].id] = v;
        });
        return { manual_sort: i + j + 1, data };
      });
      const result = await send(docId, [{ op: "AddRecords", table: tableIds.get(t.name)!, records }]);
      ids.push(...((result.results[0] as number[] | null) ?? []));
    }
    rowIds.set(t.name, ids);
    // References to rows of this same table (a task that waits for other tasks)
    // can only be filled in once those rows exist.
    const selfCols = t.columns.map((c, k) => ({ c, k })).filter(({ c }) => c.refTable === t.name && !c.formula);
    if (selfCols.length) {
      const fixes = t.rows
        .map((row, i) => {
          const values: Record<string, CellValue> = {};
          for (const { c, k } of selfCols) {
            const v = resolve(row[k] ?? null, c);
            if (v !== null && v !== "" && !(Array.isArray(v) && !v.length)) values[cols[k].id] = v;
          }
          return { id: ids[i], values };
        })
        .filter((r) => r.id !== undefined && Object.keys(r.values).length);
      if (fixes.length) await send(docId, [{ op: "UpdateRecords", table: tableIds.get(t.name)!, records: fixes }]);
    }
  }

  if (opts.withPages === false) return tableIds;
  const pageSpecs: PageSpec[] = pages ?? tables.map((t) => ({ name: t.name, widgets: [{ type: "table" as const, table: t.name }] }));
  const { data: existingPages } = await supabase().from("doc_pages").select("position").eq("doc_id", docId);
  let pagePos = Math.max(0, ...((existingPages ?? []) as { position: number }[]).map((p) => p.position));
  const layout: DocAction[] = [];
  for (const p of pageSpecs) {
    const pageId = newId();
    layout.push({ op: "Add", entity: "page", row: { id: pageId, name: p.name, position: ++pagePos } });
    const widgetIds: string[] = [];
    p.widgets.forEach((w, i) => {
      const cols = colsByTable.get(w.table) ?? [];
      const byLabel = (label?: string) => cols.find((c) => c.label === label)?.id ?? null;
      const { groupByLabels, xLabel, yLabels, labels, ...options } = w.options ?? {};
      for (const [key, label] of Object.entries(labels ?? {})) {
        const value = Array.isArray(label) ? label.map(byLabel).filter((x): x is string => !!x) : byLabel(label as string);
        (options as Record<string, unknown>)[key] = value;
      }
      if (groupByLabels) options.groupBy = groupByLabels.map(byLabel).filter((x): x is string => !!x);
      if (xLabel) options.xCol = byLabel(xLabel);
      if (yLabels) options.yCols = yLabels.map(byLabel).filter((x): x is string => !!x);
      if (w.type === "form" && !options.fields && !options.formItems) {
        options.formItems = defaultFormItems(cols);
      }
      const id = newId();
      widgetIds.push(id);
      layout.push({
        op: "Add",
        entity: "widget",
        row: {
          id,
          page_id: pageId,
          table_ref: tableIds.get(w.table),
          type: w.type,
          title: w.title ?? "",
          position: i + 1,
          width: w.width ?? 12,
          height: w.height ?? 420,
          options,
          link_source: w.linkTo !== undefined ? (widgetIds[w.linkTo] ?? null) : null,
          link_col: w.linkCol ? byLabel(w.linkCol) : null,
        },
      });
    });
  }
  if (layout.length) await send(docId, layout);
  return tableIds;
}

// ---------------------------------------------------------------- imports

function cellToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().endsWith("T00:00:00.000Z") ? v.toISOString().slice(0, 10) : v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[]; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.result !== undefined) return cellToText(o.result);
    if (o.text !== undefined) return cellToText(o.text);
    if (o.hyperlink) return o.hyperlink;
    return "";
  }
  return String(v);
}

/** Builds a table spec from a header row and text rows, guessing column types. */
export function tableFromGrid(name: string, grid: string[][]): TableSpec {
  const [header = [], ...body] = grid.filter((r) => r.some((c) => c.trim() !== ""));
  const width = Math.max(header.length, ...body.map((r) => r.length));
  const labels: string[] = [];
  for (let i = 0; i < width; i++) {
    const raw = (header[i] ?? "").trim() || `Column ${i + 1}`;
    let label = raw;
    for (let n = 2; labels.includes(label); n++) label = `${raw} ${n}`;
    labels.push(label);
  }
  const columns: ColumnSpec[] = labels.map((label, i) => ({
    label,
    type: guessType(body.slice(0, 200).map((r) => r[i] ?? "")),
  }));
  const rows = body.map((r) =>
    columns.map((c, i) => parseInput({ type: c.type!, options: {} } as DocColumn, r[i] ?? "")),
  );
  return { name, columns, rows };
}

export async function parseImportFile(file: File): Promise<TableSpec[]> {
  const base = file.name.replace(/\.[^.]+$/, "") || "Imported";
  if (/\.(xlsx|xlsm)$/i.test(file.name)) {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const specs: TableSpec[] = [];
    wb.eachSheet((sheet) => {
      const grid: string[][] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const values = row.values as unknown[];
        grid.push(values.slice(1).map(cellToText));
      });
      if (grid.length) specs.push(tableFromGrid(wb.worksheets.length > 1 ? sheet.name : base, grid));
    });
    return specs;
  }
  const Papa = (await import("papaparse")).default;
  const text = await file.text();
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  return [tableFromGrid(base, parsed.data)];
}
