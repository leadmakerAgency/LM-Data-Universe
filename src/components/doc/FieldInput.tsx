"use client";

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { CellContent } from "./CellContent";
import { commitCell, editText } from "@/lib/editing";
import type { DocColumn } from "@/lib/types";
import { getDerived, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

/** A labelled, click-to-edit field used by Card widgets. */
export function FieldInput({ col, rowId, canEdit }: { col: DocColumn; rowId: number; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const openPanel = useUi((s) => s.openPanel);
  const raw = useDoc.getState().rows.get(col.table_ref)?.get(rowId)?.data[col.id];
  const value = getDerived().engine.safeValue(col, rowId);
  const editable = canEdit && !col.is_formula;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = async () => {
    setEditing(false);
    if (text !== editText(col, rowId)) await commitCell(col, rowId, text);
  };

  const listId = `opts-${col.id}`;
  const choices = col.type === "Choice" ? col.options.choices ?? [] : [];

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
        <span className="truncate">{col.label || col.col_id}</span>
        {col.is_formula && (
          <button className="font-mono text-brand-600" title={col.formula} onClick={() => openPanel({ tab: "column", colId: col.id, focusFormula: true })}>
            =
          </button>
        )}
      </div>
      {editing ? (
        <>
          <input
            ref={inputRef}
            value={text}
            list={choices.length ? listId : undefined}
            type={col.type === "Date" ? "date" : "text"}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-9 w-full rounded-md border border-brand-400 px-2 text-sm outline-none ring-2 ring-brand-100"
          />
          {choices.length > 0 && (
            <datalist id={listId}>
              {choices.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          )}
        </>
      ) : (
        <div
          onClick={() => {
            if (!editable) return;
            if (col.type === "Bool") {
              void useDoc.getState().setCells([{ tableRef: col.table_ref, rowId, colId: col.id, value: !(raw === true) }]);
              return;
            }
            setText(editText(col, rowId));
            setEditing(true);
          }}
          className={clsx(
            "flex min-h-9 items-center rounded-md border px-2 py-1 text-sm",
            editable ? "cursor-text border-gray-200 hover:border-gray-300" : "border-transparent bg-gray-50",
            col.is_formula && "bg-brand-50/40",
          )}
        >
          <CellContent col={col} value={value} raw={raw} wrap />
        </div>
      )}
    </div>
  );
}
