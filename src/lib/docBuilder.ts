// Creates whole documents (or extra tables) from a declarative spec: used by
// templates, "new blank document" and file imports.
import { guessType, parseInput } from "./format";
import { labelToIdent, uniqueIdent } from "./ids";
import { supabase } from "./supabase";
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
  options?: WidgetOptions & { groupByLabels?: string[]; xLabel?: string; yLabels?: string[] };
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

/**
 * Inserts tables (with columns, rows, and pages) into an existing document.
 * Returns the created table uuids by spec name.
 */
export async function addTablesToDoc(
  docId: string,
  tables: TableSpec[],
  pages?: PageSpec[],
  opts: { existingTableIds?: string[]; startPosition?: number; withPages?: boolean } = {},
): Promise<Map<string, string>> {
  const sb = supabase();
  const tableIds = new Map<string, string>();
  const taken = [...(opts.existingTableIds ?? [])];
  let position = opts.startPosition ?? 0;
  for (const t of tables) {
    const tableId = uniqueIdent(labelToIdent(t.name, { capitalize: true }), taken);
    taken.push(tableId);
    const { data, error } = await sb.from("doc_tables").insert({ doc_id: docId, table_id: tableId, position: ++position }).select().single();
    if (error) throw error;
    tableIds.set(t.name, data.id);
  }

  // Columns: first pass creates them; Ref columns then get their target/display.
  const colsByTable = new Map<string, DocColumn[]>();
  for (const t of tables) {
    const used: string[] = [];
    const payload = t.columns.map((c, i) => {
      const colId = uniqueIdent(labelToIdent(c.label), used);
      used.push(colId);
      return {
        doc_id: docId,
        table_ref: tableIds.get(t.name),
        col_id: colId,
        label: c.label,
        type: c.type ?? "Text",
        is_formula: !!c.formula,
        formula: c.formula ?? "",
        options: { ...(c.options ?? {}), ...(c.refTable ? { refTable: tableIds.get(c.refTable) } : {}) },
        position: i + 1,
      };
    });
    const { data, error } = await sb.from("doc_columns").insert(payload).select();
    if (error) throw error;
    const created = (data as DocColumn[]).sort((a, b) => a.position - b.position);
    colsByTable.set(t.name, created);
  }
  for (const t of tables) {
    const cols = colsByTable.get(t.name)!;
    for (let i = 0; i < t.columns.length; i++) {
      const spec = t.columns[i];
      if (!spec.refTable || !spec.visibleCol) continue;
      const target = colsByTable.get(spec.refTable)?.find((c) => c.label === spec.visibleCol);
      if (!target) continue;
      const options = { ...cols[i].options, visibleCol: target.id };
      const { error } = await sb.from("doc_columns").update({ options }).eq("id", cols[i].id);
      if (error) throw error;
    }
  }

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
    for (let i = 0; i < t.rows.length; i += 500) {
      const chunk = t.rows.slice(i, i + 500).map((row, j) => {
        const data: Record<string, CellValue> = {};
        t.columns.forEach((c, k) => {
          if (c.formula) return;
          const v = resolve(row[k] ?? null, c);
          if (v !== null && v !== "") data[cols[k].id] = v;
        });
        return { doc_id: docId, table_ref: tableIds.get(t.name), manual_sort: i + j + 1, data };
      });
      const { data, error } = await sb.from("doc_rows").insert(chunk).select("id");
      if (error) throw error;
      ids.push(...(data as { id: number }[]).map((r) => r.id));
    }
    rowIds.set(t.name, ids);
  }

  if (opts.withPages === false) return tableIds;
  const pageSpecs: PageSpec[] = pages ?? tables.map((t) => ({ name: t.name, widgets: [{ type: "table" as const, table: t.name }] }));
  const { data: existingPages } = await sb.from("doc_pages").select("position").eq("doc_id", docId);
  let pagePos = Math.max(0, ...((existingPages ?? []) as { position: number }[]).map((p) => p.position));
  for (const p of pageSpecs) {
    const { data: page, error } = await sb.from("doc_pages").insert({ doc_id: docId, name: p.name, position: ++pagePos }).select().single();
    if (error) throw error;
    const widgetIds: string[] = [];
    for (let i = 0; i < p.widgets.length; i++) {
      const w = p.widgets[i];
      const cols = colsByTable.get(w.table) ?? [];
      const byLabel = (label?: string) => cols.find((c) => c.label === label)?.id ?? null;
      const { groupByLabels, xLabel, yLabels, ...options } = w.options ?? {};
      if (groupByLabels) options.groupBy = groupByLabels.map(byLabel).filter((x): x is string => !!x);
      if (xLabel) options.xCol = byLabel(xLabel);
      if (yLabels) options.yCols = yLabels.map(byLabel).filter((x): x is string => !!x);
      if (w.type === "form" && !options.fields) {
        options.fields = cols.filter((c) => !c.is_formula && c.type !== "Ref" && c.type !== "RefList").map((c) => ({ col: c.id }));
      }
      const { data: widget, error: wErr } = await sb
        .from("doc_widgets")
        .insert({
          doc_id: docId,
          page_id: page.id,
          table_ref: tableIds.get(w.table),
          type: w.type,
          title: w.title ?? "",
          position: i + 1,
          width: w.width ?? 12,
          height: w.height ?? 420,
          options,
          link_source: w.linkTo !== undefined ? widgetIds[w.linkTo] : null,
          link_col: w.linkCol ? byLabel(w.linkCol) : null,
        })
        .select()
        .single();
      if (wErr) throw wErr;
      widgetIds.push(widget.id);
    }
  }
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
