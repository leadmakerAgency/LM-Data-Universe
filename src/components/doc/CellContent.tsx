"use client";

import clsx from "clsx";
import { Check } from "lucide-react";
import { choiceColor, displayValue, isInvalid } from "@/lib/format";
import { FormulaError } from "@/lib/formula/values";
import type { CellValue, DocColumn } from "@/lib/types";
import { displayCtx } from "@/store/docStore";

export function isRightAligned(col: DocColumn) {
  if (col.options.alignment) return col.options.alignment === "right";
  return col.type === "Numeric" || col.type === "Int";
}

/** Read-only rendering of one cell, shared by the grid, cards and summaries. */
export function CellContent({ col, value, raw, wrap }: { col: DocColumn; value: unknown; raw?: CellValue; wrap?: boolean }) {
  if (value instanceof FormulaError) {
    return (
      <span className="truncate font-mono text-xs text-red-600" title={value.message}>
        {value.code}
      </span>
    );
  }
  if (!col.is_formula && isInvalid(col, raw)) {
    return (
      <span className="truncate text-red-600" title={`Not a valid ${col.type} value`}>
        {String(Array.isArray(raw) ? raw.join(", ") : raw)}
      </span>
    );
  }
  if (col.type === "Bool") {
    const on = value === true;
    return (
      <span
        className={clsx(
          "inline-flex h-4 w-4 items-center justify-center rounded border",
          on ? "border-brand-600 bg-brand-600 text-white" : "border-gray-300 bg-white",
        )}
      >
        {on && <Check size={12} strokeWidth={3} />}
      </span>
    );
  }
  if (col.type === "Choice" && typeof value === "string" && value) {
    return <Chip col={col} value={value} />;
  }
  if (col.type === "ChoiceList" && Array.isArray(value)) {
    return (
      <span className="flex gap-1 overflow-hidden">
        {value.map((v, i) => (
          <Chip key={i} col={col} value={String(v)} />
        ))}
      </span>
    );
  }
  const text = displayValue(displayCtx(), col, value);
  const align = col.options.alignment ?? (isRightAligned(col) ? "right" : "left");
  return (
    <span
      className={clsx(
        wrap || col.options.wrap ? "whitespace-pre-wrap break-words" : "truncate",
        (col.type === "Ref" || col.type === "RefList") && "text-brand-700",
        align === "right" && "ml-auto",
        align === "center" && "mx-auto",
      )}
    >
      {text}
    </span>
  );
}

function Chip({ col, value }: { col: DocColumn; value: string }) {
  const known = (col.options.choices ?? []).includes(value);
  return (
    <span
      className={clsx("truncate rounded px-1.5 py-px text-xs font-medium text-gray-800", !known && "outline outline-1 outline-dashed outline-gray-300")}
      style={{ background: choiceColor(col, value) }}
    >
      {value}
    </span>
  );
}
