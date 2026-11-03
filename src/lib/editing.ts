// Turning typed text into document changes, shared by the grid, cards and paste.
import { displayValue, guessType, parseInput } from "./format";
import { FormulaError, RecordRef, RecordSet, isDate } from "./formula/values";
import type { CellValue, DocColumn } from "./types";
import { displayCtx, getDerived, useDoc, type CellChange } from "@/store/docStore";
import { toast } from "@/store/toasts";

/** Text shown in the editor when editing an existing cell. */
export function editText(col: DocColumn, rowId: number): string {
  const { engine } = getDerived();
  const v = engine.safeValue(col, rowId);
  if (v instanceof FormulaError || v === null || v === undefined) return "";
  if (col.type === "Date" && isDate(v)) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && (col.type === "Numeric" || col.type === "Int" || col.type === "Any")) return String(v);
  if (v instanceof RecordRef || v instanceof RecordSet || Array.isArray(v) || typeof v !== "string") {
    return displayValue(displayCtx(), col, v);
  }
  return v;
}

function columnIsEmpty(col: DocColumn): boolean {
  const rows = useDoc.getState().rows.get(col.table_ref);
  for (const r of rows?.values() ?? []) {
    const v = r.data[col.id];
    if (v !== null && v !== undefined && v !== "") return false;
  }
  return true;
}

/**
 * Prepares a column for a typed value: "=..." in an empty data column turns
 * it into a formula column; the first value in an empty "Any" column picks
 * its type. Returns the column to parse with, or null when the text was
 * consumed as a formula.
 */
export async function prepareColumn(col: DocColumn, text: string): Promise<DocColumn | null> {
  const store = useDoc.getState();
  if (!col.is_formula && text.trim().startsWith("=") && columnIsEmpty(col)) {
    await store.updateColumn(col.id, { is_formula: true, formula: text.trim().slice(1), type: "Any" });
    return null;
  }
  if (!col.is_formula && col.type === "Any" && text.trim() && columnIsEmpty(col)) {
    const type = guessType([text]);
    await store.updateColumn(col.id, { type }, { undoable: false });
    return { ...col, type };
  }
  return col;
}

export function parseFor(col: DocColumn, text: string): CellValue {
  return parseInput(col, text, displayCtx());
}

/** Commits typed text into an existing cell. */
export async function commitCell(col: DocColumn, rowId: number, text: string) {
  const store = useDoc.getState();
  if (col.is_formula) {
    toast.info("This is a formula column. Edit its formula instead.");
    return;
  }
  const target = await prepareColumn(col, text);
  if (!target) return;
  await store.setCells([{ tableRef: col.table_ref, rowId, colId: col.id, value: parseFor(target, text) }]);
}

/** Creates a row from text typed into the "new row" line. */
export async function commitNewRow(col: DocColumn, text: string, defaults: Record<string, unknown>): Promise<number | null> {
  const store = useDoc.getState();
  if (col.is_formula) {
    const rows = await store.addRows(col.table_ref, [{ data: defaults as Record<string, CellValue> }]);
    return rows[0]?.id ?? null;
  }
  const target = await prepareColumn(col, text);
  const data: Record<string, CellValue> = { ...(defaults as Record<string, CellValue>) };
  if (target) data[col.id] = parseFor(target, text);
  const rows = await store.addRows(col.table_ref, [{ data }]);
  return rows[0]?.id ?? null;
}

/** Pastes a block of text (rows × columns) starting at a cell, adding rows when needed. */
export async function pasteGrid(
  cols: DocColumn[],
  rowIds: number[],
  startRow: number,
  startCol: number,
  grid: string[][],
  defaults: Record<string, unknown>,
) {
  const store = useDoc.getState();
  if (!cols.length) return;
  const tableRef = cols[0].table_ref;
  const changes: CellChange[] = [];
  const newRows: Record<string, CellValue>[] = [];
  grid.forEach((line, i) => {
    const r = startRow + i;
    const data: Record<string, CellValue> = {};
    line.forEach((text, j) => {
      const col = cols[startCol + j];
      if (!col || col.is_formula) return;
      const value = parseFor(col, text);
      if (r < rowIds.length) changes.push({ tableRef, rowId: rowIds[r], colId: col.id, value });
      else data[col.id] = value;
    });
    if (r >= rowIds.length) newRows.push({ ...(defaults as Record<string, CellValue>), ...data });
  });
  if (changes.length) await store.setCells(changes);
  if (newRows.length) await store.addRows(tableRef, newRows.map((data) => ({ data })));
}

/** Parses clipboard text into rows of cells (tab-separated, with quoted cells). */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function toClipboardText(grid: string[][]): string {
  return grid
    .map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join("\t"))
    .join("\n");
}
