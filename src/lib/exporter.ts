// CSV export of a widget's current view and XLSX export of a whole document.
import { displayValue } from "./format";
import { FormulaError, isDate } from "@engine/values";
import type { DocColumn, DocWidget } from "./types";
import { visibleColumns, widgetRows } from "./view";
import { errorMessage, supabase } from "./supabase";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "export";

/** Runs an export, reporting failures instead of leaving an unhandled rejection. */
async function guarded(what: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    toast.error(`${what} failed: ${errorMessage(e)}`);
  }
}

export const exportWidgetCsv = (widget: DocWidget, name: string) => guarded("CSV export", () => widgetCsv(widget, name));
export const exportDocXlsx = () => guarded("Excel export", docXlsx);
export const exportTable = (tableRef: string, format: "csv" | "tsv" | "xlsx") => guarded("Export", () => tableExport(tableRef, format));
export const exportBackup = () => guarded("Backup", backupFile);

/** Every record of a table (as this person may see it), all columns. */
async function tableExport(tableRef: string, format: "csv" | "tsv" | "xlsx") {
  const state = useDoc.getState();
  const table = state.tables.get(tableRef);
  if (!table) return;
  const cols = tableColumns(tableRef);
  const { engine } = getDerived();
  const ctx = displayCtx();
  const ids = engine.rowIds(tableRef);
  const base = `${safeName(state.doc?.name ?? "document")} - ${safeName(table.table_id)}`;
  if (format === "xlsx") {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    addSheet(wb, table.table_id, cols, ids, engine, ctx);
    const buffer = await wb.xlsx.writeBuffer();
    download(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${base}.xlsx`);
    return;
  }
  const Papa = (await import("papaparse")).default;
  const rows = ids.map((id) => cols.map((c) => displayValue(ctx, c, engine.safeValue(c, id))));
  const text = Papa.unparse({ fields: cols.map((c) => c.label || c.col_id), data: rows }, { delimiter: format === "tsv" ? "\t" : "," });
  download(
    new Blob([format === "csv" ? "﻿" + text : text], { type: format === "csv" ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8" }),
    `${base}.${format}`,
  );
}

/** The whole document (structure, records, pages, widgets; rules for owners) as a backup file. */
async function backupFile() {
  const state = useDoc.getState();
  if (!state.docId) return;
  const { data, error } = await supabase().rpc("doc_backup", { p_doc: state.docId });
  if (error) throw error;
  const stamp = new Date().toISOString().slice(0, 10);
  download(new Blob([JSON.stringify(data)], { type: "application/json" }), `${safeName(state.doc?.name ?? "document")} backup ${stamp}.lmdu.json`);
  toast.success("Backup downloaded. Attached files aren't included.");
}

async function widgetCsv(widget: DocWidget, name: string) {
  const Papa = (await import("papaparse")).default;
  const cols = visibleColumns(widget);
  const { ids } = widgetRows(widget);
  const { engine } = getDerived();
  const ctx = displayCtx();
  const rows = ids.map((id) => cols.map((c) => displayValue(ctx, c, engine.safeValue(c, id))));
  const csv = Papa.unparse({ fields: cols.map((c) => c.label || c.col_id), data: rows });
  download(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `${safeName(name)}.csv`);
}

type Engine = ReturnType<typeof getDerived>["engine"];
type Workbook = InstanceType<(typeof import("exceljs"))["Workbook"]>;

function addSheet(wb: Workbook, name: string, cols: DocColumn[], ids: number[], engine: Engine, ctx: ReturnType<typeof displayCtx>) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.columns = cols.map((c) => ({ header: c.label || c.col_id, key: c.id, width: 18 }));
  ws.getRow(1).font = { bold: true };
  for (const id of ids) {
    const row: Record<string, unknown> = {};
    for (const c of cols) {
      const v = engine.safeValue(c, id);
      if (v instanceof FormulaError) row[c.id] = v.code;
      else if (typeof v === "number" || typeof v === "boolean") row[c.id] = v;
      else if (isDate(v)) row[c.id] = v;
      else row[c.id] = displayValue(ctx, c, v);
    }
    ws.addRow(row);
  }
}

async function docXlsx() {
  const ExcelJS = (await import("exceljs")).default;
  const state = useDoc.getState();
  const { engine } = getDerived();
  const ctx = displayCtx();
  const wb = new ExcelJS.Workbook();
  const tables = [...state.tables.values()].sort((a, b) => a.position - b.position);
  for (const t of tables) addSheet(wb, t.table_id, tableColumns(t.id), engine.rowIds(t.id), engine, ctx);
  const buffer = await wb.xlsx.writeBuffer();
  download(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${safeName(state.doc?.name ?? "document")}.xlsx`,
  );
}
