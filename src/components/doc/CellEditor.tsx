"use client";

import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { displayValue } from "@/lib/format";
import { FormulaError } from "@/lib/formula/values";
import type { DocColumn } from "@/lib/types";
import { displayCtx, getDerived, tableColumns } from "@/store/docStore";

export type Move = "down" | "up" | "right" | "left" | "none";

interface Props {
  col: DocColumn;
  initial: string;
  /** Editing the column's formula rather than a cell value. */
  formula?: boolean;
  style: React.CSSProperties;
  onCommit(text: string, move: Move): void;
  onCancel(): void;
}

function suggestionsFor(col: DocColumn): string[] {
  if (col.type === "Choice" || col.type === "ChoiceList") return col.options.choices ?? [];
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
export function CellEditor({ col, initial, formula, style, onCommit, onCancel }: Props) {
  const [text, setText] = useState(initial);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const multi = col.type === "ChoiceList" || col.type === "RefList";
  const all = useMemo(() => (formula ? [] : suggestionsFor(col)), [col, formula]);
  const query = (multi ? text.split(",").pop() ?? "" : text).trim().toLowerCase();
  const options = all.filter((s) => s.toLowerCase().includes(query)).slice(0, 50);

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
    const showing = options.length > 0 && query !== "" ;
    if (e.key === "Escape") {
      done.current = true;
      onCancel();
    } else if (e.key === "ArrowDown" && options.length) {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp" && options.length) {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (showing && options[highlight] && !multi) finish(options[highlight], "down");
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
      {options.length > 0 && (
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
        </ul>
      )}
    </div>
  );
}
