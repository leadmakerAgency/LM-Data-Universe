// Importing data: reading files (CSV, TSV, Excel) into sheets of text, Google
// Sheets links, matching source columns to a table's columns, and planning
// what an import into an existing table will add and change.
import { guessType, parseInput, type ParseContext } from "./format";
import type { CellValue, ColumnType, DocColumn } from "./types";

export interface Sheet {
  name: string;
  header: string[];
  rows: string[][];
}

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

function cellToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().endsWith("T00:00:00.000Z") ? v.toISOString().slice(0, 10) : v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[]; hyperlink?: string; error?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.result !== undefined) return cellToText(o.result);
    if (o.text !== undefined) return cellToText(o.text);
    if (o.hyperlink) return o.hyperlink;
    return "";
  }
  return String(v);
}

/** A grid of text (first row: headers) as a sheet; empty rows dropped, header names made unique. */
export function sheetFromGrid(name: string, grid: string[][]): Sheet {
  const [header = [], ...body] = grid.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  const width = Math.max(header.length, ...body.map((r) => r.length), 0);
  const names: string[] = [];
  for (let i = 0; i < width; i++) {
    const raw = String(header[i] ?? "").trim() || `Column ${i + 1}`;
    let n = raw;
    for (let k = 2; names.includes(n); k++) n = `${raw} ${k}`;
    names.push(n);
  }
  return { name, header: names, rows: body.map((r) => Array.from({ length: width }, (_, i) => String(r[i] ?? ""))) };
}

const isExcel = (name: string, type: string) => /\.(xlsx|xlsm)$/i.test(name) || /spreadsheetml|ms-excel\.sheet/i.test(type);

/** Reads CSV, TSV or Excel bytes into sheets. */
export async function readSheets(name: string, type: string, bytes: ArrayBuffer): Promise<Sheet[]> {
  const base = name.replace(/\.[^.]+$/, "") || "Imported";
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error("Files can be up to 20 MB");
  if (isExcel(name, type)) {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    const sheets: Sheet[] = [];
    wb.eachSheet((ws) => {
      const grid: string[][] = [];
      ws.eachRow({ includeEmpty: false }, (row) => grid.push((row.values as unknown[]).slice(1).map(cellToText)));
      if (grid.length) sheets.push(sheetFromGrid(wb.worksheets.length > 1 ? ws.name : base, grid));
    });
    return sheets;
  }
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  if (/^\s*<(!doctype html|html)/i.test(text)) {
    throw new Error("This is a web page, not a CSV or Excel file. For Google Sheets, share the sheet so anyone with the link can view it.");
  }
  const Papa = (await import("papaparse")).default;
  const tsv = /\.tsv$/i.test(name) || /tab-separated/i.test(type);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true, delimiter: tsv ? "\t" : "" });
  return [sheetFromGrid(base, parsed.data)];
}

export async function readFile(file: File): Promise<Sheet[]> {
  return readSheets(file.name, file.type, await file.arrayBuffer());
}

/**
 * The export address for a Google Sheets link (the whole spreadsheet as
 * Excel, so every tab comes along), or null for other addresses.
 */
export function googleSheetsExportUrl(url: string): string | null {
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/(e\/)?([a-zA-Z0-9_-]{20,})/.exec(url.trim());
  if (!m) return null;
  // Published ("pub") and export links already point at a file.
  if (m[1] || /\/pub(\?|$)|\/export\?/.test(url)) return url.trim();
  return `https://docs.google.com/spreadsheets/d/${m[2]}/export?format=xlsx`;
}

// ---------------------------------------------------------------- mapping

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** For each source column, the target column with the same name (label or id), or null. */
export function autoMap(header: string[], cols: Pick<DocColumn, "id" | "label" | "col_id" | "is_formula">[]): (string | null)[] {
  const used = new Set<string>();
  return header.map((h) => {
    const c = cols.find((x) => !x.is_formula && !used.has(x.id) && (norm(x.label || x.col_id) === norm(h) || norm(x.col_id) === norm(h)));
    if (!c) return null;
    used.add(c.id);
    return c.id;
  });
}

export function guessColumnType(sheet: Sheet, index: number): ColumnType {
  return guessType(sheet.rows.slice(0, 200).map((r) => r[index] ?? ""));
}

// ---------------------------------------------------------------- planning

export type ImportMode = "add" | "upsert" | "update";

export interface ImportTarget {
  /** Source column index -> target column (null: skip). */
  mapping: (DocColumn | null)[];
  /** Target column ids whose values identify a record (upsert / update). */
  keys: string[];
  mode: ImportMode;
}

export interface ImportPlan {
  adds: Record<string, CellValue>[];
  updates: { id: number; values: Record<string, CellValue> }[];
  unchanged: number;
  /** Rows not imported: no key value (upsert/update) or no match (update only). */
  skipped: number;
  /** Rows matching more than one record (the first is updated). */
  ambiguous: number;
}

/** A stored value's identity for matching and change detection. */
export function storedKey(v: unknown): string {
  if (v === null || v === undefined || v === "") return "∅";
  if (typeof v === "string") return `s:${v.trim().toLowerCase()}`;
  return JSON.stringify(v);
}

/**
 * Plans an import of `sheet` into a table whose current records are `existing`
 * (id -> stored data by column id).
 */
export function planImport(sheet: Sheet, target: ImportTarget, existing: Map<number, Record<string, CellValue>>, ctx?: ParseContext): ImportPlan {
  const plan: ImportPlan = { adds: [], updates: [], unchanged: 0, skipped: 0, ambiguous: 0 };
  const mapped = target.mapping.map((c, i) => ({ c, i })).filter((x): x is { c: DocColumn; i: number } => !!x.c && !x.c.is_formula);
  const keyCols = target.mode === "add" ? [] : mapped.filter((m) => target.keys.includes(m.c.id));
  // Index of existing records by their key values.
  const index = new Map<string, number[]>();
  if (keyCols.length) {
    for (const [id, data] of existing) {
      const k = keyCols.map((m) => storedKey(data[m.c.id])).join("\u0001");
      const list = index.get(k);
      if (list) list.push(id);
      else index.set(k, [id]);
    }
  }
  for (const row of sheet.rows) {
    const values: Record<string, CellValue> = {};
    for (const { c, i } of mapped) {
      const v = parseInput(c, row[i] ?? "", ctx);
      values[c.id] = typeof v === "string" ? v.trim() : v;
    }
    if (target.mode === "add") {
      plan.adds.push(clean(values));
      continue;
    }
    const keyParts = keyCols.map((m) => storedKey(values[m.c.id]));
    if (!keyCols.length || keyParts.every((k) => k === "∅")) {
      plan.skipped++;
      continue;
    }
    const hits = index.get(keyParts.join("\u0001")) ?? [];
    if (!hits.length) {
      if (target.mode === "upsert") plan.adds.push(clean(values));
      else plan.skipped++;
      continue;
    }
    if (hits.length > 1) plan.ambiguous++;
    const id = hits[0];
    const before = existing.get(id) ?? {};
    const changed: Record<string, CellValue> = {};
    for (const [k, v] of Object.entries(values)) {
      if (exact(before[k]) !== exact(v)) changed[k] = v;
    }
    if (Object.keys(changed).length) plan.updates.push({ id, values: changed });
    else plan.unchanged++;
  }
  return plan;
}

/** A value's exact identity for change detection (nothing, empty text and an unticked toggle are the same). */
const exact = (v: unknown) => (v === undefined || v === null || v === "" || v === false ? "∅" : JSON.stringify(v));

/** Drops empty values from a new record. */
function clean(values: Record<string, CellValue>): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(values)) if (v !== null && v !== "" && v !== false) out[k] = v;
  return out;
}
