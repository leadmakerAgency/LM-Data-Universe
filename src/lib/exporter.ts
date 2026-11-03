// CSV export of a widget's current view and XLSX export of a whole document.
import { displayValue } from "./format";
import { FormulaError, isDate } from "./formula/values";
import type { DocWidget } from "./types";
import { visibleColumns, widgetRows } from "./view";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";

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

export async function exportWidgetCsv(widget: DocWidget, name: string) {
  const Papa = (await import("papaparse")).default;
  const cols = visibleColumns(widget);
  const { ids } = widgetRows(widget);
  const { engine } = getDerived();
  const ctx = displayCtx();
  const rows = ids.map((id) => cols.map((c) => displayValue(ctx, c, engine.safeValue(c, id))));
  const csv = Papa.unparse({ fields: cols.map((c) => c.label || c.col_id), data: rows });
  download(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `${safeName(name)}.csv`);
}

export async function exportDocXlsx() {
  const ExcelJS = (await import("exceljs")).default;
  const state = useDoc.getState();
  const { engine } = getDerived();
  const ctx = displayCtx();
  const wb = new ExcelJS.Workbook();
  const tables = [...state.tables.values()].sort((a, b) => a.position - b.position);
  for (const t of tables) {
    const cols = tableColumns(t.id);
    const ws = wb.addWorksheet(t.table_id.slice(0, 31));
    ws.columns = cols.map((c) => ({ header: c.label || c.col_id, key: c.id, width: 18 }));
    ws.getRow(1).font = { bold: true };
    for (const id of engine.rowIds(t.id)) {
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
  const buffer = await wb.xlsx.writeBuffer();
  download(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${safeName(state.doc?.name ?? "document")}.xlsx`,
  );
}
