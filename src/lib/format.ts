// Display formatting and input parsing for each column type.
import type { CellValue, ColumnType, DocColumn } from "./types";
import type { Engine } from "@engine/engine";
import { toText } from "@engine/functions";
import { FormulaError, RecordRef, RecordSet, dateToIso, isDate, parseIsoDate } from "@engine/values";
import { zonedParts, zonedToUtc, type ZonedParts } from "@engine/zone";
import { attachmentsText, isAttachmentId } from "./attachments";

/** Document settings that change how values are shown and read (Document settings dialog). */
export interface FormatSettings {
  /** BCP 47 locale ("en-US", "de-DE"); the browser's when unset. */
  locale?: string;
  /** ISO 4217 code used by currency columns that don't name one. */
  currency?: string;
  /** IANA time zone for DateTime values and TODAY(); the viewer's own when unset. */
  timezone?: string;
}

let settings: FormatSettings = {};
let decimalSep = ".";
let monthNames: { long: string[]; short: string[] } | null = null;

/** Set by the document store whenever the open document (or its settings) changes. */
export function setFormatSettings(s: FormatSettings | null | undefined) {
  settings = { ...(s ?? {}) };
  decimalSep = ".";
  monthNames = null;
  try {
    decimalSep = new Intl.NumberFormat(settings.locale || undefined).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
  } catch {
    settings.locale = undefined;
  }
  if (settings.locale) {
    try {
      const long = new Intl.DateTimeFormat(settings.locale, { month: "long", timeZone: "UTC" });
      const short = new Intl.DateTimeFormat(settings.locale, { month: "short", timeZone: "UTC" });
      const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2000, i, 1)));
      monthNames = { long: months.map((d) => long.format(d)), short: months.map((d) => short.format(d).replace(/\.$/, "")) };
    } catch {
      monthNames = null;
    }
  }
}

export function formatSettings(): FormatSettings {
  return settings;
}

/** Wall-clock parts in the document's time zone (the viewer's own if unset or unknown). */
function docZoned(d: Date): ZonedParts {
  try {
    return zonedParts(d, settings.timezone);
  } catch {
    return zonedParts(d);
  }
}

function docZonedToUtc(y: number, m: number, d: number, h = 0, mi = 0, s = 0): Date {
  try {
    return zonedToUtc(y, m, d, h, mi, s, settings.timezone);
  } catch {
    return zonedToUtc(y, m, d, h, mi, s);
  }
}

export const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD.MM.YYYY", "MMM D, YYYY", "D MMMM YYYY"];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatDate(d: Date, fmt = "YYYY-MM-DD", withTime = false): string {
  // Dates are UTC midnight; DateTime values are shown in the document's time
  // zone (Document settings), or the viewer's own when none is set.
  const zoned = withTime ? docZoned(d) : null;
  const y = zoned ? zoned.y : d.getUTCFullYear();
  const m = zoned ? zoned.m - 1 : d.getUTCMonth();
  const day = zoned ? zoned.d : d.getUTCDate();
  const out = fmt.replace(/YYYY|MMMM|MMM|MM|M|DD|D/g, (tok) => {
    switch (tok) {
      case "YYYY":
        return String(y);
      case "MMMM":
        return monthNames ? monthNames.long[m] : MONTHS[m];
      case "MMM":
        return monthNames ? monthNames.short[m] : MONTHS[m].slice(0, 3);
      case "MM":
        return pad(m + 1);
      case "M":
        return String(m + 1);
      case "DD":
        return pad(day);
      case "D":
        return String(day);
    }
    return tok;
  });
  if (!zoned) return out;
  return `${out} ${pad(zoned.h)}:${pad(zoned.mi)}`;
}

/** Parses typed text into a DateTime (ISO string), reading wall-clock times in the document's time zone. */
export function parseDateTimeText(text: string, fmt = "YYYY-MM-DD"): string | null {
  const s = text.trim();
  if (!s) return null;
  // ISO timestamps with an offset or Z are exact.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return isNaN(t) ? null : new Date(t).toISOString();
  }
  const m = /^(.*?)(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s);
  const datePart = m ? parseDateText(m[1], fmt) : null;
  if (m && datePart) {
    let h = m[2] ? Number(m[2]) : 0;
    const mi = m[3] ? Number(m[3]) : 0;
    const sec = m[4] ? Number(m[4]) : 0;
    const ampm = m[5]?.toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    if (h > 23 || mi > 59 || sec > 59) return null;
    const [y, mo, d] = datePart.split("-").map(Number);
    return docZonedToUtc(y, mo, d, h, mi, sec).toISOString();
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t).toISOString();
}

/** Today's date ("YYYY-MM-DD") in the document's time zone. */
export function todayIso(): string {
  const p = docZoned(new Date());
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** The current time ("HH:MM") in the document's time zone. */
export function nowHhmm(): string {
  const p = docZoned(new Date());
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** Midnight today in the document's time zone, as an ISO instant (for DateTime cells). */
export function startOfTodayIso(): string {
  const [y, m, d] = todayIso().split("-").map(Number);
  return docZonedToUtc(y, m, d).toISOString();
}

/** Parses typed text into "YYYY-MM-DD", or null if it isn't a date. */
export function parseDateText(text: string, fmt = "YYYY-MM-DD"): string | null {
  const s = text.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return build(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(s);
  if (m) {
    const dayFirst = fmt.startsWith("D");
    const a = +m[1];
    const b = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    return dayFirst || a > 12 ? build(y, b, a) : build(y, a, b);
  }
  // Free-form dates ("Nov 3, 2026"); a bare number is not a date.
  if (/^[\d.\s-]+$/.test(s)) return null;
  const t = Date.parse(s);
  if (!isNaN(t)) {
    const d = new Date(t);
    return build(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;

  function build(y: number, mo: number, d: number): string | null {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;
    return dateToIso(dt);
  }
}

export function formatNumber(n: number, col: Pick<DocColumn, "type" | "options">): string {
  const o = col.options;
  const mode = o.numMode ?? "decimal";
  let decimals = o.decimals ?? null;
  let value = n;
  if (mode === "percent") value = n * 100;
  if (col.type === "Int") decimals = 0;
  const opts: Intl.NumberFormatOptions =
    decimals === null
      ? { maximumFractionDigits: 10, useGrouping: mode !== "decimal" }
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: mode !== "decimal" };
  const locale = settings.locale || undefined;
  if (mode === "currency") {
    const currency = o.currency || settings.currency || "USD";
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: decimals ?? 2,
        maximumFractionDigits: decimals ?? 2,
      }).format(value);
    } catch {
      return `${currency} ${value.toFixed(decimals ?? 2)}`;
    }
  }
  const text = new Intl.NumberFormat(locale, opts).format(value);
  return mode === "percent" ? `${text}%` : text;
}

/** Column in the target table that a Ref column displays. */
export function refDisplayColumn(engineCols: Map<string, DocColumn[]>, col: DocColumn): DocColumn | null {
  const target = col.options.refTable;
  if (!target) return null;
  const cols = engineCols.get(target) ?? [];
  return cols.find((c) => c.id === col.options.visibleCol) ?? cols[0] ?? null;
}

export interface DisplayContext {
  engine: Engine;
  colsByTable: Map<string, DocColumn[]>;
}

/** Text shown for a runtime value in a given column. */
export function displayValue(ctx: DisplayContext, col: DocColumn, value: unknown): string {
  if (value instanceof FormulaError) return value.code;
  if (value === null || value === undefined) return "";
  if (value instanceof RecordRef) {
    if (!value.rowId) return "";
    const refCol = { ...col, options: { ...col.options, refTable: col.options.refTable || value.tableRef } };
    const display = refDisplayColumn(ctx.colsByTable, refCol);
    if (!display) return `#${value.rowId}`;
    const v = ctx.engine.safeValue(display, value.rowId);
    if (v instanceof FormulaError) return v.code;
    const text = displayValue(ctx, display, v);
    return text || `#${value.rowId}`;
  }
  if (col.type === "Attachments" && Array.isArray(value)) return attachmentsText(null, value);
  if (value instanceof RecordSet) {
    return value.ids.map((id) => displayValue(ctx, col, new RecordRef(value.tableRef, id))).join(", ");
  }
  if (Array.isArray(value)) {
    return value.map((v) => displayValue(ctx, { ...col, type: elementType(col.type) }, v)).join(", ");
  }
  if (typeof value === "number") {
    if (col.type === "Numeric" || col.type === "Int") return formatNumber(value, col);
    return String(Math.round(value * 1e10) / 1e10);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isDate(value)) {
    const withTime = col.type === "DateTime" || (col.type !== "Date" && !value.toISOString().endsWith("T00:00:00.000Z"));
    return formatDate(value, col.options.dateFormat || "YYYY-MM-DD", withTime);
  }
  return toText(value);
}

function elementType(t: ColumnType): ColumnType {
  return t === "ChoiceList" ? "Choice" : t === "RefList" ? "Ref" : t;
}

/** True when a stored value doesn't match its column type (shown in red). */
export function isInvalid(col: DocColumn, raw: CellValue | undefined): boolean {
  if (raw === null || raw === undefined || raw === "") return false;
  switch (col.type) {
    case "Numeric":
    case "Int":
      return typeof raw !== "number";
    case "Bool":
      return typeof raw !== "boolean";
    case "Date":
      return typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw);
    case "DateTime":
      return typeof raw !== "string" || !parseIsoDate(raw);
    case "Ref":
      return typeof raw !== "number";
    case "RefList":
    case "ChoiceList":
      return !Array.isArray(raw);
    case "Attachments":
      return !Array.isArray(raw) || !raw.every(isAttachmentId);
    default:
      return false;
  }
}

export interface ParseContext {
  /** Finds the row id in a table whose display column shows this text. */
  resolveRef(col: DocColumn, text: string): number | null;
}

/** Converts typed or pasted text into the stored value for a column. */
export function parseInput(col: DocColumn, text: string, ctx?: ParseContext): CellValue {
  const s = text.trim();
  if (s === "") return col.type === "Bool" ? false : null;
  switch (col.type) {
    case "Numeric": {
      const pct = s.endsWith("%");
      // Currency symbols and codes before or after the number are ignored.
      const cleaned = normalizeNumber(s.replace(/%$/, "")).replace(/^[^\d.\-+]+/, "").replace(/[^\d.]+$/, "");
      const n = Number(cleaned);
      if (!/\d/.test(cleaned) || isNaN(n)) return text;
      return pct ? n / 100 : n;
    }
    case "Int": {
      const n = Number(normalizeNumber(s));
      return isNaN(n) ? text : Math.round(n);
    }
    case "Bool": {
      const l = s.toLowerCase();
      if (["true", "yes", "y", "1", "x", "✓", "on"].includes(l)) return true;
      if (["false", "no", "n", "0", "off"].includes(l)) return false;
      return text;
    }
    case "Date":
      return parseDateText(s, col.options.dateFormat) ?? text;
    case "DateTime":
      return parseDateTimeText(s, col.options.dateFormat) ?? text;
    case "ChoiceList":
      return s.split(",").map((x) => x.trim()).filter(Boolean);
    case "Ref": {
      if (/^#\d+$/.test(s)) return Number(s.slice(1));
      const id = ctx?.resolveRef(col, s) ?? null;
      return id ?? text;
    }
    case "RefList": {
      const ids: number[] = [];
      for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
        const id = /^#\d+$/.test(part) ? Number(part.slice(1)) : ctx?.resolveRef(col, part);
        if (id) ids.push(id);
      }
      return ids;
    }
    case "Attachments": {
      // Pasted attachment ids (e.g. copied from another Attachments column).
      const ids = s.split(/[,\s]+/).filter(Boolean);
      return ids.every(isAttachmentId) ? ids : text;
    }
    case "Any": {
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
      return text;
    }
    default:
      return text;
  }
}

/**
 * Typed number text in JavaScript syntax: drops grouping and spaces and, in
 * locales that write decimals with a comma ("1.234,5"), swaps the separators.
 * There "1.5" stays 1.5; only dot groups of three ("1.234") read as grouping.
 */
export function normalizeNumber(s: string): string {
  const t = s.replace(/[\s  ']/g, "");
  if (decimalSep === ",") {
    if (t.includes(",")) return t.replace(/\./g, "").replace(",", ".");
    if (/^[-+]?\d{1,3}(\.\d{3})+$/.test(t)) return t.replace(/\./g, "");
    return t;
  }
  return t.replace(/,/g, "");
}

/** Guesses a column type from a sample of text values (used for imports and first entries). */
export function guessType(samples: string[]): ColumnType {
  const vals = samples.map((s) => s.trim()).filter(Boolean);
  if (!vals.length) return "Text";
  if (vals.every((v) => /^-?[\d,]*\.?\d+%?$/.test(v.replace(/^[$€£]/, "")))) {
    return vals.every((v) => /^-?\d+$/.test(v)) ? "Int" : "Numeric";
  }
  if (vals.every((v) => /^(true|false|yes|no)$/i.test(v))) return "Bool";
  if (vals.every((v) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(v) || /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(v))) return "Date";
  return "Text";
}

/** Converts an existing stored value when a column changes type. */
export function convertValue(raw: CellValue | undefined, from: DocColumn, to: DocColumn, ctx: DisplayContext & ParseContext, runtime: unknown): CellValue {
  if (raw === null || raw === undefined) return null;
  if (from.type === to.type) return raw;
  if (to.type === "Attachments") return Array.isArray(raw) && raw.every(isAttachmentId) ? raw : null;
  if (to.type === "Any" || to.type === "Text") {
    const text = displayValue(ctx, from, runtime);
    return to.type === "Any" && typeof raw === "number" ? raw : text;
  }
  if (to.type === "ChoiceList" && typeof raw === "string") return raw ? [raw] : [];
  if (to.type === "Choice" && Array.isArray(raw)) return raw.join(", ");
  const text = Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : displayValue(ctx, from, runtime);
  return parseInput(to, text, ctx);
}

export const CHOICE_PALETTE = ["#E0E7FF", "#DCFCE7", "#FEF3C7", "#FCE7F3", "#E0F2FE", "#F3E8FF", "#FFE4E6", "#ECFCCB", "#FFEDD5", "#E5E7EB"];

export function choiceColor(col: DocColumn, value: string): string {
  const custom = col.options.choiceColors?.[value];
  if (custom) return custom;
  const idx = (col.options.choices ?? []).indexOf(value);
  if (idx >= 0) return CHOICE_PALETTE[idx % CHOICE_PALETTE.length];
  return "#F3F4F6";
}
