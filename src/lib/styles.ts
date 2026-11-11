// Cell styles: a column's base style, then the table widget's row rules,
// then the column's conditional rules (later rules win where they overlap).
// A rule is a formula evaluated for the record, e.g. `$Status == "Late"`.
import type { CSSProperties } from "react";
import type { CellStyle, StyleRule } from "@engine/types";
import { truthy } from "@engine/values";
import { FormulaError } from "@engine/values";
import type { DocColumn } from "./types";
import { getDerived } from "@/store/docStore";

export const STYLE_COLORS = [
  "#000000", "#4b5563", "#9ca3af", "#ffffff",
  "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777",
  "#fee2e2", "#ffedd5", "#fef9c3", "#dcfce7", "#cffafe", "#dbeafe", "#ede9fe", "#fce7f3",
];

let cacheEngine: unknown = null;
const ruleCache = new Map<string, boolean>();

/** True when a rule's formula is true for the record (errors count as false). */
export function ruleMatches(rule: StyleRule, tableRef: string, rowId: number): boolean {
  if (!rule.formula.trim()) return false;
  const { engine } = getDerived();
  if (engine !== cacheEngine) {
    cacheEngine = engine;
    ruleCache.clear();
  }
  const key = `${tableRef}|${rule.formula}|${rowId}`;
  let hit = ruleCache.get(key);
  if (hit === undefined) {
    const v = engine.evaluate(rule.formula, tableRef, rowId);
    hit = !(v instanceof FormulaError) && truthy(v);
    ruleCache.set(key, hit);
  }
  return hit;
}

export function mergeStyle(base: CellStyle | undefined, over: CellStyle | undefined): CellStyle {
  const out: CellStyle = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(over ?? {})) if (v !== undefined && v !== null && v !== "") (out as Record<string, unknown>)[k] = v;
  return out;
}

/** The style a cell ends up with. */
export function effectiveStyle(col: DocColumn, rowId: number, rowRules?: StyleRule[]): CellStyle | null {
  const rules = col.options.rules;
  if (!col.options.style && !rules?.length && !rowRules?.length) return null;
  let style: CellStyle = { ...(col.options.style ?? {}) };
  for (const r of rowRules ?? []) if (ruleMatches(r, col.table_ref, rowId)) style = mergeStyle(style, r.style);
  for (const r of rules ?? []) if (ruleMatches(r, col.table_ref, rowId)) style = mergeStyle(style, r.style);
  return style;
}

export function styleToCss(s: CellStyle | null | undefined): CSSProperties | undefined {
  if (!s) return undefined;
  const css: CSSProperties = {};
  if (s.textColor) css.color = s.textColor;
  if (s.fillColor) css.backgroundColor = s.fillColor;
  if (s.bold) css.fontWeight = 600;
  if (s.italic) css.fontStyle = "italic";
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ");
  if (deco) css.textDecoration = deco;
  return Object.keys(css).length ? css : undefined;
}

export function cellCss(col: DocColumn, rowId: number, rowRules?: StyleRule[]): CSSProperties | undefined {
  return styleToCss(effectiveStyle(col, rowId, rowRules));
}

export function newRule(): StyleRule {
  return { id: crypto.randomUUID(), formula: "", style: { fillColor: "#fef9c3" } };
}
