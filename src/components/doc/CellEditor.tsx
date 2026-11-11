"use client";

import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { displayValue } from "@/lib/format";
import { FormulaError, RecordRef, truthy } from "@engine/values";
import type { DocColumn } from "@/lib/types";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";

export type Move = "down" | "up" | "right" | "left" | "none";

interface Props {
  col: DocColumn;
  /** The record being edited (for dropdown conditions); omitted or negative for a new row. */
  rowId?: number;
  initial: string;
  /** Editing the column's formula rather than a cell value. */
  formula?: boolean;
  style: React.CSSProperties;
  onCommit(text: string, move: Move): void;
  onCancel(): void;
}

/** True when the column's dropdown condition allows this choice for the record. */
function allowed(col: DocColumn, rowId: number | undefined, choice: unknown): boolean {
  const cond = col.options.dropdownCondition?.trim();
  if (!cond) return true;
  const v = getDerived().engine.evaluateWith(cond, col.table_ref, rowId ?? -1, { choice });
  return !(v instanceof FormulaError) && truthy(v);
}

function suggestionsFor(col: DocColumn, rowId?: number): string[] {
  if (col.type === "Choice" || col.type === "ChoiceList") return (col.options.choices ?? []).filter((c) => allowed(col, rowId, c));
  if (col.type === "Ref" || col.type === "RefList") {
    const target = col.options.refTable;
    if (!target) return [];
    const cols = tableColumns(target);
    const display = cols.find((c) => c.id === col.options.visibleCol) ?? cols[0];
    if (!display) return [];
    const { engine } = getDerived();
    const ctx = displayCtx();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of engine.rowIds(target)) {
      if (!allowed(col, rowId, new RecordRef(target, id))) continue;
      const v = engine.safeValue(display, id);
      if (v instanceof FormulaError) continue;
      const text = displayValue(ctx, display, v);
      if (text && !seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
    return out;
  }
  return [];
}

/** Inline editor positioned over a cell. Enter/Tab commit and move; Escape cancels. */
export function CellEditor({ col, rowId, initial, formula, style, onCommit, onCancel }: Props) {
  const [text, setText] = useState(initial);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const multi = col.type === "ChoiceList" || col.type === "RefList";
  const all = useMemo(() => (formula ? [] : suggestionsFor(col, rowId)), [col, formula, rowId]);
  const rawQuery = (multi ? text.split(",").pop() ?? "" : text).trim();
  const query = rawQuery.toLowerCase();
  const options = all.filter((s) => s.toLowerCase().includes(query)).slice(0, 50);
  // "+ Add …" for a value that isn't a choice / record yet.
  const canAdd =
    !formula &&
    !!rawQuery &&
    !rawQuery.startsWith("=") &&
    useDoc.getState().canEdit() &&
    ((col.type === "Ref" || col.type === "RefList") ? !!col.options.refTable : col.type === "Choice" || col.type === "ChoiceList") &&
    !all.some((s) => s.toLowerCase() === query);
  const targetName = col.options.refTable ? useDoc.getState().tables.get(col.options.refTable)?.table_id : null;

  const addNew = async () => {
    if (!canAdd) return;
    const st = useDoc.getState();
    if (col.type === "Ref" || col.type === "RefList") {
      const target = col.options.refTable!;
      const cols = tableColumns(target);
      const display = cols.find((c) => c.id === col.options.visibleCol) ?? cols[0];
      if (!display) return;
      await st.addRows(target, [{ data: { [display.id]: rawQuery } }]);
    } else {
      await st.updateColumn(col.id, { options: { ...col.options, choices: [...(col.options.choices ?? []), rawQuery] } });
    }
    if (multi) {
      const parts = text.split(",").slice(0, -1).map((s) => s.trim()).filter(Boolean);
      finish([...parts, rawQuery].join(", "), "down");
    } else finish(rawQuery, "down");
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const finish = (value: string, move: Move) => {
    if (done.current) return;
    done.current = true;
    onCommit(value, move);
  };

  const pick = (option: string) => {
    if (multi) {
      const parts = text.split(",").slice(0, -1).map((s) => s.trim()).filter(Boolean);
      setText([...parts, option].join(", ") + ", ");
      ref.current?.focus();
    } else {
      finish(option, "down");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const showing = (options.length > 0 || canAdd) && query !== "";
    if (e.key === "Escape") {
      done.current = true;
      onCancel();
    } else if (e.key === "ArrowDown" && (options.length || canAdd)) {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, options.length - (canAdd ? 0 : 1)));
    } else if (e.key === "ArrowUp" && options.length) {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (showing && highlight === options.length && canAdd) void addNew();
      else if (showing && options[highlight] && !multi) finish(options[highlight], "down");
      else if (showing && options[highlight] && multi) pick(options[highlight]);
      else finish(multi ? text.replace(/,\s*$/, "") : text, "down");
    } else if (e.key === "Tab") {
      e.preventDefault();
      finish(multi ? text.replace(/,\s*$/, "") : text, e.shiftKey ? "left" : "right");
    }
  };

  return (
    <div className="absolute z-20" style={style}>
      <div className={clsx("flex min-h-full items-start bg-white shadow-lg ring-2 ring-brand-500", formula && "min-w-[320px]")}>
        {formula && <span className="select-none px-1.5 py-1.5 font-mono text-xs font-semibold text-brand-600">=</span>}
        <textarea
          ref={ref}
          value={text}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          onChange={(e) => {
            setText(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => finish(multi ? text.replace(/,\s*$/, "") : text, "none")}
          className={clsx("w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none", formula && "font-mono text-xs")}
          spellCheck={false}
        />
      </div>
      {(options.length > 0 || canAdd) && (
        <ul className="scroll-thin mt-1 max-h-56 min-w-full overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg">
          {options.map((o, i) => (
            <li key={o}>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                className={clsx("w-full px-3 py-1 text-left text-sm", i === highlight ? "bg-brand-50 text-brand-800" : "hover:bg-gray-50")}
              >
                {o}
              </button>
            </li>
          ))}
          {canAdd && (
            <li>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  void addNew();
                }}
                className={clsx("w-full px-3 py-1 text-left text-sm text-brand-700", highlight === options.length ? "bg-brand-50" : "hover:bg-gray-50")}
              >
                + Add “{rawQuery}”{targetName ? ` to ${targetName}` : " as a choice"}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
